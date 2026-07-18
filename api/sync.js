import webPush from 'web-push';
import {
  getSalonsDb, setSalonsDb, getAllBookings, kvCmd,
  tryAcquireSlotLock, promoteLock, releaseSlotLock, hsetBooking,
  acquireBarberDayLock, releaseBarberDayLock, checkRateLimit,
  ensureMigratedV2, getAdminDb, setAdminDb,
  acquireBillingLock, releaseBillingLock, claimCancellationNotifyOnce,
  acquirePushSubsLock, releasePushSubsLock
} from '../lib/kv.js';
import { sendCustomerText, toE164, twilioConfigured, isValidItalianPhone } from '../lib/sms.js';
import { sendEmail, escapeHtml } from '../lib/email.js';
import { handleLogin, handleChangePassword, getVerifiedSession, getClientIp, verifyAdminPassword, hashPassword, isHashedPassword } from '../lib/auth.js';
import { isQuietHours, romeYearMonth, romeNow } from '../lib/time.js';
import { feeForWorkerCount } from '../lib/billing.js';
import { paypalFetch, paypalConfigured, cancelPaypalSubscription } from '../lib/paypal.js';

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

// Every booking carries the customer's name + phone. Sending that back
// unscoped (as this endpoint used to) meant any anonymous visitor — or any
// other salon's staff — could read every customer's contact info across the
// whole platform. This is the one gate all of that goes through:
//   - admin session -> everything, unchanged.
//   - owner session -> their own salon's bookings (every worker) — the
//     dashboard's cross-barber "Stato salone" widget and stats need this.
//   - barber session -> only THEIR OWN bookings within their own salon. The
//     client already only ever renders a barber's own calendar/stats
//     (SESSION.workerId filters throughout js/app.js) — this used to ship
//     every OTHER barber's bookings (including customer name/phone) to a
//     barber's client too, just relying on the UI not to show them; a
//     barber with devtools open could read (and, before the
//     isStaffForThisBooking fix below, cancel or mark-complete) any
//     colleague's appointments.
//   - no/invalid session (anonymous, or a customer's own device) -> only the
//     one salon the client is actually viewing (?salonId=... — the client
//     resolves this from the current #SLUG/#/s/SLUG before fetching), with
//     name/phone stripped. This used to ship EVERY salon's full booking
//     calendar (dates, times, services, prices, worker assignments) to any
//     anonymous caller regardless of which salon they were looking at — a
//     real cross-tenant business-data leak, not just a PII one. A caller
//     with no salonId hint (first paint before the salon is resolved locally)
//     gets nothing rather than everything; the 6s poll picks it up moments
//     later once the salon is known.
function scopeBookingsForSession(bookings, session, requestedSalonId, barberStillEmployed = true) {
  if (session && session.role === 'admin') return bookings;
  if (session && session.role === 'owner') {
    return bookings.filter(b => b.salonId === session.salonId);
  }
  if (session && session.role === 'barber') {
    // A deleted worker's token stays valid up to 30 days (stateless,
    // no revocation list) — the caller resolves whether they're still
    // actually in the salon's current worker list and passes it in, so a
    // removed barber's own bookings (real customer names/phones) stop
    // being served the moment they're removed, not up to a month later.
    if (!barberStillEmployed) return [];
    return bookings.filter(b => b.salonId === session.salonId && b.workerId === session.workerId);
  }
  if (typeof requestedSalonId !== 'string' || !requestedSalonId) return [];
  return bookings
    .filter(b => b.salonId === requestedSalonId)
    .map(({ name, phone, ...rest }) => rest);
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
  const { salonId, workerId, author, phone, comment, rating } = body;
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
  // A review used to need nothing more than a public salon/worker id (both
  // visible to any site visitor) — anyone could post fabricated reviews for
  // any salon, with no proof they were ever actually a customer. Now
  // requires the same proof-of-patronage the customer self-cancel path
  // already holds callers to: a real booking with THIS worker, at THIS
  // salon, under a matching phone number.
  const reviewerPhone = toE164(phone);
  if (!reviewerPhone) return { status: 400, json: { success: false, error: 'invalid_phone' } };
  const bookingsMap = await getAllBookings(kvUrl, kvToken);
  const hasRealBooking = Array.from(bookingsMap.values()).some(b =>
    b.salonId === salonId && b.workerId === workerId && b.phone && toE164(b.phone) === reviewerPhone);
  if (!hasRealBooking) return { status: 403, json: { success: false, error: 'no_matching_booking' } };

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

// The promo/coupon banner on the public marketing page (trimio.org, vLogin)
// — same storage pattern as handleUpdateHomepagePhotos above (admin_db blob,
// admin-session-gated). This used to only ever be written to the editing
// admin's own localStorage via the generic bulk saveState() call, which
// never actually included it in its POST body — every other device/session
// silently kept seeing the hardcoded default text, forever.
async function handleUpdateHomepageAd(body, kvUrl, kvToken, req) {
  const session = getVerifiedSession(req);
  if (!session || session.role !== 'admin') {
    return { status: 403, json: { success: false, error: 'forbidden' } };
  }
  const ad = body.ad && typeof body.ad === 'object' ? body.ad : {};
  const cleaned = {
    title: (typeof ad.title === 'string' ? ad.title : '').trim().slice(0, 60),
    description: (typeof ad.description === 'string' ? ad.description : '').trim().slice(0, 300),
    btnText: (typeof ad.btnText === 'string' ? ad.btnText : '').trim().slice(0, 30),
    code: (typeof ad.code === 'string' ? ad.code : '').trim().slice(0, 40)
  };
  const admin = await getAdminDb(kvUrl, kvToken);
  await setAdminDb(kvUrl, kvToken, { ...admin, homepageAd: cleaned });
  return { status: 200, json: { success: true, homepageAd: cleaned } };
}

// Sends a 6-digit SMS code the signup wizard's step 2 must echo back before
// continuing — real proof the phone is reachable by whoever is registering,
// not just typed in (see the signup_otp_sent gate in handleSignupSalon).
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

  // Marks that a real request reached this endpoint for this phone, whether
  // or not Twilio actually manages to deliver the code — this is what
  // closes handleSignupSalon's "just never call this endpoint" bypass below,
  // without reintroducing the trial-account lockout signup_otp_sent (below)
  // was designed to avoid: a number Twilio genuinely can't reach still lets
  // the signup through, but only after a real attempt was made for it.
  await kvCmd(kvUrl, kvToken, ['SET', `signup_otp_attempted:${phone}`, '1', 'EX', '700']);

  const code = String(Math.floor(100000 + Math.random() * 900000));
  await kvCmd(kvUrl, kvToken, ['SET', `signup_otp:${phone}`, code, 'EX', '600']);
  const sent = await sendCustomerText(phone, `Il tuo codice di verifica TRIMIO è: ${code}`);
  if (!sent) return { status: 200, json: { success: false, error: 'sms_unavailable' } };
  // Only now — an actual send succeeded for THIS phone — does
  // handleSignupSalon's gate require verification. twilioConfigured() alone
  // isn't enough: the account can be configured yet still fail to deliver to
  // a given number (e.g. a Twilio trial account's "verified numbers only"
  // restriction), which would otherwise permanently lock every real signup
  // out with phone_not_verified despite no code ever having reached anyone.
  await kvCmd(kvUrl, kvToken, ['SET', `signup_otp_sent:${phone}`, '1', 'EX', '700']);
  return { status: 200, json: { success: true } };
}

