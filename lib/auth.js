import crypto from 'crypto';
import { getSalonsDb, setSalonsDb, getAdminDb, setAdminDb } from './kv.js';

// Login + every credential mutation used to be their own serverless
// functions, but Vercel's Hobby plan caps a deployment at 12 functions —
// this project was already at 12, so this logic lives here as plain helpers
// called from api/sync.js's POST handler (action: 'login' / 'change_password')
// instead of as separate routes. No behavior difference, just fewer functions.

// Best-effort caller IP for rate limiting — Vercel's edge sets
// x-forwarded-for on every request; req.socket is only a meaningful fallback
// for local dev-server.js, which has no proxy in front of it.
export function getClientIp(req) {
  const fwd = req.headers && req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.trim()) return fwd.split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

// Verifies a caller-supplied password against the real admin password in KV —
// the same proof-of-identity check reset-all-data.js already used, now shared
// so every destructive/admin-only endpoint (toggle-salon, delete-salon) can
// require it too instead of trusting an unauthenticated request.
export async function verifyAdminPassword(password, kvUrl, kvToken) {
  if (typeof password !== 'string' || !password) return false;
  const admin = await getAdminDb(kvUrl, kvToken);
  return password === admin.password;
}

// Signed, stateless session token issued at login (see handleLogin below) so
// a client can prove "I already verified as role X for salon Y" on later
// requests (GET /api/sync scoping, /api/subscribe) WITHOUT holding a
// plaintext password locally anymore. Not a general-purpose JWT — just an
// HMAC'd JSON blob with a fixed 30-day expiry.
const TOKEN_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function tokenSecret() {
  return process.env.SESSION_SECRET || '';
}

export function issueSessionToken(payload) {
  const secret = tokenSecret();
  if (!secret) return null; // no secret configured — callers must treat this as "no token"
  const body = Buffer.from(JSON.stringify({ ...payload, iat: Date.now() }), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

// Returns the verified payload, or null if the token is missing, malformed,
// forged, or expired — callers must fall back to the most restrictive
// (anonymous) behavior on null, never assume a role.
export function verifySessionToken(token) {
  const secret = tokenSecret();
  if (!secret || typeof token !== 'string') return null;
  const dot = token.indexOf('.');
  if (dot < 1) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expected);
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload.iat || Date.now() - payload.iat > TOKEN_MAX_AGE_MS) return null;
    return payload;
  } catch {
    return null;
  }
}

// Pulls "Authorization: Bearer <token>" off a request and verifies it — the
// one place every endpoint that needs to know "who is really asking" goes
// through, so GET /api/sync and /api/subscribe apply the exact same rule.
export function getVerifiedSession(req) {
  const header = req.headers && req.headers['authorization'];
  if (!header || !header.startsWith('Bearer ')) return null;
  return verifySessionToken(header.slice(7));
}

// Predictable recovery password: first name/word, lowercased, accents and
// punctuation stripped, + "123" — mirrors the old client-side
// defaultResetPassword() in js/app.js so a reset produces the same value.
function defaultResetPassword(name) {
  const noAccents = (name || '').normalize('NFD').split('').filter(ch => {
    const code = ch.charCodeAt(0);
    return code < 0x0300 || code > 0x036f;
  }).join('');
  const base = noAccents.trim().split(/\s+/)[0].toLowerCase().replace(/[^a-z0-9]/g, '');
  return (base || 'utente') + '123';
}

