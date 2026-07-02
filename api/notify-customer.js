import webPush from 'web-push';
import { getAllBookings, getSalonsDb } from '../lib/kv.js';

const VAPID_PUBLIC_KEY = 'BLLKr1SroPRHybfSN2OunQUzy6yd5hggq2fmAmT90LL32Pgyaa_VkoESjUq3DGk0bgD2a5tb17bSZHc2heLJXGo';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY?.trim();
if (VAPID_PRIVATE_KEY) {
  webPush.setVapidDetails('mailto:trimio@example.com', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

// Lets a barber send an immediate reminder to one specific client (the
// "🔔 Notifica" button on an appointment card), on top of the automatic
// 24h-before reminder sent daily by api/send-reminders.js. Only works if
// that client opted in on their booking confirmation screen.
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!VAPID_PRIVATE_KEY) {
    return res.status(200).json({ success: false, reason: 'not_configured' });
  }

  const kvUrl = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;
  if (!kvUrl || !kvToken) {
    return res.status(500).json({ error: 'KV database not configured' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { bookingId } = body || {};
    if (!bookingId) return res.status(400).json({ error: 'Missing bookingId' });

    const bookingsMap = await getAllBookings(kvUrl, kvToken);
    const bk = bookingsMap.get(bookingId);
    if (!bk) return res.status(404).json({ error: 'Booking not found' });

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

    const targets = subscriptions.filter(s => s.role === 'customer' && s.bookingId === bookingId);
    if (targets.length === 0) {
      return res.status(200).json({ success: false, reason: 'no_subscription' });
    }

    const salons = await getSalonsDb(kvUrl, kvToken);
    const salon = salons.find(s => s.id === bk.salonId);
    const firstName = (bk.name || '').trim().split(' ')[0] || 'cliente';
    const payload = JSON.stringify({
      title: 'Promemoria appuntamento TRIMIO',
      body: `Gentile ${firstName}! Ti ricordiamo il tuo appuntamento il ${bk.dateLabel || bk.dateISO} alle ore ${bk.time} con ${bk.workerName}, presso il salone ${salon ? salon.name : 'TRIMIO'}. Grazie per la fiducia!`,
      url: '/'
    });

    let sent = 0;
    for (const target of targets) {
      try {
        await webPush.sendNotification(target.subscription, payload);
        sent++;
      } catch (err) {
        console.error('[NOTIFY-CUSTOMER] Failed to send:', err.message);
      }
    }

    return res.status(200).json({ success: sent > 0, sent });
  } catch (err) {
    console.error('[NOTIFY-CUSTOMER] Error:', err);
    return res.status(500).json({ error: err.message });
  }
}
