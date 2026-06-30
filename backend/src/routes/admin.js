const router = require('express').Router();
const bcrypt = require('bcryptjs');
const db = require('../database');
const { requireSuperAdmin } = require('../middleware/auth');
const { generateQR, buildSalonUrl } = require('../utils/qrcode');
const { uniqueSlug } = require('../utils/slugify');

router.use(requireSuperAdmin);

// Lista saloni
router.get('/salons', (req, res) => {
  const salons = db.prepare('SELECT * FROM salons ORDER BY name').all();
  res.json(salons);
});

// Crea salone (genera slug + QR automaticamente)
router.post('/salons', async (req, res) => {
  const { name, address, phone } = req.body;
  const existingSlugs = db.prepare('SELECT slug FROM salons').all().map(r => r.slug);
  const slug = uniqueSlug(name, existingSlugs);
  const url = buildSalonUrl(slug, req.body.baseUrl);
  const qr_code = await generateQR(url);

  const result = db.prepare(
    'INSERT INTO salons (name, slug, address, phone, qr_code) VALUES (?,?,?,?,?)'
  ).run(name, slug, address || null, phone || null, qr_code);

  // Crea owner di default
  const ownerHash = bcrypt.hashSync('owner123', 10);
  db.prepare(
    'INSERT INTO users (salon_id, name, username, password_hash, role) VALUES (?,?,?,?,?)'
  ).run(result.lastInsertRowid, 'Proprietario', 'owner', ownerHash, 'owner');

  res.status(201).json({ id: result.lastInsertRowid, slug, url, qr_code });
});

// Aggiorna salone
router.put('/salons/:id', async (req, res) => {
  const { name, address, phone, baseUrl } = req.body;
  const salon = db.prepare('SELECT * FROM salons WHERE id = ?').get(req.params.id);
  if (!salon) return res.status(404).json({ error: 'Salone non trovato' });

  let { slug, qr_code } = salon;
  if (name && name !== salon.name) {
    const existingSlugs = db.prepare('SELECT slug FROM salons WHERE id != ?').all(req.params.id).map(r => r.slug);
    slug = uniqueSlug(name, existingSlugs);
  }
  if (baseUrl || (name && name !== salon.name)) {
    qr_code = await generateQR(buildSalonUrl(slug, baseUrl));
  }

  db.prepare('UPDATE salons SET name=?, slug=?, address=?, phone=?, qr_code=? WHERE id=?')
    .run(name || salon.name, slug, address ?? salon.address, phone ?? salon.phone, qr_code, req.params.id);
  res.json({ ok: true, slug });
});

// Elimina salone
router.delete('/salons/:id', (req, res) => {
  db.prepare('DELETE FROM salons WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Lista barbers di un salone
router.get('/salons/:id/barbers', (req, res) => {
  const barbers = db.prepare('SELECT id, name, username, role, created_at FROM users WHERE salon_id = ? ORDER BY name').all(req.params.id);
  res.json(barbers);
});

// Aggiungi barber/owner
router.post('/salons/:id/barbers', (req, res) => {
  const { name, username, password, role } = req.body;
  const hash = bcrypt.hashSync(password || `${username}123`, 10);
  const result = db.prepare(
    'INSERT INTO users (salon_id, name, username, password_hash, role) VALUES (?,?,?,?,?)'
  ).run(req.params.id, name, username, hash, role || 'barber');
  res.status(201).json({ id: result.lastInsertRowid });
});

// Modifica barber
router.put('/barbers/:id', (req, res) => {
  const { name, username, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Utente non trovato' });
  const hash = password ? bcrypt.hashSync(password, 10) : user.password_hash;
  db.prepare('UPDATE users SET name=?, username=?, password_hash=? WHERE id=?')
    .run(name || user.name, username || user.username, hash, req.params.id);
  res.json({ ok: true });
});

// Elimina barber
router.delete('/barbers/:id', (req, res) => {
  db.prepare('DELETE FROM users WHERE id = ? AND role != ?').run(req.params.id, 'super_admin');
  res.json({ ok: true });
});

// Statistiche globali
router.get('/stats', (req, res) => {
  const totalSalons = db.prepare('SELECT COUNT(*) as c FROM salons').get().c;
  const totalBarbers = db.prepare('SELECT COUNT(*) as c FROM users WHERE role = ?').get('barber').c;
  const totalBookings = db.prepare('SELECT COUNT(*) as c FROM bookings').get().c;
  const todayBookings = db.prepare('SELECT COUNT(*) as c FROM bookings WHERE date = ?').get(new Date().toISOString().slice(0, 10)).c;
  res.json({ totalSalons, totalBarbers, totalBookings, todayBookings });
});

module.exports = router;
