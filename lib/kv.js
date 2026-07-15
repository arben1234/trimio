/* ================================================================
   SHARED KV STORAGE LAYOUT (Upstash Redis, REST API)
   Used by api/sync.js and api/toggle-salon.js.

   - salons_db     : JSON blob (string key), path-style GET/SET.
   - bookings      : Redis Hash, field = booking.id, value = JSON string.
                      One atomic field write per booking — no read-modify-
                      write of the whole collection, so concurrent booking
                      writes can never silently clobber each other.
   - lock:<slot>   : one key per active (non-cancelled) booking, used as
                      an atomic double-booking guard via SET ... NX.
   - migrated_v2   : marker key for the one-time lazy migration from the
                      legacy single-blob "bookings_db" key.
   Legacy "bookings_db" is left in place untouched after migration.
================================================================ */

// Array-command transport for Hash/lock primitives — avoids path/query
// encoding issues with booking data containing accented names, quotes, etc.
export async function kvCmd(kvUrl, kvToken, args) {
  const resp = await fetch(kvUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${kvToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args)
  });
  if (!resp.ok) throw new Error(`KV command error: ${resp.statusText}`);
  const data = await resp.json();
  return data.result;
}

// Path-style GET/SET for the two blob keys — proven pattern, unchanged.
export async function getBlob(kvUrl, kvToken, key) {
  const resp = await fetch(`${kvUrl}/get/${key}`, { headers: { Authorization: `Bearer ${kvToken}` } });
  if (!resp.ok) throw new Error(`KV error: ${resp.statusText}`);
  const data = await resp.json();
  if (!data.result) return null;
  let val = JSON.parse(data.result);
  if (typeof val === 'string') val = JSON.parse(val);
  return val;
}
export async function setBlob(kvUrl, kvToken, key, value) {
  const resp = await fetch(`${kvUrl}/set/${key}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${kvToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(JSON.stringify(value))
  });
  if (!resp.ok) throw new Error(`KV error: ${resp.statusText}`);
}

export async function getSalonsDb(kvUrl, kvToken) {
  const salons = await getBlob(kvUrl, kvToken, 'salons_db');
  return salons || [];
}
export async function setSalonsDb(kvUrl, kvToken, salons) {
  await setBlob(kvUrl, kvToken, 'salons_db', salons);
}

// Admin credentials — synced across devices the same way salons are, so a
// password change made on one device (or via the API) takes effect
// everywhere. Falls back to the original hardcoded default until an admin
// actually changes it for the first time.
export async function getAdminDb(kvUrl, kvToken) {
  const admin = await getBlob(kvUrl, kvToken, 'admin_db');
  return admin || { username: 'admin', password: 'admin123' };
}
export async function setAdminDb(kvUrl, kvToken, admin) {
  await setBlob(kvUrl, kvToken, 'admin_db', admin);
}

// HGETALL "bookings" -> Map<id, booking>
export async function getAllBookings(kvUrl, kvToken) {
  const flat = await kvCmd(kvUrl, kvToken, ['HGETALL', 'bookings']);
  const map = new Map();
  if (Array.isArray(flat)) {
    for (let i = 0; i < flat.length; i += 2) {
      try { map.set(flat[i], JSON.parse(flat[i + 1])); } catch { /* skip corrupt entry */ }
    }
  }
  return map;
}

// Fixed-window rate limiter shared by any endpoint that needs one (SMS
// sends, push-subscription registration, booking creation) — INCR is atomic
// on Redis, so concurrent callers never under-count each other. EXPIRE is a
// separate call (only set on the first hit of a window), so in the rare case
// a process dies between the two the key would live forever un-expired
// instead of resetting — acceptable for a best-effort abuse guard, not a
// billing-grade limiter.
export async function checkRateLimit(kvUrl, kvToken, key, maxCount, windowSeconds) {
  const count = await kvCmd(kvUrl, kvToken, ['INCR', key]);
  if (count === 1) {
    await kvCmd(kvUrl, kvToken, ['EXPIRE', key, String(windowSeconds)]);
  }
  return { allowed: count <= maxCount, count };
}

export function lockKeyFor(b) {
  return `lock:${b.salonId}:${b.workerId}:${b.dateISO}:${b.time}`;
}

// SET lock:<slot> <bookingId> NX EX 15 — short TTL as a crash-safety net;
// promoteLock() makes it permanent once the booking is actually stored.
export async function tryAcquireSlotLock(kvUrl, kvToken, booking) {
  const res = await kvCmd(kvUrl, kvToken, ['SET', lockKeyFor(booking), booking.id, 'NX', 'EX', '15']);
  return res === 'OK';
}
export async function promoteLock(kvUrl, kvToken, booking) {
  try { await kvCmd(kvUrl, kvToken, ['PERSIST', lockKeyFor(booking)]); } catch { /* best-effort */ }
}
// Guards the READ-then-WRITE overlap check in api/sync.js (overlapsExisting
// reads the current bookingsMap, then a lock is acquired and the booking is
// written) — the exact-slot SET NX above only catches two requests hitting
// the identical time string; two DIFFERENT start times whose service
// durations overlap (10:00+40min vs 10:20) could otherwise both read the same
// pre-write snapshot, both pass the overlap check, and both succeed. This
// serializes that whole check+write sequence per barber+day so only one
// request at a time can be mid-overlap-check for a given barber's day.
function dayLockKeyFor(salonId, workerId, dateISO) {
  return `daylock:${salonId}:${workerId}:${dateISO}`;
}
export async function acquireBarberDayLock(kvUrl, kvToken, salonId, workerId, dateISO) {
  const key = dayLockKeyFor(salonId, workerId, dateISO);
  // Retry loop, not a queue — a genuine collision resolves as soon as the
  // current holder's critical section finishes, so waiting a bit longer
  // (rather than giving up) turns what would otherwise be a FALSE "slot
  // taken" conflict into a normal successful booking. The old budget here
  // was only ~10 attempts x 50-100ms (≈0.5-1s total) — comfortably enough
  // for a single one-off collision, but a real flux burst for one popular
  // barber+day (e.g. a link shared right at opening) queues up faster than
  // that, so later callers got rejected with no actual overlap ever having
  // occurred. Wall-clock-bounded (not attempt-count-bounded) so it holds to
  // the same total budget regardless of how slow each individual round trip
  // is, and capped well under Vercel's serverless execution limit so a
  // caller that genuinely can't get in still returns before the whole
  // request itself would time out. Backoff grows (capped) as contention
  // persists, so a busy slot doesn't hammer Redis with a request every ~50ms
  // for the full 4s.
  const maxWaitMs = 4000;
  const start = Date.now();
  let delay = 40;
  while (Date.now() - start < maxWaitMs) {
    const res = await kvCmd(kvUrl, kvToken, ['SET', key, '1', 'NX', 'EX', '10']);
    if (res === 'OK') return true;
    await new Promise(r => setTimeout(r, delay + Math.floor(Math.random() * delay)));
    delay = Math.min(delay * 1.5, 300);
  }
  return false;
}
export async function releaseBarberDayLock(kvUrl, kvToken, salonId, workerId, dateISO) {
  try { await kvCmd(kvUrl, kvToken, ['DEL', dayLockKeyFor(salonId, workerId, dateISO)]); } catch { /* best-effort */ }
}

// Guards a single salon's read-modify-write in api/stripe-webhook.js —
// Stripe can deliver events for different salons within milliseconds of
// each other, and getSalonsDb/setSalonsDb is a full-blob read-modify-write,
// not a compare-and-swap, so two concurrent handlers could otherwise
// silently clobber one another's salon mutation. Same short-retry shape as
// acquireBarberDayLock, since a webhook handler's critical section is quick.
function billingLockKeyFor(salonId) {
  return `lock:billing:${salonId}`;
}
export async function acquireBillingLock(kvUrl, kvToken, salonId) {
  const key = billingLockKeyFor(salonId);
  const maxWaitMs = 4000;
  const start = Date.now();
  let delay = 40;
  while (Date.now() - start < maxWaitMs) {
    const res = await kvCmd(kvUrl, kvToken, ['SET', key, '1', 'NX', 'EX', '10']);
    if (res === 'OK') return true;
    await new Promise(r => setTimeout(r, delay + Math.floor(Math.random() * delay)));
    delay = Math.min(delay * 1.5, 300);
  }
  return false;
}
export async function releaseBillingLock(kvUrl, kvToken, salonId) {
  try { await kvCmd(kvUrl, kvToken, ['DEL', billingLockKeyFor(salonId)]); } catch { /* best-effort */ }
}

// Stripe redelivers webhook events on transient failures/timeouts — this
// SET NX EX ensures each event.id's side effects are ever applied exactly
// once. 48h TTL comfortably outlives Stripe's own redelivery window.
export async function claimStripeEventOnce(kvUrl, kvToken, eventId) {
  const res = await kvCmd(kvUrl, kvToken, ['SET', `stripe_evt:${eventId}`, '1', 'NX', 'EX', '172800']);
  return res === 'OK';
}

// api/send-reminders.js marks a booking's *Sent flag via a plain HSET
// (read-modify-write, not compare-and-set) AFTER sending — if the daily
// cron and the hourly GitHub Action both pick up the same due booking in the
// same run window, both could send before either flag is persisted. This is
// the atomic gate: only the caller that wins the SET NX actually sends;
// everyone else treats the booking as already claimed. TTL only needs to
// outlive one run of the job, not the *Sent flag itself (which is
// permanent).
export async function claimReminderOnce(kvUrl, kvToken, bookingId, kind) {
  const res = await kvCmd(kvUrl, kvToken, ['SET', `remlock:${bookingId}:${kind}`, '1', 'NX', 'EX', '3600']);
  return res === 'OK';
}

// Best-effort: if a booking is cancelled, free its slot for future bookings.
// NOTE: if a reschedule feature is ever added (changing dateISO/time/workerId
// on an existing booking instead of just its status), it must DEL the old
// lock key and SET-NX the new one here, or slots will leak/double-book.
export async function releaseSlotLock(kvUrl, kvToken, booking) {
  try { await kvCmd(kvUrl, kvToken, ['DEL', lockKeyFor(booking)]); } catch { /* best-effort */ }
}
export async function hsetBooking(kvUrl, kvToken, booking) {
  await kvCmd(kvUrl, kvToken, ['HSET', 'bookings', booking.id, JSON.stringify(booking)]);
}

// One-time lazy migration from the legacy single-blob "bookings_db" key.
// Every step is NX/HSETNX-gated, so it's safe to run concurrently from
// multiple cold starts, or interleaved with live traffic, with no locking.
export async function ensureMigratedV2(kvUrl, kvToken) {
  const marker = await kvCmd(kvUrl, kvToken, ['GET', 'migrated_v2']);
  if (marker) return;

  const legacy = await getBlob(kvUrl, kvToken, 'bookings_db');
  if (legacy) {
    if (Array.isArray(legacy.salons) && legacy.salons.length > 0) {
      await setSalonsDb(kvUrl, kvToken, legacy.salons);
    }
    for (const b of (legacy.bookings || [])) {
      await kvCmd(kvUrl, kvToken, ['HSETNX', 'bookings', b.id, JSON.stringify(b)]);
      if (b.status !== 'cancelled') {
        await kvCmd(kvUrl, kvToken, ['SET', lockKeyFor(b), b.id, 'NX', 'EX', '15']);
        await promoteLock(kvUrl, kvToken, b);
      }
    }
  }
  await kvCmd(kvUrl, kvToken, ['SET', 'migrated_v2', '1']);
}
