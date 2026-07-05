import webPush from 'web-push';
import {
  getSalonsDb, setSalonsDb, getAllBookings,
  tryAcquireSlotLock, promoteLock, releaseSlotLock, hsetBooking,
  ensureMigratedV2, getAdminDb, setAdminDb
} from '../lib/kv.js';

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
  webPush.setVapidDetails('mailto:trimio@example.com', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
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
function overlapsExisting(nb, bookingsMap, salon) {
  const start = timeToMin(nb.time);
  if (start === null) return false;
  const end = start + svcDurMin(salon, nb.service);
  for (const b of bookingsMap.values()) {
    if (b.id === nb.id || b.salonId !== nb.salonId || b.workerId !== nb.workerId
        || b.dateISO !== nb.dateISO || b.status === 'cancelled') continue;
    const bs = timeToMin(b.time);
    if (bs === null) continue;
    const be = bs + svcDurMin(salon, b.service);
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
        return res.status(200).json({ bookings: Array.from(bookingsMap.values()), salons, admin });
      }

      if (req.method === 'POST') {
        const body = req.body;
        const newData = typeof body === 'string' ? JSON.parse(body) : body;
        console.log('[SYNC] Saving database state to Vercel KV');

        const bookingsMap = await getAllBookings(kvUrl, kvToken);
        const newBks = Array.isArray(newData.bookings) ? newData.bookings : [];
        const addedBks = [];
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
            } else {
              // Update to an existing booking (e.g. status change) — no lock needed.
              const merged = { ...existing, ...nb };
              await hsetBooking(kvUrl, kvToken, merged);
              bookingsMap.set(nb.id, merged);
              if (merged.status === 'cancelled') {
                await releaseSlotLock(kvUrl, kvToken, merged);
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
            for (const incoming of newData.salons) salonMap.set(incoming.id, incoming);
            await setSalonsDb(kvUrl, kvToken, Array.from(salonMap.values()));
          } else {
            console.warn('[SYNC] Ignoring malformed salons payload (not written to salons_db)');
          }
        }

        if (newData.admin && typeof newData.admin === 'object'
            && typeof newData.admin.username === 'string' && newData.admin.username
            && typeof newData.admin.password === 'string' && newData.admin.password) {
          await setAdminDb(kvUrl, kvToken, { username: newData.admin.username, password: newData.admin.password });
        }

        // Send push notifications for new bookings — must be awaited, not
        // fire-and-forget: Vercel's Node.js serverless runtime can freeze/
        // terminate the function as soon as the HTTP response is sent, which
        // was silently killing in-flight webPush.sendNotification() calls
        // before they ever reached the push service (confirmed via prod logs
        // showing push sends limping along minutes after the response, or
        // never completing at all).
        if (addedBks.length > 0) {
          console.log(`[SYNC] Found ${addedBks.length} new bookings. Sending push notifications...`);
          try {
            await sendPushNotifications(addedBks, kvUrl, kvToken);
          } catch (err) {
            console.error('[SYNC] Push notifications job error:', err);
          }
        }

        return res.status(200).json({ success: true, bookings: Array.from(bookingsMap.values()), conflicts });
      }
    } catch (kvErr) {
      console.error('[SYNC] KV Database Error:', kvErr);
      return res.status(500).json({ error: kvErr.message });
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
async function sendPushNotifications(newBookings, kvUrl, kvToken) {
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

      for (const target of targets) {
        try {
          await webPush.sendNotification(target.subscription, payload);
          console.log(`[PUSH] Sent to ${target.role} (${target.subscription.endpoint.slice(0, 30)}...)`);
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
