// Token isolati per salone: previene cross-salon session bleed
export const getToken = (salonId) => localStorage.getItem(`trimio_token_${salonId}`);
export const setToken = (salonId, token) => localStorage.setItem(`trimio_token_${salonId}`, token);
export const clearToken = (salonId) => localStorage.removeItem(`trimio_token_${salonId}`);

export const getUser = (salonId) => {
  try { return JSON.parse(localStorage.getItem(`trimio_user_${salonId}`)); } catch { return null; }
};
export const setUser = (salonId, user) => localStorage.setItem(`trimio_user_${salonId}`, JSON.stringify(user));
export const clearUser = (salonId) => localStorage.removeItem(`trimio_user_${salonId}`);

export const getAdminToken = () => localStorage.getItem('trimio_admin_token');
export const setAdminToken = (token) => localStorage.setItem('trimio_admin_token', token);
export const clearAdminToken = () => localStorage.removeItem('trimio_admin_token');