export async function handleLogin(body, kvUrl, kvToken) {
  const { role, salonId, username, password } = body;
  if (!role || typeof username !== 'string' || !username || typeof password !== 'string' || !password) {
    return { status: 400, json: { success: false, error: 'missing_fields' } };
  }

  // A KV outage must never be reported the same way as a wrong password —
  // the old behavior let this exception bubble out of the whole request,
  // which the client's tryLogin() then treated identically to
  // invalid_credentials ("Credenziali non valide" during a real outage).
  try {
    if (role === 'admin') {
      const admin = await getAdminDb(kvUrl, kvToken);
      if (username === admin.username && password === admin.password) {
        return { status: 200, json: { success: true, role: 'admin', sessionToken: issueSessionToken({ role: 'admin' }) } };
      }
      return { status: 401, json: { success: false, error: 'invalid_credentials' } };
    }

    if (role === 'owner' || role === 'barber') {
      if (!salonId) return { status: 400, json: { success: false, error: 'missing_fields' } };
      const salons = await getSalonsDb(kvUrl, kvToken);
      const salon = salons.find(s => s.id === salonId);
      if (!salon) return { status: 401, json: { success: false, error: 'invalid_credentials' } };

      if (role === 'owner') {
        if (username === salon.ownerUsername && password === salon.ownerPassword) {
          if (salon.inactive) return { status: 200, json: { success: false, error: 'salon_inactive' } };
          const sessionToken = issueSessionToken({ role: 'owner', salonId: salon.id });
          return { status: 200, json: { success: true, role: 'owner', salonId: salon.id, salonName: salon.name, sessionToken } };
        }
      } else {
        const w = (salon.workers || []).find(x => x.username === username && x.password === password);
        if (w) {
          if (salon.inactive) return { status: 200, json: { success: false, error: 'salon_inactive' } };
          const sessionToken = issueSessionToken({ role: 'barber', salonId: salon.id, workerId: w.id });
          return { status: 200, json: { success: true, role: 'barber', salonId: salon.id, workerId: w.id, name: w.name, sessionToken } };
        }
      }
      return { status: 401, json: { success: false, error: 'invalid_credentials' } };
    }

    return { status: 400, json: { success: false, error: 'invalid_role' } };
  } catch (err) {
    console.error('[LOGIN] KV error:', err.message);
    return { status: 503, json: { success: false, error: 'service_unavailable' } };
  }
}

export async function handleChangePassword(body, kvUrl, kvToken) {
  const { type } = body;

  if (type === 'self') {
    const { role, salonId, workerId, currentPassword, newPassword } = body;
    if (!role || !salonId || typeof currentPassword !== 'string' || !newPassword || newPassword.length < 4) {
      return { status: 400, json: { success: false, error: 'invalid_request' } };
    }
    const salons = await getSalonsDb(kvUrl, kvToken);
    const salon = salons.find(s => s.id === salonId);
    if (!salon) return { status: 404, json: { success: false, error: 'salon_not_found' } };

    if (role === 'owner') {
      if (currentPassword !== salon.ownerPassword) return { status: 401, json: { success: false, error: 'wrong_current_password' } };
      salon.ownerPassword = newPassword;
    } else if (role === 'barber') {
      const w = (salon.workers || []).find(x => x.id === workerId);
      if (!w) return { status: 404, json: { success: false, error: 'worker_not_found' } };
      if (currentPassword !== w.password) return { status: 401, json: { success: false, error: 'wrong_current_password' } };
      w.password = newPassword;
    } else {
      return { status: 400, json: { success: false, error: 'invalid_role' } };
    }
    await setSalonsDb(kvUrl, kvToken, salons);
    return { status: 200, json: { success: true } };
  }

  if (type === 'admin_self') {
    const { currentPassword, newUsername, newPassword } = body;
    const admin = await getAdminDb(kvUrl, kvToken);
    if (typeof currentPassword !== 'string' || currentPassword !== admin.password) {
      return { status: 401, json: { success: false, error: 'wrong_current_password' } };
    }
    if (!newUsername || !newPassword || newPassword.length < 4) {
      return { status: 400, json: { success: false, error: 'invalid_request' } };
    }
    await setAdminDb(kvUrl, kvToken, { username: newUsername, password: newPassword });
    return { status: 200, json: { success: true, username: newUsername } };
  }

  if (type === 'admin_set') {
    const { adminPassword, targetType, salonId, workerId, newPassword } = body;
    const admin = await getAdminDb(kvUrl, kvToken);
    if (typeof adminPassword !== 'string' || adminPassword !== admin.password) {
      return { status: 401, json: { success: false, error: 'wrong_admin_password' } };
    }
    const salons = await getSalonsDb(kvUrl, kvToken);
    const salon = salons.find(s => s.id === salonId);
    if (!salon) return { status: 404, json: { success: false, error: 'salon_not_found' } };

    let finalPassword;
    if (targetType === 'owner') {
      finalPassword = newPassword || defaultResetPassword(salon.ownerUsername);
      salon.ownerPassword = finalPassword;
    } else if (targetType === 'barber') {
      const w = (salon.workers || []).find(x => x.id === workerId);
      if (!w) return { status: 404, json: { success: false, error: 'worker_not_found' } };
      finalPassword = newPassword || defaultResetPassword(w.name);
      w.password = finalPassword;
    } else {
      return { status: 400, json: { success: false, error: 'invalid_target_type' } };
    }
    await setSalonsDb(kvUrl, kvToken, salons);
    return { status: 200, json: { success: true, newPassword: finalPassword } };
  }

  return { status: 400, json: { success: false, error: 'invalid_action' } };
}
