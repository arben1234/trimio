import { useState, useEffect } from 'react';
import { getToken, getUser, setToken, setUser, clearToken, clearUser } from '../utils/storage';
import { api } from '../utils/api';

// Hook scoped al salone: legge/scrive solo il token del salone corrente
export function useSalonAuth(salonSlug, salonId) {
  const [user, setUserState] = useState(() => salonId ? getUser(salonId) : null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // Se cambia salone, resetta lo stato - previene cross-salon bleed
  useEffect(() => {
    if (salonId) {
      setUserState(getUser(salonId));
    } else {
      setUserState(null);
    }
  }, [salonId]);

  async function login(username, password) {
    setLoading(true);
    setError(null);
    try {
      const data = await api.salonLogin(salonSlug, { username, password });
      setToken(data.user.salonId, data.token);
      setUser(data.user.salonId, data.user);
      setUserState(data.user);
      return data.user;
    } catch (e) {
      setError(e.message);
      return null;
    } finally {
      setLoading(false);
    }
  }

  function logout() {
    if (salonId) { clearToken(salonId); clearUser(salonId); }
    setUserState(null);
  }

  const isLoggedIn = !!user && !!getToken(salonId);
  return { user, login, logout, loading, error, isLoggedIn };
}

export function useAdminAuth() {
  const [user, setUserState] = useState(() => {
    try { return JSON.parse(localStorage.getItem('trimio_admin_user')); } catch { return null; }
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  async function login(username, password) {
    setLoading(true);
    setError(null);
    try {
      const data = await api.adminLogin({ username, password });
      localStorage.setItem('trimio_admin_token', data.token);
      localStorage.setItem('trimio_admin_user', JSON.stringify(data.user));
      setUserState(data.user);
      return data.user;
    } catch (e) {
      setError(e.message);
      return null;
    } finally {
      setLoading(false);
    }
  }

  function logout() {
    localStorage.removeItem('trimio_admin_token');
    localStorage.removeItem('trimio_admin_user');
    setUserState(null);
  }

  return { user, login, logout, loading, error, isLoggedIn: !!user };
}
