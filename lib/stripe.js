import Stripe from 'stripe';

// Stripe: automatic monthly recurring card billing for self-signup salons —
// a NEW opt-in path alongside the existing manual bank-transfer + admin
// mark-paid flow (see CLAUDE.md's billing section). Configured entirely from
// env vars; when absent, every Stripe-touching action degrades to a clean
// "not configured" response instead of crashing — same precedent as Twilio
// (lib/sms.js's twilioConfigured()) and Resend (lib/email.js).
//   STRIPE_SECRET_KEY    — from the Stripe Dashboard (test or live mode)
//   STRIPE_WEBHOOK_SECRET — the signing secret for api/stripe-webhook.js,
//                           from the Dashboard's Webhooks settings once that
//                           endpoint URL is registered there
export function stripeConfigured() {
  return !!process.env.STRIPE_SECRET_KEY;
}

// Pinned explicitly rather than left to float to the account's dashboard
// default — an account-level API version bump must never silently change
// webhook payload shapes or Checkout/Portal behavior underneath this code.
const STRIPE_API_VERSION = '2026-06-24.dahlia';

let cachedClient = null;
export function getStripe() {
  if (!stripeConfigured()) return null;
  if (!cachedClient) {
    cachedClient = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: STRIPE_API_VERSION });
  }
  return cachedClient;
}
