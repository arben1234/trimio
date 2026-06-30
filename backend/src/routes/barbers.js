const router = require('express').Router({ mergeParams: true });
const db = require('../database');
const { requireAuth } = require('../middleware/auth');

// Orari di lavoro barber
router.get('/:salonSlug/barbers/:barberId/hours', (req, res) => {
  const hours = db.prepare('SELECT * FROM working_hours WHERE barber_id = ? ORDER BY day_of_week').all(req.params.barberId);
  res.json(hours);
});

router.put('/:salonSlug/barbers/:barberId/hours', requireAuth(['owner', 'barber', 'super_admin']), (req, res) => {
  const { hours } = req.body; // array: [{day_of_week, start_time, end_time, is_day_off}]
  const barberId = parseInt(req.params.barberId);

  // Barber può modificare solo i propri orari
  if (req.user.role === 'barber' && req.user.userId !== barberId) {
    return res.status(403).json({ error: 'Non autorizzato' });
  }

  const upsert = db.prepare(
    'INSERT INTO working_hours (barber_id, day_of_week, start_time, end_time, is_day_off) VALUES (?,?,?,?,?) ON CONFLICT(barber_id, day_of_week) DO UPDATE SET start_time=excluded.start_time, end_time=excluded.end_time, is_day_off=excluded.is_day_off'
  );
  db.exec('BEGIN');
  try {
    hours.forEach(r => upsert.run(barberId, r.day_of_week, r.start_time, r.end_time, r.is_day_off ? 1 : 0));
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  res.json({ ok: true });
});

// Festività / vacanze barber
router.get('/:salonSlug/barbers/:barberId/holidays', (req, res) => {
  const holidays = db.prepare('SELECT * FROM holidays WHERE barber_id = ? ORDER BY date').all(req.params.barberId);
  res.json(holidays);
});

router.post('/:salonSlug/barbers/:barberId/holidays', requireAuth(['owner', 'barber', 'super_admin']), (req, res) => {
  if (req.user.role === 'barber' && req.user.userId !== parseInt(req.params.barberId)) {
    return res.status(403).json({ error: 'Non autorizzato' });
  }
  const { date, reason } = req.body;
  db.prepare('INSERT OR IGNORE INTO holidays (barber_id, date, reason) VALUES (?,?,?)').run(req.params.barberId, date, reason || null);
  res.status(201).json({ ok: true });
});

router.delete('/:salonSlug/barbers/:barberId/holidays/:date', requireAuth(['owner', 'barber', 'super_admin']), (req, res) => {
  if (req.user.role === 'barber' && req.user.userId !== parseInt(req.params.barberId)) {
    return res.status(403).json({ error: 'Non autorizzato' });
  }
  db.prepare('DELETE FROM holidays WHERE barber_id = ? AND date = ?').run(req.params.barberId, req.params.date);
  res.json({ ok: true });
});

// Valutazioni barber
router.get('/:salonSlug/barbers/:barberId/ratings', (req, res) => {
  const ratings = db.prepare(
    'SELECT r.*, b.client_name, b.date FROM ratings r JOIN bookings b ON r.booking_id = b.id WHERE r.barber_id = ? ORDER BY r.created_at DESC'
  ).all(req.params.barberId);
  const avg = ratings.length ? ratings.reduce((s, r) => s + r.stars, 0) / ratings.length : 0;
  res.json({ ratings, average: Math.round(avg * 10) / 10 });
});

// Profilo barber (per dashboard)
router.get('/:salonSlug/barbers/:barberId', requireAuth(['owner', 'barber', 'super_admin']), (req, res) => {
  const barber = db.prepare('SELECT id, name, username, role FROM users WHERE id = ? AND salon_id = ?').get(req.params.barberId, req.salonId || req.user.salonId);
  if (!barber) return res.status(404).json({ error: 'Barbiere non trovato' });
  res.json(barber);
});

module.exports = router;
