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
