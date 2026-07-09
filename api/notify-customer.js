import webPush from 'web-push';
import { getAllBookings, getSalonsDb, checkRateLimit } from '../lib/kv.js';
import { sendCustomerText, twilioConfigured } from '../lib/sms.js';
import { getVerifiedSession } from '../lib/auth.js';

const VAPID_PUBLIC_KEY = 'BLLKr1SroPRHybfSN2OunQUzy6yd5hggq2fmAmT90LL32Pgyaa_VkoESjUq3DGk0bgD2a5tb17bSZHc2heLJXGo';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY?.trim();
if (VAPID_PRIVATE_KEY) {
  webPush.setVapidDetails('mailto:support@trimio.org', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

// Lets a barber send an immediate reminder to one specific client (the
// "🔔 Notifica" button on an appointment card), on top of the automatic
// 24h-before reminder sent daily by api/send-reminders.js. Only works if
// that client opted in on their booking confirmation screen.
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!VAPID_PRIVATE_KEY && !twilioConfigured()) {
    return res.status(200).json({ success: false, reason: 'not_configured' });
  }

  const kvUrl = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;
  if (!kvUrl || !kvToken) {
    return res.status(500).json({ error: 'KV database not configured' });
  }

  // This fires a real SMS/WhatsApp send (Twilio cost) or a push straight to
  // a real customer — only staff for THIS booking's own salon (or admin) may
  // trigger it, and even a legitimate staff member mashing the button
  // shouldn't be able to spam the same customer.
  const session = getVerifiedSession(req);
  if (!session || (session.role !== 'admin' && session.role !== 'owner' && session.role !== 'barber')) {
    return res.status(401).json({ error: 'invalid_session' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { bookingId } = body || {};
    if (!bookingId) return res.status(400).json({ error: 'Missing bookingId' });

    const bookingsMap = await getAllBookings(kvUrl, kvToken);
    const bk = bookingsMap.get(bookingId);
    if (!bk) return res.status(404).json({ error: 'Booking not found' });

    if (session.role !== 'admin' && session.salonId !== bk.salonId) {
      return res.status(403).json({ error: 'forbidden' });
    }

    // Cooldown per booking, not per caller — stops the same customer from
    // being messaged repeatedly regardless of who (or what) is calling.
    const rl = await checkRateLimit(kvUrl, kvToken, `ratelimit:notify-customer:${bookingId}`, 1, 120);
    if (!rl.allowed) {
      return res.status(429).json({ success: false, error: 'rate_limited', reason: 'Attendi qualche minuto prima di inviare un altro promemoria a questo cliente.' });
    }

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

    const salons = await getSalonsDb(kvUrl, kvToken);
    const salon = salons.find(s => s.id === bk.salonId);
    const firstName = (bk.name || '').trim().split(' ')[0] || 'cliente';
    const msgBody = `Gentile ${firstName}! Ti ricordiamo il tuo appuntamento il ${bk.dateLabel || bk.dateISO} alle ore ${bk.time} con ${bk.workerName}, presso il salone ${salon ? salon.name : 'TRIMIO'}. Grazie per la fiducia!`;

    const targets = VAPID_PRIVATE_KEY ? subscriptions.filter(s => s.role === 'customer' && s.bookingId === bookingId) : [];

    // No push opt-in but a phone number on the booking: reach the customer
    // via SMS/WhatsApp instead of giving up with "Cliente non iscritto".
    if (targets.length === 0) {
      if (bk.phone && await sendCustomerText(bk.phone, msgBody)) {
        return res.status(200).json({ success: true, sent: 1, via: 'sms' });
      }
      return res.status(200).json({ success: false, reason: 'no_subscription' });
    }

    const payload = JSON.stringify({ title: 'Promemoria appuntamento TRIMIO', body: msgBody, url: '/' });

    let sent = 0;
    for (const target of targets) {
      try {
        await webPush.sendNotification(target.subscription, payload);
        sent++;
      } catch (err) {
        console.error('[NOTIFY-CUSTOMER] Failed to send:', err.message);
      }
    }

    // Every push attempt failed (dead subscriptions) — SMS as last resort.
    if (sent === 0 && bk.phone && await sendCustomerText(bk.phone, msgBody)) {
      return res.status(200).json({ success: true, sent: 1, via: 'sms' });
    }

    return res.status(200).json({ success: sent > 0, sent });
  } catch (err) {
    console.error('[NOTIFY-CUSTOMER] Error:', err);
    return res.status(500).json({ error: 'Errore del server, riprova.' });
  }
}
