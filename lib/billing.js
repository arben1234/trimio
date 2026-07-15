// Server-side single source of truth for the self-signup fee tiering: €50 for
// 1-5 barbers, +€50 per additional 5 (6-10 -> €100, 11-15 -> €150, ...). Used
// by api/daily-health-check.js's daily warning/suspension check and by the
// Stripe checkout-session action in api/sync.js — both need the exact same
// number a salon's own dashboard already shows them, or a mismatch would mean
// charging a different amount than what was displayed. The client-side copy
// in js/app.js (no bundler, can't import this) must be kept in sync by hand.
export function feeForWorkerCount(n) {
  return Math.ceil(Math.max(Number(n) || 1, 1) / 5) * 50;
}
