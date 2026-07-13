import webPush from 'web-push';
import {
  getSalonsDb, setSalonsDb, getAllBookings, kvCmd,
  tryAcquireSlotLock, promoteLock, releaseSlotLock, hsetBooking,
  acquireBarberDayLock, releaseBarberDayLock, checkRateLimit,
  ensureMigratedV2, getAdminDb, setAdminDb
} from '../lib/kv.js';
import { sendCustomerText, toE164, twilioConfigured } from '../lib/sms.js';
import { sendEmail } from '../lib/email.js';
import { handleLogin, handleChangePassword, getVerifiedSession, getClientIp } from '../lib/auth.js';

// Fixed operational inbox (forwards to the real team, see CLAUDE.md) —
// used for admin-facing notifications that aren't tied to a specific admin
// push subscription, since admin_db has no email field of its own.
const ADMIN_NOTIFY_EMAIL = 'support@trimio.org';

// A minimal denylist of throwaway/disposable email providers — catches the
// most casual fake-salon attempts (real fraud would use a real-looking
// address anyway, but admin still reviews every signup by hand regardless).
const DISPOSABLE_EMAIL_DOMAINS = new Set([
  'mailinator.com', 'guerrillamail.com', 'guerrillamail.info', '10minutemail.com',
  'tempmail.com', 'temp-mail.org', 'yopmail.com', 'throwawaymail.com',
  'trashmail.com', 'getnada.com', 'dispostable.com', 'sharklasers.com', 'fakeinbox.com'
]);

// Mirrors js/app.js's DEFAULT_SERVICES — a brand-new self-signed-up salon
// needs a starter service list server-side too, same as an admin-created one.
const DEFAULT_SERVICES = [
  { id: 'sv0', name: 'Taglio', dur: '30 min', price: 15 },
  { id: 'sv1', name: 'Barba', dur: '20 min', price: 12 },
  { id: 'sv2', name: 'Taglio + Barba', dur: '45 min', price: 25 },
  { id: 'sv3', name: 'Shampoo + Taglio', dur: '40 min', price: 20 }
];

function romeYearMonth() {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit' }).formatToParts(new Date());
  const get = t => parts.find(p => p.type === t).value;
  return `${get('year')}-${get('month')}`;
}

// Every booking carries the customer's name + phone. Sending that back
// unscoped (as this endpoint used to) meant any anonymous visitor — or any
// other salon's staff — could read every customer's contact info across the
// whole platform. This is the one gate all of that goes through:
//   - admin session -> everything, unchanged.
//   - owner/barber session -> only their own salon's bookings, unchanged.
//   - no/invalid session (anonymous, or a customer's own device) -> every
//     booking is still needed for slot-availability rendering, but with
//     name/phone stripped — the customer-facing UI never displays those for
//     anyone (including its own "my bookings" list, which never re-shows the
//     name/phone the customer themselves typed in).
function scopeBookingsForSession(bookings, session) {
  if (session && session.role === 'admin') return bookings;
  if (session && (session.role === 'owner' || session.role === 'barber')) {
    return bookings.filter(b => b.salonId === session.salonId);
  }
  return bookings.map(({ name, phone, ...rest }) => rest);
}

// VAPID public key is safe to keep in source — it's meant to be shipped to
// browsers (same value already embedded in js/app.js for pushManager.subscribe).
// The private key is a real secret and must come from the environment
// (VAPID_PRIVATE_KEY in .env.local locally, or Vercel project env vars in
// production) — never hardcoded here.
const VAPID_PUBLIC_KEY = 'BLLKr1SroPRHybfSN2OunQUzy6yd5hggq2fmAmT90LL32Pgyaa_VkoESjUq3DGk0bgD2a5tb17bSZHc2heLJXGo';
// .trim() guards against stray whitespace/newline characters that can sneak
// into an env var value depending on how it was set (e.g. piping a value
// through a shell), which web-push's base64url validation rejects outright.
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY?.trim();

