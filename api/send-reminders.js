import webPush from 'web-push';
import { getAllBookings, hsetBooking } from '../lib/kv.js';

const VAPID_PUBLIC_KEY = 'BLLKr1SroPRHybfSN2OunQUzy6yd5hggq2fmAmT90LL32Pgyaa_VkoESjUq3DGk0bgD2a5tb17bSZHc2heLJXGo';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY?.trim();
if (VAPID_PRIVATE_KEY) {
  webPush.setVapidDetails('mailto:trimio@example.com', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

// Runs once a day (see vercel.json crons) — finds every confirmed booking
// scheduled for "tomorrow" (relative to whenever the cron fires) that hasn't
// been reminded yet, and sends a push notification to the customer if they
// opted in on the confirmation screen (see initCustomerPushNotifications in
// js/app.js). Marks booking.reminderSent so a booking is only ever reminded
// once, even if the cron runs more than once in a day.
function tomorrowISO() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export default async function handler(req, res) {
  // Vercel Cron requests already carry this header automatically; if a
  // CRON_SECRET is configured, also accept a matching Authorization header
  // so the endpoint can't be triggered by anyone who finds the URL.
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = req.headers['authorization'];
    if (auth !== `Bearer ${cronSecret}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  if (!VAPID_PRIVATE_KEY) {
    return res.status(200).json({ sent: 0, checked: 0, note: 'VAPID_PRIVATE_KEY not configured — reminders skipped.' });
  }

  const kvUrl = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;
  if (!kvUrl || !kvToken) {
    return res.status(500).json({ error: 'KV database not configured' });
  }

  try {
    const target = tomorrowISO();
    const bookingsMap = await getAllBookings(kvUrl, kvToken);
    const dueBookings = Array.from(bookingsMap.values()).filter(
      b => b.status === 'confirmed' && b.dateISO === target && !b.reminderSent
    );

    let subscriptions = [];
    const subResp = await fetch(`${kvUrl}/get/push_subscriptions`, { headers: { Authorization: `Bearer ${kvToken}` } });
    if (subResp.ok) {
      const subData = await subResp.json();
      if (subData.result) {
        let val = JSON.parse(subData.result);
        if (typeof val === 'string') val = JSON.parse(val);
        if (Array.isArray(val)) subscriptions = val;
      }
    }

    let sent = 0;
    let subsChanged = false;
    for (const bk of dueBookings) {
      const targets = subscriptions.filter(s => s.role === 'customer' && s.bookingId === bk.id);
      for (const target of targets) {
        try {
          const payload = JSON.stringify({
            title: 'Promemoria appuntamento TRIMIO',
            body: `Domani alle ${bk.time} da ${bk.workerName} — ${bk.service}`,
            url: '/'
          });
          await webPush.sendNotification(target.subscription, payload);
          sent++;
        } catch (err) {
          if (err.statusCode === 410 || err.statusCode === 404) {
            const idx = subscriptions.findIndex(s => s.subscription.endpoint === target.subscription.endpoint);
            if (idx !== -1) { subscriptions.splice(idx, 1); subsChanged = true; }
          } else {
            console.error('[REMINDER] Failed to send to customer:', err.message);
          }
        }
      }
      bk.reminderSent = true;
      await hsetBooking(kvUrl, kvToken, bk);
    }

    if (subsChanged) {
      await fetch(`${kvUrl}/set/push_subscriptions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${kvToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(JSON.stringify(subscriptions))
      });
    }

    return res.status(200).json({ checked: dueBookings.length, sent });
  } catch (err) {
    console.error('[REMINDER] Error:', err);
    return res.status(500).json({ error: err.message });
  }
}
