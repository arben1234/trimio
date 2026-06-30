const router = require('express').Router({ mergeParams: true });
const db = require('../database');
const { requireAuth } = require('../middleware/auth');

// Dati pubblici del salone (per pagina cliente)
router.get('/:salonSlug', (req, res) => {
  const salon = db.prepare('SELECT id, name, address, phone, qr_code, slug FROM salons WHERE slug = ?').get(req.params.salonSlug);
  if (!salon) return res.status(404).json({ error: 'Salone non trovato' });

  const barbers = db.prepare(
    'SELECT id, name FROM users WHERE salon_id = ? AND role = ? ORDER BY name'
  ).all(salon.id, 'barber');

  const services = db.prepare(
    'SELECT * FROM services WHERE salon_id = ? ORDER BY name'
  ).all(salon.id);

  res.json({ salon, barbers, services });
});

// Orari disponibili per un barber in una data
router.get('/:salonSlug/barbers/:barberId/availability', (req, res) => {
  const salon = db.prepare('SELECT id FROM salons WHERE slug = ?').get(req.params.salonSlug);
  if (!salon) return res.status(404).json({ error: 'Salone non trovato' });

  const { date, serviceId } = req.query;
  if (!date) return res.status(400).json({ error: 'Data obbligatoria' });

  const dayOfWeek = new Date(date).getDay();
  const wh = db.prepare('SELECT * FROM working_hours WHERE barber_id = ? AND day_of_week = ?')
    .get(req.params.barberId, dayOfWeek);

  if (!wh || wh.is_day_off) return res.json({ slots: [] });

  const holiday = db.prepare('SELECT id FROM holidays WHERE barber_id = ? AND date = ?')
    .get(req.params.barberId, date);
  if (holiday) return res.json({ slots: [] });

  const service = serviceId
    ? db.prepare('SELECT duration_minutes FROM services WHERE id = ?').get(serviceId)
    : { duration_minutes: 30 };
  const duration = service?.duration_minutes || 30;

  const booked = db.prepare(
    'SELECT time FROM bookings WHERE barber_id = ? AND date = ? AND status != ?'
  ).all(req.params.barberId, date, 'cancelled').map(b => b.time);

  const slots = [];
  const [sh, sm] = wh.start_time.split(':').map(Number);
  const [eh, em] = wh.end_time.split(':').map(Number);
  let cur = sh * 60 + sm;
  const end = eh * 60 + em;

  while (cur + duration <= end) {
    const h = String(Math.floor(cur / 60)).padStart(2, '0');
    const m = String(cur % 60).padStart(2, '0');
    const slot = `${h}:${m}`;
    if (!booked.includes(slot)) slots.push(slot);
    cur += duration;
  }

  res.json({ slots });
});

// Servizi del salone
router.get('/:salonSlug/services', (req, res) => {
  const salon = db.prepare('SELECT id FROM salons WHERE slug = ?').get(req.params.salonSlug);
  if (!salon) return res.status(404).json({ error: 'Salone non trovato' });
  const services = db.prepare('SELECT * FROM services WHERE salon_id = ? ORDER BY name').all(salon.id);
  res.json(services);
});

// Gestione servizi (owner)
router.post('/:salonSlug/services', requireAuth(['owner', 'super_admin']), (req, res) => {
  const salon = db.prepare('SELECT id FROM salons WHERE slug = ?').get(req.params.salonSlug);
  if (!salon) return res.status(404).json({ error: 'Salone non trovato' });
  const { name, duration_minutes, price, barber_id } = req.body;
  const result = db.prepare(
    'INSERT INTO services (salon_id, barber_id, name, duration_minutes, price) VALUES (?,?,?,?,?)'
  ).run(salon.id, barber_id || null, name, duration_minutes, price);
  res.status(201).json({ id: result.lastInsertRowid });
});

router.put('/:salonSlug/services/:id', requireAuth(['owner', 'super_admin']), (req, res) => {
  const { name, duration_minutes, price } = req.body;
  db.prepare('UPDATE services SET name=?, duration_minutes=?, price=? WHERE id=?')
    .run(name, duration_minutes, price, req.params.id);
  res.json({ ok: true });
});

router.delete('/:salonSlug/services/:id', requireAuth(['owner', 'super_admin']), (req, res) => {
  db.prepare('DELETE FROM services WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
