import webPush from 'web-push';
import { getAllBookings, hsetBooking, getSalonsDb, claimReminderOnce } from '../lib/kv.js';
import { sendCustomerText, twilioConfigured } from '../lib/sms.js';
import { romeNow } from '../lib/time.js';

const VAPID_PUBLIC_KEY = 'BLLKr1SroPRHybfSN2OunQUzy6yd5hggq2fmAmT90LL32Pgyaa_VkoESjUq3DGk0bgD2a5tb17bSZHc2heLJXGo';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY?.trim();
if (VAPID_PRIVATE_KEY) {
  webPush.setVapidDetails('mailto:support@trimio.org', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

// Runs every hour (external cron + vercel.json fallback) and sends two kinds
// of customer reminders, never before 8:00 or after 20:00 Italian time:
//  - the day before: every confirmed booking for "tomorrow" not yet reminded
//    (booking.reminderSent) — goes out at the first run at/after 8:00.
//  - ~3h before: every confirmed booking for "today" whose start time is at
//    most 3 hours away (booking.sameDayReminderSent). For early-morning
//    appointments (e.g. 9:00) it lands at the 8:00 run instead — only 1h
//    before, because of the 8:00 floor.
// A booking never gets more than one reminder per day: the two kinds fire on
// different days, so a customer who booked days ahead gets 2 in total, and a
// same-day booking gets only the ~3h one. The customer receives them only if
// they opted in on the confirmation screen (see initCustomerPushNotifications
// in js/app.js) — the subscription is tied to the bookingId. The *Sent flags
// make each reminder fire at most once even if the cron runs again.

function bookingMinutes(time) {
  const m = /^(\d{1,2}):(\d{2})/.exec(time || '');
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
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

  if (!VAPID_PRIVATE_KEY && !twilioConfigured()) {
    return res.status(200).json({ sent: 0, checked: 0, note: 'Neither VAPID_PRIVATE_KEY nor Twilio configured — reminders skipped.' });
  }

  const kvUrl = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;
  if (!kvUrl || !kvToken) {
    return res.status(500).json({ error: 'KV database not configured' });
  }

  try {
    const now = romeNow();
    if (now.minutes < 8 * 60 || now.minutes >= 20 * 60) {
      return res.status(200).json({ checked: 0, sent: 0, note: 'Outside 8:00-20:00 Europe/Rome — reminders postponed.' });
    }

    const bookingsMap = await getAllBookings(kvUrl, kvToken);
    const all = Array.from(bookingsMap.values());
    const dueTomorrow = all.filter(
      b => b.status === 'confirmed' && b.dateISO === now.tomorrowISO && !b.reminderSent
    );
    const dueToday = all.filter(b => {
      if (b.status !== 'confirmed' || b.dateISO !== now.todayISO || b.sameDayReminderSent) return false;
      const start = bookingMinutes(b.time);
      if (start === null) return false;
      const left = start - now.minutes;
      return left > 0 && left <= 3 * 60;
    });
    const salons = await getSalonsDb(kvUrl, kvToken);

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
    let smsSent = 0;
    let subsChanged = false;

    // Push to every opted-in device; when none succeeds (customer never
    // tapped "Attiva", or the subscription died) fall back to SMS/WhatsApp on
    // the phone number left at booking time — the customer then gets the
    // reminder without ever having confirmed anything.
    const notifyBooking = async (bk, body) => {
      let delivered = 0;
      const targets = VAPID_PRIVATE_KEY ? subscriptions.filter(s => s.role === 'customer' && s.bookingId === bk.id) : [];
      for (const target of targets) {
        try {
          const payload = JSON.stringify({ title: 'Promemoria appuntamento TRIMIO', body, url: '/' });
          await webPush.sendNotification(target.subscription, payload);
          sent++; delivered++;
        } catch (err) {
          if (err.statusCode === 410 || err.statusCode === 404) {
            const idx = subscriptions.findIndex(s => s.subscription.endpoint === target.subscription.endpoint);
            if (idx !== -1) { subscriptions.splice(idx, 1); subsChanged = true; }
          } else {
            console.error('[REMINDER] Failed to send to customer:', err.message);
          }
        }
      }
      if (delivered === 0 && bk.phone) {
        try {
          if (await sendCustomerText(bk.phone, body)) { sent++; smsSent++; }
        } catch (err) {
          console.error('[REMINDER] SMS fallback failed:', err.message);
        }
      }
    };

    for (const bk of dueTomorrow) {
      // Atomic claim before sending — the daily cron and the hourly GitHub
      // Action can both pick up the same due booking in overlapping runs;
      // only whichever wins this SET NX actually sends (see
      // claimReminderOnce in lib/kv.js).
      if (!(await claimReminderOnce(kvUrl, kvToken, bk.id, 'tomorrow'))) continue;
      const salon = salons.find(s => s.id === bk.salonId);
      const firstName = (bk.name || '').trim().split(' ')[0] || 'cliente';
      await notifyBooking(bk, `Gentile ${firstName}! Ti ricordiamo che domani alle ore ${bk.time} hai un appuntamento prenotato con ${bk.workerName}, presso il salone ${salon ? salon.name : 'TRIMIO'}. Grazie per la fiducia!`);
      bk.reminderSent = true;
      await hsetBooking(kvUrl, kvToken, bk);
    }

    for (const bk of dueToday) {
      if (!(await claimReminderOnce(kvUrl, kvToken, bk.id, 'today'))) continue;
      const salon = salons.find(s => s.id === bk.salonId);
      const firstName = (bk.name || '').trim().split(' ')[0] || 'cliente';
      await notifyBooking(bk, `Gentile ${firstName}! Ti ricordiamo il tuo appuntamento di oggi alle ore ${bk.time} con ${bk.workerName}, presso il salone ${salon ? salon.name : 'TRIMIO'}. A presto!`);
      bk.sameDayReminderSent = true;
      await hsetBooking(kvUrl, kvToken, bk);
    }

    if (subsChanged) {
      await fetch(`${kvUrl}/set/push_subscriptions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${kvToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(JSON.stringify(subscriptions))
      });
    }

    return res.status(200).json({ checked: dueTomorrow.length + dueToday.length, sent, smsSent, smsConfigured: twilioConfigured() });
  } catch (err) {
    console.error('[REMINDER] Error:', err);
    return res.status(500).json({ error: 'internal_error' });
  }
}
