import { getToken, getAdminToken } from './storage';

const BASE = '/api';

async function request(url, options = {}, salonId = null) {
  const token = salonId ? getToken(salonId) : getAdminToken();
  const res = await fetch(`${BASE}${url}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Errore server');
  return data;
}

export const api = {
  // Auth
  adminLogin: (creds) => request('/auth/admin/login', { method: 'POST', body: creds }),
  salonLogin: (slug, creds) => request(`/auth/salon/${slug}/login`, { method: 'POST', body: creds }),
  getVapidKey: () => request('/auth/vapid-key'),
  savePushSub: (sub, salonId) => request('/auth/push-subscription', { method: 'POST', body: { subscription: sub } }, salonId),

  // Pubblico - cliente
  getSalon: (slug) => request(`/salons/${slug}`),
  getAvailability: (slug, barberId, date, serviceId) =>
    request(`/salons/${slug}/barbers/${barberId}/availability?date=${date}${serviceId ? `&serviceId=${serviceId}` : ''}`),
  createBooking: (slug, data) => request(`/salons/${slug}/bookings`, { method: 'POST', body: data }),
  addRating: (slug, bookingId, data) => request(`/salons/${slug}/bookings/${bookingId}/rating`, { method: 'POST', body: data }),

  // Staff (con salonId per auth)
  getBookings: (slug, params, salonId) => request(`/salons/${slug}/bookings?${new URLSearchParams(params)}`, {}, salonId),
  updateBooking: (slug, id, data, salonId) => request(`/salons/${slug}/bookings/${id}`, { method: 'PUT', body: data }, salonId),
  getStats: (slug, salonId) => request(`/salons/${slug}/stats`, {}, salonId),
  getBarberHours: (slug, barberId) => request(`/salons/${slug}/barbers/${barberId}/hours`),
  updateBarberHours: (slug, barberId, hours, salonId) => request(`/salons/${slug}/barbers/${barberId}/hours`, { method: 'PUT', body: { hours } }, salonId),
  getHolidays: (slug, barberId) => request(`/salons/${slug}/barbers/${barberId}/holidays`),
  addHoliday: (slug, barberId, data, salonId) => request(`/salons/${slug}/barbers/${barberId}/holidays`, { method: 'POST', body: data }, salonId),
  deleteHoliday: (slug, barberId, date, salonId) => request(`/salons/${slug}/barbers/${barberId}/holidays/${date}`, { method: 'DELETE' }, salonId),
  getRatings: (slug, barberId) => request(`/salons/${slug}/barbers/${barberId}/ratings`),
  getServices: (slug, salonId) => request(`/salons/${slug}/services`, {}, salonId),
  createService: (slug, data, salonId) => request(`/salons/${slug}/services`, { method: 'POST', body: data }, salonId),
  updateService: (slug, id, data, salonId) => request(`/salons/${slug}/services/${id}`, { method: 'PUT', body: data }, salonId),
  deleteService: (slug, id, salonId) => request(`/salons/${slug}/services/${id}`, { method: 'DELETE' }, salonId),

  // Super admin
  admin: {
    getSalons: () => request('/admin/salons', {}, null),
    createSalon: (data) => request('/admin/salons', { method: 'POST', body: data }),
    updateSalon: (id, data) => request(`/admin/salons/${id}`, { method: 'PUT', body: data }),
    deleteSalon: (id) => request(`/admin/salons/${id}`, { method: 'DELETE' }),
    getBarbers: (salonId) => request(`/admin/salons/${salonId}/barbers`),
    addBarber: (salonId, data) => request(`/admin/salons/${salonId}/barbers`, { method: 'POST', body: data }),
    updateBarber: (id, data) => request(`/admin/barbers/${id}`, { method: 'PUT', body: data }),
    deleteBarber: (id) => request(`/admin/barbers/${id}`, { method: 'DELETE' }),
    getStats: () => request('/admin/stats')
  }
};
