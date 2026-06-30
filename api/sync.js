import webPush from 'web-push';

// Configure VAPID keys
webPush.setVapidDetails(
  'mailto:trimio@example.com',
  'BLLKr1SroPRHybfSN2OunQUzy6yd5hggq2fmAmT90LL32Pgyaa_VkoESjUq3DGk0bgD2a5tb17bSZHc2heLJXGo',
  'iqo5UL6ad--48RpYjCDoGRDukEnBZHY9oUJRlLi98A4'
);

export default async function handler(req, res) {
  // CORS configuration
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
  );

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  console.log(`[SYNC] ${req.method} request received`);

  const kvUrl = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;

  // PRIMARY DATABASE: Vercel KV (Redis)
  if (kvUrl && kvToken) {
    try {
      if (req.method === 'GET') {
        console.log('[SYNC] Reading database state from Vercel KV');
        const resp = await fetch(`${kvUrl}/get/bookings_db`, {
          headers: { Authorization: `Bearer ${kvToken}` }
        });
        if (!resp.ok) throw new Error(`KV error: ${resp.statusText}`);
        const resData = await resp.json();
        let data = resData.result ? JSON.parse(resData.result) : { bookings: [], salons: [] };
        if (typeof data === 'string') {
          data = JSON.parse(data);
        }
        return res.status(200).json(data);
      }

      if (req.method === 'POST') {
        const body = req.body;
        const newData = typeof body === 'string' ? JSON.parse(body) : body;
        console.log('[SYNC] Saving database state to Vercel KV');

        // 1. Fetch current (old) state to detect new bookings
        const getOldResp = await fetch(`${kvUrl}/get/bookings_db`, {
          headers: { Authorization: `Bearer ${kvToken}` }
        });
        let oldData = { bookings: [], salons: [] };
        if (getOldResp.ok) {
          const oldResData = await getOldResp.json();
          if (oldResData.result) {
            oldData = JSON.parse(oldResData.result);
            if (typeof oldData === 'string') oldData = JSON.parse(oldData);
          }
        }

        // 2. Detect newly created bookings
        const oldBks = oldData.bookings || [];
        const newBks = newData.bookings || [];
        const addedBks = newBks.filter(nb => nb.status !== 'cancelled' && !oldBks.some(ob => ob.id === nb.id));

        // 3. Save new state to KV
        const resp = await fetch(`${kvUrl}/set/bookings_db`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${kvToken}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(JSON.stringify(newData))
        });
        if (!resp.ok) throw new Error(`KV error: ${resp.statusText}`);

        // 4. Send background push notifications asynchronously if there are new bookings
        if (addedBks.length > 0) {
          console.log(`[SYNC] Found ${addedBks.length} new bookings. Triggering push notifications...`);
          // Start push job in background (do not block client response)
          sendPushNotifications(addedBks, kvUrl, kvToken).catch(err => {
            console.error('[SYNC] Push notifications job error:', err);
          });
        }

        return res.status(200).json({ success: true });
      }
    } catch (kvErr) {
      console.error('[SYNC] KV Database Error:', kvErr);
      return res.status(500).json({ error: kvErr.message });
    }
  }

  // FALLBACK: Return error explaining Vercel Blob store suspension
  console.warn('[SYNC] KV database is not configured. Vercel Blob is suspended.');
  return res.status(403).json({
    error: 'database_suspended',
    message: 'Il database Vercel Blob è stato sospeso. Collega Vercel KV.'
  });
}

// Function to send web push notifications to all matching active subscriptions
async function sendPushNotifications(newBookings, kvUrl, kvToken) {
  try {
    // 1. Fetch all push subscriptions
    const subResp = await fetch(`${kvUrl}/get/push_subscriptions`, {
      headers: { Authorization: `Bearer ${kvToken}` }
    });
    if (!subResp.ok) return;
    const subResData = await subResp.json();
    if (!subResData.result) return;
    let subscriptions = JSON.parse(subResData.result);
    if (typeof subscriptions === 'string') subscriptions = JSON.parse(subscriptions);
    if (!Array.isArray(subscriptions) || subscriptions.length === 0) return;

    let subListChanged = false;
    const activeSubs = [...subscriptions];

    for (const bk of newBookings) {
      const title = `Nuova Prenotazione: ${bk.name}`;
      const body = `${bk.workerName} - ${bk.service} il ${bk.dateLabel} alle ${bk.time}`;
      
      const payload = JSON.stringify({
        title,
        body,
        url: `/#DASHBOARD` // Take user to dashboard upon clicking
      });

      // Filter subscriptions that should receive notification for this booking:
      // - Admin receives all
      // - Owner of this salon receives it
      // - Barber receives it if they are the one booked
      const targets = activeSubs.filter(sub => {
        if (sub.role === 'owner' && sub.salonId === bk.salonId) return true;
        if (sub.role === 'barber' && sub.workerId === bk.workerId) return true;
        return false;
      });

      console.log(`[PUSH] Sending notifications for booking "${bk.id}" to ${targets.length} targets`);

      for (const target of targets) {
        try {
          await webPush.sendNotification(target.subscription, payload);
          console.log(`[PUSH] Sent to ${target.role} (${target.subscription.endpoint.slice(0, 30)}...)`);
        } catch (err) {
          // If subscription is invalid/expired (410 Gone or 404 Not Found), remove it
          if (err.statusCode === 410 || err.statusCode === 404) {
            console.log(`[PUSH] Removing expired subscription for ${target.role}`);
            const idx = subscriptions.findIndex(s => s.subscription.endpoint === target.subscription.endpoint);
            if (idx !== -1) {
              subscriptions.splice(idx, 1);
              subListChanged = true;
            }
          } else {
            console.error('[PUSH] Failed to send to target:', err.message);
          }
        }
      }
    }

    // 2. Save cleaned subscription list back to KV if changed
    if (subListChanged) {
      await fetch(`${kvUrl}/set/push_subscriptions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${kvToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(JSON.stringify(subscriptions))
      });
    }
  } catch (err) {
    console.error('[PUSH] error:', err);
  }
}
