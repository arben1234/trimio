import { getSalonsDb, setSalonsDb, acquireBillingLock, releaseBillingLock, claimStripeEventOnce } from '../lib/kv.js';
import { getStripe, stripeConfigured } from '../lib/stripe.js';
import { romeYearMonth } from '../lib/time.js';
import { sendEmail } from '../lib/email.js';

// Stripe webhook signature verification needs the exact raw request bytes —
// disable Vercel's automatic JSON body parsing so we can read the stream
// ourselves. (Every other api/*.js handler relies on the default parsed
// req.body; this is the one file in the project that can't.)
export const config = { api: { bodyParser: false } };

async function readRawBody(req) {
  // dev-server.js (local only) always consumes the request stream itself
  // before calling the handler and stashes the raw string on req.rawBody,
  // since it doesn't respect Vercel's bodyParser:false convention — use that
  // if present. In production (Vercel, bodyParser disabled above) the stream
  // is still open here, so buffer it ourselves.
  if (typeof req.rawBody === 'string') return req.rawBody;
  const chunks = [];
  for await (const chunk of req) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks);
}

// invoice.subscription moved under invoice.parent.subscription_details in
// newer API versions — check both so a future account-level version bump
// (or a pinned-version mismatch) doesn't silently break correlation.
function subscriptionIdFromInvoice(invoice) {
  return invoice.subscription || invoice.parent?.subscription_details?.subscription || null;
}

async function findSalonByStripeIds(salons, { customerId, subscriptionId }) {
  let salon = salons.find(s => s.billing?.stripeCustomerId === customerId);
  if (salon || !subscriptionId) return salon || null;
  salon = salons.find(s => s.billing?.stripeSubscriptionId === subscriptionId);
  return salon || null;
}

