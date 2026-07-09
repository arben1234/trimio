import { setSalonsDb, kvCmd, getAdminDb } from '../lib/kv.js';

// Admin-only, destructive, one-shot "start fresh with real salons" action —
// wipes every salon/worker/booking/push-subscription/slot-lock currently
// stored, used once when the business switches from test/demo data to real
// production data. Requires the admin's actual current password (verified
// here server-side too, not just in the UI) so this can't fire by accident
// or from someone who only knows a static confirmation phrase.
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const kvUrl = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;
  if (!kvUrl || !kvToken) return res.status(500).json({ error: 'KV database not configured' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    if (!body || typeof body.password !== 'string' || !body.password) {
      return res.status(400).json({ error: 'Missing password' });
    }
    const admin = await getAdminDb(kvUrl, kvToken);
    if (body.password !== admin.password) {
      return res.status(401).json({ error: 'Incorrect password' });
    }

    await setSalonsDb(kvUrl, kvToken, []);
    await kvCmd(kvUrl, kvToken, ['DEL', 'bookings']);
    await kvCmd(kvUrl, kvToken, ['DEL', 'push_subscriptions']);

    const lockKeys = await kvCmd(kvUrl, kvToken, ['KEYS', 'lock:*']);
    if (Array.isArray(lockKeys) && lockKeys.length > 0) {
      await kvCmd(kvUrl, kvToken, ['DEL', ...lockKeys]);
    }

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('[RESET-ALL-DATA] Error:', err);
    return res.status(500).json({ error: 'Errore del server, riprova.' });
  }
}
