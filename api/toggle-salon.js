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
      const getResp = await fetch(`${kvUrl}/get/bookings_db`, {
        headers: { Authorization: `Bearer ${kvToken}` }
      });
      if (!getResp.ok) throw new Error(`KV error: ${getResp.statusText}`);
      const resData = await getResp.json();
      let data = resData.result ? JSON.parse(resData.result) : { bookings: [], salons: [] };
      if (typeof data === 'string') {
        data = JSON.parse(data);
      }

      // Find and toggle the salon
      let found = false;
      if (data.salons && Array.isArray(data.salons)) {
        const salon = data.salons.find(s => s.id === salonId);
        if (salon) {
          salon.inactive = !!setInactive;
          found = true;
          console.log(`[TOGGLE] Found salon "${salon.name}", set inactive=${salon.inactive}`);
        }
      }

      if (!found) {
        return res.status(404).json({ error: 'Salon not found', salonId });
      }

      // Save back to KV
      const setResp = await fetch(`${kvUrl}/set/bookings_db`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${kvToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(JSON.stringify(data))
      });
      if (!setResp.ok) throw new Error(`KV error: ${setResp.statusText}`);

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
