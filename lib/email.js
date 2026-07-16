// Email via Resend's plain HTTP API — no SDK dependency needed, same
// "silent no-op when unconfigured" convention as lib/sms.js's Twilio
// wrapper. Requires RESEND_API_KEY; RESEND_FROM defaults to Resend's shared
// sandbox sender, which can only deliver to the Resend account's own
// verified address until a sending domain is verified in the Resend
// dashboard — see the env var note in CLAUDE.md.
export function emailConfigured() {
  return !!process.env.RESEND_API_KEY;
}

// Every email built in this codebase interpolates user-controlled data
// (salon name, owner name, address...) straight into an HTML body — some of
// it, at self-signup, from a completely unauthenticated caller, sent to the
// ADMIN's own inbox (a real attacker→admin trust boundary, not just self-
// XSS). Mirrors js/app.js's client-side escapeHtml() exactly.
export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export async function sendEmail(to, subject, html) {
  if (!emailConfigured() || !to) return false;
  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: process.env.RESEND_FROM || 'TRIMIO <onboarding@resend.dev>',
        to, subject, html
      })
    });
    if (!resp.ok) {
      const err = await resp.text().catch(() => '');
      console.error('[EMAIL] Resend send failed:', resp.status, err.slice(0, 300));
    }
    return resp.ok;
  } catch (e) {
    console.error('[EMAIL] send error:', e.message);
    return false;
  }
}
