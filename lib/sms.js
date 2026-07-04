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