// Wraps a salon read-modify-write with the per-salon lock, so two webhook
// events for different salons landing within milliseconds of each other
// can't clobber one another (getSalonsDb/setSalonsDb is a full-blob
// read-modify-write, not a compare-and-swap). `mutate` receives the live
// salons array and the matched salon; return false to skip the write
// (e.g. no matching salon found).
async function withSalonLock(kvUrl, kvToken, salonId, mutate) {
  const locked = await acquireBillingLock(kvUrl, kvToken, salonId);
  if (!locked) {
    console.error('[STRIPE-WEBHOOK] Could not acquire billing lock for salon', salonId);
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
  if (!stripeConfigured()) return res.status(200).json({ received: true, note: 'stripe_not_configured' });

  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) return res.status(200).json({ received: true, note: 'webhook_secret_not_configured' });

  const kvUrl = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;
  if (!kvUrl || !kvToken) return res.status(500).json({ error: 'KV database not configured' });

  const stripe = getStripe();
  let event;
  try {
    const raw = await readRawBody(req);
    event = stripe.webhooks.constructEvent(raw, req.headers['stripe-signature'], webhookSecret);
  } catch (err) {
    console.error('[STRIPE-WEBHOOK] Signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Stripe redelivers on timeout/5xx — make sure we only ever apply an
  // event's side effects once, even across redeliveries.
  if (!(await claimStripeEventOnce(kvUrl, kvToken, event.id))) {
    return res.status(200).json({ received: true, note: 'already_processed' });
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const salonId = session.client_reference_id;
        if (salonId) {
          await withSalonLock(kvUrl, kvToken, salonId, async (salons) => {
            const salon = salons.find(s => s.id === salonId);
            if (!salon) return false;
            salon.billing = salon.billing || {};
            salon.billing.stripeCustomerId = session.customer;
            salon.billing.stripeSubscriptionId = session.subscription;
            salon.billing.autopay = true;
            return true;
          });
        }
        break;
      }

      case 'invoice.paid': {
        const invoice = event.data.object;
        const subscriptionId = subscriptionIdFromInvoice(invoice);
        // Correlation may need to happen before we know which salon it is
        // (webhook delivery isn't ordered — this can arrive before
        // checkout.session.completed has written stripeCustomerId), so look
        // the salon up first without a lock, then re-resolve it by id inside
        // the locked mutation below.
        const probe = await getSalonsDb(kvUrl, kvToken);
        const salon = await findSalonByStripeIds(probe, { customerId: invoice.customer, subscriptionId });
        if (salon) {
          await withSalonLock(kvUrl, kvToken, salon.id, async (salons) => {
            const s = salons.find(x => x.id === salon.id);
            if (!s) return false;
            s.billing = s.billing || {};
            // Self-heal: this invoice was correlated via subscription
            // metadata, not stripeCustomerId, because checkout.session.completed
            // hadn't landed yet — write it now so future events match directly.
            if (!s.billing.stripeCustomerId) s.billing.stripeCustomerId = invoice.customer;
            s.billing.paidThroughMonth = romeYearMonth();
            s.billing.paymentFailing = false;
            if (s.billing.suspendedByBilling) {
              s.billing.suspendedByBilling = false;
              s.inactive = false;
            }
            return true;
          });
        } else {
          console.error('[STRIPE-WEBHOOK] invoice.paid: no salon matched customer', invoice.customer, 'subscription', subscriptionId);
        }
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        const subscriptionId = subscriptionIdFromInvoice(invoice);
        const probe = await getSalonsDb(kvUrl, kvToken);
        const salon = await findSalonByStripeIds(probe, { customerId: invoice.customer, subscriptionId });
        if (salon) {
          // Handled actively rather than left to Stripe Dashboard dunning
          // config alone — once autopay is true, the daily cron fully skips
          // this salon, so suspension can't quietly depend on an
          // easy-to-forget external setting. next_payment_attempt is null
          // once Stripe's retry schedule is exhausted.
          const finalAttempt = invoice.next_payment_attempt === null;
          await withSalonLock(kvUrl, kvToken, salon.id, async (salons) => {
            const s = salons.find(x => x.id === salon.id);
            if (!s) return false;
            s.billing = s.billing || {};
            s.billing.paymentFailing = true;
            if (finalAttempt && !s.inactive) {
              s.inactive = true;
              s.billing.suspendedByBilling = true;
            }
            return true;
          });
          if (finalAttempt) {
            await sendEmail(salon.email, 'TRIMIO — Servizio sospeso per mancato pagamento',
              `<p>Ciao,</p><p>Il servizio TRIMIO per <b>${salon.name}</b> è stato sospeso: il pagamento automatico con carta non è andato a buon fine dopo diversi tentativi. ` +
              `Accedi alla gestione del pagamento dal tuo pannello per aggiornare la carta e riattivare il servizio.</p>`);
          }
        } else {
          console.error('[STRIPE-WEBHOOK] invoice.payment_failed: no salon matched customer', invoice.customer, 'subscription', subscriptionId);
        }
        break;
      }

      case 'customer.subscription.updated': {
        const subscription = event.data.object;
        const probe = await getSalonsDb(kvUrl, kvToken);
        const salon = await findSalonByStripeIds(probe, { customerId: subscription.customer, subscriptionId: subscription.id });
        if (salon) {
          const failing = subscription.status === 'past_due' || subscription.status === 'unpaid';
          await withSalonLock(kvUrl, kvToken, salon.id, async (salons) => {
            const s = salons.find(x => x.id === salon.id);
            if (!s || !s.billing) return false;
            s.billing.paymentFailing = failing;
            return true;
          });
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object;
        const probe = await getSalonsDb(kvUrl, kvToken);
        const salon = await findSalonByStripeIds(probe, { customerId: subscription.customer, subscriptionId: subscription.id });
        if (salon) {
          // Falls back to being treated as a manual-payment salon by the
          // daily cron from its next run onward.
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
        // Unhandled event types are expected (Stripe sends many) — 200 so
        // Stripe doesn't retry them.
        break;
    }
  } catch (err) {
    console.error('[STRIPE-WEBHOOK] Handler error for event', event.type, err);
    return res.status(500).json({ error: 'internal_error' });
  }

  return res.status(200).json({ received: true });
}
