import webPush from 'web-push';
import {
  getSalonsDb, setSalonsDb, getAllBookings,
  tryAcquireSlotLock, promoteLock, releaseSlotLock, hsetBooking,
  acquireBarberDayLock, releaseBarberDayLock, checkRateLimit,
  ensureMigratedV2, getAdminDb
} from '../lib/kv.js';
import { sendCustomerText } from '../lib/sms.js';
import { handleLogin, handleChangePassword, getVerifiedSession, getClientIp } from '../lib/auth.js';

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
          admin: { username: admin.username }
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
                if (worker && (isOnVacation(worker, nb.dateISO) || isWeeklyOff(worker, nb.dateISO))) {
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
