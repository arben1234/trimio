// PayPal REST API (Subscriptions): automatic monthly recurring card billing
// for self-signup salons — chosen over Stripe because Stripe doesn't support
// merchant accounts registered in Albania (this business's country), while
// PayPal does. Called directly via fetch (no SDK), same pattern this project
// already uses for Twilio/Resend. Configured entirely from env vars; when
// absent, every PayPal-touching action degrades to a clean "not configured"
// response instead of crashing.
//   PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET — from a PayPal Developer
//                        Dashboard app (Sandbox or Live)
//   PAYPAL_ENV          — 'live' to call the production API; anything else
//                        (including unset) uses the Sandbox API, so a
//                        missing/mistyped value fails safe into test mode
//                        instead of accidentally going live.
//   PAYPAL_WEBHOOK_ID   — the id PayPal assigns when the webhook endpoint is
//                        registered (Dashboard or the Webhooks API) —
//                        required to verify incoming signatures.
export function paypalConfigured() {
  return !!(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET);
}

function apiBase() {
  return process.env.PAYPAL_ENV === 'live'
    ? 'https://api-m.paypal.com'
    : 'https://api-m.sandbox.paypal.com';
}

// Cached at module scope so a warm serverless instance reuses the same token
// across requests instead of authenticating every call; refreshed a minute
// before it actually expires.
let cachedToken = null;
let cachedTokenExpiresAt = 0;

async function getAccessToken() {
  if (cachedToken && Date.now() < cachedTokenExpiresAt - 60000) return cachedToken;
  const auth = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString('base64');
  const resp = await fetch(`${apiBase()}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials'
  });
  if (!resp.ok) {
    const err = await resp.text().catch(() => '');
    throw new Error(`PayPal OAuth token request failed: ${resp.status} ${err.slice(0, 300)}`);
  }
  const data = await resp.json();
  cachedToken = data.access_token;
  cachedTokenExpiresAt = Date.now() + data.expires_in * 1000;
  return cachedToken;
}

// Thin authenticated-JSON-call wrapper shared by every PayPal endpoint this
// app touches (Products, Plans, Subscriptions, webhook signature
// verification). Returns the parsed JSON body, or null for a 204 No Content
// (subscription cancel). Throws on a non-2xx response.
export async function paypalFetch(path, { method = 'GET', body, extraHeaders } = {}) {
  const token = await getAccessToken();
  const resp = await fetch(`${apiBase()}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...extraHeaders
    },
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  if (resp.status === 204) return null;
  const text = await resp.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON response */ }
  if (!resp.ok) {
    const err = new Error(`PayPal API ${method} ${path} failed: ${resp.status} ${text.slice(0, 300)}`);
    err.paypalResponse = json;
    throw err;
  }
  return json;
}
