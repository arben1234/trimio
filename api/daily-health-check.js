import webPush from 'web-push';
import { getAllBookings, getSalonsDb } from '../lib/kv.js';

const VAPID_PUBLIC_KEY = 'BLLKr1SroPRHybfSN2OunQUzy6yd5hggq2fmAmT90LL32Pgyaa_VkoESjUq3DGk0bgD2a5tb17bSZHc2heLJXGo';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY?.trim();
if (VAPID_PRIVATE_KEY) {
  webPush.setVapidDetails('mailto:trimio@example.com', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

// Daily self-check (vercel.json cron, ~7:30 Italy time). Verifies the parts
// of the system that fail silently — database, salons, reminder delivery,
// push subscriptions, the dynamic manifest — and sends ONE web-push to every
// admin-role subscription ONLY when problems are found. A quiet morning
// means everything passed (the full report is still in the JSON response,
// visible from the Vercel cron logs).
function romeYesterdayISO() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date());
  const get = t => Number(parts.find(p => p.type === t).value);
  const prev = new Date(Date.UTC(get('year'), get('month') - 1, get('day')) - 86400000);
  const pad = n => String(n).padStart(2, '0');
  return `${prev.getUTCFullYear()}-${pad(prev.getUTCMonth() + 1)}-${pad(prev.getUTCDate())}`;
}

export default async function handler(req, res) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = req.headers['authorization'];
    if (auth !== `Bearer ${cronSecret}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  const problems = [];
  const report = {};
  const kvUrl = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;
  const host = req.headers.host || 'trimio-two.vercel.app';
  const base = `${/^(localhost|127\.)/.test(host) ? 'http' : 'https'}://${host}`;

  if (!VAPID_PRIVATE_KEY) problems.push('VAPID_PRIVATE_KEY mancante: nessuna notifica push può partire');
  if (!kvUrl || !kvToken) {
    problems.push('Database KV non configurato');
    return res.status(200).json({ problems, report, notified: 0 });
  }

  // 1. Database + salons
  let salons = [];
  try {
    salons = await getSalonsDb(kvUrl, kvToken);
    report.salons = salons.length;
    if (!salons.length) problems.push('Nessun salone nel database cloud');
  } catch (e) {
    problems.push(`Database non raggiungibile: ${e.message}`);
  }

  // 2. Bookings integrity + reminder delivery for yesterday
  try {
    const bookings = Array.from((await getAllBookings(kvUrl, kvToken)).values());
    report.bookings = bookings.length;
    const yISO = romeYesterdayISO();
    const missedReminders = bookings.filter(b => {
      if (b.status !== 'confirmed' || b.dateISO !== yISO || b.reminderSent || b.sameDayReminderSent) return false;
      // Booked less than ~3.5h before the appointment (or after it): no
      // reminder was ever due — flagging it would be a daily false alarm.
      const m = /^(\d{1,2}):(\d{2})/.exec(b.time || '');
      if (m && b.createdAt) {
        const parts = new Intl.DateTimeFormat('en-GB', {
          timeZone: 'Europe/Rome', hourCycle: 'h23',
          year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
        }).formatToParts(new Date(b.createdAt));
        const get = t => parts.find(p => p.type === t).value;
        const createdISO = `${get('year')}-${get('month')}-${get('day')}`;
        const createdMin = Number(get('hour')) * 60 + Number(get('minute'));
        const startMin = Number(m[1]) * 60 + Number(m[2]);
        if (createdISO >= b.dateISO && (createdISO > b.dateISO || startMin - createdMin < 210)) return false;
      }
      return true;
    });
    report.missedReminders = missedReminders.length;
    if (missedReminders.length) {
      problems.push(`${missedReminders.length} prenotazioni di ieri (${yISO}) senza alcun promemoria inviato`);
    }
    const malformed = bookings.filter(b => !/^\d{4}-\d{2}-\d{2}$/.test(b.dateISO || '') || !/^\d{1,2}:\d{2}/.test(b.time || ''));
    if (malformed.length) problems.push(`${malformed.length} prenotazioni con data/ora non valide`);
  } catch (e) {
    problems.push(`Lettura prenotazioni fallita: ${e.message}`);
  }

  // 3. Push subscriptions readable + at least one admin device registered
  let subscriptions = [];
  try {
    const subResp = await fetch(`${kvUrl}/get/push_subscriptions`, { headers: { Authorization: `Bearer ${kvToken}` } });
    if (subResp.ok) {
      const subData = await subResp.json();
      if (subData.result) {
        let val = JSON.parse(subData.result);
        if (typeof val === 'string') val = JSON.parse(val);
        if (Array.isArray(val)) subscriptions = val;
      }
    }
    report.adminSubscriptions = subscriptions.filter(s => s.role === 'admin').length;
    if (!report.adminSubscriptions) problems.push('Nessun dispositivo admin registrato per le notifiche push');
  } catch (e) {
    problems.push(`Lettura sottoscrizioni push fallita: ${e.message}`);
  }

  // 4. Homepage + dynamic manifest respond correctly
  try {
    const home = await fetch(`${base}/`, { cache: 'no-store' });
    const html = home.ok ? await home.text() : '';
    if (!home.ok) problems.push(`Homepage risponde ${home.status}`);
    else if (!html.includes('app.min.js')) problems.push('Homepage senza lo script applicativo (app.min.js)');
  } catch (e) {
    problems.push(`Homepage non raggiungibile: ${e.message}`);
  }
  try {
    const mf = await fetch(`${base}/api/manifest?start=${encodeURIComponent('/?s=HEALTHCHECK')}`);
    const mfJson = mf.ok ? await mf.json() : null;
    if (!mf.ok || !mfJson || mfJson.start_url !== '/?s=HEALTHCHECK') {
      problems.push(`Manifest dinamico non valido (HTTP ${mf.status})`);
    }
  } catch (e) {
    problems.push(`Manifest dinamico non raggiungibile: ${e.message}`);
  }

  // Notify every admin device — only when something is wrong
  let notified = 0;
  if (problems.length && VAPID_PRIVATE_KEY) {
    const targets = subscriptions.filter(s => s.role === 'admin');
    const body = `Controllo delle 7:30 — ${problems.length} problem${problems.length === 1 ? 'a' : 'i'}:\n• ` + problems.slice(0, 4).join('\n• ');
    const payload = JSON.stringify({ title: '⚠️ TRIMIO — Controllo giornaliero', body, url: '/' });
    for (const target of targets) {
      try {
        await webPush.sendNotification(target.subscription, payload);
        notified++;
      } catch (err) {
        console.error('[HEALTH] push to admin failed:', err.message);
      }
    }
  }

  return res.status(200).json({ ok: problems.length === 0, problems, report, notified });
}
