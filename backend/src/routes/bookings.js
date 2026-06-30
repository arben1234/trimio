const router = require('express').Router({ mergeParams: true });
const db = require('../database');
const { requireAuth } = require('../middleware/auth');
const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../middleware/auth');
const { notifyNewBooking } = require('../utils/push');

// SSE: mappa salonId -> Set di { res, userId, role }
const salonClients = new Map();

function emitBooking(salonId, booking) {
  const clients = salonClients.get(salonId);
  if (!clients || clients.size === 0) return;
  const enriched = db.prepare(
    'SELECT b.*, u.name as barber_name, s.name as service_name, s.price FROM bookings b LEFT JOIN users u ON b.barber_id = u.id LEFT JOIN services s ON b.service_id = s.id WHERE b.id = ?'
  ).get(booking.id);
  const payload = `event: new-booking\ndata: ${JSON.stringify(enriched)}\n\n`;
  clients.forEach(client => {
    // Barber riceve solo le sue; owner riceve tutte — admin mai
    if (client.role === 'owner' || client.userId === booking.barber_id) {
      try { client.res.write(payload); } catch {}
    }
  });
}

// SSE endpoint — token come query param perché EventSource non supporta headers
router.get('/:salonSlug/events', (req, res) => {
  const token = req.query.token;
  if (!token) return res.status(401).end();

  let payload;
  try { payload = jwt.verify(token, JWT_SECRET); }
  catch { return res.status(401).end(); }

  const salon = db.prepare('SELECT id FROM salons WHERE slug = ?').get(req.params.salonSlug);
  if (!salon) return res.status(404).end();

  // Solo owner e barber — mai super_admin
  if (!['owner', 'barber'].includes(payload.role)) return res.status(403).end();
  if (payload.salonId !== salon.id) return res.status(403).end();

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const client = { res, userId: payload.userId, role: payload.role };
  if (!salonClients.has(salon.id)) salonClients.set(salon.id, new Set());
  salonClients.get(salon.id).add(client);

  // Heartbeat ogni 25s per tenere la connessione viva
  const heartbeat = setInterval(() => {
    try { res.write(':heartbeat\n\n'); } catch { clearInterval(heartbeat); }
  }, 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    salonClients.get(salon.id)?.delete(client);
  });
});

// Crea prenotazione (pubblico - cliente)
router.post('/:salonSlug/bookings', (req, res) => {
  const salon = db.prepare('SELECT * FROM salons WHERE slug = ?').get(req.params.salonSlug);
  if (!salon) return res.status(404).json({ error: 'Salone non trovato' });

  const { barberId, serviceId, clientName, clientPhone, date, time, notes } = req.body;
  if (!barberId || !clientName || !date || !time) {
    return res.status(400).json({ error: 'Campi obbligatori mancanti' });
  }

  const barber = db.prepare('SELECT * FROM users WHERE id = ? AND salon_id = ? AND role = ?')
    .get(barberId, salon.id, 'barber');
  if (!barber) return res.status(400).json({ error: 'Barbiere non valido' });

  const conflict = db.prepare(
    'SELECT id FROM bookings WHERE barber_id = ? AND date = ? AND time = ? AND status != ?'
  ).get(barberId, date, time, 'cancelled');
  if (conflict) return res.status(409).json({ error: 'Slot già occupato' });

  const result = db.prepare(
    'INSERT INTO bookings (salon_id, barber_id, service_id, client_name, client_phone, date, time, notes) VALUES (?,?,?,?,?,?,?,?)'
  ).run(salon.id, barberId, serviceId || null, clientName, clientPhone || null, date, time, notes || null);

  const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(result.lastInsertRowid);

  // SSE: aggiornamento in-dashboard real-time
  emitBooking(salon.id, booking);
  // Web Push: notifica anche quando il browser è chiuso
  notifyNewBooking(salon.id, booking);

  res.status(201).json(booking);
});

// Lista prenotazioni (owner: tutte; barber: solo sue)
router.get('/:salonSlug/bookings', requireAuth(['owner', 'barber', 'super_admin']), (req, res) => {
  const { date, status } = req.query;
  let query = 'SELECT b.*, u.name as barber_name, s.name as service_name, s.price FROM bookings b LEFT JOIN users u ON b.barber_id = u.id LEFT JOIN services s ON b.service_id = s.id WHERE b.salon_id = ?';
  const params = [req.salonId || req.user.salonId];

  if (req.user.role === 'barber') {
    query += ' AND b.barber_id = ?';
    params.push(req.user.userId);
  }
  if (date) { query += ' AND b.date = ?'; params.push(date); }
  if (status) { query += ' AND b.status = ?'; params.push(status); }
  query += ' ORDER BY b.date DESC, b.time ASC';

  res.json(db.prepare(query).all(...params));
});

// Aggiorna stato prenotazione
router.put('/:salonSlug/bookings/:id', requireAuth(['owner', 'barber', 'super_admin']), (req, res) => {
  const { status } = req.body;
  const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(req.params.id);
  if (!booking) return res.status(404).json({ error: 'Prenotazione non trovata' });

  if (req.user.role === 'barber' && booking.barber_id !== req.user.userId) {
    return res.status(403).json({ error: 'Non autorizzato' });
  }

  db.prepare('UPDATE bookings SET status = ? WHERE id = ?').run(status, req.params.id);
  res.json({ ok: true });
});

// Statistiche
router.get('/:salonSlug/stats', requireAuth(['owner', 'barber', 'super_admin']), (req, res) => {
  const salonId = req.salonId || req.user.salonId;
  const isBarber = req.user.role === 'barber';
  const filter = isBarber ? 'AND b.barber_id = ?' : '';
  const params = isBarber ? [salonId, req.user.userId] : [salonId];

  const total = db.prepare(`SELECT COUNT(*) as c FROM bookings b WHERE b.salon_id = ? ${filter} AND b.status != 'cancelled'`).get(...params).c;
  const completed = db.prepare(`SELECT COUNT(*) as c FROM bookings b WHERE b.salon_id = ? ${filter} AND b.status = 'confirmed'`).get(...params).c;
  const revenue = db.prepare(`SELECT COALESCE(SUM(s.price),0) as r FROM bookings b LEFT JOIN services s ON b.service_id = s.id WHERE b.salon_id = ? ${filter} AND b.status = 'confirmed'`).get(...params).r;
  const today = db.prepare(`SELECT COUNT(*) as c FROM bookings b WHERE b.salon_id = ? ${filter} AND b.date = ?`).get(...params, new Date().toISOString().slice(0, 10)).c;

  res.json({ total, completed, revenue, today });
});

// Valutazione
router.post('/:salonSlug/bookings/:bookingId/rating', (req, res) => {
  const { stars, comment } = req.body;
  const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(req.params.bookingId);
  if (!booking) return res.status(404).json({ error: 'Prenotazione non trovata' });
  db.prepare('INSERT OR REPLACE INTO ratings (booking_id, barber_id, stars, comment) VALUES (?,?,?,?)')
    .run(booking.id, booking.barber_id, stars, comment || null);
  res.status(201).json({ ok: true });
});

module.exports = router;
