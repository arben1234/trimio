import webPush from 'web-push';
import { put, list, del } from '@vercel/blob';
import { getAllBookings, getSalonsDb, setSalonsDb, getAdminDb, getBlob, setBlob, acquireBillingLock, releaseBillingLock } from '../lib/kv.js';
import { twilioConfigured } from '../lib/sms.js';
import { sendEmail, escapeHtml } from '../lib/email.js';
import { feeForWorkerCount } from '../lib/billing.js';

const VAPID_PUBLIC_KEY = 'BLLKr1SroPRHybfSN2OunQUzy6yd5hggq2fmAmT90LL32Pgyaa_VkoESjUq3DGk0bgD2a5tb17bSZHc2heLJXGo';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY?.trim();
if (VAPID_PRIVATE_KEY) {
  webPush.setVapidDetails('mailto:support@trimio.org', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

// Daily self-check (vercel.json cron, ~7:30 Italy time). Verifies the parts
// of the system that fail silently — database, salons, reminder delivery,
// push subscriptions, the dynamic manifest — and sends ONE web-push to every
// admin-role subscription ONLY when problems are found, and at most ONCE per
// Rome calendar day regardless of how many times this endpoint runs that day
// (manual checks, retries, etc.) — see health_check_notified_date below. A
// quiet morning means everything passed (the full report is still in the
// JSON response, visible from the Vercel cron logs).
function romeYesterdayISO() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date());
  const get = t => Number(parts.find(p => p.type === t).value);
  const prev = new Date(Date.UTC(get('year'), get('month') - 1, get('day')) - 86400000);
  const pad = n => String(n).padStart(2, '0');
  return `${prev.getUTCFullYear()}-${pad(prev.getUTCMonth() + 1)}-${pad(prev.getUTCDate())}`;
}
function romeTodayISO() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date());
  const get = t => parts.find(p => p.type === t).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export default async function handler(req, res) {
  const cronSecret = process.env.CRON_SECRET;
  // If CRON_SECRET isn't configured at all (not documented among this
  // project's required env vars — easy to have skipped), this used to fall
  // through as fully open: any anonymous caller got back the full
  // response, including real salon names tied to unpaid/failed billing
  // status (report.problems) and platform-wide counts (bookings, admin
  // device registrations) — a genuine cross-tenant business-data leak, not
  // just a theoretical one. Rather than reject the request outright (which
  // could break the real Vercel cron / GitHub Action if CRON_SECRET
  // genuinely isn't set there either — this endpoint's actual health-check/
  // suspend/notify side effects must keep running regardless), only the
  // detailed RESPONSE BODY is gated below; Vercel's own cron scheduler
  // never reads the response body, so this can't break the real job.
  const isAuthenticated = !!cronSecret && req.headers['authorization'] === `Bearer ${cronSecret}`;
  if (cronSecret && !isAuthenticated) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const problems = [];
  const report = {};
  const kvUrl = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;
  const host = req.headers.host || 'trimio.org';
  const base = `${/^(localhost|127\.)/.test(host) ? 'http' : 'https'}://${host}`;

  if (!VAPID_PRIVATE_KEY) problems.push('VAPID_PRIVATE_KEY mancante: nessuna notifica push può partire');
  report.smsConfigured = twilioConfigured();
  if (!kvUrl || !kvToken) {
    problems.push('Database KV non configurato');
    return res.status(200).json(isAuthenticated ? { problems, report, notified: 0 } : { ok: false, notified: 0 });
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
    // The "bookings" KV hash has no pagination/archiving — every GET (every
    // 6s per open client tab) and POST does a full HGETALL across ALL
    // salons' entire booking history (lib/kv.js getAllBookings), with cost
    // scaling with total platform volume, not per-salon. Currently
    // negligible; this is an early-warning tripwire so growth into a real
    // performance problem gets noticed proactively instead of silently,
    // long before it's large enough to matter.
    if (bookings.length > 8000) {
      problems.push(`La tabella prenotazioni ha ${bookings.length} righe, senza archiviazione automatica — le performance di sincronizzazione potrebbero iniziare a risentirne; valuta di archiviare le prenotazioni più vecchie.`);
    }
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

  // 5. Daily off-Upstash backup. Every salon/worker/booking/review lives in
  // exactly one Upstash Redis instance with no independent copy anywhere —
  // if that instance were ever accidentally wiped, hit a plan limit, or lost
  // data in an Upstash-side incident, there would be no way back. This
  // writes one JSON snapshot per day to Vercel Blob storage (a completely
  // separate service/account boundary from Upstash) as the recovery path.
  // Credentials are deliberately never included: a real restore already
  // needs the admin to reset owner/barber passwords by hand (the existing
  // 🔑 reset-to-default flow), which is a far smaller cost than a plaintext
  // password dump sitting in a backup file.
  try {
    const blobToken = process.env.BLOB_READ_WRITE_TOKEN;
    if (!blobToken) {
      problems.push('Backup non eseguito: BLOB_READ_WRITE_TOKEN non configurato');
    } else {
      const backupSalons = salons.map(({ ownerPassword, workers, ...rest }) => ({
        ...rest,
        workers: (workers || []).map(({ password, ...w }) => w)
      }));
      const backupBookings = Array.from((await getAllBookings(kvUrl, kvToken)).values());
      const admin = await getAdminDb(kvUrl, kvToken);
      const snapshot = {
        exportedAt: new Date().toISOString(),
        adminUsername: admin.username,
        salons: backupSalons,
        bookings: backupBookings
      };
      const todayISO = romeTodayISO();
      await put(`backups/trimio-${todayISO}.json`, JSON.stringify(snapshot), {
        access: 'public',
        contentType: 'application/json',
        token: blobToken
      });
      report.backupSalons = backupSalons.length;
      report.backupBookings = backupBookings.length;

      // Retention: keep the last ~35 days, delete anything older so this
      // doesn't grow forever — a month of daily snapshots is plenty to
      // recover from any realistic incident without unbounded storage cost.
      try {
        const { blobs } = await list({ prefix: 'backups/trimio-', token: blobToken });
        const cutoff = Date.now() - 35 * 24 * 60 * 60 * 1000;
        const stale = blobs.filter(b => new Date(b.uploadedAt).getTime() < cutoff);
        if (stale.length) await del(stale.map(b => b.url), { token: blobToken });
      } catch (e) {
        console.error('[HEALTH] Backup retention cleanup failed:', e.message);
      }
    }
  } catch (e) {
    problems.push(`Backup giornaliero fallito: ${e.message}`);
  }

  // 6. Monthly billing for self-signed-up salons. Every salon with a
  // `billing` object (only self-service signups have one — admin-created
  // salons are untouched by this) that isn't still pending admin approval
  // gets a daily warning email from the 2nd of the month if that month's fee
  // isn't marked paid, and is auto-suspended (same `inactive` flag the admin
  // toggle uses) if still unpaid from the 6th onward. `lastWarningEmailSentDate`
  // gates this to once/day per salon even if this endpoint runs more than
  // once the same day (manual retrigger, etc.) — same idempotency shape as
  // health_check_notified_date below.
  try {
    const todayISO = romeTodayISO();
    const currentMonth = todayISO.slice(0, 7);
    const dayOfMonth = Number(todayISO.slice(8, 10));
    // `salons` was fetched once, several awaited network calls (homepage
    // fetch, manifest fetch, the daily Vercel Blob backup) ago — mutating
    // that same stale in-memory array and writing it all back in one
    // setSalonsDb call at the end (as this used to) could silently discard
    // a webhook event that landed for any of these salons' billing in the
    // meantime. Each salon that actually needs a change now gets its own
    // locked, freshly-re-read write instead — more KV calls, but this is a
    // once-a-day cron, not a hot path, so correctness wins over efficiency.
    for (const salon of salons) {
      if (!salon.billing || salon.billing.pendingApproval) continue;
      // Autopay salons' suspend/reactivate lifecycle is fully handled by
      // api/paypal-webhook.js (payment confirmation, active suspension on
      // final retry failure) — this manual warning/suspend track stays
      // bank-transfer-only. But that leaves admin with ZERO automated
      // visibility into whether an autopay salon's recurring charge is
      // actually landing at all: a missed/undelivered webhook event (network
      // blip, PayPal outage, a bug) would leave paidThroughMonth silently
      // stale forever, with nothing else ever re-checking it. Surface it as
      // a regular health-check problem (admin already gets pushed once/day
      // when problems.length > 0) instead of full silence — this doesn't
      // touch inactive/billing state, purely a visibility flag. Gated to the
      // last week of the month: a subscription's billing anchor is its
      // signup day, not the 1st, so paidThroughMonth legitimately still
      // shows last month for most of this one — checking only once nearly
      // every anchor day should have already fired avoids a daily false
      // alarm for every autopay salon that didn't sign up on the 1st.
      if (salon.billing.autopay) {
        if (!salon.inactive && dayOfMonth >= 25 && salon.billing.paidThroughMonth < currentMonth) {
          problems.push(`Salone "${salon.name}": pagamento automatico non confermato per ${currentMonth} (ultimo mese pagato: ${salon.billing.paidThroughMonth || 'mai'})`);
        }
        continue;
      }
      if (salon.billing.paidThroughMonth >= currentMonth) continue; // paid up

      if (dayOfMonth >= 2 && dayOfMonth <= 5) {
        if (salon.billing.lastWarningEmailSentDate === todayISO) continue;
        const locked = await acquireBillingLock(kvUrl, kvToken, salon.id);
        if (!locked) continue; // try again on tomorrow's run rather than write unprotected
        try {
          const freshSalons = await getSalonsDb(kvUrl, kvToken);
          const freshSalon = freshSalons.find(s => s.id === salon.id);
          // Re-check under lock — a webhook may have already resolved this
          // (or already sent today's warning) in the time since the
          // unlocked snapshot at the top of this function was read.
          if (!freshSalon || !freshSalon.billing || freshSalon.billing.pendingApproval
              || freshSalon.billing.autopay || freshSalon.billing.paidThroughMonth >= currentMonth
              || freshSalon.billing.lastWarningEmailSentDate === todayISO) continue;
          const fee = feeForWorkerCount(Math.max((freshSalon.workers || []).length, freshSalon.billing.declaredWorkerCount || 0));
          await sendEmail(freshSalon.email, 'TRIMIO — Pagamento canone mensile in sospeso',
            `<p>Ciao,</p><p>Il canone mensile di €${fee} per <b>${escapeHtml(freshSalon.name)}</b> risulta non ancora saldato per ${currentMonth}. ` +
            `Il servizio verrà sospeso se il pagamento non risulta entro il giorno 5 del mese.</p>`);
          freshSalon.billing.lastWarningEmailSentDate = todayISO;
          await setSalonsDb(kvUrl, kvToken, freshSalons);
        } finally {
          await releaseBillingLock(kvUrl, kvToken, salon.id);
        }
      } else if (dayOfMonth >= 6 && !salon.inactive) {
        const locked = await acquireBillingLock(kvUrl, kvToken, salon.id);
        if (!locked) continue;
        try {
          const freshSalons = await getSalonsDb(kvUrl, kvToken);
          const freshSalon = freshSalons.find(s => s.id === salon.id);
          if (!freshSalon || !freshSalon.billing || freshSalon.billing.pendingApproval
              || freshSalon.billing.autopay || freshSalon.billing.paidThroughMonth >= currentMonth
              || freshSalon.inactive) continue;
          freshSalon.inactive = true;
          freshSalon.billing.suspendedByBilling = true;
          await sendEmail(freshSalon.email, 'TRIMIO — Servizio sospeso per mancato pagamento',
            `<p>Ciao,</p><p>Il servizio TRIMIO per <b>${escapeHtml(freshSalon.name)}</b> è stato sospeso per mancato pagamento del canone di ${currentMonth}. ` +
            `Contattaci non appena effettuato il pagamento per riattivarlo.</p>`);
          await setSalonsDb(kvUrl, kvToken, freshSalons);
        } finally {
          await releaseBillingLock(kvUrl, kvToken, salon.id);
        }
      }
    }
    report.billingChecked = salons.filter(s => s.billing && !s.billing.pendingApproval).length;
  } catch (e) {
    problems.push(`Controllo fatturazione fallito: ${e.message}`);
  }

  // Notify every admin device — only when something is wrong, and only ONCE
  // per calendar day (Rome time). Without this, re-running the check (a
  // second cron tick, a manual curl, the health-check being polled) would
  // re-push the SAME already-known problem to every admin device every
  // single time — the endpoint itself has no other rate limit.
  let notified = 0;
  let alreadyNotifiedToday = false;
  if (problems.length && VAPID_PRIVATE_KEY) {
    const todayISO = romeTodayISO();
    let lastNotifiedISO = null;
    try { lastNotifiedISO = await getBlob(kvUrl, kvToken, 'health_check_notified_date'); } catch (e) {}
    if (lastNotifiedISO === todayISO) {
      alreadyNotifiedToday = true;
    } else {
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
      try { await setBlob(kvUrl, kvToken, 'health_check_notified_date', todayISO); } catch (e) {}
    }
  }

  // The health-check side effects above (billing warnings/suspensions, the
  // daily backup, the admin push notification) already ran regardless of
  // auth — only the detailed response body (real salon names, billing
  // status, platform-wide counts) is withheld from an unauthenticated
  // caller, same reasoning as the early-return above.
  return res.status(200).json(isAuthenticated
    ? { ok: problems.length === 0, problems, report, notified, alreadyNotifiedToday }
    : { ok: problems.length === 0 });
}
