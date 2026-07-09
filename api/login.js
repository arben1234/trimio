import { getSalonsDb, getAdminDb } from '../lib/kv.js';

// Server-side credential check for all three login levels. Replaces the old
// client-side comparison against the full salons/admin blob — that blob used
// to ship every plaintext password to any anonymous visitor via GET /api/sync,
// which this endpoint (plus the sanitization in api/sync.js) closes off.
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'method_not_allowed' });

  const kvUrl = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;
  if (!kvUrl || !kvToken) return res.status(500).json({ success: false, error: 'database_not_configured' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const { role, salonId, username, password } = body;
    if (!role || typeof username !== 'string' || !username || typeof password !== 'string' || !password) {
      return res.status(400).json({ success: false, error: 'missing_fields' });
    }

    if (role === 'admin') {
      const admin = await getAdminDb(kvUrl, kvToken);
      if (username === admin.username && password === admin.password) {
        return res.status(200).json({ success: true, role: 'admin' });
      }
      return res.status(401).json({ success: false, error: 'invalid_credentials' });
    }

    if (role === 'owner' || role === 'barber') {
      if (!salonId) return res.status(400).json({ success: false, error: 'missing_fields' });
      const salons = await getSalonsDb(kvUrl, kvToken);
      const salon = salons.find(s => s.id === salonId);
      if (!salon) return res.status(401).json({ success: false, error: 'invalid_credentials' });

      if (role === 'owner') {
        if (username === salon.ownerUsername && password === salon.ownerPassword) {
          if (salon.inactive) return res.status(200).json({ success: false, error: 'salon_inactive' });
          return res.status(200).json({ success: true, role: 'owner', salonId: salon.id, salonName: salon.name });
        }
      } else {
        const w = (salon.workers || []).find(x => x.username === username && x.password === password);
        if (w) {
          if (salon.inactive) return res.status(200).json({ success: false, error: 'salon_inactive' });
          return res.status(200).json({ success: true, role: 'barber', salonId: salon.id, workerId: w.id, name: w.name });
        }
      }
      return res.status(401).json({ success: false, error: 'invalid_credentials' });
    }

    return res.status(400).json({ success: false, error: 'invalid_role' });
  } catch (err) {
    console.error('[LOGIN] Error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
