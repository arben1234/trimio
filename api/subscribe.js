import { getVerifiedSession } from '../lib/auth.js';
import { getAllBookings } from '../lib/kv.js';

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,POST');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { subscription, role, bookingId } = body;

    if (!subscription || !subscription.endpoint) {
      return res.status(400).json({ error: 'Missing subscription details' });
    }

    const kvUrl = process.env.KV_REST_API_URL;
    const kvToken = process.env.KV_REST_API_TOKEN;

    if (!kvUrl || !kvToken) {
      return res.status(500).json({ error: 'KV Database not configured' });
    }

    // What role/salonId/workerId this subscription is actually trusted to be
    // registered as — NEVER taken from the client-declared fields directly,
    // since anyone could claim role:'admin' or role:'owner'+someone else's
    // salonId to receive live booking notifications meant for that salon.
    let salonId = null;
    let workerId = null;

    if (role === 'admin' || role === 'owner' || role === 'barber') {
      const session = getVerifiedSession(req);
      if (!session || session.role !== role) {
        return res.status(401).json({ error: 'invalid_session' });
      }
      salonId = session.salonId || null;
      workerId = session.workerId || null;
    } else if (role === 'customer') {
      // Lower stakes (tied to one specific booking the customer already
      // knows the id of), but still worth confirming the booking is real
      // before persisting a subscription against it.
      if (!bookingId) return res.status(400).json({ error: 'Missing bookingId' });
      const bookingsMap = await getAllBookings(kvUrl, kvToken);
      if (!bookingsMap.has(bookingId)) {
        return res.status(404).json({ error: 'Booking not found' });
      }
    } else {
      return res.status(400).json({ error: 'invalid_role' });
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
      bookingId: bookingId || null,
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
