// SMS (and later WhatsApp) reminders via Twilio's REST API — no SDK needed.
// Configured entirely from env vars; when they're absent every send is a
// silent no-op so the push-only behavior stays unchanged:
//   TWILIO_ACCOUNT_SID  — from the Twilio console dashboard
//   TWILIO_AUTH_TOKEN   — idem
//   TWILIO_FROM         — sender: alphanumeric "TRIMIO" (one-way, allowed in
//                         Italy) or a purchased number "+1..."
//   TWILIO_WHATSAPP_FROM (optional) — "whatsapp:+39..." approved WhatsApp
//                         sender; when set it is tried BEFORE SMS. Note that
//                         business-initiated WhatsApp messages outside a 24h
//                         customer session require a pre-approved template.
export function twilioConfigured() {
  return !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM);
}

// "+39 345 678 9012" / "345 6789012" / "0039..." -> "+393456789012".
// Bare national numbers are assumed Italian (the booking UI already
// normalizes new numbers, this covers bookings saved before that).
export function toE164(phone) {
  let v = String(phone || '').replace(/[^\d+]/g, '');
  if (!v) return null;
  if (v.startsWith('00')) v = '+' + v.slice(2);
  if (!v.startsWith('+')) v = '+39' + v;
  return /^\+\d{8,15}$/.test(v) ? v : null;
}

// toE164() above is deliberately lenient — a bare length/shape check, used
// to format ANY phone (including legacy numbers saved before client-side
// validation existed) for SMS delivery, where an undeliverable number is
// harmless (the send just silently fails). It alone doesn't catch a
// +39-prefixed number that isn't a real Italian mobile/landline shape.
// Mirrors js/app.js's isValidItalianPhone() exactly — used specifically for
// validating a phone number COLLECTED at signup/salon-creation, where the
// client already enforces this and a direct API call should not be able to
// submit anything looser.
export function isValidItalianPhone(phone) {
  // Callers that persist the RAW string (not toE164()'s stripped digits-only
  // form — the salon/owner phone stored here is deliberately kept in
  // whatever human-formatted shape the caller sent, e.g. "+39 335 123 4567")
  // must never accept a value whose non-digit characters could be an HTML
  // injection: toE164() strips everything except digits/'+' BEFORE
  // validating the shape, so a payload like `+393331234567"><img
  // src=x onerror=...>` normalizes to a valid-looking Italian number while
  // the malicious raw string still gets stored and later rendered
  // unescaped-adjacent. Restrict the raw input itself to characters any
  // real phone-number formatting would actually use.
  if (typeof phone !== 'string' || !/^[\d\s+\-().]+$/.test(phone)) return false;
  const e164 = toE164(phone);
  if (!e164) return false;
  if (e164.startsWith('+39')) {
    const n = e164.slice(3);
    return /^3\d{8,9}$/.test(n) || /^0\d{7,10}$/.test(n);
  }
  return /^\+\d{8,15}$/.test(e164);
}

async function twilioSend(params) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const resp = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams(params)
  });
  if (!resp.ok) {
    const err = await resp.text().catch(() => '');
    console.error('[SMS] Twilio send failed:', resp.status, err.slice(0, 300));
  }
  return resp.ok;
}

// Sends the reminder to one customer phone. Tries WhatsApp first when a
// WhatsApp sender is configured, falling back to SMS. Returns true if any
// channel accepted the message.
export async function sendCustomerText(phone, body) {
  if (!twilioConfigured()) return false;
  const to = toE164(phone);
  if (!to) return false;

  const waFrom = process.env.TWILIO_WHATSAPP_FROM;
  if (waFrom) {
    const ok = await twilioSend({ To: `whatsapp:${to}`, From: waFrom, Body: body });
    if (ok) return true;
  }
  return twilioSend({ To: to, From: process.env.TWILIO_FROM, Body: body });
}
