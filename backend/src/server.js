require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
const allowedOrigins = [
  'http://localhost:5173',
  'https://trimio-app.vercel.app',
  'https://frontend-iota-smoky-64.vercel.app',
  process.env.FRONTEND_URL
].filter(Boolean);
app.use(cors({
  origin: (origin, cb) => cb(null, !origin || allowedOrigins.includes(origin)),
  credentials: true
}));
app.use(express.json());
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  next();
});

app.use('/api/auth', require('./routes/auth'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/salons', require('./routes/salons'));
app.use('/api/salons', require('./routes/bookings'));
app.use('/api/salons', require('./routes/barbers'));

app.get('/api/health', (_, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, async () => {
  console.log(`TRIMIO backend → http://localhost:${PORT}`);
  const db = require('./database');
  const count = db.prepare('SELECT COUNT(*) as c FROM salons').get().c;
  if (count === 0) {
    console.log('Database vuoto — eseguo seed automatico...');
    try { require('./database/seed'); } catch (e) { console.error('Seed error:', e.message); }
  }
});