async function handleVerifySignupOtp(body, kvUrl, kvToken, req) {
  const phone = toE164(body.phone);
  const code = typeof body.code === 'string' ? body.code.trim() : '';
  if (!phone || !/^\d{4,6}$/.test(code)) return { status: 400, json: { success: false, error: 'missing_fields' } };

  // The request side (above) was rate-limited from the start, but the
  // VERIFY side — the actual guess against a 6-digit code, 1,000,000
  // possibilities, valid for 10 minutes — had no limit at all. Requesting
  // an OTP for a victim's real phone (one unwanted SMS, but the attacker
  // never needs to read it) then flooding this endpoint with guesses was
  // trivially fast enough to win within the code's lifetime.
  const rlIp = await checkRateLimit(kvUrl, kvToken, `ratelimit:otpverify_ip:${getClientIp(req)}`, 15, 3600);
  if (!rlIp.allowed) return { status: 429, json: { success: false, error: 'rate_limited' } };
  const rlPhone = await checkRateLimit(kvUrl, kvToken, `ratelimit:otpverify_phone:${phone}`, 8, 3600);
  if (!rlPhone.allowed) return { status: 429, json: { success: false, error: 'rate_limited' } };

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
  // No real geocoding/format validation exists (or is planned) for this
  // field — it's accepted as free text. This is a light sanity check only:
  // a real street address is essentially never a single word ("Via Roma 12"
  // vs "asdf"), so requiring a space catches obvious garbage without
  // rejecting legitimate addresses this can't actually verify.
  if (address.length < 5 || !/\s/.test(address)) return { status: 400, json: { success: false, error: 'invalid_address' } };
  // The client (suSubmit, js/app.js) also requires the typed signature to
  // match the declared owner name — this is the one server-side check that
  // was missing it, only verifying a bare length minimum. A direct API call
  // could otherwise persist a "signed" contract whose name has nothing to
  // do with the declared owner, undermining the one thing admin's "Nuove
  // Richieste" review actually relies on this field for.
  if (!body.contractAccepted || contractSignedName.length < 2
      || contractSignedName.toLowerCase() !== ownerName.toLowerCase()) {
    return { status: 400, json: { success: false, error: 'contract_not_accepted' } };
  }

  if (!isValidItalianPhone(body.ownerPhone)) return { status: 400, json: { success: false, error: 'invalid_phone' } };
  const ownerPhone = toE164(body.ownerPhone);
  // Kept as the human-formatted string the client sent (matches how
  // admin-created salons store their public contact phone), just required
  // to at least look like a real number — toE164/isValidItalianPhone only
  // used to validate.
  const salonPhone = typeof body.phone === 'string' ? body.phone.trim() : '';
  if (!isValidItalianPhone(salonPhone)) return { status: 400, json: { success: false, error: 'invalid_salon_phone' } };

  const workerCountNum = Number(body.declaredWorkerCount);
  if (!Number.isFinite(workerCountNum) || workerCountNum < 1) {
    return { status: 400, json: { success: false, error: 'invalid_worker_count' } };
  }

  const rl = await checkRateLimit(kvUrl, kvToken, `ratelimit:signup:${getClientIp(req)}`, 5, 3600);
  if (!rl.allowed) return { status: 429, json: { success: false, error: 'rate_limited' } };

  // Real anti-fraud gate: verification is only ever REQUIRED if an OTP was
  // actually, successfully dispatched to this exact phone (signup_otp_sent,
  // set by request_signup_otp only after sendCustomerText returns true) —
  // not merely "is Twilio configured". A configured-but-non-delivering
  // account (e.g. a Twilio trial account's verified-numbers-only
  // restriction) would otherwise permanently lock out every real signup
  // with phone_not_verified despite no code ever having reached anyone.
  const otpWasSent = await kvCmd(kvUrl, kvToken, ['GET', `signup_otp_sent:${ownerPhone}`]);
  if (otpWasSent) {
    // Atomic claim-and-consume: DEL returns how many keys it actually
    // removed, so exactly one concurrent request can ever get a truthy
    // result here — this used to be a plain GET (non-consuming), with the
    // flag only deleted much later after the whole salon was successfully
    // created. Two requests sharing one phone's verification (a real
    // scenario: a double-tapped submit, or two tabs) could both read
    // "verified" before either consumed it, and both create a pending
    // salon from the same single OTP proof.
    const claimed = await kvCmd(kvUrl, kvToken, ['DEL', `signup_otp_verified:${ownerPhone}`]);
    if (!claimed) return { status: 403, json: { success: false, error: 'phone_not_verified' } };
  } else if (twilioConfigured()) {
    // Twilio IS available in this deployment, so every genuine signer has
    // the means to prove their number — require they at least WENT THROUGH
    // request_signup_otp for this phone (even if delivery itself then
    // failed, e.g. a Twilio trial account's verified-numbers-only
    // restriction — the documented reason this whole gate doesn't hard-
    // require signup_otp_sent by itself, preserved above). A caller who
    // never calls request_signup_otp at all — simply skipping the endpoint
    // rather than fighting the gate — used to sail through with a
    // completely unverified/fabricated phone number; now rejected here.
    const attempted = await kvCmd(kvUrl, kvToken, ['GET', `signup_otp_attempted:${ownerPhone}`]);
    if (!attempted) return { status: 403, json: { success: false, error: 'otp_not_requested' } };
  }

  // A brand-new salon has no id yet to lock on individually (unlike editing
  // an existing one) — serialize ALL new-salon creation behind one fixed
  // global key instead, reusing the same per-id lock primitive with a
  // pseudo-id that can never collide with a real salon id (those are always
  // 'salon'+Date.now()/'salon<N>'). Without this, two people self-
  // registering within the same read-modify-write window (a marketing push,
  // a shared referral link) could both read the same pre-write salons_db
  // snapshot, both pass their own username/slug uniqueness check against
  // that stale snapshot, and the second setSalonsDb call — a raw overwrite,
  // not a merge — would silently erase the first signup, which had already
  // returned {success:true} to that owner.
  const signupLocked = await acquireBillingLock(kvUrl, kvToken, 'new_salon_creation');
  if (!signupLocked) return { status: 503, json: { success: false, error: 'busy' } };
  let declaredWorkerCount;
  try {
    const salons = await getSalonsDb(kvUrl, kvToken);
    if (salons.some(s => s.ownerUsername === username)) {
      return { status: 409, json: { success: false, error: 'username_taken' } };
    }

    const baseSlug = salonName.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'SALONE';
    let slug = baseSlug, n = 2;
    while (salons.some(s => s.slug === slug)) slug = `${baseSlug}_${n++}`;

    declaredWorkerCount = Math.max(1, Math.min(200, Math.round(workerCountNum)));

    salons.push({
      id: 'salon' + Date.now(),
      name: salonName, slug,
      city, address, phone: salonPhone, promo: '',
      bgImage: '', gallery: [], themeColor: '#e5c158',
      closedDays: [], bookingDays: 30,
      services: DEFAULT_SERVICES.map(s => ({ ...s })),
      workers: [],
      ownerUsername: username, ownerPassword: hashPassword(password),
      ownerName, ownerPhone, email,
      inactive: true,
      billing: {
        declaredWorkerCount,
        paidThroughMonth: romeYearMonth(), // first partial month is free
        pendingApproval: true,
        contractSignedAt: new Date().toISOString(),
        contractSignedName,
        signupIp: getClientIp(req) // fraud-review signal for admin, not enforcement
      }
    });
    await setSalonsDb(kvUrl, kvToken, salons);
  } finally {
    await releaseBillingLock(kvUrl, kvToken, 'new_salon_creation');
  }
  // signup_otp_verified was already atomically claimed (deleted) above;
  // only signup_otp_sent still needs cleanup here.
  try {
    await kvCmd(kvUrl, kvToken, ['DEL', `signup_otp_sent:${ownerPhone}`]);
  } catch { /* best-effort cleanup */ }
  // Must be awaited (not fire-and-forget) — Vercel can freeze the function
  // right after the response is sent, same reason booking pushes are
  // awaited above.
  await notifyAdminsOfNewSignup(salonName, kvUrl, kvToken);
  await sendEmail(ADMIN_NOTIFY_EMAIL, '🆕 TRIMIO — Nuovo salone in attesa di approvazione',
    `<p>Un nuovo salone si è registrato e attende la tua conferma:</p>
     <ul>
       <li><b>Salone:</b> ${escapeHtml(salonName)}</li>
       <li><b>Proprietario:</b> ${escapeHtml(ownerName)} (${escapeHtml(username)}, ${escapeHtml(ownerPhone)})</li>
       <li><b>Email:</b> ${escapeHtml(email)}</li>
       <li><b>Indirizzo:</b> ${escapeHtml(address)}, ${escapeHtml(city)}</li>
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
  // Every other push sender in this file respects Italy quiet hours
  // (8:00-20:00) — this one didn't, so a self-signup submitted at 3am woke
  // every admin device immediately. A new pending salon isn't so urgent it
  // can't wait until morning; admin still sees it in "Nuove Richieste" the
  // moment they next open the dashboard either way.
  if (isQuietHours()) return;
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

// Admin-only, destructive, one-shot "start fresh with real salons" action —
// wipes every salon/worker/booking/push-subscription/slot-lock currently
// stored, used once when the business switches from test/demo data to real
// production data. Requires the admin's actual current password (verified
// here server-side too, not just in the UI) so this can't fire by accident
// or from someone who only knows a static confirmation phrase. Folded in
// from the former standalone api/reset-all-data.js — same body.password +
// verifyAdminPassword auth shape, unchanged — to free a Vercel function slot
// for the payment webhook endpoint (Hobby plan caps a deployment at 12).
async function handleResetAllData(body, kvUrl, kvToken, req) {
  if (!body || typeof body.password !== 'string' || !body.password) {
    return { status: 400, json: { success: false, error: 'Missing password' } };
  }
  if (!(await verifyAdminPassword(body.password, kvUrl, kvToken, req))) {
    return { status: 401, json: { success: false, error: 'Incorrect password' } };
  }

  await setSalonsDb(kvUrl, kvToken, []);
  await kvCmd(kvUrl, kvToken, ['DEL', 'bookings']);
  await kvCmd(kvUrl, kvToken, ['DEL', 'push_subscriptions']);

  const lockKeys = await kvCmd(kvUrl, kvToken, ['KEYS', 'lock:*']);
  if (Array.isArray(lockKeys) && lockKeys.length > 0) {
    await kvCmd(kvUrl, kvToken, ['DEL', ...lockKeys]);
  }

  return { status: 200, json: { success: true } };
}

// Admin-only: confirms this month's fee was received (payment is manual for
// now — no bank/card processor wired up yet). Also reactivates a salon that
// had been auto-suspended by the daily billing check (api/daily-health-check.js),
// but never touches an `inactive` flip the admin made for an unrelated reason.
async function handleMarkSalonPaid(body, kvUrl, kvToken, req) {
  const session = getVerifiedSession(req);
  if (!session || session.role !== 'admin') return { status: 403, json: { success: false, error: 'forbidden' } };
  if (!body.salonId) return { status: 400, json: { success: false, error: 'missing_fields' } };

  // Same per-salon lock every other billing-mutating path uses — an admin
  // marking a salon paid at the same moment a PayPal webhook updates that
  // salon's billing object could otherwise lose one side's write.
  const locked = await acquireBillingLock(kvUrl, kvToken, body.salonId);
  if (!locked) return { status: 503, json: { success: false, error: 'busy' } };
  try {
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
  } finally {
    await releaseBillingLock(kvUrl, kvToken, body.salonId);
  }
}

// Admin-only: opts an admin-created salon (which has no billing object at
// all by default — see CLAUDE.md) into the billing system on request, e.g.
// an owner who wants automatic PayPal billing but can't self-signup a whole
// new account for it. Starts them "paid up" for the current month rather
// than backdating an obligation for time they were never actually billed
// for — no surprise retroactive warning/suspension.
async function handleEnableSalonBilling(body, kvUrl, kvToken, req) {
  const session = getVerifiedSession(req);
  if (!session || session.role !== 'admin') return { status: 403, json: { success: false, error: 'forbidden' } };
  if (!body.salonId) return { status: 400, json: { success: false, error: 'missing_fields' } };

  // Same per-salon lock api/paypal-webhook.js uses — this read-modify-write
  // must never race a webhook event landing for this salon at the same time.
  const locked = await acquireBillingLock(kvUrl, kvToken, body.salonId);
  if (!locked) return { status: 503, json: { success: false, error: 'busy' } };
  try {
    const salons = await getSalonsDb(kvUrl, kvToken);
    const salon = salons.find(s => s.id === body.salonId);
    if (!salon) return { status: 404, json: { success: false, error: 'salon_not_found' } };
    if (salon.billing) return { status: 409, json: { success: false, error: 'already_enabled' } };

    salon.billing = {
      declaredWorkerCount: Math.max((salon.workers || []).length, 1),
      paidThroughMonth: romeYearMonth(),
      pendingApproval: false
    };
    await setSalonsDb(kvUrl, kvToken, salons);
    return { status: 200, json: { success: true, billing: salon.billing } };
  } finally {
    await releaseBillingLock(kvUrl, kvToken, body.salonId);
  }
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

  // Same per-salon lock every other billing-mutating path uses (the
  // sibling toggle-salon.js Attiva path already had it) — this was the one
  // salons_db read-modify-write in this file still missing it, closing a
  // race against a concurrent webhook event or another admin action for
  // the same salon.
  const locked = await acquireBillingLock(kvUrl, kvToken, body.salonId);
  if (!locked) return { status: 503, json: { success: false, error: 'busy' } };
  let salon;
  try {
    const salons = await getSalonsDb(kvUrl, kvToken);
    salon = salons.find(s => s.id === body.salonId);
    if (!salon) return { status: 404, json: { success: false, error: 'salon_not_found' } };
    if (!salon.billing || !salon.billing.pendingApproval) {
      return { status: 409, json: { success: false, error: 'not_pending' } };
    }

    salon.inactive = false;
    salon.billing.pendingApproval = false;
    await setSalonsDb(kvUrl, kvToken, salons);
  } finally {
    await releaseBillingLock(kvUrl, kvToken, body.salonId);
  }

  const link = `https://trimio.org/s/${encodeURIComponent(salon.slug)}`;
  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=${encodeURIComponent(link)}`;
  await sendEmail(salon.email, '🎉 TRIMIO — Il tuo salone è stato approvato!',
    `<p>Ciao ${escapeHtml(salon.ownerName || '')},</p>
     <p>Il tuo salone <b>${escapeHtml(salon.name)}</b> è stato approvato ed è ora attivo su TRIMIO!</p>
     <p><b>Accesso proprietario:</b><br>
     Username: ${escapeHtml(salon.ownerUsername)}<br>
     Password: quella che hai scelto in fase di registrazione.</p>
     <p><b>Link di prenotazione del tuo salone:</b><br><a href="${link}">${link}</a></p>
     <p>I tuoi clienti possono anche scansionare questo QR code per prenotare direttamente:</p>
     <img src="${qrUrl}" alt="QR Code" width="200" height="200">`);

  return { status: 200, json: { success: true } };
}

// The Product + Plan are long-lived and shared across every salon (only the
// price is overridden per-subscription below) — created lazily on first use
// and cached on admin_db so we don't recreate them on every checkout.
async function ensurePaypalPlan(kvUrl, kvToken) {
  const admin = await getAdminDb(kvUrl, kvToken);
  if (admin.paypalPlanId) return admin.paypalPlanId;

  // The very first two owners to ever activate billing (before this shared
  // Plan exists) could otherwise both read admin.paypalPlanId as unset
  // concurrently — this is called from handleCreateBillingCheckoutSession,
  // which only locks the CALLER's own salonId, so two DIFFERENT salons'
  // first-ever activations don't block each other here at all — and each
  // create their own separate PayPal Product+Plan, with the second
  // setAdminDb call silently winning and orphaning the first at PayPal
  // (cosmetic clutter — both subscriptions still work off their own valid
  // plan id — but avoidable). Locked on a fixed pseudo-id (this init only
  // ever needs to happen once, platform-wide, not per-salon), re-checking
  // after acquiring it in case another request already finished while this
  // one waited.
  const locked = await acquireBillingLock(kvUrl, kvToken, 'paypal_plan_init');
  if (!locked) throw new Error('Could not acquire lock to initialize the shared PayPal plan');
  try {
    const freshAdmin = await getAdminDb(kvUrl, kvToken);
    if (freshAdmin.paypalPlanId) return freshAdmin.paypalPlanId;

    const product = await paypalFetch('/v1/catalogs/products', {
      method: 'POST',
      body: { name: 'TRIMIO - Canone mensile', type: 'SERVICE' }
    });
    const plan = await paypalFetch('/v1/billing/plans', {
      method: 'POST',
      body: {
        product_id: product.id,
        name: 'TRIMIO Monthly',
        status: 'ACTIVE',
        billing_cycles: [{
          frequency: { interval_unit: 'MONTH', interval_count: 1 },
          tenure_type: 'REGULAR',
          sequence: 1,
          total_cycles: 0, // 0 = renews until cancelled, not a fixed-term plan
          pricing_scheme: { fixed_price: { value: '1.00', currency_code: 'EUR' } }
        }],
        payment_preferences: { auto_bill_outstanding: true, payment_failure_threshold: 3 }
      }
    });
    await setAdminDb(kvUrl, kvToken, { ...freshAdmin, paypalProductId: product.id, paypalPlanId: plan.id });
    return plan.id;
  } finally {
    await releaseBillingLock(kvUrl, kvToken, 'paypal_plan_init');
  }
}

// Owner-only, own-salon: creates a PayPal subscription so the owner can
// activate automatic monthly card billing — an opt-in alternative to the
// existing manual bank-transfer + admin mark-paid flow, never required.
// Only self-signup salons (which carry a `billing` object) are eligible;
// admin-created salons aren't billed at all.
async function handleCreateBillingCheckoutSession(body, kvUrl, kvToken, req) {
  const session = getVerifiedSession(req);
  if (!session || session.role !== 'owner' || session.salonId !== body.salonId) {
    return { status: 403, json: { success: false, error: 'forbidden' } };
  }
  if (!paypalConfigured()) {
    return { status: 200, json: { success: false, error: 'not_configured' } };
  }

  // Longer TTL than the default 10s — this critical section makes multiple
  // real PayPal network calls below (see acquireBillingLock's comment).
  const locked = await acquireBillingLock(kvUrl, kvToken, body.salonId, 25);
  if (!locked) return { status: 503, json: { success: false, error: 'busy' } };
  try {
    const salons = await getSalonsDb(kvUrl, kvToken);
    const salon = salons.find(s => s.id === body.salonId);
    if (!salon) return { status: 404, json: { success: false, error: 'salon_not_found' } };
    if (!salon.billing) return { status: 409, json: { success: false, error: 'billing_not_applicable' } };
    if (salon.billing.autopay) return { status: 200, json: { success: false, error: 'already_active' } };

    // A previous checkout was started but never approved (abandoned tab,
    // owner clicked "Attiva" twice, two tabs/devices racing) — this used to
    // unconditionally best-effort cancelPaypalSubscription() the stale one
    // and barrel ahead to create a fresh subscription regardless of whether
    // that cancel actually succeeded. PayPal's /cancel endpoint only accepts
    // ACTIVE/SUSPENDED subscriptions — a subscription still awaiting the
    // owner's approval is APPROVAL_PENDING, which /cancel rejects, so the
    // "stale" one was silently left alive and approvable while a SECOND
    // subscription was created and returned as the new checkout link. If
    // the owner then completed approval on both (plausible — they clicked
    // "Attiva" twice because the first seemed to hang), two real PayPal
    // subscriptions went active for one salon: genuine double-billing, with
    // nothing in TRIMIO ever tracking or cancelling the orphaned one.
    // Fetching the real current status first and branching on it closes
    // this: an already-active one is never silently superseded, a still-
    // pending one is reused (its own approve link handed back again)
    // instead of creating a competing second subscription, and only a
    // genuinely dead one (or a real cancel that actually succeeds) clears
    // the way for a fresh subscription below.
    if (salon.billing.paypalSubscriptionId) {
      const staleId = salon.billing.paypalSubscriptionId;
      // A caught fetch failure used to be treated identically to "this
      // subscription genuinely doesn't exist" regardless of WHY it failed
      // — a transient network blip or PayPal 5xx at exactly the moment of
      // a repeat "Attiva" click would fall through to creating a second
      // subscription anyway, reopening a narrower version of the double-
      // billing race this whole check exists to close. Only a confirmed
      // 404 means "genuinely gone"; any other failure aborts instead of
      // silently proceeding.
      let staleSub = null;
      try {
        staleSub = await paypalFetch(`/v1/billing/subscriptions/${encodeURIComponent(staleId)}`);
      } catch (err) {
        if (err.status !== 404) {
          console.error('[BILLING] Could not verify stale subscription status, aborting rather than risk a duplicate:', err.message);
          return { status: 502, json: { success: false, error: 'paypal_error' } };
        }
        // Confirmed 404 — genuinely gone, nothing to reuse or cancel.
      }
      const staleStatus = staleSub && staleSub.status;
      if (staleStatus === 'ACTIVE') {
        // Shouldn't normally be reachable (the ACTIVATED webhook would
        // already have flipped billing.autopay=true, caught above) — but a
        // truly active subscription must never be superseded by a second
        // one, which is exactly the double-billing scenario this exists to
        // prevent.
        return { status: 200, json: { success: false, error: 'already_active' } };
      }
      if (staleStatus === 'APPROVAL_PENDING') {
        const approveLink = (staleSub.links || []).find(l => l.rel === 'approve');
        if (approveLink) {
          return { status: 200, json: { success: true, url: approveLink.href } };
        }
        // No approve link for some reason — fall through and create fresh.
      } else if (staleStatus) {
        // SUSPENDED or any other cancellable-but-not-pending/active state.
        await cancelPaypalSubscription(staleId, 'Superseded by a new checkout attempt');
      }
      // staleStatus === null here only means a confirmed 404 — genuinely
      // gone at PayPal — nothing to reuse or cancel, proceed below.
    }

    const fee = feeForWorkerCount(Math.max((salon.workers || []).length, salon.billing.declaredWorkerCount || 0));

    let subscription;
    try {
      const planId = await ensurePaypalPlan(kvUrl, kvToken);
      subscription = await paypalFetch('/v1/billing/subscriptions', {
        method: 'POST',
        body: {
          plan_id: planId,
          // Echoed back on every webhook event for this subscription — the
          // PayPal equivalent of Stripe's client_reference_id/metadata, used
          // to correlate an incoming event back to a salon.
          custom_id: salon.id,
          // Per-subscription price override — PayPal has no ad-hoc "price at
          // checkout" object like Stripe's price_data, so the shared Plan
          // carries a placeholder price and every real subscription overrides
          // it with this salon's actual fee tier.
          plan: {
            billing_cycles: [{
              sequence: 1,
              // Matches the base plan's own total_cycles (ensurePaypalPlan
              // above) explicitly, rather than relying on this override
              // implicitly inheriting it — an unconfirmed assumption not
              // worth carrying into money-handling code.
              total_cycles: 0,
              pricing_scheme: { fixed_price: { value: fee.toFixed(2), currency_code: 'EUR' } }
            }]
          },
          application_context: {
            brand_name: 'TRIMIO',
            user_action: 'SUBSCRIBE_NOW',
            return_url: 'https://trimio.org/#DASHBOARD',
            cancel_url: 'https://trimio.org/#DASHBOARD'
          }
        }
      });
    } catch (err) {
      console.error('[BILLING] PayPal subscription creation failed:', err.message);
      return { status: 502, json: { success: false, error: 'paypal_error' } };
    }

    const approveLink = (subscription.links || []).find(l => l.rel === 'approve');
    if (!approveLink) {
      console.error('[BILLING] PayPal subscription response missing approve link:', JSON.stringify(subscription));
      return { status: 502, json: { success: false, error: 'paypal_error' } };
    }

    // Persisted immediately (pending) so a reload before the ACTIVATED
    // webhook lands doesn't lose the association — autopay itself only
    // flips true once api/paypal-webhook.js confirms the buyer approved it.
    salon.billing.paypalSubscriptionId = subscription.id;
    try {
      await setSalonsDb(kvUrl, kvToken, salons);
    } catch (err) {
      // The real PayPal subscription now exists but TRIMIO never recorded
      // its id anywhere — left alone, it becomes a phantom, untracked
      // APPROVAL_PENDING subscription at PayPal (harmless — it never
      // charges until approved — but invisible to the "cancel any stale
      // subscription before creating a new one" check above on a retry,
      // since that check only ever looks at salon.billing.paypalSubscriptionId,
      // which was never saved). Best-effort cleanup: cancel it now rather
      // than leave an orphan for a future retry to never find.
      console.error('[BILLING] setSalonsDb failed after creating PayPal subscription — cancelling it to avoid an orphan:', err.message);
      await cancelPaypalSubscription(subscription.id, 'TRIMIO failed to record this subscription');
      return { status: 500, json: { success: false, error: 'internal_error' } };
    }

    return { status: 200, json: { success: true, url: approveLink.href } };
  } finally {
    await releaseBillingLock(kvUrl, kvToken, body.salonId);
  }
}

// Owner-only, own-salon: cancels the PayPal subscription directly — PayPal
// has no Stripe-Billing-Portal equivalent to redirect to for self-service
// card updates, so this is a direct API call instead. Card updates aren't
// possible on an existing subscription either way; the owner reactivates
// (a new subscription) if they need to change the card. Requires autopay to
// have already been activated at least once (there's a subscription to act on).
async function handleCancelBillingSubscription(body, kvUrl, kvToken, req) {
  const session = getVerifiedSession(req);
  if (!session || session.role !== 'owner' || session.salonId !== body.salonId) {
    return { status: 403, json: { success: false, error: 'forbidden' } };
  }
  if (!paypalConfigured()) {
    return { status: 200, json: { success: false, error: 'not_configured' } };
  }

  const locked = await acquireBillingLock(kvUrl, kvToken, body.salonId);
  if (!locked) return { status: 503, json: { success: false, error: 'busy' } };
  try {
    const salons = await getSalonsDb(kvUrl, kvToken);
    const salon = salons.find(s => s.id === body.salonId);
    if (!salon) return { status: 404, json: { success: false, error: 'salon_not_found' } };
    if (!salon.billing || !salon.billing.paypalSubscriptionId) {
      return { status: 409, json: { success: false, error: 'no_subscription' } };
    }

    const cancelled = await cancelPaypalSubscription(salon.billing.paypalSubscriptionId, 'Disattivato dal proprietario dal pannello TRIMIO');
    if (!cancelled) return { status: 502, json: { success: false, error: 'paypal_error' } };

    // autopay reflected immediately rather than waiting for the CANCELLED
    // webhook — the owner is looking at this screen right now and the
    // cancel call above already succeeded synchronously. paypalSubscriptionId
    // is cleared too (not left pointing at the now-dead subscription) so a
    // stale/delayed webhook for it (e.g. a late PAYMENT.FAILED or SUSPENDED)
    // can no longer correlate to this salon and re-suspend someone who
    // already opted out.
    salon.billing.autopay = false;
    salon.billing.paypalSubscriptionId = null;
    await setSalonsDb(kvUrl, kvToken, salons);

    return { status: 200, json: { success: true } };
  } finally {
    await releaseBillingLock(kvUrl, kvToken, body.salonId);
  }
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

// A brand-new salon (no `existing` match in the bulk-save loop below) can
// only ever come from an admin session — an owner's isAuthorizedEditor check
// requires session.salonId === incoming.id, which only ever matches a salon
// they already own. Until now, isValidSalonsArray's bare "has a non-empty
// id" check was the ONLY server-side validation a new salon got; everything
// else (name, slug, owner credentials) was trusted verbatim from the client.
// A duplicate slug in particular silently made a salon unreachable by its
// own URL/QR code (every slug lookup is a first-match find()), with no
// error surfaced anywhere.
function isValidNewSalon(s, existingSalonsMap) {
  if (typeof s.name !== 'string' || s.name.trim().length < 2) return false;
  if (typeof s.slug !== 'string' || !/^[A-Z0-9_]{2,50}$/.test(s.slug)) return false;
  if (typeof s.ownerUsername !== 'string' || !/^[a-zA-Z0-9._-]{3,30}$/.test(s.ownerUsername)) return false;
  // Matches handleSignupSalon's own rules (password length, real phone
  // format via toE164, minimum address length) — this path (an admin's
  // "Nuovo salone" panel) used to accept a 4-character password and skip
  // phone/address validation entirely server-side; the client UI already
  // checks phone but not password length or address, and neither check
  // existed at all against a direct API call bypassing the client.
  if (typeof s.ownerPassword !== 'string' || s.ownerPassword.length < 6) return false;
  if (typeof s.phone !== 'string' || !isValidItalianPhone(s.phone)) return false;
  // Same light "not a single word" sanity check as handleSignupSalon.
  if (typeof s.address !== 'string' || s.address.trim().length < 5 || !/\s/.test(s.address.trim())) return false;
  // handleSignupSalon requires city.length>=2 — this path (admin-created
  // salon) had no check on it at all, a parity gap versus self-signup.
  if (typeof s.city !== 'string' || s.city.trim().length < 2) return false;
  for (const other of existingSalonsMap.values()) {
    if (other.id === s.id) continue;
    if (other.slug === s.slug) return false;
    if (other.ownerUsername === s.ownerUsername) return false;
  }
  return true;
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
// Same lookup for price — used to re-derive a brand-new booking's price
// server-side instead of trusting whatever the client sent (see the
// !existing branch below). Falls back to 0, never to a client-supplied
// value, for the edge case where the service name doesn't match anything
// currently on the salon (a deleted/renamed service) — this shouldn't occur
// in any legitimate flow (both the customer and manual-booking UI always
// pick a service from the salon's own live list), so it's not worth
// rejecting the booking outright over, but it must never fall back to
// trusting an attacker-chosen number either.
function svcPrice(salon, serviceName) {
  const svcs = salon && Array.isArray(salon.services) && salon.services.length ? salon.services : null;
  const s = svcs ? svcs.find(x => x && x.name === serviceName) : null;
  const n = s ? Number(s.price) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : 0;
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
  // CORS configuration. Access-Control-Allow-Credentials:true combined with
  // a wildcard origin is a real (if currently inert) misconfiguration — the
  // spec/browsers actually refuse to expose a credentialed response to a
  // wildcard-origin request, and this app never uses cookies for auth
  // anyway (every privileged action is Bearer-token-based, read from
  // localStorage and attached manually), so the header served no purpose.
  // Removed as defense in depth against it ever mattering if a cookie-based
  // mechanism is added later.
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
        const session = getVerifiedSession(req);
        // getVerifiedSession returns null identically for "no token sent"
        // and "a token WAS sent but it's expired/forged/malformed" — the
        // client used to have no way to tell those apart, so an expired
        // session silently degraded to anonymous-scoped data (empty/PII-
        // stripped) forever, with no re-login prompt ever surfaced: a
        // barber's "Fatto"/cancel action could appear to succeed locally
        // (dashAction() mutates STATE optimistically) and then silently
        // revert on the next poll once the real, unchanged server record
        // came back. Flag it explicitly so the client can react.
        const hadToken = !!(req.headers && req.headers['authorization']);
        const sessionExpired = hadToken && !session;
        // See the POST handler's own barberStillEmployed for the full
        // rationale — a deleted worker's token stays valid up to 30 days,
        // so their own former bookings (real customer names/phones) must
        // stop being served the moment they're actually removed from the
        // salon's worker list, not up to a month later. `salons` here is
        // the same fresh read already used for sanitizedSalons below.
        let barberStillEmployed = true;
        if (session && session.role === 'barber') {
          const sessionSalon = salons.find(s => s.id === session.salonId);
          barberStillEmployed = !!(sessionSalon && (sessionSalon.workers || []).some(w => w.id === session.workerId));
        }
        const isAdminCaller = !!(session && session.role === 'admin');
        // iban/taxId/signupIp/contract fields, the owner's personal
        // email/name/phone, and their login username are admin-review-only
        // data — this used to strip only the two password fields, so EVERY
        // salon's full record (including every other salon's IBAN/tax id)
        // shipped to any caller, authenticated or not. No client UI outside
        // the admin dashboard reads email/ownerName/ownerPhone/ownerUsername,
        // so those stay admin-only. `billing` itself, though, is also read by
        // the owner's own "Fatturazione" dashboard section (fee tier, paid
        // status, autopay state) — so a salon's own owner needs it back for
        // their own salon specifically, never for any other salon.
        // A pending self-signup salon (not yet admin-approved) or one
        // deactivated by admin/billing must not even be VISIBLE to a caller
        // who isn't admin or that salon's own staff — booking creation was
        // already blocked server-side for one, but the raw record (name,
        // slug, workers...) was still shipped to every anonymous caller via
        // this GET, only ever hidden by client-side UI filters (the public
        // map, the homepage list...). A direct API call bypassed all of
        // that. Own staff can still see their own salon regardless of its
        // state (e.g. an owner checking why their salon shows inactive).
        const visibleSalons = salons.filter(s => !s.inactive || isAdminCaller
          || (session && (session.role === 'owner' || session.role === 'barber') && session.salonId === s.id));
        const sanitizedSalons = visibleSalons.map(({ ownerPassword, workers, billing, email, ownerName, ownerPhone, ownerUsername, ...rest }) => {
          // Every worker's own login username and personal phone number used
          // to ship to ANY caller for EVERY salon on the platform — only the
          // password itself was ever stripped. An anonymous visitor (or any
          // other salon's staff) could read every barber's login username
          // (half of their credentials) and phone number platform-wide by
          // simply calling this endpoint. Name/photo/role/description/
          // reviews/vacation-and-break windows stay public — the anonymous
          // customer booking UI genuinely needs those (worker cards,
          // slot-availability computation) — only username/phone are
          // staff-only now.
          const isOwnSalonStaff = session && session.salonId === rest.id
            && (session.role === 'owner' || (session.role === 'barber' && barberStillEmployed));
          const canSeeWorkerContact = isAdminCaller || isOwnSalonStaff;
          const base = {
            ...rest,
            workers: (workers || []).map(({ password, username, phone, ...w }) => canSeeWorkerContact ? { ...w, username, phone } : w)
          };
          if (isAdminCaller) return { ...base, billing, email, ownerName, ownerPhone, ownerUsername };
          const isOwnSalonOwner = session && session.role === 'owner' && session.salonId === rest.id;
          if (isOwnSalonOwner && billing) {
            // The owner's own "Fatturazione" section (renderFatturazione,
            // js/app.js) only ever reads declaredWorkerCount/paidThroughMonth/
            // paymentFailing/suspendedByBilling/autopay — the FULL billing
            // object used to be handed back here instead, including fields
            // explicitly documented elsewhere in this file as admin-review-
            // only: signupIp (a fraud-review signal — telling the very owner
            // under review that it's tracked lets a bad-faith operator vary
            // IP on a future signup to evade it), contractSignedAt/Name,
            // lastWarningEmailSentDate, pendingApproval, and any legacy iban/
            // taxId/paymentMethod a pre-PayPal-autopay signup may still carry.
            const { declaredWorkerCount, paidThroughMonth, paymentFailing, suspendedByBilling, autopay } = billing;
            return { ...base, billing: { declaredWorkerCount, paidThroughMonth, paymentFailing, suspendedByBilling, autopay } };
          }
          return base;
        });
        const requestedSalonId = req.query && typeof req.query.salonId === 'string' ? req.query.salonId : null;
        return res.status(200).json({
          bookings: scopeBookingsForSession(Array.from(bookingsMap.values()), session, requestedSalonId, barberStillEmployed),
          salons: sanitizedSalons,
          sessionExpired,
          admin: {
            // The platform admin's own login username used to ship to
            // EVERY caller here unconditionally, unlike every other
            // admin-only field this response already gates (ownerPassword,
            // billing, worker username/phone...) — the exact same bug class
            // as the worker-credential leak a prior audit round fixed, just
            // left unswept for the admin account itself. Anyone learning it
            // only needs to guess one credential (the password) instead of
            // two to attack the single highest-value account on the
            // platform. homepagePhotos/homepageAd stay public — they're the
            // public marketing homepage's own content.
            username: isAdminCaller ? admin.username : undefined,
            homepagePhotos: admin.homepagePhotos || [], homepageAd: admin.homepageAd || null
          }
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
          const r = await handleLogin(newData, kvUrl, kvToken, req);
          return res.status(r.status).json(r.json);
        }
        if (newData && newData.action === 'change_password') {
          const r = await handleChangePassword(newData, kvUrl, kvToken, req);
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
        if (newData && newData.action === 'update_homepage_ad') {
          const r = await handleUpdateHomepageAd(newData, kvUrl, kvToken, req);
          return res.status(r.status).json(r.json);
        }
        if (newData && newData.action === 'request_signup_otp') {
          const r = await handleRequestSignupOtp(newData, kvUrl, kvToken, req);
          return res.status(r.status).json(r.json);
        }
        if (newData && newData.action === 'verify_signup_otp') {
          const r = await handleVerifySignupOtp(newData, kvUrl, kvToken, req);
          return res.status(r.status).json(r.json);
        }
        if (newData && newData.action === 'signup_salon') {
          const r = await handleSignupSalon(newData, kvUrl, kvToken, req);
          return res.status(r.status).json(r.json);
        }
        if (newData && newData.action === 'reset_all_data') {
          const r = await handleResetAllData(newData, kvUrl, kvToken, req);
          return res.status(r.status).json(r.json);
        }
        if (newData && newData.action === 'mark_salon_paid') {
          const r = await handleMarkSalonPaid(newData, kvUrl, kvToken, req);
          return res.status(r.status).json(r.json);
        }
        if (newData && newData.action === 'enable_salon_billing') {
          const r = await handleEnableSalonBilling(newData, kvUrl, kvToken, req);
          return res.status(r.status).json(r.json);
        }
        if (newData && newData.action === 'approve_salon') {
          const r = await handleApproveSalon(newData, kvUrl, kvToken, req);
          return res.status(r.status).json(r.json);
        }
        if (newData && newData.action === 'create_billing_checkout_session') {
          const r = await handleCreateBillingCheckoutSession(newData, kvUrl, kvToken, req);
          return res.status(r.status).json(r.json);
        }
        if (newData && newData.action === 'cancel_billing_subscription') {
          const r = await handleCancelBillingSubscription(newData, kvUrl, kvToken, req);
          return res.status(r.status).json(r.json);
        }

        console.log('[SYNC] Saving database state to Vercel KV');

        const session = getVerifiedSession(req);
        // A deleted worker's session token stays cryptographically valid
        // (stateless HMAC, no revocation list) for up to 30 days — without
        // re-checking they're still actually in the salon's CURRENT worker
        // list, a fired/removed barber could keep viewing and cancelling
        // their own former bookings (real customer names/phone numbers)
        // for the rest of that window, with the salon having no way to
        // know. Resolved once per request (not once per booking item in
        // the loop below) and reused everywhere a barber session's
        // authority is checked in this handler.
        let barberStillEmployed = true;
        if (session && session.role === 'barber') {
          const sessionSalons = await getSalonsDb(kvUrl, kvToken);
          const sessionSalon = sessionSalons.find(s => s.id === session.salonId);
          barberStillEmployed = !!(sessionSalon && (sessionSalon.workers || []).some(w => w.id === session.workerId));
        }
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
              const salonForVac = salonsForDur.find(s => s.id === nb.salonId);
              // A pending self-signup salon (not yet admin-approved) or one
              // deactivated/suspended by admin/billing must never actually
              // become bookable — until now this was enforced ONLY by the
              // client UI's inactive-salon alert; a direct POST bypassing it
              // (the salon id/workerId are both visible in the anonymous
              // GET response, needed for slot-availability rendering) could
              // create a real booking against a salon nobody is watching.
              if (!salonForVac || salonForVac.inactive) {
                conflicts.push({ id: nb.id, salonId: nb.salonId, workerId: nb.workerId, dateISO: nb.dateISO, time: nb.time, error: 'salon_inactive' });
                continue;
              }
              // A brand-new booking's price AND duration used to be
              // whatever the client sent, stored verbatim — a customer (no
              // session required for this whole flow) could submit any
              // price for a real service, corrupting the salon's own
              // revenue stats, or a fabricated short duration that fools
              // the overlap check below into thinking the barber frees up
              // long before the service actually finishes, letting a
              // second real booking land on top of it (an actual schedule
              // collision, not just a stats-accuracy issue). Re-derived
              // here from the salon's own current service list — this IS
              // still "snapshotting the price/duration at creation time"
              // (the existing, correct design for surviving a LATER
              // service edit), just computed server-side instead of
              // trusted from the client.
              nb.price = svcPrice(salonForVac, nb.service);
              nb.dur = svcDurMin(salonForVac, nb.service);
              // "Fatto"/completed must only ever be reached by first
              // creating a booking normally (status 'confirmed') and later
              // transitioning it via the existing-booking update branch
              // below, which already rejects marking a future appointment
              // completed. A brand-new booking submitted directly with
              // status:'completed' skipped that check entirely — no
              // legitimate client ever does this (manual staff bookings and
              // customer bookings both always create as 'confirmed'), so
              // this is rejected outright rather than re-implementing the
              // future-date check a second time here.
              if (nb.status === 'completed') {
                conflicts.push({ id: nb.id, error: 'invalid_booking' });
                continue;
              }
              // Defense-in-depth: a new booking for a date already gone in
              // Italy should never be accepted regardless of what the
              // client thinks "today" is (e.g. a customer whose device
              // clock/timezone disagrees with Europe/Rome — the actual gap
              // that motivated moving todayISO()/openDays() onto
              // romeNowParts() client-side). Only the DATE is checked, not
              // the exact time-of-day, so a legitimate walk-in booking
              // entered for "right now" by staff can't be falsely rejected
              // by a few seconds/minutes of request latency.
              if (nb.status !== 'cancelled' && nb.dateISO < romeNow().todayISO) {
                conflicts.push({ id: nb.id, error: 'invalid_booking' });
                continue;
              }
              if (nb.status !== 'cancelled') {
                const worker = (salonForVac.workers || []).find(w => w.id === nb.workerId);
                // An unmatched workerId used to just silently SKIP the
                // vacation/off-day/break check below (no worker found to
                // check it against) instead of rejecting the booking — a
                // caller could pair a real, active salonId with a workerId
                // belonging to a completely different salon and still have
                // the booking accepted. Beyond polluting a foreign salon's
                // calendar with a phantom appointment, sendPushNotifications'
                // barber-target filter matches on workerId alone (not also
                // salonId), so this let an anonymous caller push an
                // arbitrary "Nuova Prenotazione" notification straight to
                // any specific barber on the platform.
                if (!worker) {
                  conflicts.push({ id: nb.id, error: 'invalid_booking' });
                  continue;
                }
                if (isOnVacation(worker, nb.dateISO) || isWeeklyOff(worker, nb.dateISO) || overlapsBreak(worker, nb, salonForVac)) {
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
                // This means contention, not necessarily a real double-
                // booking — a burst of simultaneous requests for the same
                // popular barber+day can exhaust acquireBarberDayLock's wait
                // budget before this request's own turn, even though the
                // slot itself may still be genuinely free. Tagged distinctly
                // from a real overlap/slot-taken conflict below so the
                // client can tell the customer "riprova" instead of
                // "orario già occupato" (misleading — simply retrying the
                // SAME slot moments later would likely succeed here, unlike
                // a genuine conflict where it never would).
                conflicts.push({ id: nb.id, salonId: nb.salonId, workerId: nb.workerId, dateISO: nb.dateISO, time: nb.time, error: 'busy_retry' });
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
                // Independent writes to different keys (the booking hash
                // field vs. the slot lock's TTL) — running them concurrently
                // instead of sequentially shrinks how long this request holds
                // the day-lock, so more bookings for the same busy barber+day
                // can cycle through the lock within acquireBarberDayLock's
                // wait budget instead of piling up behind it.
                await Promise.all([
                  hsetBooking(kvUrl, kvToken, nb),
                  promoteLock(kvUrl, kvToken, nb)
                ]);
                bookingsMap.set(nb.id, nb);
                if (nb.status !== 'cancelled') addedBks.push(nb);
              } finally {
                await releaseBarberDayLock(kvUrl, kvToken, nb.salonId, nb.workerId, nb.dateISO);
              }
            } else if (!session && nb.status === 'confirmed' && existing.status === 'confirmed'
                && nb.salonId === existing.salonId && nb.workerId === existing.workerId
                && nb.dateISO === existing.dateISO && nb.time === existing.time
                && toE164(nb.phone) && toE164(nb.phone) === toE164(existing.phone)) {
              // An anonymous customer resubmitting what is genuinely THEIR
              // OWN already-confirmed booking (id + core identity fields +
              // phone all match — booking ids are random per-attempt, so
              // this can't collide with a different customer's booking) —
              // typically a retry after the original request's response
              // was lost client-side despite the server having already
              // committed it. The exact-byte-match dedup above already
              // handles the common case, but price/dur are server-derived
              // from the salon's live service list at creation time and
              // can legitimately drift from the client's own cached copy
              // between the original attempt and a retry (e.g. the owner
              // edited that service's price in between) — treated here as
              // a no-op success instead of falling through to the generic
              // 'forbidden' conflict below, which used to show the
              // customer a confusing "someone else took this slot" modal
              // for a booking that had actually already succeeded.
              continue;
            } else {
              // Update to an existing booking (e.g. status change) — no lock
              // needed, but this must never let a caller touch a booking
              // outside their own salon (or, for a barber, outside their own
              // calendar — a barber session used to be able to cancel or
              // mark-complete any OTHER barber's booking in the same salon,
              // since only salonId was checked here; the UI never offered
              // that action, but a direct POST could). Legitimate callers:
              // admin (any booking); owner (any booking in their salon);
              // barber (only bookings assigned to their OWN workerId); and a
              // customer — who has no session at all — cancelling their OWN
              // booking (the only self-service action customers have,
              // gated further below by a phone-number match, not just the
              // booking id). Anyone else's request is dropped as a conflict
              // instead of silently no-op'ing, so the client knows the
              // change didn't take.
              const isStaffForThisBooking = session && (session.role === 'admin'
                || (session.role === 'owner' && session.salonId === existing.salonId)
                || (session.role === 'barber' && barberStillEmployed && session.salonId === existing.salonId && session.workerId === existing.workerId));
              // The self-cancel phone match just below costs one in-memory
              // string compare, no KV round-trip — the request-level booking
              // rate limit further up budgets whole REQUESTS, not individual
              // guesses, and saveState() always resends the client's ENTIRE
              // local bookings snapshot (not just what changed), so a batch
              // can't be capped by array size either without breaking real
              // usage. Rate-limit the actual guess itself, per IP, so
              // bundling many (known id, phone guess) pairs into one request
              // doesn't sidestep the request-level budget.
              if (!session && !isStaffForThisBooking) {
                const rlGuess = await checkRateLimit(kvUrl, kvToken, `ratelimit:cancelguess:${getClientIp(req)}`, 20, 600);
                if (!rlGuess.allowed) {
                  conflicts.push({ id: nb.id, error: 'rate_limited' });
                  continue;
                }
              }
              let merged;
              if (isStaffForThisBooking) {
                // A cancelled booking's slot lock is released the moment it's
                // cancelled (below), freeing that exact time for anyone else
                // to book — so "resurrecting" it later (status sent back to
                // anything active) must never just merge straight through:
                // whatever booking may have legitimately taken that slot
                // since would be silently double-booked, with none of the
                // new-booking branch's overlap/day-lock/slot-lock checks
                // ever re-run. No client code path actually does this
                // (dashAction() only ever moves status forward, to
                // 'completed' or 'cancelled', never back), so it's rejected
                // outright rather than re-implementing the full booking-
                // creation safety pipeline a second time here.
                if (existing.status === 'cancelled' && nb.status !== 'cancelled') {
                  conflicts.push({ id: nb.id, error: 'cannot_reactivate_cancelled_booking' });
                  continue;
                }
                // A staff update must never let the caller move a booking
                // onto a different day/time/barber/salon by resending those
                // fields differently — there's no "reschedule" feature today
                // (dashAction() in js/app.js only ever changes status/
                // cancelledBy), and allowing it here would completely bypass
                // every safety check (vacation/day-off/break, day-lock,
                // overlap) that only the NEW-booking branch above actually
                // runs. Keep the server's own values for anything that
                // would otherwise silently relocate the booking. Likewise
                // price/dur/service/name/phone are never legitimately
                // editable through this path either (the client always
                // resends its own already-synced copy of these — trusting
                // them instead of the server's record would let a crafted
                // request quietly deflate a booking's price/duration, e.g.
                // to under-report revenue or shrink the window the overlap
                // check thinks it occupies).
                merged = {
                  ...existing, ...nb,
                  salonId: existing.salonId, workerId: existing.workerId, dateISO: existing.dateISO, time: existing.time,
                  price: existing.price, dur: existing.dur, service: existing.service, name: existing.name, phone: existing.phone
                };
                // "Fatto"/completed must only ever apply to an appointment
                // that has actually happened — js/app.js's
                // isBookingInFuture() is the only thing stopping this
                // client-side; a direct POST could otherwise mark a future
                // appointment as served, inflating revenue/stats before the
                // client has even shown up.
                if (merged.status === 'completed' && existing.status !== 'completed') {
                  const now = romeNow();
                  const bookingMin = timeToMin(merged.time);
                  const isFuture = merged.dateISO > now.todayISO
                    || (merged.dateISO === now.todayISO && bookingMin !== null && bookingMin > now.minutes);
                  if (isFuture) {
                    conflicts.push({ id: nb.id, error: 'booking_in_future' });
                    continue;
                  }
                }
              } else if (existing.status === 'confirmed' && nb.status === 'cancelled' && nb.cancelledBy !== 'staff'
                  // A booking id alone proves nothing — the anonymous GET
                  // response hands every id out to anyone viewing this
                  // salon's page (needed for slot-availability rendering),
                  // with name/phone stripped. Without this check, anyone who
                  // learned/enumerated an id could cancel a stranger's
                  // appointment: no staff notification would even fire
                  // (cancelledBy is forced to 'customer', not 'staff'), and
                  // it would silently vanish from the real customer's own
                  // "my bookings" list too (that view hides anything
                  // cancelledBy:'customer'). Require the phone number used
                  // at booking time — never shipped by the anonymous GET —
                  // to prove the caller is actually the customer.
                  && existing.phone && typeof nb.phone === 'string' && nb.phone.trim()
                  && toE164(nb.phone) && toE164(nb.phone) === toE164(existing.phone)) {
                // Customer self-cancellation — only status/cancelledBy change,
                // everything else on the booking (price, time, name...) is
                // taken from the server's own record, never from the caller.
                merged = { ...existing, status: 'cancelled', cancelledBy: 'customer' };
              } else if (nb.status === 'cancelled' && existing.status !== 'confirmed') {
                // Not a phone-mismatch case — the booking was already
                // resolved (staff already cancelled it, or it's already
                // completed) by the time this request landed. Distinct from
                // 'forbidden' so the client doesn't wrongly tell the
                // customer their phone number was incorrect when the real
                // reason is simply that there's nothing left to cancel.
                conflicts.push({ id: nb.id, error: 'already_resolved' });
                continue;
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
                // claimCancellationNotifyOnce dedupes two concurrent requests
                // for the same booking (this branch takes no per-booking lock)
                // down to a single notification — the cancellation itself is
                // written correctly by both either way.
                if (existing.status !== 'cancelled' && merged.cancelledBy === 'staff'
                    && await claimCancellationNotifyOnce(kvUrl, kvToken, merged.id)) {
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
          // The only rate limit on this whole POST handler used to be
          // anonymous-caller-only (the booking limiter above) — a valid
          // owner/barber/admin session could otherwise spam this full
          // salons_db read-modify-write indefinitely with no throttle at
          // all. Generous enough for real interactive use (every small
          // dashboard edit triggers one full save) while still bounding a
          // scripted flood from a single compromised or malicious session.
          const saveRl = await checkRateLimit(kvUrl, kvToken, `ratelimit:salonsave:${getClientIp(req)}`, 60, 300);
          if (!saveRl.allowed) {
            return res.status(429).json({ success: false, error: 'rate_limited', conflicts: [] });
          }
          if (isValidSalonsArray(newData.salons)) {
            // getSalonsDb/setSalonsDb below is a full-blob read-modify-write,
            // not a compare-and-swap — two concurrent saves for the SAME
            // salon (two tabs/devices, or a save racing a billing webhook)
            // could otherwise both read the same pre-write snapshot and the
            // second writer's setSalonsDb silently clobbers the first
            // writer's change (a new worker, a service edit...). Lock every
            // salon id this request is actually authorized to touch first —
            // reuses the same per-salon lock the billing actions already
            // take, so a generic save and a billing mutation for the same
            // salon can't interleave either.
            // For an admin session this is every salon id in the payload —
            // and saveState() always sends the client's ENTIRE local
            // snapshot, so an admin's payload holds every salon on the
            // platform on every single save, unrelated actions included.
            // Acquiring (and later releasing) these one at a time used to
            // mean N sequential Redis round-trips — each potentially
            // waiting out its own contention — for a write that almost
            // always touches at most one or two of them. Parallelized: the
            // total wait is now bounded by the single slowest acquisition,
            // not their sum.
            const lockIds = Array.from(new Set(newData.salons
              .map(s => s && s.id)
              .filter(id => typeof id === 'string' && session &&
                (session.role === 'admin' || session.salonId === id))
            )).sort();
            const lockResults = await Promise.all(lockIds.map(id =>
              acquireBillingLock(kvUrl, kvToken, id).then(ok => ({ id, ok }))
            ));
            const heldLocks = lockResults.filter(r => r.ok).map(r => r.id);
            const heldLocksSet = new Set(heldLocks);
            try {
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
            // Slug/ownerUsername uniqueness (see the per-item check below)
            // must be resolved against the FINAL proposed state of the
            // WHOLE batch up front, not incrementally salon-by-salon as
            // each item is processed — checking incrementally against
            // salonMap (mutated as the loop progresses) made a genuine
            // two-salon slug SWAP submitted in one request (A takes B's
            // old slug, B takes A's old slug) silently no-op for BOTH:
            // processing A first sees B still at its old slug (collision,
            // A reverted), then processing B sees A already reverted back
            // to its own old slug (collision again, B reverted too) — with
            // no error ever surfaced. Computing everyone's intended final
            // value first means a real swap has each salon claiming a
            // value nobody else's FINAL state still holds, so it resolves
            // cleanly, while an actual theft attempt (setting your slug to
            // someone else's who ISN'T changing) still collides and reverts.
            const finalSlugs = new Map(currentSalons.map(s => [s.id, s.slug]));
            const finalUsernames = new Map(currentSalons.map(s => [s.id, s.ownerUsername]));
            for (const incoming of newData.salons) {
              const existingForResolve = salonMap.get(incoming.id);
              if (!existingForResolve) continue; // new-salon uniqueness handled separately by isValidNewSalon
              const authorizedForResolve = session && (session.role === 'admin'
                || (session.role === 'owner' && session.salonId === incoming.id));
              if (!authorizedForResolve) continue;
              if (typeof incoming.slug === 'string') finalSlugs.set(incoming.id, incoming.slug);
              if (typeof incoming.ownerUsername === 'string') finalUsernames.set(incoming.id, incoming.ownerUsername);
            }
            function resolveCollisions(finalMap, originalMap) {
              const byValue = new Map();
              for (const [id, val] of finalMap) {
                // A falsy slug/ownerUsername (missing on an old/legacy
                // record, or a malformed edit) must never be treated as a
                // shared "value" that collides with every other such
                // record — only a genuine non-empty duplicate is a real
                // collision.
                if (!val) continue;
                if (!byValue.has(val)) byValue.set(val, []);
                byValue.get(val).push(id);
              }
              for (const [val, ids] of byValue) {
                if (ids.length <= 1) continue;
                // More than one salon ending up with the same final value —
                // whichever of them didn't already legitimately hold it
                // loses and reverts to its own prior value. (The one salon,
                // if any, whose value was already this exact one keeps it —
                // it never actually asked to change.)
                for (const id of ids) {
                  if (originalMap.get(id) !== val) finalMap.set(id, originalMap.get(id));
                }
              }
            }
            resolveCollisions(finalSlugs, new Map(currentSalons.map(s => [s.id, s.slug])));
            resolveCollisions(finalUsernames, new Map(currentSalons.map(s => [s.id, s.ownerUsername])));
            for (const incoming of newData.salons) {
              const existing = salonMap.get(incoming.id);
              // lockIds above only includes ids this session is actually
              // authorized to touch — if acquiring THIS one's lock failed
              // within budget (contention with a webhook or another save),
              // the write must be skipped entirely rather than proceeding
              // unprotected: writing here without the lock would silently
              // reintroduce the exact lost-update race it exists to close.
              // Rare (needs sustained contention on one specific salon), but
              // a real gap the lock-skip loop above used to leave open.
              if (typeof incoming.id === 'string' && lockIds.includes(incoming.id) && !heldLocksSet.has(incoming.id)) {
                console.warn('[SYNC] Skipping salon save, could not acquire lock:', incoming.id);
                continue;
              }
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
              // salons_db is ONE JSON blob shared by the ENTIRE platform —
              // every GET and every save (from ANY salon, any user) reads/
              // writes it in full. With no cap here, a single authorized
              // owner (or a compromised low-privilege session) could push
              // tens of thousands of fake worker/service entries in one
              // save, cheaply inflating latency/bandwidth/Upstash command
              // cost for every other tenant on the platform. These limits
              // are far above any real barber shop's actual scale.
              if (Array.isArray(incoming.workers) && incoming.workers.length > 200) {
                console.warn('[SYNC] Rejected salon save, too many workers:', incoming.id, incoming.workers.length);
                continue;
              }
              if (Array.isArray(incoming.services) && incoming.services.length > 200) {
                console.warn('[SYNC] Rejected salon save, too many services:', incoming.id, incoming.services.length);
                continue;
              }
              if (!existing) {
                if (!isValidNewSalon(incoming, salonMap)) {
                  console.warn('[SYNC] Rejected invalid new salon payload for', incoming.id);
                  continue;
                }
                // An admin creating a brand-new salon directly (as opposed to
                // self-signup, which already hashes at handleSignupSalon) is
                // the only other place a fresh ownerPassword/worker password
                // is ever written — hash both here so nothing plaintext ever
                // reaches salons_db.
                if (!isHashedPassword(incoming.ownerPassword)) incoming.ownerPassword = hashPassword(incoming.ownerPassword);
                if (Array.isArray(incoming.workers)) {
                  incoming.workers = incoming.workers
                    .filter(w => !(w && typeof w.password === 'string' && w.password.length < 6))
                    .map(w =>
                      (w && typeof w.password === 'string' && !isHashedPassword(w.password))
                        ? { ...w, password: hashPassword(w.password) } : w);
                }
              }
              if (existing) {
                // Slug is the salon's actual public routing key (booking
                // link/QR code — js/app.js resolves a salon by first-match
                // slug lookup) and ownerUsername is the global login lookup
                // key for the homepage "Accedi" button — uniqueness for
                // both was only ever enforced for a BRAND NEW salon
                // (isValidNewSalon below), never re-checked when an
                // EXISTING salon is edited. An authenticated owner/admin
                // session for salon A could set salon A's own slug to
                // collide with salon B's, silently hijacking B's booking
                // link/QR code (or making A itself unreachable, depending
                // on lookup order) — a real cross-tenant integrity break
                // reachable with just a valid session for ANY salon.
                // Resolved for the whole batch up front (see finalSlugs/
                // finalUsernames + resolveCollisions above, which also
                // makes a genuine two-salon slug SWAP in one request work
                // correctly instead of silently no-op'ing for both) — just
                // apply the already-collision-resolved value here.
                if (finalSlugs.has(incoming.id)) incoming.slug = finalSlugs.get(incoming.id);
                if (finalUsernames.has(incoming.id)) incoming.ownerUsername = finalUsernames.get(incoming.id);
                // Credentials for anything that already exists must never be
                // overwritten through this generic bulk-save path — the client
                // no longer even holds real passwords locally (GET strips them),
                // so any password it sends back here is stale/blank. Password
                // changes only happen through /api/change-password.
                incoming.ownerPassword = existing.ownerPassword;
                // Billing (fee tier, paidThroughMonth, suspendedByBilling,
                // pendingApproval, iban/taxId/signupIp, ...), the owner's
                // personal contact info, and their login username are
                // admin-review-only — an owner's own client no longer even
                // receives these fields from GET (see the sanitizedSalons
                // change above), so without this an owner's very next save
                // of anything (a vacation date, a new worker...) would wipe
                // them to undefined. Also closes the escalation this was
                // protecting against even before that: a client that DID
                // still hold stale values (or a hand-crafted request) could
                // set its own billing.paidThroughMonth into the future or
                // clear suspendedByBilling to dodge the payment-suspension
                // cron in api/daily-health-check.js.
                if (session.role !== 'admin') {
                  incoming.billing = existing.billing;
                  incoming.email = existing.email;
                  incoming.ownerName = existing.ownerName;
                  incoming.ownerPhone = existing.ownerPhone;
                  incoming.ownerUsername = existing.ownerUsername;
                  incoming.inactive = existing.inactive;
                } else {
                  // Admin sessions still can't flip inactive/pendingApproval
                  // through this generic path — the normal admin UI
                  // (saveSalon() in js/app.js) never touches these fields
                  // here anyway, activation always goes through the
                  // dedicated approve_salon action or toggle-salon.js, both
                  // of which email the owner their credentials/link/QR on
                  // first activation. Without this, a crafted admin-session
                  // POST through this generic bulk save could silently flip
                  // a pending self-signup salon live with NEITHER approval
                  // email ever firing — a third, unintended activation path.
                  incoming.inactive = existing.inactive;
                  incoming.billing = existing.billing;
                }
                // Reviews only ever change through action=submit_review (see
                // handleSubmitReview below) now — never through this bulk
                // path, which sends the client's last-known LOCAL snapshot
                // and would otherwise silently discard a review someone else
                // submitted in the meantime (last-write-wins on the whole
                // worker object).
                const existingWorkersById = new Map((existing.workers || []).map(w => [w.id, w]));
                // A non-array/missing incoming.workers (stale client, or a
                // tampered request with `workers: null`/omitted) used to skip
                // this whole block and fall through to salonMap.set() with no
                // workers array at all, wiping every worker on the salon for
                // a non-admin save. Coerce to [] first so the restore loop
                // below still runs and puts every existing worker back.
                if (session.role !== 'admin' && !Array.isArray(incoming.workers)) {
                  incoming.workers = [];
                }
                if (Array.isArray(incoming.workers)) {
                  incoming.workers = incoming.workers.map(w => {
                    const ew = existingWorkersById.get(w.id);
                    // An EXISTING worker's password is always restored from
                    // the stored record (real changes only go through
                    // handleChangePassword) — but a genuinely NEW worker
                    // being added here carries whatever password the client
                    // just set for them, which must be hashed before it's
                    // ever persisted. A brand-new SALON's owner password
                    // (isValidNewSalon) and a password CHANGE (lib/auth.js)
                    // both already enforce a real minimum length — this was
                    // the one remaining password-setting path with no floor
                    // at all, silently accepting an empty/1-character
                    // worker password from a direct API call bypassing the
                    // (also unenforced) client UI check.
                    if (ew) return { ...w, password: ew.password, reviews: ew.reviews || [] };
                    if (w && typeof w.password === 'string' && w.password.length < 6) {
                      console.warn('[SYNC] Dropping new worker with too-short password:', w.id);
                      return null;
                    }
                    if (w && typeof w.password === 'string' && !isHashedPassword(w.password)) {
                      return { ...w, password: hashPassword(w.password) };
                    }
                    return w;
                  }).filter(Boolean);
                  // Only admin may actually remove a worker — an owner's
                  // payload that omits an existing worker (client bug, stale
                  // local copy, or a tampered request) must not silently
                  // delete them; restore anything missing from a non-admin save.
                  if (session.role !== 'admin') {
                    const incomingIds = new Set(incoming.workers.map(w => w.id));
                    for (const ew of existingWorkersById.values()) {
                      if (!incomingIds.has(ew.id)) incoming.workers.push(ew);
                    }
                  } else {
                    // A worker admin actually removes here used to just
                    // vanish from the array with no other cleanup: their
                    // remaining FUTURE confirmed bookings stayed on the
                    // books referencing a workerId that no longer exists —
                    // customers kept getting reminders for an appointment
                    // with someone no longer on staff, and nothing ever
                    // surfaced it to the salon. Their review history was
                    // also just destroyed outright. Cancel the former, and
                    // preserve the latter, for every actually-removed id.
                    const incomingIdsAfterRemoval = new Set(incoming.workers.map(w => w.id));
                    for (const removedWorker of existingWorkersById.values()) {
                      if (incomingIdsAfterRemoval.has(removedWorker.id)) continue;
                      if (Array.isArray(removedWorker.reviews) && removedWorker.reviews.length) {
                        if (!Array.isArray(incoming.archivedReviews)) incoming.archivedReviews = [];
                        incoming.archivedReviews.push(...removedWorker.reviews.map(r => ({ ...r, workerName: removedWorker.name })));
                      }
                      const now = romeNow();
                      for (const b of bookingsMap.values()) {
                        if (b.salonId !== incoming.id || b.workerId !== removedWorker.id || b.status !== 'confirmed') continue;
                        const bMin = timeToMin(b.time);
                        const isFuture = b.dateISO > now.todayISO || (b.dateISO === now.todayISO && bMin !== null && bMin > now.minutes);
                        if (!isFuture) continue;
                        const cancelled = { ...b, status: 'cancelled', cancelledBy: 'staff' };
                        await hsetBooking(kvUrl, kvToken, cancelled);
                        await releaseSlotLock(kvUrl, kvToken, cancelled);
                        bookingsMap.set(b.id, cancelled);
                        // Same idempotency guard the normal staff-cancel path
                        // uses, so a retried/duplicated request can't notify
                        // the same customer twice for the same cancellation.
                        if (await claimCancellationNotifyOnce(kvUrl, kvToken, cancelled.id)) {
                          staffCancelledBks.push(cancelled);
                        }
                      }
                    }
                  }
                }
              }
              salonMap.set(incoming.id, incoming);
            }
            await setSalonsDb(kvUrl, kvToken, Array.from(salonMap.values()));
            } finally {
              await Promise.all(heldLocks.map(id => releaseBillingLock(kvUrl, kvToken, id)));
            }
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

        const postRequestedSalonId = req.query && typeof req.query.salonId === 'string' ? req.query.salonId : null;
        return res.status(200).json({ success: true, bookings: scopeBookingsForSession(Array.from(bookingsMap.values()), session, postRequestedSalonId, barberStillEmployed), conflicts });
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
  // No push/SMS to anyone (admin, owner, or the barber) between 20:00 and
  // 8:00 Italian time — the booking itself is still created either way and
  // shows up the moment anyone next opens the dashboard (the 6s sync poll
  // sees it regardless), only the proactive ping is withheld overnight.
  if (isQuietHours()) return;
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

    // Endpoints found dead during this run — pruned from KV in one locked
    // pass at the end (see below) against a FRESH read of the blob, rather
    // than writing back the `subscriptions` snapshot read at the top of
    // this function unlocked: a concurrent api/subscribe.js registration
    // (or api/send-reminders.js's own pruning pass) landing in between used
    // to be silently discarded by this function's stale, unlocked write.
    const deadEndpoints = new Set();
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
        // Also requires salonId to match, not just workerId, as defense in
        // depth — worker ids are meant to be unique per salon already (the
        // real fix is the new-booking branch above now rejecting a
        // salonId/workerId pair that don't actually belong together), but a
        // subscription record predating that fix, or any future bug that
        // lets a mismatched pair back in, must not be able to target a
        // barber outside the booking's own salon.
        if (sub.role === 'barber' && sub.workerId === bk.workerId && sub.salonId === bk.salonId) return true;
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
            deadEndpoints.add(target.subscription.endpoint);
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

    // 2. Save cleaned subscription list back to KV if changed — locked,
    // against a fresh re-read, same pattern as api/send-reminders.js.
    if (deadEndpoints.size > 0) {
      const locked = await acquirePushSubsLock(kvUrl, kvToken);
      if (locked) {
        try {
          const freshResp = await fetch(`${kvUrl}/get/push_subscriptions`, { headers: { Authorization: `Bearer ${kvToken}` } });
          let fresh = [];
          if (freshResp.ok) {
            const freshData = await freshResp.json();
            if (freshData.result) {
              let val = JSON.parse(freshData.result);
              if (typeof val === 'string') val = JSON.parse(val);
              if (Array.isArray(val)) fresh = val;
            }
          }
          const pruned = fresh.filter(s => !deadEndpoints.has(s.subscription.endpoint));
          if (pruned.length !== fresh.length) {
            await fetch(`${kvUrl}/set/push_subscriptions`, {
              method: 'POST',
              headers: { Authorization: `Bearer ${kvToken}`, 'Content-Type': 'application/json' },
              body: JSON.stringify(JSON.stringify(pruned))
            });
          }
        } finally {
          await releasePushSubsLock(kvUrl, kvToken);
        }
      }
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
  // No SMS between 20:00 and 8:00 Italian time — the on-screen confirmation
  // the customer is already looking at is enough overnight; the receipt SMS
  // is a nice-to-have, not worth a text landing at 3am.
  if (isQuietHours()) return;
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
  // No push/SMS between 20:00 and 8:00 Italian time — same rule as every
  // other immediate send. The cancellation itself still takes effect right
  // away; the customer sees it the next time the app syncs even without a
  // ping overnight.
  if (isQuietHours()) return;
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
