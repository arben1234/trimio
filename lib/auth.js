import crypto from 'crypto';
import { getSalonsDb, setSalonsDb, getAdminDb, setAdminDb, checkRateLimit } from './kv.js';

// Every password on the platform (admin, owner, barber) used to be stored
// and compared in plaintext — a single compromise of the Upstash REST token
// (or an incident at Upstash itself) would have handed over every real
// credential instantly, no work factor at all. scrypt (Node's built-in,
// synchronous — no native-binding dependency issues on Vercel's serverless
// runtime, unlike bcrypt) with a random salt per password closes that.
// Format: "scrypt$<saltHex>$<hashHex>" — the prefix lets verifyPasswordAny()
// tell a hash apart from a legacy plaintext value stored before this change,
// so existing accounts keep working and are opportunistically upgraded to a
// hash the next time they successfully log in / verify, rather than needing
// a disruptive one-time migration of the whole database.
const SCRYPT_PREFIX = 'scrypt$';
const SCRYPT_KEYLEN = 64;

export function hashPassword(plain) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(plain), salt, SCRYPT_KEYLEN);
  return `${SCRYPT_PREFIX}${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function isHashedPassword(stored) {
  return typeof stored === 'string' && stored.startsWith(SCRYPT_PREFIX);
}

// Verifies against either a scrypt hash (current format) or a legacy
// plaintext value (pre-hashing accounts) — timing-safe either way. Never
// mutates anything; callers that hold the underlying record (salons array /
// admin object) are responsible for persisting the opportunistic upgrade to
// a hash on a successful legacy-plaintext match.
export function verifyPasswordAny(plain, stored) {
  if (typeof plain !== 'string' || !plain || typeof stored !== 'string' || !stored) return false;
  if (isHashedPassword(stored)) {
    const parts = stored.slice(SCRYPT_PREFIX.length).split('$');
    if (parts.length !== 2) return false;
    const [saltHex, hashHex] = parts;
    let salt, expected;
    try { salt = Buffer.from(saltHex, 'hex'); expected = Buffer.from(hashHex, 'hex'); } catch { return false; }
    const actual = crypto.scryptSync(plain, salt, SCRYPT_KEYLEN);
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  }
  const a = Buffer.from(plain);
  const b = Buffer.from(stored);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Login + every credential mutation used to be their own serverless
// functions, but Vercel's Hobby plan caps a deployment at 12 functions —
// this project was already at 12, so this logic lives here as plain helpers
// called from api/sync.js's POST handler (action: 'login' / 'change_password')
// instead of as separate routes. No behavior difference, just fewer functions.

// Best-effort caller IP for rate limiting. Verified against Vercel's own
// docs (vercel.com/docs/headers/request-headers#x-forwarded-for): Vercel's
// edge overwrites x-forwarded-for itself and does not forward externally
// supplied IPs, specifically to prevent spoofing — so on a real deployment
// this header is always a single trustworthy value, not a client-editable
// list. Still take the last entry rather than the first: it's a no-op in
// that normal single-value case, but stays correct if this project is ever
// placed behind Vercel's Enterprise "trusted proxy" feature (which can
// prepend an additional, client-supplied hop). req.socket is only a
// meaningful fallback for local dev-server.js, which has no proxy in front
// of it.
export function getClientIp(req) {
  const fwd = req.headers && req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.trim()) {
    const parts = fwd.split(',').map(s => s.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

// Verifies a caller-supplied password against the real admin password in KV —
// the same proof-of-identity check reset-all-data.js already used, now shared
// so every destructive/admin-only endpoint (toggle-salon, delete-salon) can
// require it too instead of trusting an unauthenticated request.
//
// This is the ONLY gate protecting the single global admin password — every
// caller passes `req` and gets IP-rate-limited here (a shared budget across
// every admin-password-gated action, not per-endpoint, since they're all
// really guessing the same one secret) before it's even worth comparing
// passwords; a caller with no `req` (there shouldn't be one) fails closed.
// The comparison itself is also now timing-safe (crypto.timingSafeEqual,
// matching the pattern verifySessionToken below already used) rather than a
// plain `===`, which short-circuits on the first mismatched byte.
export async function verifyAdminPassword(password, kvUrl, kvToken, req) {
  if (typeof password !== 'string' || !password) return false;
  if (!req) return false;
  const rl = await checkRateLimit(kvUrl, kvToken, `ratelimit:admin_pw:${getClientIp(req)}`, 10, 600);
  if (!rl.allowed) return false;
  const admin = await getAdminDb(kvUrl, kvToken);
  const ok = verifyPasswordAny(password, admin.password);
  if (ok && !isHashedPassword(admin.password)) {
    // Opportunistic migration off plaintext — never blocks the caller on it.
    await setAdminDb(kvUrl, kvToken, { ...admin, password: hashPassword(password) }).catch(() => {});
  }
  return ok;
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

export async function handleLogin(body, kvUrl, kvToken, req) {
  const { role, salonId, username, password } = body;
  if (!role || typeof username !== 'string' || !username || typeof password !== 'string' || !password) {
    return { status: 400, json: { success: false, error: 'missing_fields' } };
  }

  // Login itself used to have NO rate limit at all — every other credential
  // check in this file was hardened, but the actual login form (admin, every
  // owner, every barber on the platform) was missed, leaving the single
  // highest-value account (admin) open to an unthrottled brute-force loop.
  // Shared IP budget across all three roles, same shape as verifyAdminPassword's.
  if (!req) return { status: 503, json: { success: false, error: 'service_unavailable' } };
  const rl = await checkRateLimit(kvUrl, kvToken, `ratelimit:login:${getClientIp(req)}`, 15, 600);
  if (!rl.allowed) return { status: 429, json: { success: false, error: 'rate_limited' } };

  // A KV outage must never be reported the same way as a wrong password —
  // the old behavior let this exception bubble out of the whole request,
  // which the client's tryLogin() then treated identically to
  // invalid_credentials ("Credenziali non valide" during a real outage).
  try {
    if (role === 'admin') {
      const admin = await getAdminDb(kvUrl, kvToken);
      if (username === admin.username && verifyPasswordAny(password, admin.password)) {
        if (!isHashedPassword(admin.password)) {
          await setAdminDb(kvUrl, kvToken, { ...admin, password: hashPassword(password) }).catch(() => {});
        }
        return { status: 200, json: { success: true, role: 'admin', sessionToken: issueSessionToken({ role: 'admin' }) } };
      }
      return { status: 401, json: { success: false, error: 'invalid_credentials' } };
    }

    if (role === 'owner') {
      const salons = await getSalonsDb(kvUrl, kvToken);
      // A salon owner can log in from the generic homepage ("Accedi") without
      // knowing their salon's own URL — ownerUsername is enforced unique at
      // self-signup, so it's a safe global lookup key. The salon-specific
      // page ("gear" button on a salon's own page) still passes salonId,
      // scoping the check the same way it always did. Looked up by USERNAME
      // only now (not username+password together) since password is no
      // longer comparable with plain equality once hashed.
      const salon = salonId
        ? salons.find(s => s.id === salonId)
        : salons.find(s => s.ownerUsername === username);
      if (!salon) return { status: 401, json: { success: false, error: 'invalid_credentials' } };

      if (username === salon.ownerUsername && verifyPasswordAny(password, salon.ownerPassword)) {
        if (!isHashedPassword(salon.ownerPassword)) {
          salon.ownerPassword = hashPassword(password);
          await setSalonsDb(kvUrl, kvToken, salons).catch(() => {});
        }
        if (salon.inactive) return { status: 200, json: { success: false, error: 'salon_inactive' } };
        const sessionToken = issueSessionToken({ role: 'owner', salonId: salon.id });
        return { status: 200, json: { success: true, role: 'owner', salonId: salon.id, salonName: salon.name, sessionToken } };
      }
      return { status: 401, json: { success: false, error: 'invalid_credentials' } };
    }

    if (role === 'barber') {
      // Barbers still only ever log in from their own salon's page — no
      // generic-homepage entry point exists for them, so salonId stays required.
      if (!salonId) return { status: 400, json: { success: false, error: 'missing_fields' } };
      const salons = await getSalonsDb(kvUrl, kvToken);
      const salon = salons.find(s => s.id === salonId);
      if (!salon) return { status: 401, json: { success: false, error: 'invalid_credentials' } };

      const w = (salon.workers || []).find(x => x.username === username);
      if (w && verifyPasswordAny(password, w.password)) {
        if (!isHashedPassword(w.password)) {
          w.password = hashPassword(password);
          await setSalonsDb(kvUrl, kvToken, salons).catch(() => {});
        }
        if (salon.inactive) return { status: 200, json: { success: false, error: 'salon_inactive' } };
        const sessionToken = issueSessionToken({ role: 'barber', salonId: salon.id, workerId: w.id });
        return { status: 200, json: { success: true, role: 'barber', salonId: salon.id, workerId: w.id, name: w.name, sessionToken } };
      }
      return { status: 401, json: { success: false, error: 'invalid_credentials' } };
    }

    return { status: 400, json: { success: false, error: 'invalid_role' } };
  } catch (err) {
    console.error('[LOGIN] KV error:', err.message);
    return { status: 503, json: { success: false, error: 'service_unavailable' } };
  }
}

export async function handleChangePassword(body, kvUrl, kvToken, req) {
  const { type } = body;

  if (type === 'self') {
    const { role, salonId, workerId, currentPassword, newPassword } = body;
    if (!role || !salonId || typeof currentPassword !== 'string' || !newPassword || newPassword.length < 4) {
      return { status: 400, json: { success: false, error: 'invalid_request' } };
    }
    // Unlike owner_set (which requires a verified session token), this
    // branch authorizes purely by proof-of-current-password from the
    // request body — a correct guess doesn't just prove identity, it
    // OVERWRITES the real password, silently locking out the legitimate
    // owner/barber. Was the only credential-check path in this file with
    // no rate limit at all.
    const rl = await checkRateLimit(kvUrl, kvToken, `ratelimit:selfpw:${getClientIp(req)}`, 10, 600);
    if (!rl.allowed) return { status: 429, json: { success: false, error: 'rate_limited' } };
    const salons = await getSalonsDb(kvUrl, kvToken);
    const salon = salons.find(s => s.id === salonId);
    if (!salon) return { status: 404, json: { success: false, error: 'salon_not_found' } };

    if (role === 'owner') {
      if (!verifyPasswordAny(currentPassword, salon.ownerPassword)) return { status: 401, json: { success: false, error: 'wrong_current_password' } };
      salon.ownerPassword = hashPassword(newPassword);
    } else if (role === 'barber') {
      const w = (salon.workers || []).find(x => x.id === workerId);
      if (!w) return { status: 404, json: { success: false, error: 'worker_not_found' } };
      if (!verifyPasswordAny(currentPassword, w.password)) return { status: 401, json: { success: false, error: 'wrong_current_password' } };
      w.password = hashPassword(newPassword);
    } else {
      return { status: 400, json: { success: false, error: 'invalid_role' } };
    }
    await setSalonsDb(kvUrl, kvToken, salons);
    return { status: 200, json: { success: true } };
  }

  if (type === 'admin_self') {
    const { currentPassword, newUsername, newPassword } = body;
    if (!(await verifyAdminPassword(currentPassword, kvUrl, kvToken, req))) {
      return { status: 401, json: { success: false, error: 'wrong_current_password' } };
    }
    if (!newUsername || !newPassword || newPassword.length < 4) {
      return { status: 400, json: { success: false, error: 'invalid_request' } };
    }
    await setAdminDb(kvUrl, kvToken, { username: newUsername, password: hashPassword(newPassword) });
    return { status: 200, json: { success: true, username: newUsername } };
  }

  if (type === 'admin_set') {
    const { adminPassword, targetType, salonId, workerId, newPassword } = body;
    if (!(await verifyAdminPassword(adminPassword, kvUrl, kvToken, req))) {
      return { status: 401, json: { success: false, error: 'wrong_admin_password' } };
    }
    // Every other password-setting path in this file enforces a floor
    // (self/owner_set: 4 chars; new-salon/new-worker: 6) — this was the one
    // remaining gap, silently hashing and persisting an admin-supplied
    // 1-character password as-is. Only checked when a real value is
    // supplied; an omitted newPassword still falls back to
    // defaultResetPassword() below, which is always well-formed.
    if (typeof newPassword === 'string' && newPassword && newPassword.length < 6) {
      return { status: 400, json: { success: false, error: 'invalid_request' } };
    }
    const salons = await getSalonsDb(kvUrl, kvToken);
    const salon = salons.find(s => s.id === salonId);
    if (!salon) return { status: 404, json: { success: false, error: 'salon_not_found' } };

    // finalPassword is returned to the admin caller in plaintext once (to
    // display/share the freshly (re)set credential) — only the persisted
    // copy is hashed.
    let finalPassword;
    if (targetType === 'owner') {
      finalPassword = newPassword || defaultResetPassword(salon.ownerUsername);
      salon.ownerPassword = hashPassword(finalPassword);
    } else if (targetType === 'barber') {
      const w = (salon.workers || []).find(x => x.id === workerId);
      if (!w) return { status: 404, json: { success: false, error: 'worker_not_found' } };
      finalPassword = newPassword || defaultResetPassword(w.name);
      w.password = hashPassword(finalPassword);
    } else {
      return { status: 400, json: { success: false, error: 'invalid_target_type' } };
    }
    await setSalonsDb(kvUrl, kvToken, salons);
    return { status: 200, json: { success: true, newPassword: finalPassword } };
  }

  if (type === 'owner_set') {
    // Owner setting/resetting a password for one of THEIR OWN barbers —
    // proven via the caller's verified session token, never a password
    // prompt (the owner has no admin password to give, and must not be
    // asked to re-enter their own).
    const { salonId, workerId, newPassword } = body;
    const session = getVerifiedSession(req);
    if (!session || session.role !== 'owner' || session.salonId !== salonId) {
      return { status: 401, json: { success: false, error: 'unauthorized' } };
    }
    if (!newPassword || newPassword.length < 4) {
      return { status: 400, json: { success: false, error: 'invalid_request' } };
    }
    const salons = await getSalonsDb(kvUrl, kvToken);
    const salon = salons.find(s => s.id === salonId);
    if (!salon) return { status: 404, json: { success: false, error: 'salon_not_found' } };
    const w = (salon.workers || []).find(x => x.id === workerId);
    if (!w) return { status: 404, json: { success: false, error: 'worker_not_found' } };
    w.password = hashPassword(newPassword);
    await setSalonsDb(kvUrl, kvToken, salons);
    return { status: 200, json: { success: true } };
  }

  return { status: 400, json: { success: false, error: 'invalid_action' } };
}
