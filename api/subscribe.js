import { getVerifiedSession, getClientIp } from '../lib/auth.js';
import { getAllBookings, checkRateLimit, acquirePushSubsLock, releasePushSubsLock } from '../lib/kv.js';
import { toE164 } from '../lib/sms.js';

export default async function handler(req, res) {
  // CORS. Allow-Credentials:true + a wildcard origin is a real (if inert)
  // misconfiguration — this app never uses cookies for auth (Bearer-token
  // only), so it served no purpose. See api/sync.js's handler for detail.
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
    const rawBody = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    // An empty/missing request body leaves req.body undefined — destructuring
    // it would throw and fall into the generic 500 below instead of a clean
    // 400, same as a malformed JSON body.
    const body = rawBody && typeof rawBody === 'object' ? rawBody : null;
    if (!body) return res.status(400).json({ error: 'Missing request body' });
    const { subscription, role, bookingId } = body;

    if (!subscription || !subscription.endpoint) {
      return res.status(400).json({ error: 'Missing subscription details' });
    }

    const kvUrl = process.env.KV_REST_API_URL;
    const kvToken = process.env.KV_REST_API_TOKEN;

    if (!kvUrl || !kvToken) {
      return res.status(500).json({ error: 'KV Database not configured' });
    }

    // Caps mass-registration (e.g. scripting many fake customer
    // subscriptions against guessed bookingIds to evict real ones from the
    // 200-item cap below) without affecting normal use — one real
    // device/session re-subscribes far less than this per hour.
    const rl = await checkRateLimit(kvUrl, kvToken, `ratelimit:subscribe:${getClientIp(req)}`, 30, 3600);
    if (!rl.allowed) {
      return res.status(429).json({ error: 'rate_limited' });
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
      // Booking ids aren't secret — the anonymous GET /api/sync response
      // hands every id out to anyone viewing a salon's page (name/phone
      // stripped, but not the id itself), needed for slot-availability
      // rendering. Confirming the booking merely EXISTS let anyone who
      // scraped/enumerated a salon's ids register their own device against
      // a stranger's real appointment — every cancellation/reminder push
      // for it (customer's first name, date/time, salon) would then go
      // straight to the attacker instead. Requires the same phone-number
      // proof the customer self-cancel path already holds callers to.
      if (!bookingId) return res.status(400).json({ error: 'Missing bookingId' });
      const bookingsMap = await getAllBookings(kvUrl, kvToken);
      const booking = bookingsMap.get(bookingId);
      if (!booking) {
        return res.status(404).json({ error: 'Booking not found' });
      }
      const claimedPhone = toE164(body.phone);
      if (!booking.phone || !claimedPhone || toE164(booking.phone) !== claimedPhone) {
        return res.status(403).json({ error: 'phone_mismatch' });
      }
    } else {
      return res.status(400).json({ error: 'invalid_role' });
    }

    // This whole read-modify-write must not interleave with another writer
    // of the same blob (send-reminders.js pruning a dead endpoint, or another
    // concurrent subscribe call) — see acquirePushSubsLock's comment in lib/kv.js.
    const locked = await acquirePushSubsLock(kvUrl, kvToken);
    if (!locked) return res.status(503).json({ error: 'busy' });
    try {
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
    } finally {
      await releasePushSubsLock(kvUrl, kvToken);
    }
  } catch (error) {
    console.error('[SUBSCRIBE] Error:', error);
    return res.status(500).json({ error: 'Errore del server, riprova.' });
  }
}
