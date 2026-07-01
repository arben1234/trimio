import { getSalonsDb, setSalonsDb, ensureMigratedV2 } from '../lib/kv.js';

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,POST');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const salonId = body.salonId;
    const setInactive = body.inactive; // true or false

    if (!salonId) {
      return res.status(400).json({ error: 'Missing salonId' });
    }

    console.log(`[TOGGLE] salonId=${salonId}, inactive=${setInactive}`);

    const kvUrl = process.env.KV_REST_API_URL;
    const kvToken = process.env.KV_REST_API_TOKEN;

    // PRIMARY: Vercel KV (Redis)
    if (kvUrl && kvToken) {
      await ensureMigratedV2(kvUrl, kvToken);
      const salons = await getSalonsDb(kvUrl, kvToken);

      // Find and toggle the salon
      let found = false;
      const salon = salons.find(s => s.id === salonId);
      if (salon) {
        salon.inactive = !!setInactive;
        found = true;
        console.log(`[TOGGLE] Found salon "${salon.name}", set inactive=${salon.inactive}`);
      }

      if (!found) {
        return res.status(404).json({ error: 'Salon not found', salonId });
      }

      // Save back to KV
      await setSalonsDb(kvUrl, kvToken, salons);

      return res.status(200).json({ success: true, salonId, inactive: setInactive });
    }

    // FALLBACK
    return res.status(403).json({
      error: 'database_suspended',
      message: 'Il database Vercel Blob è stato sospeso. Per riattivare, collega un database Vercel KV.'
    });
  } catch (error) {
    console.error('[TOGGLE] Error:', error);
    return res.status(500).json({ error: error.message });
  }
}
