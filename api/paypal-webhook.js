import { getSalonsDb, setSalonsDb, acquireBillingLock, releaseBillingLock, claimWebhookEventOnce } from '../lib/kv.js';
import { paypalFetch, paypalConfigured } from '../lib/paypal.js';
import { romeYearMonth } from '../lib/time.js';
import { sendEmail } from '../lib/email.js';

// Unlike Stripe, PayPal's webhook signing is asymmetric/certificate-based,
// not an HMAC over the raw body — verification works by posting the
// already-parsed event object back to PayPal's own verify endpoint, so this
// file (unlike the earlier Stripe webhook it replaces) can use Vercel's
// normal automatic JSON body parsing; no bodyParser:false / raw-body
// handling needed.

async function findSalonByPaypalIds(salons, { customId, subscriptionId }) {
  if (customId) {
    const bySalonId = salons.find(s => s.id === customId);
    if (bySalonId) return bySalonId;
  }
  if (subscriptionId) {
    const bySub = salons.find(s => s.billing?.paypalSubscriptionId === subscriptionId);
    if (bySub) return bySub;
  }
  return null;
}

// Wraps a salon read-modify-write with the per-salon lock, so two webhook
// events for different salons landing within milliseconds of each other
// can't clobber one another (getSalonsDb/setSalonsDb is a full-blob
// read-modify-write, not a compare-and-swap). `mutate` receives the live
// salons array; return false to skip the write (e.g. no matching salon).
async function withSalonLock(kvUrl, kvToken, salonId, mutate) {
  const locked = await acquireBillingLock(kvUrl, kvToken, salonId);
  if (!locked) {
    console.error('[PAYPAL-WEBHOOK] Could not acquire billing lock for salon', salonId);
    return;
  }
  try {
    const salons = await getSalonsDb(kvUrl, kvToken);
    const changed = await mutate(salons);
    if (changed) await setSalonsDb(kvUrl, kvToken, salons);
  } finally {
    await releaseBillingLock(kvUrl, kvToken, salonId);
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  if (!paypalConfigured()) return res.status(200).json({ received: true, note: 'paypal_not_configured' });

  const webhookId = process.env.PAYPAL_WEBHOOK_ID;
  if (!webhookId) return res.status(200).json({ received: true, note: 'webhook_id_not_configured' });

  const kvUrl = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;
  if (!kvUrl || !kvToken) return res.status(500).json({ error: 'KV database not configured' });

  const event = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  if (!event || !event.id) return res.status(400).json({ error: 'invalid_event' });

  // PayPal signs with an asymmetric, certificate-based scheme (not HMAC) —
  // rather than implementing that crypto ourselves, post the event + these
  // headers back to PayPal's own verify-webhook-signature endpoint and trust
  // its verdict. Headers arrive lowercased in Node's req.headers regardless
  // of how PayPal capitalized them on the wire.
  try {
    const verify = await paypalFetch('/v1/notifications/verify-webhook-signature', {
      method: 'POST',
      body: {
        auth_algo: req.headers['paypal-auth-algo'],
        cert_url: req.headers['paypal-cert-url'],
        transmission_id: req.headers['paypal-transmission-id'],
        transmission_sig: req.headers['paypal-transmission-sig'],
        transmission_time: req.headers['paypal-transmission-time'],
        webhook_id: webhookId,
        webhook_event: event
      }
    });
    if (!verify || verify.verification_status !== 'SUCCESS') {
      console.error('[PAYPAL-WEBHOOK] Signature verification failed:', JSON.stringify(verify));
      return res.status(400).json({ error: 'invalid_signature' });
    }
  } catch (err) {
    console.error('[PAYPAL-WEBHOOK] Signature verification request failed:', err.message);
    return res.status(400).json({ error: 'verification_error' });
  }

  // PayPal can redeliver on timeout/5xx — make sure we only ever apply an
  // event's side effects once, even across redeliveries.
  if (!(await claimWebhookEventOnce(kvUrl, kvToken, event.id))) {
    return res.status(200).json({ received: true, note: 'already_processed' });
  }

  try {
    const resource = event.resource || {};
    switch (event.event_type) {
      case 'BILLING.SUBSCRIPTION.ACTIVATED': {
        const salonId = resource.custom_id;
        if (salonId) {
          await withSalonLock(kvUrl, kvToken, salonId, async (salons) => {
            const salon = salons.find(s => s.id === salonId);
            if (!salon) return false;
            salon.billing = salon.billing || {};
            salon.billing.paypalSubscriptionId = resource.id;
            salon.billing.autopay = true;
            salon.billing.paymentFailing = false;
            // The activation itself counts this month as paid immediately —
            // the first PAYMENT.SALE.COMPLETED for the recurring charge
            // doesn't fire until the *next* billing cycle.
            salon.billing.paidThroughMonth = romeYearMonth();
            if (salon.billing.suspendedByBilling) {
              salon.billing.suspendedByBilling = false;
              salon.inactive = false;
            }
            return true;
          });
        } else {
          console.error('[PAYPAL-WEBHOOK] BILLING.SUBSCRIPTION.ACTIVATED missing custom_id (salon id)');
        }
        break;
      }

      case 'PAYMENT.SALE.COMPLETED':
      case 'PAYMENT.CAPTURE.COMPLETED': {
        // Which of these two actually fires for a subscription's recurring
        // charge isn't fully nailed down from docs alone — handle both
        // defensively rather than betting on just one. Correlates by
        // paypalSubscriptionId (already stored by ACTIVATED above for every
        // real subscription by the time its second charge happens), not
        // custom_id, since a Sale/Capture resource doesn't reliably carry it.
        const subscriptionId = resource.billing_agreement_id
          || resource.supplementary_data?.related_ids?.subscription_id
          || null;
        if (subscriptionId) {
          const probe = await getSalonsDb(kvUrl, kvToken);
          const salon = await findSalonByPaypalIds(probe, { subscriptionId });
          if (salon) {
            await withSalonLock(kvUrl, kvToken, salon.id, async (salons) => {
              const s = salons.find(x => x.id === salon.id);
              if (!s) return false;
              s.billing = s.billing || {};
              s.billing.paidThroughMonth = romeYearMonth();
              s.billing.paymentFailing = false;
              if (s.billing.suspendedByBilling) {
                s.billing.suspendedByBilling = false;
                s.inactive = false;
              }
              return true;
            });
          }
        }
        break;
      }

      case 'BILLING.SUBSCRIPTION.PAYMENT.FAILED': {
        const probe = await getSalonsDb(kvUrl, kvToken);
        const salon = await findSalonByPaypalIds(probe, { customId: resource.custom_id, subscriptionId: resource.id });
        if (salon) {
          await withSalonLock(kvUrl, kvToken, salon.id, async (salons) => {
            const s = salons.find(x => x.id === salon.id);
            if (!s || !s.billing) return false;
            s.billing.paymentFailing = true;
            return true;
          });
        }
        break;
      }

      case 'BILLING.SUBSCRIPTION.SUSPENDED': {
        // PayPal auto-suspends a subscription once its own retry schedule is
        // exhausted — this is the "final attempt failed" signal, so suspend
        // actively here rather than depending on anything else, since the
        // daily cron (api/daily-health-check.js) fully skips autopay salons.
        const probe = await getSalonsDb(kvUrl, kvToken);
        const salon = await findSalonByPaypalIds(probe, { customId: resource.custom_id, subscriptionId: resource.id });
        if (salon) {
          await withSalonLock(kvUrl, kvToken, salon.id, async (salons) => {
            const s = salons.find(x => x.id === salon.id);
            if (!s || !s.billing) return false;
            s.billing.paymentFailing = true;
            if (!s.inactive) {
              s.inactive = true;
              s.billing.suspendedByBilling = true;
            }
            return true;
          });
          await sendEmail(salon.email, 'TRIMIO — Servizio sospeso per mancato pagamento',
            `<p>Ciao,</p><p>Il servizio TRIMIO per <b>${salon.name}</b> è stato sospeso: il pagamento automatico con carta non è andato a buon fine dopo diversi tentativi. ` +
            `Accedi alla gestione del pagamento dal tuo pannello per riattivare il servizio.</p>`);
        }
        break;
      }

      case 'BILLING.SUBSCRIPTION.CANCELLED': {
        const probe = await getSalonsDb(kvUrl, kvToken);
        const salon = await findSalonByPaypalIds(probe, { customId: resource.custom_id, subscriptionId: resource.id });
        if (salon) {
          await withSalonLock(kvUrl, kvToken, salon.id, async (salons) => {
            const s = salons.find(x => x.id === salon.id);
            if (!s || !s.billing) return false;
            s.billing.autopay = false;
            return true;
          });
        }
        break;
      }

      default:
        // Unhandled event types are expected (PayPal sends many) — 200 so
        // it doesn't retry them.
        break;
    }
  } catch (err) {
    console.error('[PAYPAL-WEBHOOK] Handler error for event', event.event_type, err);
    return res.status(500).json({ error: 'internal_error' });
  }

  return res.status(200).json({ received: true });
}
