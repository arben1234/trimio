const webpush = require('web-push');
const db = require('../database');

let initialized = false;

function init() {
  if (initialized) return;
  const pub = process.env.VAPID_PUBLIC;
  const priv = process.env.VAPID_PRIVATE;
  if (!pub || !priv) return;
  webpush.setVapidDetails('mailto:admin@trimio.app', pub, priv);
  initialized = true;
}

function sendPush(pushSubJson, title, body, url) {
  if (!initialized) return;
  try {
    const sub = typeof pushSubJson === 'string' ? JSON.parse(pushSubJson) : pushSubJson;
    webpush.sendNotification(sub, JSON.stringify({ title, body, url })).catch(() => {});
  } catch {}
}

// Invia push al barber prenotato e a tutti gli owner del salone
function notifyNewBooking(salonId, booking) {
  init();
  if (!initialized) return;

  const enriched = db.prepare(
    'SELECT b.*, u.name as barber_name, s.name as service_name FROM bookings b LEFT JOIN users u ON b.barber_id = u.id LEFT JOIN services s ON b.service_id = s.id WHERE b.id = ?'
  ).get(booking.id);
  if (!enriched) return;

  const salonSlug = db.prepare('SELECT slug FROM salons WHERE id = ?').get(salonId)?.slug;
  const body = `${enriched.client_name} · ${enriched.time}`;
  const base = process.env.APP_URL || 'https://trimio-app.vercel.app';

  // Barber prenotato
  const barber = db.prepare('SELECT push_sub FROM users WHERE id = ?').get(enriched.barber_id);
  if (barber?.push_sub) {
    sendPush(barber.push_sub, 'Nuova prenotazione ✂️', body, salonSlug ? `${base}/s/${salonSlug}/barber` : base);
  }

  // Tutti gli owner del salone
  const owners = db.prepare(
    "SELECT push_sub FROM users WHERE salon_id = ? AND role = 'owner' AND push_sub IS NOT NULL"
  ).all(salonId);
  owners.forEach(o => {
    sendPush(o.push_sub, `Prenotazione · ${enriched.barber_name || ''}`, body, salonSlug ? `${base}/s/${salonSlug}/owner` : base);
  });
}

module.exports = { notifyNewBooking };
