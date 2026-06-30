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
    const { subscription, role, salonId, workerId } = body;

    if (!subscription || !subscription.endpoint) {
      return res.status(400).json({ error: 'Missing subscription details' });
    }

    const kvUrl = process.env.KV_REST_API_URL;
    const kvToken = process.env.KV_REST_API_TOKEN;

    if (!kvUrl || !kvToken) {
      return res.status(500).json({ error: 'KV Database not configured' });
    }

    // 1. Get current subscriptions
    const getResp = await fetch(`${kvUrl}/get/push_subscriptions`, {
      headers: { Authorization: `Bearer ${kvToken}` }
    });
    let subscriptions = [];
    if (getResp.ok) {
      const resData = await getResp.json();
      if (resData.result) {
        let val = JSON.parse(resData.result);
        if (typeof val === 'string') val = JSON.parse(val);
        if (Array.isArray(val)) subscriptions = val;
      }
    }

    // 2. Remove duplicates by endpoint
    subscriptions = subscriptions.filter(s => s.subscription.endpoint !== subscription.endpoint);

    // 3. Add new subscription
    subscriptions.push({
      subscription,
      role: role || null,
      salonId: salonId || null,
      workerId: workerId || null,
      updatedAt: new Date().toISOString()
    });

    // Limit subscriptions list to 200 items to avoid KV storage size limits
    if (subscriptions.length > 200) {
      subscriptions = subscriptions.slice(-200);
    }

    // 4. Save back to KV
    const setResp = await fetch(`${kvUrl}/set/push_subscriptions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${kvToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(JSON.stringify(subscriptions))
    });

    if (!setResp.ok) throw new Error('Failed to save subscription in KV');

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error('[SUBSCRIBE] Error:', error);
    return res.status(500).json({ error: error.message });
  }
}
