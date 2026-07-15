import { getSalonsDb, setSalonsDb, ensureMigratedV2 } from '../lib/kv.js';
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
    const setInactive = body.inactive; // true or false

    if (!salonId) {
      return res.status(400).json({ error: 'Missing salonId' });
    }

    const kvUrl = process.env.KV_REST_API_URL;
    const kvToken = process.env.KV_REST_API_TOKEN;

    // Admin-only, destructive-adjacent action — salon ids are predictable
    // (js/app.js generates them as 'salon'+Date.now()) and are visible in the
    // public /api/sync response, so this must never be reachable with just an
    // id. Same proof-of-identity pattern as reset-all-data.js.
    if (!kvUrl || !kvToken) {
      return res.status(403).json({ error: 'database_suspended', message: 'Il database Vercel Blob è stato sospeso. Per riattivare, collega un database Vercel KV.' });
    }
    if (!(await verifyAdminPassword(body.adminPassword, kvUrl, kvToken))) {
      return res.status(401).json({ error: 'Incorrect admin password' });
    }

    console.log(`[TOGGLE] salonId=${salonId}, inactive=${setInactive}`);

    await ensureMigratedV2(kvUrl, kvToken);
    const salons = await getSalonsDb(kvUrl, kvToken);

    const salon = salons.find(s => s.id === salonId);
    if (!salon) {
      return res.status(404).json({ error: 'Salon not found', salonId });
    }
    salon.inactive = !!setInactive;
    // Reactivating (this is also the "approve a pending self-signup" action)
    // clears any billing-driven pending/suspended flags too — Attiva is the
    // one place admin approval/reactivation happens, whatever the reason the
    // salon was inactive. Deactivating for an unrelated reason leaves billing
    // fields untouched.
    if (!salon.inactive && salon.billing) {
      salon.billing.pendingApproval = false;
      salon.billing.suspendedByBilling = false;
    }
    // Deactivating a salon that still has a live PayPal subscription must
    // stop it from continuing to charge the customer every month for a
    // service that's no longer being provided — this used to be a pure gap,
    // nothing here ever told PayPal the salon went away. Best-effort: if the
    // cancel call fails, the salon still gets deactivated either way.
    if (salon.inactive && salon.billing && salon.billing.autopay && salon.billing.paypalSubscriptionId) {
      await cancelPaypalSubscription(salon.billing.paypalSubscriptionId, 'Salone disattivato su TRIMIO');
      salon.billing.autopay = false;
      salon.billing.paypalSubscriptionId = null;
    }
    console.log(`[TOGGLE] Found salon "${salon.name}", set inactive=${salon.inactive}`);

    await setSalonsDb(kvUrl, kvToken, salons);

    return res.status(200).json({ success: true, salonId, inactive: setInactive });
  } catch (error) {
    console.error('[TOGGLE] Error:', error);
    return res.status(500).json({ error: 'Errore del server, riprova.' });
  }
}
