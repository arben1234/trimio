// Shared Italy wall-clock time helpers. The server always runs in UTC, but
// every reminder window and quiet-hours rule in this app is defined in terms
// of what a customer/barber in Italy actually sees on a clock — Europe/Rome,
// DST-aware via the IANA tz database (Intl), never a fixed UTC offset (which
// would silently drift wrong every summer/winter).
export function romeNow() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Rome', hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
  }).formatToParts(new Date());
  const get = t => parts.find(p => p.type === t).value;
  const year = Number(get('year')), month = Number(get('month')), day = Number(get('day'));
  const pad = n => String(n).padStart(2, '0');
  const next = new Date(Date.UTC(year, month - 1, day) + 86400000);
  return {
    todayISO: `${year}-${pad(month)}-${pad(day)}`,
    tomorrowISO: `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}`,
    minutes: Number(get('hour')) * 60 + Number(get('minute'))
  };
}

// The one place "no notification before 8:00 or after 20:00 Europe/Rome" is
// decided — used by the scheduled reminder cron AND every immediate/
// event-triggered send (new-booking push to the barber, booking-confirmation
// SMS to the customer, staff-cancellation notice, the manual "Notifica"
// button), so the rule can never drift between a cron job and a live request.
export function isQuietHours() {
  const { minutes } = romeNow();
  return minutes < 8 * 60 || minutes >= 20 * 60;
}
