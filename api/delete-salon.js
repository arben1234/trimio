import { getSalonsDb, setSalonsDb, getAllBookings, releaseSlotLock, kvCmd, ensureMigratedV2 } from '../lib/kv.js';
import { verifyAdminPassword } from '../lib/auth.js';
import { cancelPaypalSubscription } from '../lib/paypal.js';

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,POST');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const salonId = body.salonId;
    if (!salonId) {
      return res.status(400).json({ error: 'Missing salonId' });
    }

    const kvUrl = process.env.KV_REST_API_URL;
    const kvToken = process.env.KV_REST_API_TOKEN;
    if (!kvUrl || !kvToken) {
      return res.status(403).json({
        error: 'database_suspended',
        message: 'Il database Vercel KV non è configurato.'
      });
    }

    // Irreversible, and salon ids are predictable + publicly visible via
    // /api/sync — must never be reachable with just an id. Same
    // proof-of-identity pattern as reset-all-data.js.
    if (!(await verifyAdminPassword(body.adminPassword, kvUrl, kvToken))) {
      return res.status(401).json({ error: 'Incorrect admin password' });
    }

    await ensureMigratedV2(kvUrl, kvToken);

    // Read the CURRENT server-side salon list directly — this is an
    // explicit, targeted delete (like toggle-salon.js), not a whole-array
    // overwrite from a client's possibly-stale local snapshot.
    const salons = await getSalonsDb(kvUrl, kvToken);
    const salon = salons.find(s => s.id === salonId);
    if (!salon) {
      return res.status(404).json({ error: 'Salon not found', salonId });
    }

    // Deleting a salon that still has a live PayPal subscription must stop
    // it from continuing to charge the customer every month for a service
    // that no longer exists — this used to be a pure gap, nothing here ever
    // told PayPal the salon was gone. Best-effort: the delete proceeds
    // either way even if this call fails.
    if (salon.billing && salon.billing.autopay && salon.billing.paypalSubscriptionId) {
      await cancelPaypalSubscription(salon.billing.paypalSubscriptionId, 'Salone eliminato su TRIMIO');
    }

    const remaining = salons.filter(s => s.id !== salonId);
    await setSalonsDb(kvUrl, kvToken, remaining);

    // Clean up bookings + slot locks that belonged to this salon.
    const bookingsMap = await getAllBookings(kvUrl, kvToken);
    let removedBookings = 0;
    for (const b of bookingsMap.values()) {
      if (b.salonId === salonId) {
        await kvCmd(kvUrl, kvToken, ['HDEL', 'bookings', b.id]);
        await releaseSlotLock(kvUrl, kvToken, b);
        removedBookings++;
      }
    }

    console.log(`[DELETE-SALON] Deleted salon "${salon.name}" (${salonId}) and ${removedBookings} booking(s)`);
    return res.status(200).json({ success: true, salonId, removedBookings });
  } catch (error) {
    console.error('[DELETE-SALON] Error:', error);
    return res.status(500).json({ error: 'Errore del server, riprova.' });
  }
}
