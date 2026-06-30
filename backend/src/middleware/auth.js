const jwt = require('jsonwebtoken');
const db = require('../database');

const JWT_SECRET = process.env.JWT_SECRET || 'trimio-secret-change-in-production';

function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });
}

// Middleware: verifica token e salon_id nella URL coincidono
function requireAuth(roles = []) {
  return (req, res, next) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'Token mancante' });

    let payload;
    try {
      payload = jwt.verify(token, JWT_SECRET);
    } catch {
      return res.status(401).json({ error: 'Token non valido' });
    }

    // Isolamento salone: se la rotta ha :salonSlug, il token deve appartenere a quel salone
    if (req.params.salonSlug) {
      const salon = db.prepare('SELECT id FROM salons WHERE slug = ?').get(req.params.salonSlug);
      if (!salon) return res.status(404).json({ error: 'Salone non trovato' });
      if (payload.role !== 'super_admin' && payload.salonId !== salon.id) {
        return res.status(403).json({ error: 'Accesso negato a questo salone' });
      }
      req.salonId = salon.id;
    }

    if (roles.length && !roles.includes(payload.role)) {
      return res.status(403).json({ error: 'Permessi insufficienti' });
    }

    req.user = payload;
    next();
  };
}

function requireSuperAdmin(req, res, next) {
  return requireAuth(['super_admin'])(req, res, next);
}

module.exports = { signToken, requireAuth, requireSuperAdmin, JWT_SECRET };
