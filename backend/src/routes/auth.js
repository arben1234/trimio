const router = require('express').Router();
const bcrypt = require('bcryptjs');
const db = require('../database');
const { signToken, requireAuth } = require('../middleware/auth');

// Login super admin
router.post('/admin/login', (req, res) => {
  const { username, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE username = ? AND role = ?').get(username, 'super_admin');
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Credenziali non valide' });
  }
  const token = signToken({ userId: user.id, role: 'super_admin', name: user.name });
  res.json({ token, user: { id: user.id, name: user.name, role: 'super_admin' } });
});

// Login staff (owner o barber) — SEMPRE scoped al salone tramite slug
router.post('/salon/:salonSlug/login', (req, res) => {
  const { username, password } = req.body;
  const salon = db.prepare('SELECT * FROM salons WHERE slug = ?').get(req.params.salonSlug);
  if (!salon) return res.status(404).json({ error: 'Salone non trovato' });

  const user = db.prepare(
    'SELECT * FROM users WHERE salon_id = ? AND username = ? AND role IN (\'owner\',\'barber\')'
  ).get(salon.id, username);

  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Credenziali non valide' });
  }

  const token = signToken({ userId: user.id, role: user.role, salonId: salon.id, name: user.name });
  res.json({
    token,
    user: { id: user.id, name: user.name, role: user.role, salonId: salon.id, salonSlug: salon.slug }
  });
});

// Cambia password
router.put('/change-password', requireAuth(['owner', 'barber']), (req, res) => {
  const { currentPassword, newPassword } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.userId);
  if (!bcrypt.compareSync(currentPassword, user.password_hash)) {
    return res.status(400).json({ error: 'Password attuale errata' });
  }
  const hash = bcrypt.hashSync(newPassword, 10);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, user.id);
  res.json({ ok: true });
});

// Chiave pubblica VAPID (necessaria al frontend per iscriversi al push)
router.get('/vapid-key', (req, res) => {
  res.json({ key: process.env.VAPID_PUBLIC || null });
});

// Salva push subscription
router.post('/push-subscription', requireAuth(['owner', 'barber']), (req, res) => {
  const { subscription } = req.body;
  db.prepare('UPDATE users SET push_sub = ? WHERE id = ?').run(JSON.stringify(subscription), req.user.userId);
  res.json({ ok: true });
});

module.exports = router;
