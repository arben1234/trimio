import { getSalonsDb, setSalonsDb, getAdminDb, setAdminDb } from '../lib/kv.js';

// Predictable recovery password: first name/word, lowercased, accents and
// punctuation stripped, + "123" — mirrors defaultResetPassword() in js/app.js
// so an admin-triggered reset produces the same value the UI has always shown.
function defaultResetPassword(name) {
  const noAccents = (name || '').normalize('NFD').split('').filter(ch => {
    const code = ch.charCodeAt(0);
    return code < 0x0300 || code > 0x036f;
  }).join('');
  const base = noAccents.trim().split(/\s+/)[0].toLowerCase().replace(/[^a-z0-9]/g, '');
  return (base || 'utente') + '123';
}

// Every credential mutation in the app (self-service change, admin reset,
// admin's own credentials) now goes through this single verified endpoint
// instead of the client editing STATE.admin/STATE.salons locally and pushing
// the whole blob back via /api/sync — the client no longer even holds
// plaintext passwords locally (GET /api/sync strips them), so there is
// nothing left to mutate client-side.
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'method_not_allowed' });

  const kvUrl = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;
  if (!kvUrl || !kvToken) return res.status(500).json({ success: false, error: 'database_not_configured' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const { action } = body;

    if (action === 'self') {
      // Owner/barber changing their OWN password — proven via their current one.
      const { role, salonId, workerId, currentPassword, newPassword } = body;
      if (!role || !salonId || typeof currentPassword !== 'string' || !newPassword || newPassword.length < 4) {
        return res.status(400).json({ success: false, error: 'invalid_request' });
      }
      const salons = await getSalonsDb(kvUrl, kvToken);
      const salon = salons.find(s => s.id === salonId);
      if (!salon) return res.status(404).json({ success: false, error: 'salon_not_found' });

      if (role === 'owner') {
        if (currentPassword !== salon.ownerPassword) return res.status(401).json({ success: false, error: 'wrong_current_password' });
        salon.ownerPassword = newPassword;
      } else if (role === 'barber') {
        const w = (salon.workers || []).find(x => x.id === workerId);
        if (!w) return res.status(404).json({ success: false, error: 'worker_not_found' });
        if (currentPassword !== w.password) return res.status(401).json({ success: false, error: 'wrong_current_password' });
        w.password = newPassword;
      } else {
        return res.status(400).json({ success: false, error: 'invalid_role' });
      }
      await setSalonsDb(kvUrl, kvToken, salons);
      return res.status(200).json({ success: true });
    }

    if (action === 'admin_self') {
      // Admin changing their OWN username/password.
      const { currentPassword, newUsername, newPassword } = body;
      const admin = await getAdminDb(kvUrl, kvToken);
      if (typeof currentPassword !== 'string' || currentPassword !== admin.password) {
        return res.status(401).json({ success: false, error: 'wrong_current_password' });
      }
      if (!newUsername || !newPassword || newPassword.length < 4) {
        return res.status(400).json({ success: false, error: 'invalid_request' });
      }
      await setAdminDb(kvUrl, kvToken, { username: newUsername, password: newPassword });
      return res.status(200).json({ success: true, username: newUsername });
    }

    if (action === 'admin_set') {
      // Admin setting/resetting an owner's or a worker's password — proven via
      // the admin's OWN current password (same proof-of-identity pattern as
      // /api/reset-all-data), since there is no server-side session to check.
      const { adminPassword, targetType, salonId, workerId, newPassword } = body;
      const admin = await getAdminDb(kvUrl, kvToken);
      if (typeof adminPassword !== 'string' || adminPassword !== admin.password) {
        return res.status(401).json({ success: false, error: 'wrong_admin_password' });
      }
      const salons = await getSalonsDb(kvUrl, kvToken);
      const salon = salons.find(s => s.id === salonId);
      if (!salon) return res.status(404).json({ success: false, error: 'salon_not_found' });

      let finalPassword;
      if (targetType === 'owner') {
        finalPassword = newPassword || defaultResetPassword(salon.ownerUsername);
        salon.ownerPassword = finalPassword;
      } else if (targetType === 'barber') {
        const w = (salon.workers || []).find(x => x.id === workerId);
        if (!w) return res.status(404).json({ success: false, error: 'worker_not_found' });
        finalPassword = newPassword || defaultResetPassword(w.name);
        w.password = finalPassword;
      } else {
        return res.status(400).json({ success: false, error: 'invalid_target_type' });
      }
      await setSalonsDb(kvUrl, kvToken, salons);
      return res.status(200).json({ success: true, newPassword: finalPassword });
    }

    return res.status(400).json({ success: false, error: 'invalid_action' });
  } catch (err) {
    console.error('[CHANGE-PASSWORD] Error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