if (VAPID_PRIVATE_KEY) {
  webPush.setVapidDetails('mailto:support@trimio.org', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

// Reviews used to ride along inside the generic salons[] bulk-save — which
// meant ANY anonymous visitor could push an arbitrary review (no booking
// link, no length limit, no rate limit) simply by POSTing a crafted salons
// array, and it silently last-write-wins raced with any other concurrent
// salon edit. This is now the only way a review is ever written.
async function handleSubmitReview(body, kvUrl, kvToken, req) {
  const { salonId, workerId, author, comment, rating } = body;
  if (!salonId || !workerId) return { status: 400, json: { success: false, error: 'missing_fields' } };

  const rl = await checkRateLimit(kvUrl, kvToken, `ratelimit:review:${getClientIp(req)}`, 5, 3600);
  if (!rl.allowed) return { status: 429, json: { success: false, error: 'rate_limited' } };

  const authorTrimmed = (typeof author === 'string' ? author : '').trim().slice(0, 60);
  const commentTrimmed = (typeof comment === 'string' ? comment : '').trim().slice(0, 500);
  const ratingNum = Math.round(Number(rating));
  if (authorTrimmed.length < 2) return { status: 400, json: { success: false, error: 'invalid_author' } };
  if (commentTrimmed.length < 5) return { status: 400, json: { success: false, error: 'invalid_comment' } };
  if (!Number.isInteger(ratingNum) || ratingNum < 1 || ratingNum > 5) {
    return { status: 400, json: { success: false, error: 'invalid_rating' } };
  }

  const salons = await getSalonsDb(kvUrl, kvToken);
  const salon = salons.find(s => s.id === salonId);
  if (!salon) return { status: 404, json: { success: false, error: 'salon_not_found' } };
  const worker = (salon.workers || []).find(w => w.id === workerId);
  if (!worker) return { status: 404, json: { success: false, error: 'worker_not_found' } };

  if (!Array.isArray(worker.reviews)) worker.reviews = [];
  worker.reviews.push({
    rating: ratingNum,
    author: authorTrimmed,
    comment: commentTrimmed,
    date: new Date().toISOString().split('T')[0]
  });
  await setSalonsDb(kvUrl, kvToken, salons);
  return { status: 200, json: { success: true } };
}

// The curated photo strip on the public marketing page (trimio.org, vLogin)
// is admin-controlled and global (not tied to any one salon) — stored on the
// same admin_db blob as the admin's own credentials, gated to admin sessions
// only. Capped in count/length since these render on the one page every
// anonymous visitor sees, unauthenticated.
async function handleUpdateHomepagePhotos(body, kvUrl, kvToken, req) {
  const session = getVerifiedSession(req);
  if (!session || session.role !== 'admin') {
    return { status: 403, json: { success: false, error: 'forbidden' } };
  }
  const photos = Array.isArray(body.photos) ? body.photos : [];
  const cleaned = photos
    .filter(u => typeof u === 'string' && u.length > 0 && u.length <= 300)
    .slice(0, 20);
  const admin = await getAdminDb(kvUrl, kvToken);
  await setAdminDb(kvUrl, kvToken, { ...admin, homepagePhotos: cleaned });
  return { status: 200, json: { success: true, homepagePhotos: cleaned } };
}

// Sends a 6-digit SMS code the signup wizard's step 2 must echo back before
// continuing — real proof the phone is reachable by whoever is registering,
// not just typed in (see the twilioConfigured() gate in handleSignupSalon).
// A no-op if Twilio isn't configured, same "safe when unconfigured"
// convention as every other Twilio-backed feature in this codebase.
async function handleRequestSignupOtp(body, kvUrl, kvToken, req) {
  if (!twilioConfigured()) return { status: 200, json: { success: false, error: 'sms_unavailable' } };
  const phone = toE164(body.phone);
  if (!phone) return { status: 400, json: { success: false, error: 'invalid_phone' } };

  const rlIp = await checkRateLimit(kvUrl, kvToken, `ratelimit:otp_ip:${getClientIp(req)}`, 8, 3600);
  if (!rlIp.allowed) return { status: 429, json: { success: false, error: 'rate_limited' } };
  const rlPhone = await checkRateLimit(kvUrl, kvToken, `ratelimit:otp_phone:${phone}`, 4, 3600);
  if (!rlPhone.allowed) return { status: 429, json: { success: false, error: 'rate_limited' } };

  const code = String(Math.floor(100000 + Math.random() * 900000));
  await kvCmd(kvUrl, kvToken, ['SET', `signup_otp:${phone}`, code, 'EX', '600']);
  const sent = await sendCustomerText(phone, `Il tuo codice di verifica TRIMIO è: ${code}`);
  if (!sent) return { status: 200, json: { success: false, error: 'sms_unavailable' } };
  return { status: 200, json: { success: true } };
}

async function handleVerifySignupOtp(body, kvUrl, kvToken) {
  const phone = toE164(body.phone);
  const code = typeof body.code === 'string' ? body.code.trim() : '';
  if (!phone || !/^\d{4,6}$/.test(code)) return { status: 400, json: { success: false, error: 'missing_fields' } };

  const stored = await kvCmd(kvUrl, kvToken, ['GET', `signup_otp:${phone}`]);
  if (!stored || stored !== code) return { status: 401, json: { success: false, error: 'invalid_code' } };

  await kvCmd(kvUrl, kvToken, ['DEL', `signup_otp:${phone}`]);
  // Short-lived proof-of-verification flag, consumed (and deleted) by
  // handleSignupSalon once the salon is actually created.
  await kvCmd(kvUrl, kvToken, ['SET', `signup_otp_verified:${phone}`, '1', 'EX', '1800']);
  return { status: 200, json: { success: true } };
}

// Self-service salon signup ("Registra il tuo salone" on the public
// homepage) — the ONLY path where a genuinely new salon can be created
// without an admin session (the generic bulk salons[] save further below
// rejects unauthenticated writes for ids that don't already exist yet, by
// design — see isAuthorizedEditor). New signups are created inactive and
// pending admin review; the existing Attiva button (api/toggle-salon.js) is
// what brings them live, same trust boundary as an admin-created salon, just
// with the initial data entry self-served instead of typed by admin.
async function handleSignupSalon(body, kvUrl, kvToken, req) {
  // Honeypot: a hidden field no real visitor ever fills in (see index.html's
  // #suWebsite). A bot that blindly fills every input trips this — reply
  // with a fake success so it doesn't learn the trap exists, but never
  // actually create anything or send any email/push.
  if (typeof body.website === 'string' && body.website.trim()) {
    return { status: 200, json: { success: true } };
  }

  const ownerName = typeof body.ownerName === 'string' ? body.ownerName.trim() : '';
  const username = typeof body.username === 'string' ? body.username.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  const salonName = typeof body.salonName === 'string' ? body.salonName.trim() : '';
  const email = typeof body.email === 'string' ? body.email.trim() : '';
  const city = typeof body.city === 'string' ? body.city.trim() : '';
  const address = typeof body.address === 'string' ? body.address.trim() : '';
  const iban = typeof body.iban === 'string' ? body.iban.trim().toUpperCase().replace(/\s+/g, '') : '';
  const taxId = typeof body.taxId === 'string' ? body.taxId.trim().toUpperCase() : '';
  const paymentMethod = typeof body.paymentMethod === 'string' && body.paymentMethod ? body.paymentMethod : 'bonifico_bancario';
  const contractSignedName = typeof body.contractSignedName === 'string' ? body.contractSignedName.trim() : '';

  // Every field below is mandatory in the signup wizard — reject a bare
  // API call that skips the client-side checks the same way, rather than
  // silently defaulting missing data to empty/1.
  if (ownerName.length < 2) return { status: 400, json: { success: false, error: 'invalid_owner_name' } };
  if (!/^[a-zA-Z0-9._-]{3,30}$/.test(username)) return { status: 400, json: { success: false, error: 'invalid_username' } };
  if (password.length < 6) return { status: 400, json: { success: false, error: 'invalid_password' } };
  if (salonName.length < 2) return { status: 400, json: { success: false, error: 'invalid_salon_name' } };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { status: 400, json: { success: false, error: 'invalid_email' } };
  if (DISPOSABLE_EMAIL_DOMAINS.has(email.split('@')[1]?.toLowerCase())) {
    return { status: 400, json: { success: false, error: 'disposable_email' } };
  }
  if (city.length < 2) return { status: 400, json: { success: false, error: 'invalid_city' } };
  if (address.length < 3) return { status: 400, json: { success: false, error: 'invalid_address' } };
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(iban)) return { status: 400, json: { success: false, error: 'invalid_iban' } };
  if (taxId.length < 6) return { status: 400, json: { success: false, error: 'invalid_tax_id' } };
  if (!body.contractAccepted || contractSignedName.length < 2) {
    return { status: 400, json: { success: false, error: 'contract_not_accepted' } };
  }

  const ownerPhone = toE164(body.ownerPhone);
  if (!ownerPhone) return { status: 400, json: { success: false, error: 'invalid_phone' } };
  // Kept as the human-formatted string the client sent (matches how
  // admin-created salons store their public contact phone), just required
  // to at least look like a real number — toE164 only used to validate.
  const salonPhone = typeof body.phone === 'string' ? body.phone.trim() : '';
  if (!toE164(salonPhone)) return { status: 400, json: { success: false, error: 'invalid_salon_phone' } };

  const workerCountNum = Number(body.declaredWorkerCount);
  if (!Number.isFinite(workerCountNum) || workerCountNum < 1) {
    return { status: 400, json: { success: false, error: 'invalid_worker_count' } };
  }

  const rl = await checkRateLimit(kvUrl, kvToken, `ratelimit:signup:${getClientIp(req)}`, 5, 3600);
  if (!rl.allowed) return { status: 429, json: { success: false, error: 'rate_limited' } };

  // Real anti-fraud gate: if SMS is configured, the phone must have already
  // passed OTP verification (see request_signup_otp/verify_signup_otp below)
  // within the last 30 minutes — proves a real, reachable phone, not just a
  // typed-in string. Degrades gracefully (no gate) if Twilio isn't
  // configured, so signup never breaks outright over this.
  if (twilioConfigured()) {
    const verified = await kvCmd(kvUrl, kvToken, ['GET', `signup_otp_verified:${ownerPhone}`]);
    if (!verified) return { status: 403, json: { success: false, error: 'phone_not_verified' } };
  }

  const salons = await getSalonsDb(kvUrl, kvToken);
  if (salons.some(s => s.ownerUsername === username)) {
    return { status: 409, json: { success: false, error: 'username_taken' } };
  }

  const baseSlug = salonName.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'SALONE';
  let slug = baseSlug, n = 2;
  while (salons.some(s => s.slug === slug)) slug = `${baseSlug}_${n++}`;

  const declaredWorkerCount = Math.max(1, Math.min(200, Math.round(workerCountNum)));

  salons.push({
    id: 'salon' + Date.now(),
    name: salonName, slug,
    city, address, phone: salonPhone, promo: '',
    bgImage: '', gallery: [], themeColor: '#e5c158',
    closedDays: [], bookingDays: 30,
    services: DEFAULT_SERVICES.map(s => ({ ...s })),
    workers: [],
    ownerUsername: username, ownerPassword: password,
    ownerName, ownerPhone, email,
    inactive: true,
    billing: {
      declaredWorkerCount,
      paidThroughMonth: romeYearMonth(), // first partial month is free
      pendingApproval: true,
      paymentMethod, iban, taxId,
      contractSignedAt: new Date().toISOString(),
      contractSignedName,
      signupIp: getClientIp(req) // fraud-review signal for admin, not enforcement
    }
  });
  await setSalonsDb(kvUrl, kvToken, salons);
  if (twilioConfigured()) {
    try { await kvCmd(kvUrl, kvToken, ['DEL', `signup_otp_verified:${ownerPhone}`]); } catch { /* best-effort cleanup */ }
  }
  // Must be awaited (not fire-and-forget) — Vercel can freeze the function
  // right after the response is sent, same reason booking pushes are
  // awaited above.
  await notifyAdminsOfNewSignup(salonName, kvUrl, kvToken);
  await sendEmail(ADMIN_NOTIFY_EMAIL, '🆕 TRIMIO — Nuovo salone in attesa di approvazione',
    `<p>Un nuovo salone si è registrato e attende la tua conferma:</p>
     <ul>
       <li><b>Salone:</b> ${salonName}</li>
       <li><b>Proprietario:</b> ${ownerName} (${username}, ${ownerPhone})</li>
       <li><b>Email:</b> ${email}</li>
       <li><b>Indirizzo:</b> ${address}, ${city}</li>
       <li><b>Barbieri dichiarati:</b> ${declaredWorkerCount}</li>
     </ul>
     <p>Vai su TRIMIO → <b>Nuove Richieste</b> per esaminare e approvare la richiesta.</p>`);
  return { status: 200, json: { success: true } };
}

// Alerts every admin device the moment a new salon self-registers, so admin
// doesn't have to stumble onto a pending signup by chance — same
// push-subscription lookup sendPushNotifications() uses for new bookings,
// just always targeted at admin-role subscriptions.
async function notifyAdminsOfNewSignup(salonName, kvUrl, kvToken) {
  if (!VAPID_PRIVATE_KEY) return;
  try {
    const subResp = await fetch(`${kvUrl}/get/push_subscriptions`, { headers: { Authorization: `Bearer ${kvToken}` } });
    if (!subResp.ok) return;
    const subResData = await subResp.json();
    if (!subResData.result) return;
    let subscriptions = JSON.parse(subResData.result);
    if (typeof subscriptions === 'string') subscriptions = JSON.parse(subscriptions);
    if (!Array.isArray(subscriptions)) return;

    const payload = JSON.stringify({
      title: '🆕 Nuovo salone in attesa di approvazione',
      body: `"${salonName}" si è registrato su TRIMIO e attende la tua approvazione.`,
      url: '/#DASHBOARD'
    });
    for (const target of subscriptions.filter(s => s.role === 'admin')) {
      try {
        await webPush.sendNotification(target.subscription, payload);
      } catch (err) {
        console.error('[PUSH] signup-notify to admin failed:', err.message);
      }
    }
  } catch (err) {
    console.error('[PUSH] notifyAdminsOfNewSignup error:', err);
  }
}

// Admin-only: confirms this month's fee was received (payment is manual for
// now — no bank/card processor wired up yet). Also reactivates a salon that
// had been auto-suspended by the daily billing check (api/daily-health-check.js),
// but never touches an `inactive` flip the admin made for an unrelated reason.
async function handleMarkSalonPaid(body, kvUrl, kvToken, req) {
  const session = getVerifiedSession(req);
  if (!session || session.role !== 'admin') return { status: 403, json: { success: false, error: 'forbidden' } };
  if (!body.salonId) return { status: 400, json: { success: false, error: 'missing_fields' } };

  const salons = await getSalonsDb(kvUrl, kvToken);
  const salon = salons.find(s => s.id === body.salonId);
  if (!salon) return { status: 404, json: { success: false, error: 'salon_not_found' } };

  salon.billing = salon.billing || {};
  salon.billing.paidThroughMonth = romeYearMonth();
  if (salon.billing.suspendedByBilling) {
    salon.billing.suspendedByBilling = false;
    salon.inactive = false;
  }
  await setSalonsDb(kvUrl, kvToken, salons);
  return { status: 200, json: { success: true, paidThroughMonth: salon.billing.paidThroughMonth } };
}

// Admin-only: the dedicated "Nuove Richieste" approval action — deliberately
// separate from the generic Attiva/Inattivo toggle (api/toggle-salon.js),
// which is also used to reactivate a billing-suspended salon and doesn't
// distinguish why a salon was inactive. Only ever acts on a genuinely
// pending self-signup, and is the one place that emails the new owner their
// login credentials + booking link + QR code.
async function handleApproveSalon(body, kvUrl, kvToken, req) {
  const session = getVerifiedSession(req);
  if (!session || session.role !== 'admin') return { status: 403, json: { success: false, error: 'forbidden' } };
  if (!body.salonId) return { status: 400, json: { success: false, error: 'missing_fields' } };

  const salons = await getSalonsDb(kvUrl, kvToken);
  const salon = salons.find(s => s.id === body.salonId);
  if (!salon) return { status: 404, json: { success: false, error: 'salon_not_found' } };
  if (!salon.billing || !salon.billing.pendingApproval) {
    return { status: 409, json: { success: false, error: 'not_pending' } };
  }

  salon.inactive = false;
  salon.billing.pendingApproval = false;
  await setSalonsDb(kvUrl, kvToken, salons);

  const link = `https://trimio.org/s/${encodeURIComponent(salon.slug)}`;
  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=${encodeURIComponent(link)}`;
  await sendEmail(salon.email, '🎉 TRIMIO — Il tuo salone è stato approvato!',
    `<p>Ciao ${salon.ownerName || ''},</p>
     <p>Il tuo salone <b>${salon.name}</b> è stato approvato ed è ora attivo su TRIMIO!</p>
     <p><b>Le tue credenziali di accesso proprietario:</b><br>
     Username: ${salon.ownerUsername}<br>
     Password: ${salon.ownerPassword}</p>
     <p><b>Link di prenotazione del tuo salone:</b><br><a href="${link}">${link}</a></p>
     <p>I tuoi clienti possono anche scansionare questo QR code per prenotare direttamente:</p>
     <img src="${qrUrl}" alt="QR Code" width="200" height="200">`);

  return { status: 200, json: { success: true } };
}

function isValidBooking(b) {
  return !!b && typeof b === 'object'
    && typeof b.id === 'string' && b.id
    && typeof b.salonId === 'string' && b.salonId
    && typeof b.workerId === 'string' && b.workerId
    && typeof b.dateISO === 'string' && b.dateISO
    && typeof b.time === 'string' && b.time;
}
function isValidSalonsArray(salons) {
  return Array.isArray(salons) && salons.length > 0
    && salons.every(s => s && typeof s === 'object' && typeof s.id === 'string' && s.id);
}

// Mirrors js/app.js's isOnVacation/isWeeklyOff — the UI already hides these
// slots from the customer, but nothing stopped a request POSTed directly to
// this endpoint (bypassing the UI entirely) from booking a worker during
// their vacation or on their weekly day off.
function isOnVacation(w, iso) { return !!(w.vacFrom && w.vacTo && iso >= w.vacFrom && iso <= w.vacTo); }
function isWeeklyOff(w, iso) { return Array.isArray(w.offDays) && w.offDays.includes(new Date(iso + 'T00:00:00').getDay()); }
// Same gap as vacation/weekly-off above, but for the worker's daily lunch
// break (breakFrom/breakTo) — the UI hides these slots from the customer,
// but a request posted directly to this endpoint could still claim one.
function overlapsBreak(w, nb, salon) {
  if (!w || !w.breakFrom || !w.breakTo) return false;
  const bs = timeToMin(w.breakFrom), be = timeToMin(w.breakTo);
  if (bs === null || be === null || be <= bs) return false;
  const start = timeToMin(nb.time);
  if (start === null) return false;
  const end = start + bookingDurMin(nb, salon);
  return start < be && end > bs;
}

// ---- Duration-aware overlap detection (mirrors js/app.js) ----
// A booking occupies [start, start+service duration): a 40-min service at
// 10:00 blocks the barber until 10:40, a 20-min one until 10:20. The exact
// per-time slot lock below can't see two DIFFERENT start times overlapping
// (10:00/40min vs 10:20), so new bookings are also checked against every
// existing booking of the same barber+day.
function timeToMin(t) { const m = /^(\d{1,2}):(\d{2})/.exec(t || ''); return m ? (+m[1]) * 60 + (+m[2]) : null; }
function svcDurMin(salon, serviceName) {
  const svcs = salon && Array.isArray(salon.services) && salon.services.length ? salon.services : null;
  const s = svcs ? svcs.find(x => x && x.name === serviceName) : null;
  const n = s ? parseInt(s.dur, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 30;
}
// A booking now snapshots its own duration at creation time (booking.dur) so
// shortening/renaming a service later can't retroactively shrink the
// overlap window of appointments already on the books — falls back to a
// live service-name lookup only for bookings created before this existed.
function bookingDurMin(booking, salon) {
  const own = parseInt(booking.dur, 10);
  return Number.isFinite(own) && own > 0 ? own : svcDurMin(salon, booking.service);
}
function overlapsExisting(nb, bookingsMap, salon) {
  const start = timeToMin(nb.time);
  if (start === null) return false;
  const end = start + bookingDurMin(nb, salon);
  for (const b of bookingsMap.values()) {
    if (b.id === nb.id || b.salonId !== nb.salonId || b.workerId !== nb.workerId
        || b.dateISO !== nb.dateISO || b.status === 'cancelled') continue;
    const bs = timeToMin(b.time);
    if (bs === null) continue;
    const be = bs + bookingDurMin(b, salon);
    if (start < be && end > bs) return true;
  }
  return false;
}

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
      await ensureMigratedV2(kvUrl, kvToken);

      if (req.method === 'GET') {
        console.log('[SYNC] Reading database state from Vercel KV');
        const [salons, bookingsMap, admin] = await Promise.all([
          getSalonsDb(kvUrl, kvToken),
          getAllBookings(kvUrl, kvToken),
          getAdminDb(kvUrl, kvToken)
        ]);
        // Never ship plaintext credentials to the client — login and every
        // password change now go through the action-based branches of the
        // POST handler below (backed by lib/auth.js), which read/write KV
        // directly, so the client has no need to hold these locally at all.
        const sanitizedSalons = salons.map(({ ownerPassword, workers, ...rest }) => ({
          ...rest,
          workers: (workers || []).map(({ password, ...w }) => w)
        }));
        const session = getVerifiedSession(req);
        return res.status(200).json({
          bookings: scopeBookingsForSession(Array.from(bookingsMap.values()), session),
          salons: sanitizedSalons,
          admin: { username: admin.username, homepagePhotos: admin.homepagePhotos || [] }
        });
      }

      if (req.method === 'POST') {
        const body = req.body;
        const newData = typeof body === 'string' ? JSON.parse(body) : body;

        // Login / password-change requests are routed through this same
        // endpoint (kept here rather than as their own serverless functions
        // — Vercel's Hobby plan caps a deployment at 12 functions). They're
        // fully separate from the booking/salon sync logic below.
        if (newData && newData.action === 'login') {
          const r = await handleLogin(newData, kvUrl, kvToken);
          return res.status(r.status).json(r.json);
        }
        if (newData && newData.action === 'change_password') {
          const r = await handleChangePassword(newData, kvUrl, kvToken);
          return res.status(r.status).json(r.json);
        }

        if (newData && newData.action === 'submit_review') {
          const r = await handleSubmitReview(newData, kvUrl, kvToken, req);
          return res.status(r.status).json(r.json);
        }
        if (newData && newData.action === 'update_homepage_photos') {
          const r = await handleUpdateHomepagePhotos(newData, kvUrl, kvToken, req);
          return res.status(r.status).json(r.json);
        }
        if (newData && newData.action === 'request_signup_otp') {
          const r = await handleRequestSignupOtp(newData, kvUrl, kvToken, req);
          return res.status(r.status).json(r.json);
        }
        if (newData && newData.action === 'verify_signup_otp') {
          const r = await handleVerifySignupOtp(newData, kvUrl, kvToken);
          return res.status(r.status).json(r.json);
        }
        if (newData && newData.action === 'signup_salon') {
          const r = await handleSignupSalon(newData, kvUrl, kvToken, req);
          return res.status(r.status).json(r.json);
        }
        if (newData && newData.action === 'mark_salon_paid') {
          const r = await handleMarkSalonPaid(newData, kvUrl, kvToken, req);
          return res.status(r.status).json(r.json);
        }
        if (newData && newData.action === 'approve_salon') {
          const r = await handleApproveSalon(newData, kvUrl, kvToken, req);
          return res.status(r.status).json(r.json);
        }

        console.log('[SYNC] Saving database state to Vercel KV');

        const session = getVerifiedSession(req);
        const newBks = Array.isArray(newData.bookings) ? newData.bookings : [];
        // Only anonymous callers (the public customer booking flow) are
        // capped — staff carry a verified session token and legitimately
        // batch-edit many bookings at once (status changes, etc.), which
        // this must never throttle. A real customer never needs more than a
        // handful of new bookings from one IP in ten minutes.
        if (newBks.length && !session) {
          const rl = await checkRateLimit(kvUrl, kvToken, `ratelimit:booking:${getClientIp(req)}`, 20, 600);
          if (!rl.allowed) {
            return res.status(429).json({ success: false, error: 'rate_limited', conflicts: [] });
          }
        }

        const bookingsMap = await getAllBookings(kvUrl, kvToken);
        const addedBks = [];
        const staffCancelledBks = [];
        const conflicts = [];
        // Salons are needed to translate each booking's service into a
        // duration for the overlap check below.
        const salonsForDur = newBks.length ? await getSalonsDb(kvUrl, kvToken) : [];

        for (const nb of newBks) {
          try {
            if (!isValidBooking(nb)) {
              console.warn('[SYNC] Skipping malformed booking payload:', nb && nb.id);
              conflicts.push({ id: nb && nb.id, error: 'invalid_booking' });
              continue;
            }

            const existing = bookingsMap.get(nb.id);
            if (existing && JSON.stringify(existing) === JSON.stringify(nb)) {
              continue; // unchanged — skip, saves an Upstash command
            }

            if (!existing) {
              if (nb.status !== 'cancelled') {
                const salonForVac = salonsForDur.find(s => s.id === nb.salonId);
                const worker = salonForVac && (salonForVac.workers || []).find(w => w.id === nb.workerId);
                if (worker && (isOnVacation(worker, nb.dateISO) || isWeeklyOff(worker, nb.dateISO) || overlapsBreak(worker, nb, salonForVac))) {
                  conflicts.push({ id: nb.id, salonId: nb.salonId, workerId: nb.workerId, dateISO: nb.dateISO, time: nb.time });
                  continue;
                }
              }
              // Serialize the whole "check overlap, then claim the slot"
              // sequence per barber+day — otherwise two concurrent requests
              // can both read the same pre-write bookingsMap snapshot, both
              // pass overlapsExisting(), and both succeed with genuinely
              // overlapping times (the exact-slot SET NX below only catches
              // identical start times, not different-but-overlapping ones).
              const dayLocked = await acquireBarberDayLock(kvUrl, kvToken, nb.salonId, nb.workerId, nb.dateISO);
              if (!dayLocked) {
                conflicts.push({ id: nb.id, salonId: nb.salonId, workerId: nb.workerId, dateISO: nb.dateISO, time: nb.time });
                continue;
              }
              try {
                // bookingsMap was fetched BEFORE this lock was acquired — a
                // concurrent request for this same barber+day may have
                // committed its own booking while we were waiting for the
                // lock, which our stale snapshot wouldn't see. Re-fetch now
                // that we hold exclusive access, so the overlap check below
                // sees the true current state (the lock alone only orders
                // the writes; it doesn't refresh what we already read).
                const freshBookings = await getAllBookings(kvUrl, kvToken);
                for (const [id, b] of freshBookings) bookingsMap.set(id, b);

                // Duration-aware overlap with any existing booking of the same
                // barber+day (different start times can still collide).
                if (nb.status !== 'cancelled'
                    && overlapsExisting(nb, bookingsMap, salonsForDur.find(s => s.id === nb.salonId))) {
                  conflicts.push({ id: nb.id, salonId: nb.salonId, workerId: nb.workerId, dateISO: nb.dateISO, time: nb.time });
                  continue;
                }
                // Brand-new booking claiming a slot — must go through the atomic lock.
                const acquired = await tryAcquireSlotLock(kvUrl, kvToken, nb);
                if (!acquired) {
                  conflicts.push({ id: nb.id, salonId: nb.salonId, workerId: nb.workerId, dateISO: nb.dateISO, time: nb.time });
                  continue;
                }
                await hsetBooking(kvUrl, kvToken, nb);
                await promoteLock(kvUrl, kvToken, nb);
                bookingsMap.set(nb.id, nb);
                if (nb.status !== 'cancelled') addedBks.push(nb);
              } finally {
                await releaseBarberDayLock(kvUrl, kvToken, nb.salonId, nb.workerId, nb.dateISO);
              }
            } else {
              // Update to an existing booking (e.g. status change) — no lock
              // needed, but this must never let a caller touch a booking
              // outside their own salon. Two legitimate callers reach this
              // branch: staff (admin, or owner/barber scoped to THIS
              // booking's salon) making any change, and a customer — who has
              // no session at all — cancelling their OWN booking (the only
              // self-service action customers have, identified purely by
              // knowing the booking id). Anyone else's request is dropped as
              // a conflict instead of silently no-op'ing, so the client
              // knows the change didn't take.
              const isStaffForThisBooking = session && (session.role === 'admin'
                || ((session.role === 'owner' || session.role === 'barber') && session.salonId === existing.salonId));
              let merged;
              if (isStaffForThisBooking) {
                merged = { ...existing, ...nb };
              } else if (existing.status === 'confirmed' && nb.status === 'cancelled' && nb.cancelledBy !== 'staff') {
                // Customer self-cancellation — only status/cancelledBy change,
                // everything else on the booking (price, time, name...) is
                // taken from the server's own record, never from the caller.
                merged = { ...existing, status: 'cancelled', cancelledBy: 'customer' };
              } else {
                conflicts.push({ id: nb.id, error: 'forbidden' });
                continue;
              }
              await hsetBooking(kvUrl, kvToken, merged);
              bookingsMap.set(nb.id, merged);
              if (merged.status === 'cancelled') {
                await releaseSlotLock(kvUrl, kvToken, merged);
                // Only a STAFF-initiated cancellation is news to the customer —
                // if they cancelled it themselves there's nothing to tell them.
                if (existing.status !== 'cancelled' && merged.cancelledBy === 'staff') {
                  staffCancelledBks.push(merged);
                }
              }
            }
          } catch (itemErr) {
            // One malformed/unexpected booking must never abort the whole batch —
            // saveState() sends the client's entire local array on every save, so a
            // single bad item shouldn't break syncing for every other booking too.
            console.error('[SYNC] Failed to process booking', nb && nb.id, itemErr);
            conflicts.push({ id: nb && nb.id, error: 'processing_failed' });
          }
        }

        if (Array.isArray(newData.salons) && newData.salons.length > 0) {
          if (isValidSalonsArray(newData.salons)) {
            // Merge by id (upsert) instead of overwriting the whole array.
            // saveState() sends the client's ENTIRE local salons snapshot on
            // every save, even for unrelated actions (confirming a booking,
            // etc.) — a client with a stale/partial local copy would
            // otherwise silently wipe out salons added by someone else in
            // the meantime. Never remove a salon just because it's absent
            // from an incoming payload; deletion goes through the dedicated
            // /api/delete-salon endpoint instead, which acts on the current
            // server-side list directly.
            const currentSalons = await getSalonsDb(kvUrl, kvToken);
            const salonMap = new Map(currentSalons.map(s => [s.id, s]));
            for (const incoming of newData.salons) {
              const existing = salonMap.get(incoming.id);
              // Only an admin (any salon) or that salon's own owner may
              // create/edit it through this generic bulk path — a caller with
              // no session, or a valid session for a DIFFERENT salon, used to
              // have its payload accepted verbatim (protecting only the two
              // password fields below). Salon ids aren't secret (the
              // sanitized GET response includes every salon), so this was a
              // real cross-tenant tampering hole, not just a theoretical one.
              const isAuthorizedEditor = session && (session.role === 'admin'
                || (session.role === 'owner' && session.salonId === incoming.id));
              // A barber sets their own lunch break / weekly rest days /
              // vacation dates from "Le mie Pause" (saveBreak() in js/app.js)
              // through this same bulk endpoint, but was never in the
              // allowlist above — every save silently hit the `continue`
              // below, so breakFrom/breakTo/offDays never actually reached
              // the database and the break-time booking guard above always
              // saw an unset break. Scoped narrowly to just those fields on
              // their OWN worker record, never the rest of the salon.
              const isBarberSelfEditor = !isAuthorizedEditor && existing && session
                && session.role === 'barber' && session.salonId === incoming.id;
              if (isBarberSelfEditor) {
                const existingWorker = (existing.workers || []).find(w => w.id === session.workerId);
                const incomingWorker = (incoming.workers || []).find(w => w.id === session.workerId);
                if (existingWorker && incomingWorker) {
                  const mergedWorker = {
                    ...existingWorker,
                    breakFrom: incomingWorker.breakFrom,
                    breakTo: incomingWorker.breakTo,
                    offDays: incomingWorker.offDays,
                    vacFrom: incomingWorker.vacFrom,
                    vacTo: incomingWorker.vacTo,
                  };
                  salonMap.set(incoming.id, {
                    ...existing,
                    workers: existing.workers.map(w => w.id === session.workerId ? mergedWorker : w),
                  });
                }
                continue;
              }
              if (!isAuthorizedEditor) {
                console.warn('[SYNC] Rejected unauthorized salon write for', incoming.id);
                continue; // existing record (or absence of one) is left untouched
              }
              if (existing) {
                // Credentials for anything that already exists must never be
                // overwritten through this generic bulk-save path — the client
                // no longer even holds real passwords locally (GET strips them),
                // so any password it sends back here is stale/blank. Password
                // changes only happen through /api/change-password.
                incoming.ownerPassword = existing.ownerPassword;
                // Reviews only ever change through action=submit_review (see
                // handleSubmitReview below) now — never through this bulk
                // path, which sends the client's last-known LOCAL snapshot
                // and would otherwise silently discard a review someone else
                // submitted in the meantime (last-write-wins on the whole
                // worker object).
                const existingWorkersById = new Map((existing.workers || []).map(w => [w.id, w]));
                if (Array.isArray(incoming.workers)) {
                  incoming.workers = incoming.workers.map(w => {
                    const ew = existingWorkersById.get(w.id);
                    return ew ? { ...w, password: ew.password, reviews: ew.reviews || [] } : w;
                  });
                }
              }
              salonMap.set(incoming.id, incoming);
            }
            await setSalonsDb(kvUrl, kvToken, Array.from(salonMap.values()));
          } else {
            console.warn('[SYNC] Ignoring malformed salons payload (not written to salons_db)');
          }
        }

        // Admin credential changes go exclusively through
        // /api/change-password (action=admin_self) now — never accepted here.

        // Send push notifications for new bookings — must be awaited, not
        // fire-and-forget: Vercel's Node.js serverless runtime can freeze/
        // terminate the function as soon as the HTTP response is sent, which
        // was silently killing in-flight webPush.sendNotification() calls
        // before they ever reached the push service (confirmed via prod logs
        // showing push sends limping along minutes after the response, or
        // never completing at all).
        if (addedBks.length > 0) {
          console.log(`[SYNC] Found ${addedBks.length} new bookings. Sending push notifications...`);
          // Independent jobs (staff push+SMS vs. customer SMS) — run concurrently
          // instead of one after the other, but still both fully awaited before
          // the response is sent (required per the CLAUDE.md note above: Vercel
          // can freeze the function right after the response goes out).
          const [pushResult, confirmResult] = await Promise.allSettled([
            sendPushNotifications(addedBks, salonsForDur, kvUrl, kvToken),
            sendCustomerBookingConfirmations(addedBks)
          ]);
          if (pushResult.status === 'rejected') console.error('[SYNC] Push notifications job error:', pushResult.reason);
          if (confirmResult.status === 'rejected') console.error('[SYNC] Customer confirmation job error:', confirmResult.reason);
        }
        if (staffCancelledBks.length > 0) {
          console.log(`[SYNC] ${staffCancelledBks.length} booking(s) cancelled by staff. Notifying customers...`);
          try {
            const salonsForNotif = await getSalonsDb(kvUrl, kvToken);
            await sendCancellationNotifications(staffCancelledBks, salonsForNotif, kvUrl, kvToken);
          } catch (err) {
            console.error('[SYNC] Cancellation notifications job error:', err);
          }
        }

        return res.status(200).json({ success: true, bookings: scopeBookingsForSession(Array.from(bookingsMap.values()), session), conflicts });
      }
    } catch (kvErr) {
      console.error('[SYNC] KV Database Error:', kvErr);
      return res.status(500).json({ error: 'Errore del server, riprova.' });
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
async function sendPushNotifications(newBookings, salons, kvUrl, kvToken) {
  if (!VAPID_PRIVATE_KEY) {
    console.warn('[PUSH] VAPID_PRIVATE_KEY not configured — skipping push notifications.');
    return;
  }
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
        if (sub.role === 'admin') return true;
        if (sub.role === 'owner' && sub.salonId === bk.salonId) return true;
        if (sub.role === 'barber' && sub.workerId === bk.workerId) return true;
        return false;
      });

      console.log(`[PUSH] Sending notifications for booking "${bk.id}" to ${targets.length} targets`);

      let barberNotified = false;
      for (const target of targets) {
        try {
          await webPush.sendNotification(target.subscription, payload);
          console.log(`[PUSH] Sent to ${target.role} (${target.subscription.endpoint.slice(0, 30)}...)`);
          if (target.role === 'barber') barberNotified = true;
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

      // The barber is the one who actually needs to know a new appointment
      // landed on their calendar — if push never reached them (no
      // subscription registered yet, expired, or the send failed), fall
      // back to SMS the same way cancellations already do, instead of them
      // finding out only whenever they next happen to open the dashboard.
      if (!barberNotified) {
        const salon = (salons || []).find(s => s.id === bk.salonId);
        const worker = salon && (salon.workers || []).find(w => w.id === bk.workerId);
        if (worker && worker.phone) {
          try {
            await sendCustomerText(worker.phone, `Nuova prenotazione: ${bk.name} - ${bk.service} il ${bk.dateLabel} alle ${bk.time}.`);
          } catch (err) {
            console.error('[PUSH] Barber SMS fallback failed:', err.message);
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

// A brand-new booking has no push subscription yet (the customer only ever
// subscribes on the confirmation screen, AFTER the booking already exists
// server-side) — without this, a customer got no confirmation of any kind
// until the reminder or a cancellation. Phone number has been required at
// booking time, so an immediate SMS receipt is always possible.
async function sendCustomerBookingConfirmations(newBookings) {
  // Each booking's confirmation is independent of the others — fire them
  // concurrently instead of one Twilio round trip at a time.
  await Promise.all(newBookings.map(async bk => {
    if (!bk.phone) return;
    const body = `Prenotazione confermata: ${bk.service} con ${bk.workerName} il ${bk.dateLabel} alle ${bk.time}. Grazie per aver scelto TRIMIO!`;
    try {
      await sendCustomerText(bk.phone, body);
    } catch (err) {
      console.error('[CONFIRM] SMS confirmation failed:', err.message);
    }
  }));
}

// Tells a customer immediately when the SALON cancels their booking (as
// opposed to the customer cancelling it themselves, which needs no
// notification — they already know). Falls back to SMS/WhatsApp when the
// customer never opted into push, same as the manual notify-customer button.
async function sendCancellationNotifications(cancelledBookings, salons, kvUrl, kvToken) {
  let subscriptions = [];
  if (VAPID_PRIVATE_KEY) {
    try {
      const subResp = await fetch(`${kvUrl}/get/push_subscriptions`, { headers: { Authorization: `Bearer ${kvToken}` } });
      if (subResp.ok) {
        const subResData = await subResp.json();
        if (subResData.result) {
          let val = JSON.parse(subResData.result);
          if (typeof val === 'string') val = JSON.parse(val);
          if (Array.isArray(val)) subscriptions = val;
        }
      }
    } catch (err) {
      console.error('[CANCEL-NOTIFY] Failed to read subscriptions:', err.message);
    }
  }

  for (const bk of cancelledBookings) {
    const salon = salons.find(s => s.id === bk.salonId);
    const firstName = (bk.name || '').trim().split(' ')[0] || 'cliente';
    const body = `Gentile ${firstName}, la tua prenotazione del ${bk.dateLabel} alle ore ${bk.time} con ${bk.workerName}, presso ${salon ? salon.name : 'TRIMIO'}, è stata annullata dal salone.`;

    const targets = VAPID_PRIVATE_KEY ? subscriptions.filter(s => s.role === 'customer' && s.bookingId === bk.id) : [];
    let delivered = 0;
    const payload = JSON.stringify({ title: 'Prenotazione annullata', body, url: '/' });
    for (const target of targets) {
      try {
        await webPush.sendNotification(target.subscription, payload);
        delivered++;
      } catch (err) {
        console.error('[CANCEL-NOTIFY] Push failed:', err.message);
      }
    }
    if (delivered === 0 && bk.phone) {
      try {
        await sendCustomerText(bk.phone, body);
      } catch (err) {
        console.error('[CANCEL-NOTIFY] SMS fallback failed:', err.message);
      }
    }
  }
}
