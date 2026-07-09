import { getSalonsDb, setSalonsDb, getAdminDb, setAdminDb } from './kv.js';

// Login + every credential mutation used to be their own serverless
// functions, but Vercel's Hobby plan caps a deployment at 12 functions —
// this project was already at 12, so this logic lives here as plain helpers
// called from api/sync.js's POST handler (action: 'login' / 'change_password')
// instead of as separate routes. No behavior difference, just fewer functions.

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

  if (role === 'admin') {
    const admin = await getAdminDb(kvUrl, kvToken);
    if (username === admin.username && password === admin.password) {
      return { status: 200, json: { success: true, role: 'admin' } };
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
        return { status: 200, json: { success: true, role: 'owner', salonId: salon.id, salonName: salon.name } };
      }
    } else {
      const w = (salon.workers || []).find(x => x.username === username && x.password === password);
      if (w) {
        if (salon.inactive) return { status: 200, json: { success: false, error: 'salon_inactive' } };
        return { status: 200, json: { success: true, role: 'barber', salonId: salon.id, workerId: w.id, name: w.name } };
      }
    }
    return { status: 401, json: { success: false, error: 'invalid_credentials' } };
  }

  return { status: 400, json: { success: false, error: 'invalid_role' } };
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
