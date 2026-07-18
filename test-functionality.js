/* ================================================================
   TRIMIO / BARBERS BLOCK — FUNCTIONAL TEST SUITE
   Read-only test harness: loads js/app.js and api/*.js unmodified,
   runs them against mocked DOM/fetch/KV, and asserts on real
   behaviour. Does not touch index.html, css/style.css, js/app.js,
   or the api/*.js files, and never calls the live Vercel/Upstash DB.
   Run with: node test-functionality.js
================================================================ */
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { fileURLToPath, pathToFileURL } from 'url';
import { isValidItalianPhone as isValidItalianPhoneServer } from './lib/sms.js';
import { issueSessionToken } from './lib/auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let pass = 0, fail = 0;
const failures = [];

function ok(cond, label) {
  if (cond) { pass++; }
  else { fail++; failures.push(label); console.log(`  [FAIL] ${label}`); }
}
function eq(actual, expected, label) {
  const okCond = JSON.stringify(actual) === JSON.stringify(expected);
  if (!okCond) console.log(`         expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`);
  ok(okCond, label);
}
function section(name) { console.log(`\n--- ${name} ---`); }
// process.env only stores strings — assigning `undefined` back would coerce
// to the literal string "undefined" (truthy!) instead of clearing the key.
function restoreEnv(key, val) {
  if (val === undefined) delete process.env[key];
  else process.env[key] = val;
}

/* ================================================================
   1. MOCK DOM / BROWSER ENVIRONMENT FOR js/app.js
================================================================ */
const elementCache = new Map();
function makeElement(id) {
  const el = {
    id, value: '', textContent: '', innerHTML: '',
    style: {}, dataset: {},
    _classes: new Set(),
    classList: {
      add: (...c) => c.forEach(x => el._classes.add(x)),
      remove: (...c) => c.forEach(x => el._classes.delete(x)),
      toggle: (c, force) => {
        if (force === undefined) { el._classes.has(c) ? el._classes.delete(c) : el._classes.add(c); }
        else { force ? el._classes.add(c) : el._classes.delete(c); }
      },
      contains: (c) => el._classes.has(c)
    },
    children: [],
    addEventListener: () => {},
    removeEventListener: () => {},
    appendChild: (child) => { el.children.push(child); return child; },
    querySelector: () => makeElement('__anon__'),
    querySelectorAll: () => [],
    click: () => {},
    remove: () => {},
    scrollIntoView: () => {},
    focus: () => {}
  };
  return el;
}
function getElementById(id) {
  if (!elementCache.has(id)) elementCache.set(id, makeElement(id));
  return elementCache.get(id);
}

const localStorageStore = {};
const fakeLocalStorage = {
  getItem: (k) => (k in localStorageStore ? localStorageStore[k] : null),
  setItem: (k, v) => { localStorageStore[k] = String(v); },
  removeItem: (k) => { delete localStorageStore[k]; }
};

// fetch is mocked to never touch the network; app.js's saveState() already
// wraps this in try/catch, so a rejected fetch is a safe no-op in tests.
const fakeFetch = async () => ({
  ok: false, status: 503,
  json: async () => null,
  text: async () => 'mocked-network-disabled-in-test'
});

const sandbox = {
  console,
  window: {
    storage: undefined,
    AudioContext: undefined,
    addEventListener: () => {},
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    navigator: { standalone: false },
    matchMedia: undefined
  },
  document: {
    getElementById,
    querySelector: () => makeElement('__anon__'),
    querySelectorAll: () => [],
    addEventListener: () => {},
    createElement: () => makeElement('__anon__')
  },
  navigator: { clipboard: {} },
  location: { hash: '' },
  localStorage: fakeLocalStorage,
  fetch: fakeFetch,
  setTimeout, clearTimeout, setInterval, clearInterval,
  Date, Math, JSON, Object, Array, String, Number, Boolean, parseInt, parseFloat,
  isNaN, encodeURIComponent, decodeURIComponent
};
sandbox.globalThis = sandbox;
const context = vm.createContext(sandbox);

const appJsPath = path.join(__dirname, 'js', 'app.js');
const appJsCode = fs.readFileSync(appJsPath, 'utf8');

section('Loading js/app.js into sandboxed VM (unmodified source)');
try {
  new vm.Script(appJsCode, { filename: appJsPath }).runInContext(context);
  ok(true, 'app.js executes with no syntax/runtime errors under mock DOM');
} catch (e) {
  ok(false, `app.js threw during load: ${e.stack || e}`);
  console.log('\nCannot continue further tests — app.js failed to load.');
  process.exit(1);
}

// Pull out the pieces we need to exercise, and neutralise the heavy UI
// cascades (showView/initDash/initPushNotifications) that doLogin() would
// otherwise trigger — we're testing login/business logic, not rendering.
new vm.Script(`
  var __EXPORTS__ = {
    STATE, DEFAULT_SERVICES, DEFAULT_SLOTS,
    bookedTimesFor, bookingsFor, openDays,
    getDistance, deg2rad, dayLabel, initials, isoOf, todayISO, relDay,
    isOnVacation, freqTag, urlBase64ToUint8Array, isValidItalianPhone,
    validateCust, custData, doSubmit, custNext,
    doLogin, getSession: function(){ return SESSION; },
    filterByPeriod, feeForWorkerCount,
    isBookingInFuture, getMyBookingsForSalon, rememberMyBooking, renderMyBookingsModal
  };
  var __uiCallCounts = { showView:0, initDash:0, initPush:0 };
  showView = function(){ __uiCallCounts.showView++; };
  initDash = function(){ __uiCallCounts.initDash++; };
  initPushNotifications = function(){ __uiCallCounts.initPush++; return Promise.resolve(); };
  // boot() auto-runs at the bottom of app.js (real behaviour). Its
  // continuation (after "await loadState()") fires as a microtask the
  // first time our test script itself awaits something. Neutralise the
  // side effects we don't want racing our assertions (live geolocation,
  // cloud-sync polling) — this only affects how the test drives app.js,
  // it does not modify app.js itself.
  initCloudSync = function(){};
  findNearestSalons = function(){};
`, { filename: 'export-shim.js' }).runInContext(context);

const X = context.__EXPORTS__;

/* ================================================================
   2. DATA INTEGRITY OF DEFAULT STATE
================================================================ */
section('Default STATE data integrity');
ok(Array.isArray(X.STATE.salons) && X.STATE.salons.length === 9, `9 default salons present (found ${X.STATE.salons.length})`);
ok(X.STATE.salons.every(s => s.id && s.slug && s.ownerUsername && s.ownerPassword), 'every salon has id/slug/owner credentials');
ok(X.STATE.salons.every(s => Array.isArray(s.workers) && s.workers.length > 0), 'every salon has at least one worker');
ok(X.STATE.salons.every(s => s.workers.every(w => w.username && w.password)), 'every worker has username/password');
ok(X.DEFAULT_SERVICES.length === 4 && X.DEFAULT_SERVICES.every(s => s.name && s.price > 0), 'DEFAULT_SERVICES well-formed');
ok(X.DEFAULT_SLOTS.length === 16, `DEFAULT_SLOTS has 16 entries (found ${X.DEFAULT_SLOTS.length})`);

const allUsernames = X.STATE.salons.flatMap(s => [s.ownerUsername, ...s.workers.map(w => w.username)]);
eq(new Set(allUsernames).size, allUsernames.length, 'no duplicate usernames across owners/workers');

/* ================================================================
   4. DATE / GEO UTILITIES
================================================================ */
section('Date & geo utility functions');
ok(/^\d{4}-\d{2}-\d{2}$/.test(X.todayISO()), 'todayISO() returns ISO date string');
eq(X.isoOf(2026, 0, 5), '2026-01-05', 'isoOf() pads month/day correctly');
ok(X.dayLabel('2026-07-01').length > 0, 'dayLabel() produces a non-empty label');
eq(X.relDay(X.todayISO()), 'Oggi', 'relDay(today) === "Oggi"');
ok(X.isOnVacation({ vacFrom: '2026-07-01', vacTo: '2026-07-10' }, '2026-07-05') === true, 'isOnVacation() true inside range');
ok(X.isOnVacation({ vacFrom: '2026-07-01', vacTo: '2026-07-10' }, '2026-08-01') === false, 'isOnVacation() false outside range');
eq(X.freqTag(3).l, 'Fedele', 'freqTag(3) => Fedele');
eq(X.freqTag(1).l, 'Regolare', 'freqTag(1) => Regolare');
eq(X.freqTag(0).l, 'Da riattivare', 'freqTag(0) => Da riattivare');

// Bergamo -> Milano is roughly 40km in a straight line
const dist = X.getDistance(45.6983, 9.6773, 45.4642, 9.1900);
ok(dist > 30 && dist < 60, `getDistance(Bergamo, Milano) plausible (${dist.toFixed(1)} km)`);
eq(X.getDistance(45, 9, 45, 9), 0, 'getDistance() of identical points is 0');

ok(X.isValidItalianPhone('+39 035 123 4567'), 'isValidItalianPhone() accepts +39 with spaces');
ok(X.isValidItalianPhone('3331234567'), 'isValidItalianPhone() accepts a bare 10-digit mobile number');
ok(X.isValidItalianPhone('02-1234567'), 'isValidItalianPhone() accepts dashes as separators');
ok(!X.isValidItalianPhone(''), 'isValidItalianPhone() rejects an empty string');
ok(!X.isValidItalianPhone('abc'), 'isValidItalianPhone() rejects non-numeric input');
ok(!X.isValidItalianPhone('123'), 'isValidItalianPhone() rejects an implausibly short number');

// lib/sms.js's server-side isValidItalianPhone() mirrors the client check
// above, but is the one actually gating what gets PERSISTED (signup_salon /
// admin-created salon phone fields). A prior audit found it validated only
// the digits toE164() extracts, not the raw string itself — a payload like
// `+393331234567"><img src=x onerror=...>` normalized to a valid-looking
// number while the malicious raw string still got stored/rendered
// unescaped-adjacent. This is the regression test for that fix: the raw
// input must be restricted to characters a real phone number would use.
section('lib/sms.js — isValidItalianPhone() rejects unsafe raw characters (stored-XSS regression)');
ok(isValidItalianPhoneServer('+39 333 123 4567'), 'server: accepts a normal formatted Italian mobile number');
ok(!isValidItalianPhoneServer('+393331234567"><img src=x onerror=alert(1)>'), 'server: rejects real-looking digits smuggled inside an HTML-injection payload');
ok(!isValidItalianPhoneServer('<script>3331234567</script>'), 'server: rejects a script tag wrapped around real digits');
ok(!isValidItalianPhoneServer(123), 'server: rejects a non-string input outright');

/* ================================================================
   MONTHLY BILLING FEE TIERS (self-signup salons)
================================================================ */
eq(X.feeForWorkerCount(1), 50, 'feeForWorkerCount(1) is €50 (1-5 tier)');
eq(X.feeForWorkerCount(5), 50, 'feeForWorkerCount(5) is €50 (1-5 tier)');
eq(X.feeForWorkerCount(6), 100, 'feeForWorkerCount(6) is €100 (6-10 tier)');
eq(X.feeForWorkerCount(10), 100, 'feeForWorkerCount(10) is €100 (6-10 tier)');
eq(X.feeForWorkerCount(11), 150, 'feeForWorkerCount(11) is €150 (11-15 tier)');
eq(X.feeForWorkerCount(15), 150, 'feeForWorkerCount(15) is €150 (11-15 tier)');
eq(X.feeForWorkerCount(16), 200, 'feeForWorkerCount(16) extrapolates to €200 (16-20 tier)');
eq(X.feeForWorkerCount(0), 50, 'feeForWorkerCount(0) floors to the 1-5 tier');

/* ================================================================
   5. BOOKING HELPERS
================================================================ */
section('Booking helpers (bookedTimesFor / bookingsFor / openDays)');
{
  const salon = X.STATE.salons[0];
  const worker = salon.workers[0];
  const iso = X.todayISO();
  X.STATE.bookings.push({ id: 'test1', salonId: salon.id, workerId: worker.id, dateISO: iso, time: '10:00', status: 'confirmed' });
  X.STATE.bookings.push({ id: 'test2', salonId: salon.id, workerId: worker.id, dateISO: iso, time: '11:00', status: 'cancelled' });

  const booked = X.bookedTimesFor(salon.id, iso, worker.id);
  ok(booked.includes('10:00'), 'bookedTimesFor() includes confirmed booking time');
  ok(!booked.includes('11:00'), 'bookedTimesFor() excludes cancelled bookings');

  const forSalon = X.bookingsFor(salon.id);
  ok(forSalon.length >= 2, 'bookingsFor(salonId) returns bookings for that salon');
  const forWorker = X.bookingsFor(salon.id, worker.id);
  ok(forWorker.every(b => b.workerId === worker.id), 'bookingsFor(salonId, workerId) filters by worker');

  const days = X.openDays(salon);
  ok(days.length === (salon.bookingDays || 30), `openDays() returns ${salon.bookingDays} bookable days`);
  ok(new Set(days.map(d => d.iso)).size === days.length, 'openDays() returns no duplicate dates');
  ok(days[0].isToday === true, 'openDays() marks first day as isToday');

  // cleanup so later tests start from a clean slate
  X.STATE.bookings = X.STATE.bookings.filter(b => b.id !== 'test1' && b.id !== 'test2');
}

/* ================================================================
   6. CUSTOMER BOOKING VALIDATION (validateCust)
================================================================ */
section('Customer booking flow validation (validateCust)');
{
  const custStepScript = (n) => new vm.Script(`custStep = ${n};`, { filename: 'set-step.js' }).runInContext(context);
  Object.keys(X.custData).forEach(k => X.custData[k] = null);

  custStepScript(0);
  ok(X.validateCust() === false, 'step 0 rejected without a selected barber');
  X.custData.barberId = 'w1';
  ok(X.validateCust() === true, 'step 0 passes once barber selected');

  // Step order per validateCust() itself: 0=barber, 1=service, 2=date/time, 3=contact.
  custStepScript(1);
  ok(X.validateCust() === false, 'step 1 rejected without a service');
  X.custData.service = 'Taglio';
  ok(X.validateCust() === true, 'step 1 passes once service selected');

  custStepScript(2);
  ok(X.validateCust() === false, 'step 2 rejected without date/time');
  X.custData.dateISO = '2099-01-01'; X.custData.time = '10:00';
  ok(X.validateCust() === true, 'step 2 passes with future date + time');

  custStepScript(3);
  X.custData.name = 'A';
  ok(X.validateCust() === false, 'step 3 rejected for a 1-character name');
  X.custData.name = 'Mario Rossi';
  ok(X.validateCust() === false, 'step 3 still rejected with no phone number');
  X.custData.phone = '3331234567';
  ok(X.validateCust() === true, 'step 3 passes with a valid name and phone');
}

section('isBookingInFuture() and the customer "my bookings" list (past-bookings-hidden regression)');
{
  const todayIso = X.todayISO();
  ok(X.isBookingInFuture({ dateISO: '2099-01-01', time: '10:00' }) === true, 'isBookingInFuture(): a far-future date is future');
  ok(X.isBookingInFuture({ dateISO: '2000-01-01', time: '10:00' }) === false, 'isBookingInFuture(): a far-past date is not future');
  ok(X.isBookingInFuture({ dateISO: todayIso, time: '00:00' }) === false, "isBookingInFuture(): today at 00:00 has already passed (unless run at literally midnight)");
  ok(X.isBookingInFuture({ dateISO: todayIso, time: '23:59' }) === true, 'isBookingInFuture(): today at 23:59 has not happened yet');

  // renderMyBookingsModal() used to hand getMyBookingsForSalon()'s result
  // (deliberately unfiltered by date — sorted by nearest-in-time in EITHER
  // direction) straight to the customer's own booking list, mixing past
  // appointments in alongside upcoming ones.
  const salon = new vm.Script(`custSalon = STATE.salons[0]; custSalon;`, { filename: 'set-salon-mybookings.js' }).runInContext(context);
  const pastBk = { id: 'mybk-past', salonId: salon.id, workerId: salon.workers[0].id, workerName: salon.workers[0].name, dateISO: '2000-01-01', dateLabel: '1 Gen 2000', time: '10:00', service: 'Taglio', status: 'confirmed', name: 'Me', phone: '333' };
  const futureBk = { id: 'mybk-future', salonId: salon.id, workerId: salon.workers[0].id, workerName: salon.workers[0].name, dateISO: '2099-01-01', dateLabel: '1 Gen 2099', time: '10:00', service: 'Taglio', status: 'confirmed', name: 'Me', phone: '333' };
  X.STATE.bookings.push(pastBk, futureBk);
  fakeLocalStorage.setItem('trimio_my_bookings', JSON.stringify(['mybk-past', 'mybk-future']));

  const mineUnfiltered = X.getMyBookingsForSalon(salon.id);
  ok(mineUnfiltered.some(b => b.id === 'mybk-past') && mineUnfiltered.some(b => b.id === 'mybk-future'),
    'getMyBookingsForSalon() itself is still unfiltered by date (used elsewhere for nearest-in-time sorting)');

  elementCache.delete('myBookingsList');
  X.renderMyBookingsModal();
  const listHtml = elementCache.get('myBookingsList').innerHTML;
  ok(listHtml.includes('1 Gen 2099'), "the customer's booking list shows an upcoming booking");
  ok(!listHtml.includes('1 Gen 2000'), "the customer's booking list no longer shows a past booking");

  // cleanup
  X.STATE.bookings = X.STATE.bookings.filter(b => b.id !== 'mybk-past' && b.id !== 'mybk-future');
  fakeLocalStorage.removeItem('trimio_my_bookings');
}

/* ================================================================
   7. FULL BOOKING SUBMISSION incl. DOUBLE-BOOKING CONFLICT
================================================================ */
section('doSubmit() booking creation + conflict detection');
{
  // Swap the sandbox's fetch for one that echoes a successful sync response
  // (default sandbox fetch always fails, to keep other sections network-free).
  const echoSuccessFetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    return { ok: true, status: 200, json: async () => ({ success: true, bookings: body.bookings || [], conflicts: [] }) };
  };
  context.fetch = echoSuccessFetch;

  new vm.Script(`custSalon = STATE.salons[0];`, { filename: 'set-salon.js' }).runInContext(context);
  const salon = X.STATE.salons[0];
  const before = X.STATE.bookings.length;

  Object.assign(X.custData, {
    barberId: salon.workers[0].id, barberName: salon.workers[0].name,
    dateISO: '2099-06-15', dateLabel: 'Lun 15 Giu', time: '09:00',
    service: 'Taglio', price: 15, name: 'Cliente Test', phone: '3331234567'
  });
  await X.doSubmit();
  ok(X.STATE.bookings.length === before + 1, 'doSubmit() adds exactly one booking on success');
  const created = X.STATE.bookings[X.STATE.bookings.length - 1];
  eq(created.status, 'confirmed', 'newly created booking has status=confirmed');
  eq(created.name, 'Cliente Test', 'newly created booking keeps trimmed customer name');

  // Re-submit the exact same slot for the exact same barber -> rejected client-side
  // (bookedTimesFor already sees it locally) before any network call is made.
  const beforeConflict = X.STATE.bookings.length;
  await X.doSubmit();
  ok(X.STATE.bookings.length === beforeConflict, 'doSubmit() refuses a double-booking for the same barber/slot/day (client-side check)');

  // cleanup
  X.STATE.bookings = X.STATE.bookings.filter(b => b.id !== created.id);

  // Server-reported conflict: client thinks the slot is free, but the server
  // (racing against another customer) rejects it via the `conflicts` list.
  Object.assign(X.custData, {
    barberId: salon.workers[1].id, barberName: salon.workers[1].name,
    dateISO: '2099-06-16', dateLabel: 'Mar 16 Giu', time: '09:30',
    service: 'Taglio', price: 15, name: 'Cliente Conflitto', phone: ''
  });
  const beforeServerConflict = X.STATE.bookings.length;
  context.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    const submitted = body.bookings[0];
    return { ok: true, status: 200, json: async () => ({ success: true, bookings: [], conflicts: [{ id: submitted.id }] }) };
  };
  await X.doSubmit();
  ok(X.STATE.bookings.length === beforeServerConflict, 'a server-reported conflict rolls back the optimistic local booking push');
  ok(elementCache.get('altModal')?._classes.has('show'), 'a server-reported conflict shows the alternative-barber modal instead of a fake success screen');

  // Generic failure (network/server error): must not show a fake success screen.
  elementCache.get('altModal')?._classes.delete('show');
  elementCache.delete('cErr');
  Object.assign(X.custData, {
    barberId: salon.workers[2].id, barberName: salon.workers[2].name,
    dateISO: '2099-06-17', dateLabel: 'Mer 17 Giu', time: '10:00',
    service: 'Taglio', price: 15, name: 'Cliente Errore', phone: ''
  });
  const beforeFailure = X.STATE.bookings.length;
  context.fetch = async () => ({ ok: false, status: 500, text: async () => 'boom' });
  await X.doSubmit();
  ok(X.STATE.bookings.length === beforeFailure, 'a generic save failure rolls back the optimistic local booking push');
  ok(elementCache.get('cErr')?._classes.has('show'), 'a generic save failure shows an error to the customer instead of a fake success screen');

  context.fetch = fakeFetch; // restore the default network-disabled sandbox fetch
}

/* ================================================================
   8. LOGIN — ALL 4 USER LEVELS
================================================================ */
section('doLogin() across the 4 access levels');
{
  // Login moved from a synchronous local-STATE credential check to an async
  // POST /api/sync (action:'login'), server-verified. Mirrors lib/auth.js's
  // handleLogin matching rules against X.STATE
  // (the same default salons/admin embedded in app.js) purely to drive
  // doLogin()'s own client-side routing/gating logic under test here — the
  // server-side credential matching itself is exercised separately by the
  // KV-backed api/sync.js "login" tests further down.
  const loginEchoFetch = async (url, opts) => {
    // onLoginSuccess() also fires a GET refresh right after login (no
    // request body) — only action:'login' POSTs are actually handled here.
    const body = opts && opts.body ? JSON.parse(opts.body) : null;
    if (!body || body.action !== 'login') return { ok: true, json: async () => ({ success: false }) };
    const { role, salonId, username, password } = body;
    if (role === 'admin') {
      if (username === X.STATE.admin.username && password === X.STATE.admin.password) {
        return { ok: true, json: async () => ({ success: true, role: 'admin', sessionToken: 'test-admin-token' }) };
      }
      return { ok: true, json: async () => ({ success: false, error: 'invalid_credentials' }) };
    }
    if (role === 'owner') {
      const salon = salonId
        ? X.STATE.salons.find(s => s.id === salonId)
        : X.STATE.salons.find(s => s.ownerUsername === username && s.ownerPassword === password);
      if (salon && username === salon.ownerUsername && password === salon.ownerPassword) {
        return { ok: true, json: async () => ({ success: true, role: 'owner', salonId: salon.id, salonName: salon.name, sessionToken: 'test-owner-token' }) };
      }
      return { ok: true, json: async () => ({ success: false, error: 'invalid_credentials' }) };
    }
    if (role === 'barber') {
      const salon = X.STATE.salons.find(s => s.id === salonId);
      const w = salon && (salon.workers || []).find(x => x.username === username && x.password === password);
      if (w) return { ok: true, json: async () => ({ success: true, role: 'barber', salonId: salon.id, workerId: w.id, name: w.name, sessionToken: 'test-barber-token' }) };
      return { ok: true, json: async () => ({ success: false, error: 'invalid_credentials' }) };
    }
    return { ok: true, json: async () => ({ success: false, error: 'invalid_role' }) };
  };
  context.fetch = loginEchoFetch;

  const setLogin = (usr, pwd) => new vm.Script(
    `document.getElementById('lusr').value = ${JSON.stringify(usr)}; document.getElementById('lpw').value = ${JSON.stringify(pwd)};`,
    { filename: 'set-login.js' }
  ).runInContext(context);
  const setLoginSalonContext = (id) => new vm.Script(
    `loginSalonContext = ${id === null ? 'null' : JSON.stringify(id)};`,
    { filename: 'set-login-salon-context.js' }
  ).runInContext(context);
  const setLoginRoleContext = (role) => new vm.Script(
    `loginRoleContext = ${role === null ? 'null' : JSON.stringify(role)};`,
    { filename: 'set-login-role-context.js' }
  ).runInContext(context);

  // Generic entry point (no salon context, e.g. the bare root URL) — admin only.
  setLoginSalonContext(null);
  setLogin('admin', 'admin123');
  await X.doLogin();
  eq(X.getSession().role, 'admin', 'Level 1 — admin/admin123 authenticates as admin from the generic entry point');

  const salon0 = X.STATE.salons[0];
  setLoginSalonContext(null);
  setLogin(salon0.ownerUsername, salon0.ownerPassword);
  await X.doLogin();
  let sess = X.getSession();
  ok(sess.role === 'admin', 'owner credentials are REJECTED from the generic entry point (still admin session from before)');

  const worker0 = salon0.workers[0];
  setLoginSalonContext(null);
  setLogin(worker0.username, worker0.password);
  await X.doLogin();
  sess = X.getSession();
  ok(sess.role === 'admin', 'barber credentials are REJECTED from the generic entry point (still admin session from before)');

  // Salon-specific entry point (reached via that salon's own page) — owner/barber allowed.
  setLoginSalonContext(salon0.id);
  setLogin(salon0.ownerUsername, salon0.ownerPassword);
  await X.doLogin();
  sess = X.getSession();
  ok(sess.role === 'owner' && sess.salonId === salon0.id, 'Level 2 — owner credentials authenticate when scoped to their own salon');

  setLoginSalonContext(salon0.id);
  setLogin(worker0.username, worker0.password);
  await X.doLogin();
  sess = X.getSession();
  ok(sess.role === 'barber' && sess.workerId === worker0.id, 'Level 3 — barber credentials authenticate when scoped to their own salon');

  setLoginSalonContext(salon0.id);
  setLogin('nobody', 'wrongpass');
  await X.doLogin();
  sess = X.getSession();
  ok(sess.role === 'barber', 'invalid credentials leave SESSION untouched (still previous barber session)');

  // Admin credentials must NEVER work once a salon context is set, even from
  // the generic role-agnostic staff entry (gear icon / "Sei staff?").
  setLoginSalonContext(salon0.id);
  setLoginRoleContext(null);
  setLogin(X.STATE.admin.username, X.STATE.admin.password);
  await X.doLogin();
  sess = X.getSession();
  ok(sess.role === 'barber', 'admin credentials are REJECTED from a salon-scoped login (still previous barber session)');

  // Role-specific entry points ("Login Proprietario" / "Login Staf") must
  // strictly reject the OTHER role's credentials, not silently log them in.
  setLoginSalonContext(salon0.id);
  setLoginRoleContext('owner');
  setLogin(worker0.username, worker0.password);
  await X.doLogin();
  sess = X.getSession();
  ok(sess.role === 'barber', 'barber credentials are REJECTED from the "Login Proprietario" entry (still previous barber session)');

  setLoginSalonContext(salon0.id);
  setLoginRoleContext('owner');
  setLogin(salon0.ownerUsername, salon0.ownerPassword);
  await X.doLogin();
  sess = X.getSession();
  ok(sess.role === 'owner' && sess.salonId === salon0.id, 'owner credentials still authenticate via the "Login Proprietario" entry');

  setLoginSalonContext(salon0.id);
  setLoginRoleContext('barber');
  setLogin(salon0.ownerUsername, salon0.ownerPassword);
  await X.doLogin();
  sess = X.getSession();
  ok(sess.role === 'owner', 'owner credentials are REJECTED from the "Login Staf/Barbiere" entry (still previous owner session)');

  setLoginSalonContext(salon0.id);
  setLoginRoleContext('barber');
  setLogin(worker0.username, worker0.password);
  await X.doLogin();
  sess = X.getSession();
  ok(sess.role === 'barber' && sess.workerId === worker0.id, 'barber credentials still authenticate via the "Login Staf/Barbiere" entry');

  setLoginRoleContext(null); // restore generic context so later suites are unaffected
  context.fetch = fakeFetch; // restore the default network-disabled sandbox fetch

  ok(context.__uiCallCounts.showView >= 3, `successful logins triggered showView() (${context.__uiCallCounts.showView} times)`);
}

/* ================================================================
   9. filterByPeriod()
================================================================ */
section('filterByPeriod()');
{
  new vm.Script(`statsPeriod = 'oggi';`, { filename: 'set-period.js' }).runInContext(context);
  const today = X.todayISO();
  const sample = [{ dateISO: today }, { dateISO: '2000-01-01' }];
  const filtered = X.filterByPeriod(sample);
  eq(filtered.length, 1, 'filterByPeriod("oggi") keeps only bookings dated today');
}

/* ================================================================
   10. SERVERLESS API HANDLERS — WITH A FAKE IN-MEMORY REDIS
   (never touches the real Vercel/Upstash database from .env.local)

   Simulates both transports the real handlers use against Upstash:
   - path-style GET/SET on a single blob key (salons_db, legacy bookings_db,
     push_subscriptions)
   - array-command POST to the base URL (HSET/HGETALL/SET NX/DEL/PERSIST),
     used for the per-booking Hash storage + atomic slot locks.
================================================================ */
function makeFakeRedis() {
  const strings = new Map();
  const hashes = new Map();
  const ttl = new Map();

  function alive(key) {
    if (!strings.has(key)) return false;
    const exp = ttl.get(key);
    if (exp !== undefined && Date.now() > exp) { strings.delete(key); ttl.delete(key); return false; }
    return true;
  }
  function okResult(result) { return { ok: true, json: async () => ({ result }) }; }

  async function fetchImpl(url, opts) {
    const u = new URL(url);
    const pathMatch = u.pathname.match(/\/(get|set)\/([^/]+)$/);
    if (pathMatch) {
      const [, verb, key] = pathMatch;
      if (verb === 'get') return okResult(alive(key) ? strings.get(key) : null);
      const value = JSON.parse(opts.body); // path-style /set/<key> body = JSON.stringify(value)
      strings.set(key, value);
      ttl.delete(key);
      return okResult('OK');
    }

    // Array-command form: POST to the base URL with a JSON array body.
    const args = JSON.parse(opts.body);
    const [cmd, ...rest] = args;
    switch (String(cmd).toUpperCase()) {
      case 'GET': {
        const [key] = rest;
        return okResult(alive(key) ? strings.get(key) : null);
      }
      case 'SET': {
        const [key, value, ...flags] = rest;
        const nx = flags.includes('NX');
        if (nx && alive(key)) return okResult(null);
        strings.set(key, value);
        const exIdx = flags.indexOf('EX');
        if (exIdx !== -1) ttl.set(key, Date.now() + Number(flags[exIdx + 1]) * 1000);
        else ttl.delete(key);
        return okResult('OK');
      }
      case 'PERSIST': {
        const [key] = rest;
        const had = ttl.has(key);
        ttl.delete(key);
        return okResult(had ? 1 : 0);
      }
      case 'TTL': {
        const [key] = rest;
        if (!alive(key)) return okResult(-2);
        return okResult(ttl.has(key) ? Math.ceil((ttl.get(key) - Date.now()) / 1000) : -1);
      }
      case 'DEL': {
        let count = 0;
        for (const key of rest) {
          if (strings.delete(key)) count++;
          if (hashes.delete(key)) count++;
          ttl.delete(key);
        }
        return okResult(count);
      }
      case 'HSET': {
        const [key, field, value] = rest;
        if (!hashes.has(key)) hashes.set(key, new Map());
        const isNew = !hashes.get(key).has(field);
        hashes.get(key).set(field, value);
        return okResult(isNew ? 1 : 0);
      }
      case 'HDEL': {
        const [key, ...fields] = rest;
        const h = hashes.get(key);
        if (!h) return okResult(0);
        let count = 0;
        for (const f of fields) { if (h.delete(f)) count++; }
        return okResult(count);
      }
      case 'HSETNX': {
        const [key, field, value] = rest;
        if (!hashes.has(key)) hashes.set(key, new Map());
        const h = hashes.get(key);
        if (h.has(field)) return okResult(0);
        h.set(field, value);
        return okResult(1);
      }
      case 'HGETALL': {
        const [key] = rest;
        const h = hashes.get(key);
        const flat = [];
        if (h) for (const [f, v] of h.entries()) flat.push(f, v);
        return okResult(flat);
      }
      case 'KEYS': {
        const [pattern] = rest;
        const re = new RegExp('^' + String(pattern).split('*').map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
        const matched = [...strings.keys()].filter(k => alive(k) && re.test(k));
        return okResult(matched);
      }
      case 'INCR': {
        // Mirrors real Redis: INCR on an absent/expired key starts at 1 and
        // does not itself set a TTL (checkRateLimit in lib/kv.js issues a
        // separate EXPIRE only on the first INCR of a window).
        const [key] = rest;
        const next = (alive(key) ? Number(strings.get(key)) : 0) + 1;
        strings.set(key, String(next));
        return okResult(next);
      }
      case 'EXPIRE': {
        const [key, seconds] = rest;
        if (!strings.has(key)) return okResult(0);
        ttl.set(key, Date.now() + Number(seconds) * 1000);
        return okResult(1);
      }
      default:
        throw new Error('Unsupported fake redis command in test harness: ' + cmd);
    }
  }

  return { fetchImpl, strings, hashes, ttl };
}

// Swaps global fetch + KV env vars for the duration of `fn`, always restoring them.
async function withFakeKv(fake, fn) {
  const prevFetch = globalThis.fetch;
  const prevEnvUrl = process.env.KV_REST_API_URL;
  const prevEnvToken = process.env.KV_REST_API_TOKEN;
  globalThis.fetch = fake.fetchImpl;
  process.env.KV_REST_API_URL = 'https://fake-kv.test';
  process.env.KV_REST_API_TOKEN = 'fake-token';
  try {
    await fn(fake);
  } finally {
    globalThis.fetch = prevFetch;
    restoreEnv('KV_REST_API_URL', prevEnvUrl);
    restoreEnv('KV_REST_API_TOKEN', prevEnvToken);
  }
}
async function freshImport(relPath) {
  const mod = await import(pathToFileURL(path.join(__dirname, relPath)).href + `?t=${Date.now()}_${Math.random()}`);
  return mod.default;
}
function mkRes() {
  const r = { body: null, status: null, headers: {}, endArg: undefined };
  r.obj = {
    setHeader(k, v) { r.headers[k] = v; return r.obj; },
    status(c) { r.status = c; return r.obj; },
    json(b) { r.body = b; return r.obj; },
    end(b) { r.endArg = b; return r.obj; }
  };
  return r;
}

section('api/sync.js — booking sync + merge logic (fake KV, no live network)');
await withFakeKv(makeFakeRedis(), async (fake) => {
  // A new booking is only ever accepted against a real, active salon (see
  // the "salon_inactive" hardening test below) — must be seeded before any
  // booking against salonId 'salonX' can succeed. An anonymous GET/POST also
  // only reflects bookings scoped to an explicit ?salonId= (scopeBookingsForSession
  // in api/sync.js) — a bare "give me every booking on the platform" request
  // now returns [] by design, so every read below scopes to salonX.
  fake.strings.set('salons_db', JSON.stringify([{ id: 'salonX', name: 'Salon X', workers: [{ id: 'w1', name: 'Worker 1' }] }]));
  const handler = await freshImport('api/sync.js');

  const r1 = mkRes();
  await handler({ method: 'GET', query: { salonId: 'salonX' } }, r1.obj);
  ok(r1.status === 200 && Array.isArray(r1.body.bookings) && r1.body.bookings.length === 0, 'GET returns empty bookings initially');

  // A self-cancel (below) proves ownership by matching phone numbers, so the
  // original booking needs one on record.
  const newBooking = { id: 'bk1', status: 'confirmed', salonId: 'salonX', workerId: 'w1', dateISO: '2030-01-01', service: 'Taglio', time: '10:00', dateLabel: 'oggi', name: 'Test', phone: '3331234567' };
  const r2 = mkRes();
  await handler({ method: 'POST', query: { salonId: 'salonX' }, body: { bookings: [newBooking], salons: [] } }, r2.obj);
  ok(r2.status === 200 && r2.body.success === true, 'POST accepts a new booking');
  ok(r2.body.bookings.some(b => b.id === 'bk1'), 'POST response includes the newly merged booking');
  eq(r2.body.conflicts, [], 'no conflicts reported for a genuinely new booking');

  const r3 = mkRes();
  await handler({ method: 'GET', query: { salonId: 'salonX' } }, r3.obj);
  ok(r3.body.bookings.length === 1 && r3.body.bookings[0].id === 'bk1', 'subsequent GET reflects the persisted booking (proves the Hash round-trip works)');

  const r4 = mkRes();
  await handler({ method: 'POST', query: { salonId: 'salonX' }, body: { bookings: [{ ...newBooking, status: 'cancelled' }], salons: [] } }, r4.obj);
  ok(r4.body.bookings.length === 1 && r4.body.bookings[0].status === 'cancelled', 'POST updates existing booking by id instead of duplicating');

  const r5 = mkRes();
  await handler({ method: 'OPTIONS' }, r5.obj);
  eq(r5.status, 200, 'OPTIONS preflight returns 200');
});

section('api/sync.js — CONCURRENCY: same-slot double-booking is rejected atomically');
await withFakeKv(makeFakeRedis(), async (fake) => {
  fake.strings.set('salons_db', JSON.stringify([{ id: 'sX', name: 'Salon X', workers: [{ id: 'wX', name: 'Worker X' }] }]));
  const handler = await freshImport('api/sync.js');
  const base = { salonId: 'sX', workerId: 'wX', dateISO: '2030-02-02', time: '10:00', status: 'confirmed' };
  const bkA = { ...base, id: 'race-a', name: 'A' };
  const bkB = { ...base, id: 'race-b', name: 'B' };
  const rA = mkRes(), rB = mkRes();

  // Fire both requests together (not awaited individually) so their internal
  // awaits genuinely interleave, the same way two concurrent HTTP requests
  // would on a real single-threaded Node server.
  await Promise.all([
    handler({ method: 'POST', body: { bookings: [bkA], salons: [] } }, rA.obj),
    handler({ method: 'POST', body: { bookings: [bkB], salons: [] } }, rB.obj)
  ]);

  const withConflict = [rA, rB].filter(r => r.body.conflicts.length > 0);
  const withoutConflict = [rA, rB].filter(r => r.body.conflicts.length === 0);
  eq(withConflict.length, 1, 'exactly one of two concurrent same-slot bookings is rejected as a conflict');
  eq(withoutConflict.length, 1, 'exactly one of two concurrent same-slot bookings succeeds');

  const storedIds = [...(fake.hashes.get('bookings')?.keys() || [])];
  eq(storedIds.length, 1, 'only one booking is ever actually persisted for a contested slot — no double-booking');
});

section('api/sync.js — CONCURRENCY: different-slot bookings never lose an update');
await withFakeKv(makeFakeRedis(), async (fake) => {
  fake.strings.set('salons_db', JSON.stringify([{ id: 'sX', name: 'Salon X', workers: [{ id: 'wA', name: 'Worker A' }, { id: 'wB', name: 'Worker B' }] }]));
  const handler = await freshImport('api/sync.js');
  const bkA = { id: 'diff-a', salonId: 'sX', workerId: 'wA', dateISO: '2030-02-02', time: '10:00', status: 'confirmed', name: 'A' };
  const bkB = { id: 'diff-b', salonId: 'sX', workerId: 'wB', dateISO: '2030-02-02', time: '10:00', status: 'confirmed', name: 'B' };
  const rA = mkRes(), rB = mkRes();

  await Promise.all([
    handler({ method: 'POST', body: { bookings: [bkA], salons: [] } }, rA.obj),
    handler({ method: 'POST', body: { bookings: [bkB], salons: [] } }, rB.obj)
  ]);

  eq(rA.body.conflicts, [], 'first of two concurrent different-slot bookings has no conflict');
  eq(rB.body.conflicts, [], 'second of two concurrent different-slot bookings has no conflict');
  const storedIds = new Set(fake.hashes.get('bookings')?.keys() || []);
  ok(storedIds.has('diff-a') && storedIds.has('diff-b'), 'both concurrent bookings for different slots are persisted — neither is silently lost');
});

section('api/sync.js — cancelling a booking releases its slot lock for reuse');
await withFakeKv(makeFakeRedis(), async (fake) => {
  fake.strings.set('salons_db', JSON.stringify([{ id: 'sX', name: 'Salon X', workers: [{ id: 'wX', name: 'Worker X' }] }]));
  const handler = await freshImport('api/sync.js');
  // A self-cancel (below) proves ownership by matching phone numbers, so the
  // original booking needs one on record.
  const bk = { id: 'cancel-1', salonId: 'sX', workerId: 'wX', dateISO: '2030-03-03', time: '11:00', status: 'confirmed', name: 'First', phone: '3331234567' };

  await handler({ method: 'POST', body: { bookings: [bk], salons: [] } }, mkRes().obj);

  const rBlocked = mkRes();
  await handler({ method: 'POST', body: { bookings: [{ ...bk, id: 'cancel-2', name: 'Second' }], salons: [] } }, rBlocked.obj);
  ok(rBlocked.body.conflicts.some(c => c.id === 'cancel-2'), 'a second booking for the same slot is rejected while the first is still active');

  await handler({ method: 'POST', body: { bookings: [{ ...bk, status: 'cancelled' }], salons: [] } }, mkRes().obj);

  const rReuse = mkRes();
  await handler({ method: 'POST', body: { bookings: [{ ...bk, id: 'cancel-3', name: 'Third' }], salons: [] } }, rReuse.obj);
  eq(rReuse.body.conflicts, [], 'after cancellation, the freed slot can be booked again without conflict');
});

section('api/sync.js — HARDENING: a staff update can never resurrect a cancelled booking or tamper with price/service/name/phone');
await withFakeKv(makeFakeRedis(), async (fake) => {
  const prevSecret = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = 'test-only-secret-for-session-tokens';
  try {
    // A real services entry is needed — new-booking creation re-derives
    // price/dur server-side from the salon's own service list (svcPrice/
    // svcDurMin), ignoring whatever the client sent, so the tampering test
    // below needs a genuine baseline to tamper away from.
    fake.strings.set('salons_db', JSON.stringify([{ id: 'sY', name: 'Salon Y', workers: [{ id: 'wY', name: 'Worker Y' }], services: [{ name: 'Taglio', price: 20, dur: 30 }] }]));
    const handler = await freshImport('api/sync.js');
    const ownerToken = issueSessionToken({ role: 'owner', salonId: 'sY' });
    const authHdr = { authorization: `Bearer ${ownerToken}` };

    // --- Resurrection: cancelling a booking frees its slot lock for anyone
    // else to take — sending status back to 'confirmed' must never just
    // merge straight through without re-running the same checks a brand
    // new booking would.
    const bk = { id: 'resur-1', salonId: 'sY', workerId: 'wY', dateISO: '2030-07-07', time: '09:00', status: 'confirmed', name: 'Original', phone: '3339990000', service: 'Taglio', price: 20, dur: 30 };
    await handler({ method: 'POST', headers: authHdr, body: { bookings: [bk], salons: [] } }, mkRes().obj);
    await handler({ method: 'POST', headers: authHdr, body: { bookings: [{ ...bk, status: 'cancelled', cancelledBy: 'staff' }], salons: [] } }, mkRes().obj);

    const rResurrect = mkRes();
    await handler({ method: 'POST', headers: authHdr, body: { bookings: [{ ...bk, status: 'confirmed' }], salons: [] } }, rResurrect.obj);
    ok(rResurrect.body.conflicts.some(c => c.id === 'resur-1' && c.error === 'cannot_reactivate_cancelled_booking'), 'sending a cancelled booking back to confirmed is rejected outright');

    const rCheck = mkRes();
    await handler({ method: 'GET', headers: authHdr }, rCheck.obj);
    eq(rCheck.body.bookings.find(b => b.id === 'resur-1')?.status, 'cancelled', 'the booking is still cancelled server-side after the rejected resurrection attempt');

    // Now prove the slot really is free for someone else — a genuine NEW
    // booking (fresh id, goes through the real new-booking checks) at the
    // exact same slot must succeed.
    const rNewAtSameSlot = mkRes();
    await handler({ method: 'POST', headers: authHdr, body: { bookings: [{ ...bk, id: 'resur-1-legit-rebook' }], salons: [] } }, rNewAtSameSlot.obj);
    eq(rNewAtSameSlot.body.conflicts, [], 'a genuinely new booking for the same freed slot succeeds normally');

    // --- Field tampering: a staff update must never let price/duration/
    // service/name/phone be rewritten through the generic status-change path.
    const bk2 = { id: 'tamper-1', salonId: 'sY', workerId: 'wY', dateISO: '2030-07-08', time: '10:00', status: 'confirmed', name: 'Real Name', phone: '3331112222', service: 'Taglio', price: 20, dur: 30 };
    await handler({ method: 'POST', headers: authHdr, body: { bookings: [bk2], salons: [] } }, mkRes().obj);

    const tampered = { ...bk2, status: 'cancelled', cancelledBy: 'staff', price: 1, dur: 999, service: 'FREE HAIRCUT', name: 'Hacked Name', phone: '0000000000' };
    await handler({ method: 'POST', headers: authHdr, body: { bookings: [tampered], salons: [] } }, mkRes().obj);

    const rFinal = mkRes();
    await handler({ method: 'GET', headers: authHdr }, rFinal.obj);
    const stored = rFinal.body.bookings.find(b => b.id === 'tamper-1');
    eq(stored.status, 'cancelled', 'the legitimate status change (cancel) still goes through');
    eq(stored.price, 20, "price can't be tampered via a staff update");
    eq(stored.dur, 30, "duration can't be tampered via a staff update");
    eq(stored.service, 'Taglio', "service name can't be tampered via a staff update");
    eq(stored.name, 'Real Name', "customer name can't be tampered via a staff update");
    eq(stored.phone, '3331112222', "customer phone can't be tampered via a staff update");
  } finally {
    restoreEnv('SESSION_SECRET', prevSecret);
  }
});

section('api/sync.js — one-time migration from the legacy bookings_db blob');
await withFakeKv(makeFakeRedis(), async (fake) => {
  const legacyBooking = { id: 'legacy-1', salonId: 'sLegacy', workerId: 'wLegacy', dateISO: '2030-04-04', time: '09:00', status: 'confirmed', name: 'Legacy Customer' };
  const legacySalons = [{ id: 'sLegacy', name: 'Legacy Salon' }];
  fake.strings.set('bookings_db', JSON.stringify({ bookings: [legacyBooking], salons: legacySalons }));

  const handler = await freshImport('api/sync.js');
  const rGet = mkRes();
  await handler({ method: 'GET', query: { salonId: 'sLegacy' } }, rGet.obj);
  ok(rGet.body.salons.some(s => s.id === 'sLegacy'), 'migrated GET response includes the legacy salon');
  ok(rGet.body.bookings.some(b => b.id === 'legacy-1'), 'migrated GET response includes the legacy booking');

  // The legacy booking's slot must now be protected by a real lock too
  const rConflict = mkRes();
  const clashing = { id: 'new-clash', salonId: 'sLegacy', workerId: 'wLegacy', dateISO: '2030-04-04', time: '09:00', status: 'confirmed', name: 'New Customer' };
  await handler({ method: 'POST', body: { bookings: [clashing], salons: [] } }, rConflict.obj);
  ok(rConflict.body.conflicts.some(c => c.id === 'new-clash'), 'a new booking clashing with a migrated legacy booking is correctly rejected');
});

section('api/sync.js — HARDENING: malformed input cannot crash the handler or corrupt data');
await withFakeKv(makeFakeRedis(), async (fake) => {
  fake.strings.set('salons_db', JSON.stringify([{ id: 'sX', name: 'Salon X', workers: [{ id: 'wX', name: 'Worker X' }] }]));
  const handler = await freshImport('api/sync.js');
  const goodBooking = { id: 'good-1', salonId: 'sX', workerId: 'wX', dateISO: '2030-05-05', time: '09:00', status: 'confirmed', name: 'Good' };
  const malformedBooking = { id: 'bad-1', salonId: 'sX' }; // missing workerId/dateISO/time
  const noIdBooking = { salonId: 'sX', workerId: 'wX', dateISO: '2030-05-05', time: '10:00' };

  const r1 = mkRes();
  await handler({ method: 'POST', query: { salonId: 'sX' }, body: { bookings: [goodBooking, malformedBooking, noIdBooking], salons: [] } }, r1.obj);
  ok(r1.status === 200, 'a batch mixing valid and malformed bookings does not crash the request');
  ok(r1.body.bookings.some(b => b.id === 'good-1'), 'the well-formed booking in the same batch is still persisted');
  ok(r1.body.conflicts.some(c => c.id === 'bad-1' && c.error === 'invalid_booking'), 'the malformed booking is reported back instead of silently accepted');
  const storedIds = new Set(fake.hashes.get('bookings')?.keys() || []);
  ok(!storedIds.has('bad-1') && !storedIds.has('undefined'), 'malformed bookings are never written into the bookings hash');

  // Malformed salons payload must not wipe out the real salons_db.
  fake.strings.set('salons_db', JSON.stringify([{ id: 'sReal', name: 'Real Salon' }]));
  const r2 = mkRes();
  await handler({ method: 'POST', body: { bookings: [], salons: [{ name: 'No id here' }] } }, r2.obj);
  ok(r2.status === 200, 'a malformed salons payload does not crash the request');
  const salonsAfter = JSON.parse(fake.strings.get('salons_db'));
  ok(salonsAfter.some(s => s.id === 'sReal'), 'a malformed salons payload is rejected instead of overwriting salons_db with garbage');
});

section('api/toggle-salon.js — activate/deactivate a salon (fake KV, no live network)');
await withFakeKv(makeFakeRedis(), async (fake) => {
  fake.strings.set('salons_db', JSON.stringify([{ id: 'salonX', name: 'Salon X' }]));
  fake.strings.set('admin_db', JSON.stringify({ username: 'admin', password: 'realSecret1' }));
  const handler = await freshImport('api/toggle-salon.js');

  // Admin-only destructive-adjacent action — salon ids are predictable and
  // publicly visible, so a valid admin password is required (proof-of-
  // identity, same pattern as reset_all_data).
  const rNoPw = mkRes();
  await handler({ method: 'POST', body: { salonId: 'salonX', inactive: true } }, rNoPw.obj);
  eq(rNoPw.status, 401, 'toggle-salon rejects a request with no admin password');

  const r1 = mkRes();
  await handler({ method: 'POST', body: { salonId: 'salonX', inactive: true, adminPassword: 'realSecret1' } }, r1.obj);
  ok(r1.status === 200 && r1.body.success === true, 'toggle-salon marks an existing salon inactive once the correct admin password is given');

  const parsed = JSON.parse(fake.strings.get('salons_db'));
  ok(parsed.find(s => s.id === 'salonX').inactive === true, 'inactive flag persisted into fake KV store');

  const r2 = mkRes();
  await handler({ method: 'POST', body: { salonId: 'does-not-exist', inactive: true, adminPassword: 'realSecret1' } }, r2.obj);
  eq(r2.status, 404, 'toggle-salon returns 404 for an unknown salonId');

  const r3 = mkRes();
  await handler({ method: 'GET' }, r3.obj);
  eq(r3.status, 405, 'toggle-salon rejects non-POST methods with 405');
});

section('api/sync.js — CRITICAL: a stale/partial salons snapshot never deletes other salons');
await withFakeKv(makeFakeRedis(), async (fake) => {
  const prevSecret = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = 'test-only-secret-for-session-tokens';
  try {
  fake.strings.set('salons_db', JSON.stringify([
    { id: 'salonA', name: 'Salon A' },
    { id: 'salonB', name: 'Salon B' }
  ]));
  const handler = await freshImport('api/sync.js');

  // A client with a stale local copy (only knows about salonA, e.g. it
  // loaded before salonB was created) saves for an unrelated reason
  // (confirming a booking) and sends its whole local salons snapshot. Must
  // be salonA's own owner (or admin) — an unauthenticated salon write for an
  // id that already exists is now rejected outright (isAuthorizedEditor).
  const ownerToken = issueSessionToken({ role: 'owner', salonId: 'salonA' });
  const staleClientSalons = [{ id: 'salonA', name: 'Salon A Edited' }];
  const r1 = mkRes();
  await handler({ method: 'POST', headers: { authorization: `Bearer ${ownerToken}` }, body: { bookings: [], salons: staleClientSalons } }, r1.obj);
  ok(r1.status === 200, 'sync accepts a save from a client with a partial salons snapshot');

  const salonsAfter = JSON.parse(fake.strings.get('salons_db'));
  ok(salonsAfter.some(s => s.id === 'salonB'), 'salonB (absent from the stale payload) is NOT deleted');
  ok(salonsAfter.find(s => s.id === 'salonA')?.name === 'Salon A Edited', 'salonA is still updated with the fields the client actually sent');
  eq(salonsAfter.length, 2, 'total salon count is unchanged — nothing silently lost');
  } finally {
    restoreEnv('SESSION_SECRET', prevSecret);
  }
});

section('api/sync.js — HARDENING: an existing salon cannot steal another salon\'s slug or ownerUsername (URL/QR-hijack regression)');
await withFakeKv(makeFakeRedis(), async (fake) => {
  const prevSecret = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = 'test-only-secret-for-session-tokens';
  try {
    fake.strings.set('salons_db', JSON.stringify([
      { id: 'salonA', name: 'Salon A', slug: 'SALON_A', ownerUsername: 'ownerA' },
      { id: 'salonB', name: 'Salon B', slug: 'SALON_B', ownerUsername: 'ownerB' }
    ]));
    const handler = await freshImport('api/sync.js');
    const adminToken = issueSessionToken({ role: 'admin' });

    // Admin editing salonA tries to set its slug/ownerUsername to collide
    // with salonB's — this used to pass straight through (uniqueness was
    // only ever checked for a BRAND NEW salon), silently hijacking B's
    // public booking link/QR code.
    const hijack = { id: 'salonA', name: 'Salon A', slug: 'SALON_B', ownerUsername: 'ownerB' };
    const r1 = mkRes();
    await handler({ method: 'POST', headers: { authorization: `Bearer ${adminToken}` }, body: { bookings: [], salons: [hijack] } }, r1.obj);
    ok(r1.status === 200, 'the save itself is accepted (not a hard rejection)');

    const salonsAfter = JSON.parse(fake.strings.get('salons_db'));
    const a = salonsAfter.find(s => s.id === 'salonA');
    const b = salonsAfter.find(s => s.id === 'salonB');
    eq(a.slug, 'SALON_A', "salonA's slug reverts to its own existing value instead of stealing salonB's");
    eq(a.ownerUsername, 'ownerA', "salonA's ownerUsername reverts to its own existing value instead of stealing salonB's");
    eq(b.slug, 'SALON_B', "salonB's own slug is completely untouched");

    // A genuinely unique new slug still goes through normally.
    const rename = { id: 'salonA', name: 'Salon A', slug: 'SALON_A_RENAMED', ownerUsername: 'ownerA' };
    const r2 = mkRes();
    await handler({ method: 'POST', headers: { authorization: `Bearer ${adminToken}` }, body: { bookings: [], salons: [rename] } }, r2.obj);
    const salonsAfter2 = JSON.parse(fake.strings.get('salons_db'));
    eq(salonsAfter2.find(s => s.id === 'salonA').slug, 'SALON_A_RENAMED', 'a genuinely unique slug change still goes through normally');
  } finally {
    restoreEnv('SESSION_SECRET', prevSecret);
  }
});

section('api/sync.js — GET flags sessionExpired when a presented Authorization token is rejected (silent-degradation regression)');
await withFakeKv(makeFakeRedis(), async () => {
  const handler = await freshImport('api/sync.js');

  const rNoToken = mkRes();
  await handler({ method: 'GET', headers: {} }, rNoToken.obj);
  eq(rNoToken.body.sessionExpired, false, 'an anonymous GET with no Authorization header at all is not flagged as an expired session');

  const rBadToken = mkRes();
  await handler({ method: 'GET', headers: { authorization: 'Bearer garbage.notarealtoken' } }, rBadToken.obj);
  eq(rBadToken.body.sessionExpired, true, 'a GET with a present-but-invalid/expired token IS flagged, distinct from having no session at all');
});

section('api/delete-salon.js — explicit, targeted salon deletion (fake KV, no live network)');
await withFakeKv(makeFakeRedis(), async (fake) => {
  fake.strings.set('salons_db', JSON.stringify([
    { id: 'salonA', name: 'Salon A' },
    { id: 'salonB', name: 'Salon B' }
  ]));
  fake.strings.set('admin_db', JSON.stringify({ username: 'admin', password: 'realSecret1' }));
  const handler = await freshImport('api/delete-salon.js');

  // Seed a booking + lock belonging to salonA to confirm cleanup.
  fake.hashes.set('bookings', new Map([
    ['bkA1', JSON.stringify({ id: 'bkA1', salonId: 'salonA', workerId: 'w1', dateISO: '2030-01-01', time: '10:00', status: 'confirmed' })],
    ['bkB1', JSON.stringify({ id: 'bkB1', salonId: 'salonB', workerId: 'w2', dateISO: '2030-01-01', time: '11:00', status: 'confirmed' })]
  ]));
  fake.strings.set('lock:salonA:w1:2030-01-01:10:00', 'bkA1');
  fake.strings.set('lock:salonB:w2:2030-01-01:11:00', 'bkB1');

  // Irreversible + salon ids are predictable/public — requires proof of the
  // admin password, same as toggle-salon.js and reset_all_data.
  const rNoPw = mkRes();
  await handler({ method: 'POST', body: { salonId: 'salonA' } }, rNoPw.obj);
  eq(rNoPw.status, 401, 'delete-salon rejects a request with no admin password');

  const r1 = mkRes();
  await handler({ method: 'POST', body: { salonId: 'salonA', adminPassword: 'realSecret1' } }, r1.obj);
  ok(r1.status === 200 && r1.body.success === true, 'delete-salon succeeds for an existing salon once the correct admin password is given');
  eq(r1.body.removedBookings, 1, 'reports exactly the one booking removed for that salon');

  const salonsAfter = JSON.parse(fake.strings.get('salons_db'));
  ok(!salonsAfter.some(s => s.id === 'salonA'), 'salonA is removed from salons_db');
  ok(salonsAfter.some(s => s.id === 'salonB'), 'salonB is untouched');
  ok(!fake.hashes.get('bookings').has('bkA1'), 'salonA\'s booking is removed from the bookings hash');
  ok(fake.hashes.get('bookings').has('bkB1'), 'salonB\'s booking is untouched');
  ok(!fake.strings.has('lock:salonA:w1:2030-01-01:10:00'), 'salonA\'s slot lock is released');

  const r2 = mkRes();
  await handler({ method: 'POST', body: { salonId: 'does-not-exist', adminPassword: 'realSecret1' } }, r2.obj);
  eq(r2.status, 404, 'delete-salon returns 404 for an unknown salonId');
});

section('api/sync.js action:reset_all_data — wipe all test data before going live (fake KV, no live network)');
await withFakeKv(makeFakeRedis(), async (fake) => {
  fake.strings.set('salons_db', JSON.stringify([{ id: 'salonA', name: 'Salon A' }]));
  fake.strings.set('admin_db', JSON.stringify({ username: 'admin', password: 'realSecret1' }));
  fake.hashes.set('bookings', new Map([
    ['bkA1', JSON.stringify({ id: 'bkA1', salonId: 'salonA', status: 'confirmed' })]
  ]));
  fake.strings.set('push_subscriptions', JSON.stringify([{ subscription: { endpoint: 'x' }, role: 'customer' }]));
  fake.strings.set('lock:salonA:w1:2030-01-01:10:00', 'bkA1');
  // Folded into api/sync.js from the former standalone api/reset-all-data.js
  // (freed a Vercel function slot for the payment webhook endpoint) — same
  // body.password + verifyAdminPassword auth shape, now dispatched by action.
  const handler = await freshImport('api/sync.js');

  const r0 = mkRes();
  await handler({ method: 'POST', body: { action: 'reset_all_data' } }, r0.obj);
  eq(r0.status, 400, 'rejects a request with no password at all');

  const r1 = mkRes();
  await handler({ method: 'POST', body: { action: 'reset_all_data', password: 'wrongPassword' } }, r1.obj);
  eq(r1.status, 401, 'rejects a request with an incorrect admin password');
  ok(fake.strings.has('salons_db') && JSON.parse(fake.strings.get('salons_db')).length === 1, 'salons_db untouched after a rejected password');

  const r2 = mkRes();
  await handler({ method: 'POST', body: { action: 'reset_all_data', password: 'realSecret1' } }, r2.obj);
  ok(r2.status === 200 && r2.body.success === true, 'wipes everything once the correct current admin password is provided');
  eq(JSON.parse(fake.strings.get('salons_db')).length, 0, 'salons_db is now an empty array');
  ok(!fake.hashes.has('bookings') || fake.hashes.get('bookings').size === 0, 'bookings hash is emptied');
  ok(!fake.strings.has('push_subscriptions') || JSON.parse(fake.strings.get('push_subscriptions') || '[]').length === 0, 'push_subscriptions cleared');
  ok(!fake.strings.has('lock:salonA:w1:2030-01-01:10:00'), 'stale slot locks are cleared');
});

section('api/sync.js — admin credentials: GET never ships a plaintext password, and a change requires proof of the current one');
await withFakeKv(makeFakeRedis(), async (fake) => {
  const prevSecret = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = 'test-only-secret-for-session-tokens';
  try {
    const handler = await freshImport('api/sync.js');
    fake.strings.set('salons_db', JSON.stringify([{ id: 'salon1', name: 'Salon', workers: [] }]));

    // Login/password-change moved entirely to action-based, session-token
    // flows — GET no longer ships plaintext credentials to the client at
    // all (not even to an anonymous caller for the username, and never a
    // password to anyone, admin session or not).
    const r1 = mkRes();
    await handler({ method: 'GET' }, r1.obj);
    eq(r1.body.admin.username, undefined, 'anonymous GET does not reveal the admin username');
    eq(r1.body.admin.password, undefined, 'GET response never includes a plaintext admin password field');

    const adminToken = issueSessionToken({ role: 'admin' });
    const rAdminGet = mkRes();
    await handler({ method: 'GET', headers: { authorization: `Bearer ${adminToken}` } }, rAdminGet.obj);
    eq(rAdminGet.body.admin.username, 'admin', 'an authenticated admin GET reveals the default admin username');
    eq(rAdminGet.body.admin.password, undefined, 'an authenticated admin GET still never includes a plaintext password');

    // Changing it requires proving the CURRENT password — a bare "here are
    // new credentials" POST with no proof is not a valid path anymore.
    const rWrongCurrent = mkRes();
    await handler({ method: 'POST', body: { action: 'change_password', type: 'admin_self', currentPassword: 'totallyWrong', newUsername: 'boss', newPassword: 'newSecret9' } }, rWrongCurrent.obj);
    eq(rWrongCurrent.status, 401, 'admin_self password change is rejected without the correct current password');

    const rChange = mkRes();
    await handler({ method: 'POST', body: { action: 'change_password', type: 'admin_self', currentPassword: 'admin123', newUsername: 'boss', newPassword: 'newSecret9' } }, rChange.obj);
    eq(rChange.status, 200, 'admin_self password change succeeds once the correct current password is proven');

    // The new credentials now actually authenticate; the old ones no longer do.
    const rLoginNew = mkRes();
    await handler({ method: 'POST', body: { action: 'login', role: 'admin', username: 'boss', password: 'newSecret9' } }, rLoginNew.obj);
    eq(rLoginNew.body.success, true, 'the new admin credentials authenticate after the change');

    const rLoginOld = mkRes();
    await handler({ method: 'POST', body: { action: 'login', role: 'admin', username: 'admin', password: 'admin123' } }, rLoginOld.obj);
    eq(rLoginOld.body.success, false, 'the old admin credentials no longer authenticate after the change');
  } finally {
    restoreEnv('SESSION_SECRET', prevSecret);
  }
});

section('lib/auth.js — passwords are hashed at rest, never plaintext (stored-credential-leak regression)');
await withFakeKv(makeFakeRedis(), async (fake) => {
  const prevSecret = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = 'test-only-secret-for-session-tokens';
  try {
    const handler = await freshImport('api/sync.js');

    // A brand-new self-signup's password must be a scrypt hash on disk, never
    // the raw string a KV/backup compromise could read directly.
    const rSignup = mkRes();
    await handler({ method: 'POST', body: {
      action: 'signup_salon', salonName: 'Test Salon HashCheck', city: 'Roma', address: 'Via Roma 12',
      declaredWorkerCount: '2', username: 'hashtestowner', password: 'plainTextSecret1',
      ownerName: 'Mario Rossi', ownerPhone: '+39 333 123 4567', phone: '+39 06 123 4567', email: 'owner@test.it',
      contractAccepted: true, contractSignedName: 'Mario Rossi'
    } }, rSignup.obj);
    ok(rSignup.status === 200 && rSignup.body.success === true, 'signup_salon succeeds');
    const storedSalons = JSON.parse(fake.strings.get('salons_db'));
    const newSalon = storedSalons.find(s => s.ownerUsername === 'hashtestowner');
    ok(newSalon, 'new salon was actually persisted');
    ok(newSalon.ownerPassword !== 'plainTextSecret1', 'the raw password is never stored verbatim');
    ok(newSalon.ownerPassword.startsWith('scrypt$'), 'the stored password is a scrypt hash');

    // A fresh self-signup salon is created `inactive:true` pending admin
    // approval — activate it here so the login check below tests hashing,
    // not the separate (already-tested-elsewhere) salon_inactive gate.
    newSalon.inactive = false;
    fake.strings.set('salons_db', JSON.stringify(storedSalons));

    // Login with the real password still works against the hash.
    const rLogin = mkRes();
    await handler({ method: 'POST', body: { action: 'login', role: 'owner', username: 'hashtestowner', password: 'plainTextSecret1' } }, rLogin.obj);
    eq(rLogin.body.success, true, 'login succeeds against a hashed password');

    const rWrong = mkRes();
    await handler({ method: 'POST', body: { action: 'login', role: 'owner', username: 'hashtestowner', password: 'wrongGuess' } }, rWrong.obj);
    eq(rWrong.body.success, false, 'login rejects a wrong password against a hashed one');

    // A legacy account that predates hashing (raw plaintext still in KV)
    // must keep working, AND get opportunistically upgraded to a hash on
    // its first successful login — no disruptive one-time migration needed.
    fake.strings.set('salons_db', JSON.stringify([
      ...storedSalons,
      { id: 'legacySalon', slug: 'legacy-salon', name: 'Legacy Salon', ownerUsername: 'legacyowner', ownerPassword: 'oldPlainPw1', workers: [] }
    ]));
    const rLegacyLogin = mkRes();
    await handler({ method: 'POST', body: { action: 'login', role: 'owner', username: 'legacyowner', password: 'oldPlainPw1' } }, rLegacyLogin.obj);
    eq(rLegacyLogin.body.success, true, 'a legacy plaintext-password account can still log in');
    const afterMigration = JSON.parse(fake.strings.get('salons_db')).find(s => s.id === 'legacySalon');
    ok(afterMigration.ownerPassword.startsWith('scrypt$'), 'the legacy account is opportunistically upgraded to a hash on successful login');
    ok(afterMigration.ownerPassword !== 'oldPlainPw1', 'the plaintext value no longer exists in storage after migration');

    const rLegacyReLogin = mkRes();
    await handler({ method: 'POST', body: { action: 'login', role: 'owner', username: 'legacyowner', password: 'oldPlainPw1' } }, rLegacyReLogin.obj);
    eq(rLegacyReLogin.body.success, true, 'login still succeeds with the same password after migration (now verified against the hash)');
  } finally {
    restoreEnv('SESSION_SECRET', prevSecret);
  }
});

section('lib/auth.js — login is rate-limited (previously the one credential check with no limit at all)');
await withFakeKv(makeFakeRedis(), async (fake) => {
  fake.strings.set('admin_db', JSON.stringify({ username: 'admin', password: 'realSecret1' }));
  const handler = await freshImport('api/sync.js');

  for (let i = 1; i <= 15; i++) {
    const r = mkRes();
    await handler({ method: 'POST', body: { action: 'login', role: 'admin', username: 'admin', password: 'wrongGuess' } }, r.obj);
    eq(r.status, 401, `login attempt ${i}/15 with a wrong password is rejected normally (within budget)`);
  }
  const rBlocked = mkRes();
  await handler({ method: 'POST', body: { action: 'login', role: 'admin', username: 'admin', password: 'realSecret1' } }, rBlocked.obj);
  eq(rBlocked.status, 429, 'the 16th login attempt is rate-limited even with the CORRECT password — brute-force protection actually engages');
});

section('api/sync.js — signup OTP verification is rate-limited (a 6-digit code was previously brute-forceable with no limit at all)');
await withFakeKv(makeFakeRedis(), async (fake) => {
  const handler = await freshImport('api/sync.js');
  const phone = '+393331234567';
  fake.strings.set(`signup_otp:${phone}`, '999999');

  for (let i = 1; i <= 8; i++) {
    const r = mkRes();
    await handler({ method: 'POST', body: { action: 'verify_signup_otp', phone, code: '000000' } }, r.obj);
    eq(r.status, 401, `guess ${i}/8 with a wrong code is rejected normally (within budget)`);
  }
  const rBlocked = mkRes();
  await handler({ method: 'POST', body: { action: 'verify_signup_otp', phone, code: '999999' } }, rBlocked.obj);
  eq(rBlocked.status, 429, 'the 9th verify attempt is rate-limited even with the CORRECT code — brute-force protection actually engages');
});

section('api/sync.js — a new booking against an inactive/unknown salon is rejected server-side');
await withFakeKv(makeFakeRedis(), async () => {
  // Bypassing the client UI's inactive-salon alert used to be possible with
  // a direct POST, since the salon id/workerId are both visible in the
  // anonymous GET response (needed for slot-availability rendering).
  const handler = await freshImport('api/sync.js');

  // Nothing seeded in salons_db yet — this booking references a salon that
  // simply doesn't exist.
  const ghostBooking = { id: 'ghost-1', salonId: 'does-not-exist', workerId: 'w1', dateISO: '2030-06-01', time: '10:00', status: 'confirmed', name: 'Ghost' };
  const r1 = mkRes();
  await handler({ method: 'POST', body: { bookings: [ghostBooking], salons: [] } }, r1.obj);
  ok(r1.body.conflicts.some(c => c.id === 'ghost-1' && c.error === 'salon_inactive'), 'a booking for a salon id that does not exist is rejected as salon_inactive');

  const kvUrl = process.env.KV_REST_API_URL, kvToken = process.env.KV_REST_API_TOKEN;
  await import('./lib/kv.js').then(m => m.setSalonsDb(kvUrl, kvToken, [
    { id: 'salonPending', name: 'Salon Pending', inactive: true, workers: [{ id: 'w1', name: 'Barbiere' }] }
  ]));
  const pendingBooking = { id: 'pending-1', salonId: 'salonPending', workerId: 'w1', dateISO: '2030-06-01', time: '10:00', status: 'confirmed', name: 'Cliente' };
  const r2 = mkRes();
  await handler({ method: 'POST', body: { bookings: [pendingBooking], salons: [] } }, r2.obj);
  ok(r2.body.conflicts.some(c => c.id === 'pending-1' && c.error === 'salon_inactive'), 'a booking for a real but inactive/pending salon is rejected as salon_inactive');
  eq(r2.body.bookings.filter(b => b.id === 'pending-1').length, 0, 'the rejected booking is never actually persisted');
});

section('api/sync.js — HARDENING: a review requires proof of a real booking with that worker (fake-review regression)');
await withFakeKv(makeFakeRedis(), async (fake) => {
  fake.strings.set('salons_db', JSON.stringify([{ id: 'salonR', name: 'Salon R', workers: [{ id: 'wR', name: 'Worker R', reviews: [] }] }]));
  fake.hashes.set('bookings', new Map([
    ['bk-real-r', JSON.stringify({ id: 'bk-real-r', salonId: 'salonR', workerId: 'wR', dateISO: '2030-01-01', time: '10:00', status: 'confirmed', phone: '3339990000' })]
  ]));
  const handler = await freshImport('api/sync.js');

  const rNoBooking = mkRes();
  await handler({ method: 'POST', body: { action: 'submit_review', salonId: 'salonR', workerId: 'wR', author: 'Stranger', phone: '0009998888', comment: 'Fake review, never booked', rating: 5 } }, rNoBooking.obj);
  eq(rNoBooking.body.success, false, 'a review with no matching booking phone is rejected');
  eq(rNoBooking.body.error, 'no_matching_booking', 'the rejection reason is specifically no_matching_booking');

  const rReal = mkRes();
  await handler({ method: 'POST', body: { action: 'submit_review', salonId: 'salonR', workerId: 'wR', author: 'Real Customer', phone: '333 999 0000', comment: 'Genuinely booked and had a great cut', rating: 5 } }, rReal.obj);
  eq(rReal.body.success, true, "the real customer's phone (matching their actual booking) is accepted");

  const salonsAfter = JSON.parse(fake.strings.get('salons_db'));
  const worker = salonsAfter.find(s => s.id === 'salonR').workers.find(w => w.id === 'wR');
  eq(worker.reviews.length, 1, 'exactly the one legitimate review was persisted');
});

section('api/sync.js — HARDENING: a new worker cannot be added with a too-short password');
await withFakeKv(makeFakeRedis(), async (fake) => {
  const prevSecret = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = 'test-only-secret-for-session-tokens';
  try {
    fake.strings.set('salons_db', JSON.stringify([{ id: 'salonW', name: 'Salon W', slug: 'SALON_W', ownerUsername: 'ownerW', ownerPassword: 'realOwnerPw1', workers: [] }]));
    const handler = await freshImport('api/sync.js');
    const ownerToken = issueSessionToken({ role: 'owner', salonId: 'salonW' });

    const weakWorker = { id: 'newWorker', name: 'New Barber', username: 'newbarber', password: '123' };
    const r1 = mkRes();
    await handler({ method: 'POST', headers: { authorization: `Bearer ${ownerToken}` }, body: { bookings: [], salons: [{ id: 'salonW', name: 'Salon W', slug: 'SALON_W', workers: [weakWorker] }] } }, r1.obj);
    const afterWeak = JSON.parse(fake.strings.get('salons_db')).find(s => s.id === 'salonW');
    ok(!(afterWeak.workers || []).some(w => w.id === 'newWorker'), 'a new worker with a too-short password is dropped, never persisted');

    const strongWorker = { id: 'newWorker2', name: 'New Barber 2', username: 'newbarber2', password: 'realStrongPw1' };
    const r2 = mkRes();
    await handler({ method: 'POST', headers: { authorization: `Bearer ${ownerToken}` }, body: { bookings: [], salons: [{ id: 'salonW', name: 'Salon W', slug: 'SALON_W', workers: [strongWorker] }] } }, r2.obj);
    const afterStrong = JSON.parse(fake.strings.get('salons_db')).find(s => s.id === 'salonW');
    const added = (afterStrong.workers || []).find(w => w.id === 'newWorker2');
    ok(added, 'a new worker with a valid-length password is persisted normally');
    ok(added.password.startsWith('scrypt$'), "the new worker's password is hashed, not stored in plaintext");
  } finally {
    restoreEnv('SESSION_SECRET', prevSecret);
  }
});

section('api/sync.js — HARDENING: a booking cannot pair a real salon with a workerId belonging to a DIFFERENT salon (cross-tenant push-spoofing regression)');
await withFakeKv(makeFakeRedis(), async (fake) => {
  fake.strings.set('salons_db', JSON.stringify([
    { id: 'salonReal', name: 'Salon Real', workers: [{ id: 'wReal', name: 'Real Worker' }] },
    { id: 'salonForeign', name: 'Salon Foreign', workers: [{ id: 'wForeign', name: 'Foreign Worker' }] }
  ]));
  const handler = await freshImport('api/sync.js');

  // salonReal is a real, active salon (passes the salon_inactive gate), but
  // wForeign belongs to salonForeign — pairing them used to silently skip
  // the vacation/day-off/break check (no matching worker to check it
  // against) and let the booking through, which also let its push
  // notification target a barber outside the booking's own salon.
  const spoofed = { id: 'spoof-1', salonId: 'salonReal', workerId: 'wForeign', dateISO: '2030-08-01', time: '10:00', status: 'confirmed', name: 'Spoofer' };
  const r1 = mkRes();
  await handler({ method: 'POST', body: { bookings: [spoofed], salons: [] } }, r1.obj);
  ok(r1.body.conflicts.some(c => c.id === 'spoof-1' && c.error === 'invalid_booking'), 'a salonId/workerId pair that do not actually belong together is rejected');

  // A genuinely matching pair still works normally.
  const legit = { id: 'legit-1', salonId: 'salonReal', workerId: 'wReal', dateISO: '2030-08-01', time: '10:00', status: 'confirmed', name: 'Real Customer' };
  const r2 = mkRes();
  await handler({ method: 'POST', body: { bookings: [legit], salons: [] } }, r2.obj);
  eq(r2.body.conflicts, [], 'a salonId/workerId pair that DO belong together is accepted normally');
});

section('api/subscribe.js — HARDENING: a customer push subscription requires proof of the booking\'s own phone number (subscription-hijack regression)');
await withFakeKv(makeFakeRedis(), async (fake) => {
  fake.hashes.set('bookings', new Map([
    ['bk-real', JSON.stringify({ id: 'bk-real', salonId: 'sZ', workerId: 'wZ', dateISO: '2030-09-01', time: '10:00', status: 'confirmed', name: 'Real Customer', phone: '3335554444' })]
  ]));
  const handler = await freshImport('api/subscribe.js');

  const rNoPhone = mkRes();
  await handler({ method: 'POST', body: { subscription: { endpoint: 'https://push.test/stranger' }, role: 'customer', bookingId: 'bk-real' } }, rNoPhone.obj);
  eq(rNoPhone.status, 403, 'a customer subscription with no phone at all is rejected');

  const rWrongPhone = mkRes();
  await handler({ method: 'POST', body: { subscription: { endpoint: 'https://push.test/stranger' }, role: 'customer', bookingId: 'bk-real', phone: '0000000000' } }, rWrongPhone.obj);
  eq(rWrongPhone.status, 403, 'a customer subscription with the WRONG phone is rejected — a scraped/guessed booking id alone is not enough');

  const rRightPhone = mkRes();
  await handler({ method: 'POST', body: { subscription: { endpoint: 'https://push.test/real-customer' }, role: 'customer', bookingId: 'bk-real', phone: '333 555 4444' } }, rRightPhone.obj);
  eq(rRightPhone.status, 200, "the booking's real customer, proving their own phone, can still subscribe normally");
});

section('api/sync.js — HARDENING: a removed worker\'s session token stops being served their old bookings (revocation regression)');
await withFakeKv(makeFakeRedis(), async (fake) => {
  const prevSecret = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = 'test-only-secret-for-session-tokens';
  try {
    fake.strings.set('salons_db', JSON.stringify([{ id: 'salonV', name: 'Salon V', workers: [{ id: 'wV', name: 'Worker V' }] }]));
    fake.hashes.set('bookings', new Map([
      ['bkV1', JSON.stringify({ id: 'bkV1', salonId: 'salonV', workerId: 'wV', dateISO: '2030-01-01', time: '10:00', status: 'confirmed', name: 'Client', phone: '333' })]
    ]));
    const handler = await freshImport('api/sync.js');
    const barberToken = issueSessionToken({ role: 'barber', salonId: 'salonV', workerId: 'wV' });

    const rBefore = mkRes();
    await handler({ method: 'GET', headers: { authorization: `Bearer ${barberToken}` } }, rBefore.obj);
    ok(rBefore.body.bookings.some(b => b.id === 'bkV1'), "a still-employed barber's own booking is visible normally");

    // Admin removes the worker from the salon (the token itself is still
    // cryptographically valid — stateless, no revocation list).
    fake.strings.set('salons_db', JSON.stringify([{ id: 'salonV', name: 'Salon V', workers: [] }]));

    const rAfterGet = mkRes();
    await handler({ method: 'GET', headers: { authorization: `Bearer ${barberToken}` } }, rAfterGet.obj);
    eq(rAfterGet.body.bookings, [], "a removed worker's token no longer sees their old bookings via GET, despite still being a valid signature");

    const rAfterCancel = mkRes();
    await handler({ method: 'POST', headers: { authorization: `Bearer ${barberToken}` }, body: { bookings: [{ id: 'bkV1', salonId: 'salonV', workerId: 'wV', dateISO: '2030-01-01', time: '10:00', status: 'cancelled', cancelledBy: 'staff' }], salons: [] } }, rAfterCancel.obj);
    ok(rAfterCancel.body.conflicts.some(c => c.id === 'bkV1'), "a removed worker's token can no longer cancel their old bookings either");
    const stillConfirmedBk = JSON.parse(fake.hashes.get('bookings').get('bkV1'));
    eq(stillConfirmedBk.status, 'confirmed', 'the booking itself is genuinely untouched — the rejected cancel attempt never actually applied');
  } finally {
    restoreEnv('SESSION_SECRET', prevSecret);
  }
});

section('api/sync.js — GET response strips PII by caller role (cross-tenant leak regression)');
await withFakeKv(makeFakeRedis(), async (fake) => {
  const prevSecret = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = 'test-only-secret-for-session-tokens';
  try {
    fake.strings.set('salons_db', JSON.stringify([
      {
        id: 'salonA', slug: 'salon-a', name: 'Salon A',
        ownerUsername: 'ownerA', ownerPassword: 'secretA', ownerName: 'Mario', ownerPhone: '3331112222', email: 'a@test.it',
        billing: { declaredWorkerCount: 3, paidThroughMonth: '2026-07', paymentFailing: false, suspendedByBilling: false, autopay: true, signupIp: '1.2.3.4', contractSignedName: 'Mario Rossi' },
        workers: [{ id: 'wA1', name: 'Barbiere A', username: 'barberA', phone: '3339998888', password: 'pw' }]
      },
      { id: 'salonB', slug: 'salon-b', name: 'Salon B (inactive)', inactive: true, ownerUsername: 'ownerB', ownerPassword: 'secretB', workers: [] }
    ]));
    fake.strings.set('admin_db', JSON.stringify({ username: 'realAdminUser', password: 'adminPass1' }));
    const handler = await freshImport('api/sync.js');

    // Anonymous caller (no session at all — the public booking page).
    const rAnon = mkRes();
    await handler({ method: 'GET', headers: {} }, rAnon.obj);
    const anonSalonA = rAnon.body.salons.find(s => s.id === 'salonA');
    ok(!rAnon.body.salons.some(s => s.id === 'salonB'), 'anonymous GET does not list an inactive salon at all');
    ok(anonSalonA && anonSalonA.workers[0].username === undefined && anonSalonA.workers[0].phone === undefined, 'anonymous GET strips worker username/phone');
    ok(anonSalonA.billing === undefined, 'anonymous GET strips the whole billing object for a salon that is not their own');
    ok(anonSalonA.ownerUsername === undefined && anonSalonA.ownerPassword === undefined && anonSalonA.email === undefined, 'anonymous GET strips owner credentials/contact fields');
    eq(rAnon.body.admin.username, undefined, 'anonymous GET strips the platform admin username');

    // Admin caller — sees everything, including the inactive salon.
    const adminToken = issueSessionToken({ role: 'admin' });
    const rAdmin = mkRes();
    await handler({ method: 'GET', headers: { authorization: `Bearer ${adminToken}` } }, rAdmin.obj);
    ok(rAdmin.body.salons.some(s => s.id === 'salonB'), 'admin GET includes the inactive salon');
    const adminSalonA = rAdmin.body.salons.find(s => s.id === 'salonA');
    eq(adminSalonA.workers[0].username, 'barberA', 'admin GET includes worker username');
    eq(adminSalonA.billing.signupIp, '1.2.3.4', 'admin GET includes the full billing object, including admin-review-only fields like signupIp');
    eq(rAdmin.body.admin.username, 'realAdminUser', 'admin GET includes the platform admin username');

    // Owner of salonA — sees their OWN salon's staff contact info and a
    // trimmed billing object, but still can't see the inactive salonB or
    // the admin username.
    const ownerToken = issueSessionToken({ role: 'owner', salonId: 'salonA' });
    const rOwner = mkRes();
    await handler({ method: 'GET', headers: { authorization: `Bearer ${ownerToken}` } }, rOwner.obj);
    const ownerSalonA = rOwner.body.salons.find(s => s.id === 'salonA');
    eq(ownerSalonA.workers[0].username, 'barberA', "owner GET includes their OWN salon's worker username");
    ok(ownerSalonA.billing && ownerSalonA.billing.signupIp === undefined, "owner GET's billing omits admin-review-only fields (signupIp)");
    eq(ownerSalonA.billing.declaredWorkerCount, 3, "owner GET's billing keeps the fields the Fatturazione UI actually needs");
    ok(!rOwner.body.salons.some(s => s.id === 'salonB'), "owner of salonA still can't see an unrelated inactive salon");
    eq(rOwner.body.admin.username, undefined, 'owner GET still strips the platform admin username');
  } finally {
    restoreEnv('SESSION_SECRET', prevSecret);
  }
});

section('lib/auth.js — verifyAdminPassword rate-limits repeated guesses (shared budget across every admin-password-gated action)');
await withFakeKv(makeFakeRedis(), async () => {
  // Exercised via the reset_all_data action (api/sync.js), the only
  // admin-password-gated action already covered by an existing test — the
  // rate limit itself lives in lib/auth.js's verifyAdminPassword and is
  // shared by every caller keyed on IP, not on the specific action.
  const handler = await freshImport('api/sync.js');
  const { setAdminDb } = await import('./lib/kv.js');
  await setAdminDb(process.env.KV_REST_API_URL, process.env.KV_REST_API_TOKEN, { username: 'admin', password: 'realSecret1' });

  for (let i = 1; i <= 10; i++) {
    const r = mkRes();
    await handler({ method: 'POST', body: { action: 'reset_all_data', password: 'wrongGuess' } }, r.obj);
    eq(r.status, 401, `attempt ${i}/10 with a wrong password is rejected normally (within the rate-limit budget)`);
  }
  const rBlocked = mkRes();
  await handler({ method: 'POST', body: { action: 'reset_all_data', password: 'realSecret1' } }, rBlocked.obj);
  eq(rBlocked.status, 401, 'the 11th attempt is rejected even with the CORRECT password — proves the rate limit itself is gating, not just wrong-password checks');
});

section('api/image.js — serves stored images with a nosniff header (fake KV, no live network)');
await withFakeKv(makeFakeRedis(), async (fake) => {
  fake.strings.set('img:abc123', 'image/png|aGVsbG8=');
  const handler = await freshImport('api/image.js');

  const r1 = mkRes();
  await handler({ query: { id: 'abc123' } }, r1.obj);
  eq(r1.status, 200, 'a valid, existing image id returns 200');
  eq(r1.headers['Content-Type'], 'image/png', 'response carries the stored content type');
  eq(r1.headers['X-Content-Type-Options'], 'nosniff', 'response sets X-Content-Type-Options: nosniff (image/HTML polyglot hardening)');
  ok(Buffer.isBuffer(r1.endArg) && r1.endArg.toString() === 'hello', 'response body is the correctly base64-decoded image bytes');

  const r2 = mkRes();
  await handler({ query: { id: 'not-there' } }, r2.obj);
  eq(r2.status, 404, 'an unknown image id returns 404 instead of leaking a KV error');

  const r3 = mkRes();
  await handler({ query: { id: '../../etc/passwd' } }, r3.obj);
  eq(r3.status, 400, 'an image id with path-traversal-shaped characters is rejected before ever touching KV');
});

section('api/subscribe.js — push subscription storage (fake KV, no live network)');
await withFakeKv(makeFakeRedis(), async (fake) => {
  const prevSecret = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = 'test-only-secret-for-session-tokens';
  try {
    fake.strings.set('salons_db', JSON.stringify([{ id: 'salonX', name: 'Salon X', workers: [{ id: 'w1', name: 'Worker 1' }] }]));
    const handler = await freshImport('api/subscribe.js');

    const r1 = mkRes();
    await handler({ method: 'POST', body: { subscription: {} } }, r1.obj);
    eq(r1.status, 400, 'rejects a subscription payload missing an endpoint');

    // role:'owner'/'barber' are never trusted from the client-declared body
    // alone — a caller must present a verified session token matching that
    // exact role, so anyone can't claim to be a salon's owner just by
    // saying so and receive that salon's live booking notifications.
    const ownerToken = issueSessionToken({ role: 'owner', salonId: 'salonX' });
    const sub = { subscription: { endpoint: 'https://push.test/abc' }, role: 'owner', salonId: 'salonX' };
    const rNoSession = mkRes();
    await handler({ method: 'POST', body: sub }, rNoSession.obj);
    eq(rNoSession.status, 401, 'a role:owner subscription with no session token is rejected');

    const r2 = mkRes();
    await handler({ method: 'POST', headers: { authorization: `Bearer ${ownerToken}` }, body: sub }, r2.obj);
    ok(r2.status === 200 && r2.body.success === true, 'valid subscription accepted and stored once backed by a matching owner session');

    const stored = JSON.parse(fake.strings.get('push_subscriptions'));
    ok(stored.length === 1 && stored[0].subscription.endpoint === sub.subscription.endpoint, 'subscription persisted to fake KV with correct endpoint');

    // re-subscribing with the same endpoint should replace, not duplicate
    const barberToken = issueSessionToken({ role: 'barber', salonId: 'salonX', workerId: 'w1' });
    const r3 = mkRes();
    await handler({ method: 'POST', headers: { authorization: `Bearer ${barberToken}` }, body: { ...sub, role: 'barber' } }, r3.obj);
    const stored2 = JSON.parse(fake.strings.get('push_subscriptions'));
    eq(stored2.length, 1, 'duplicate endpoint replaces existing subscription instead of appending');
    eq(stored2[0].role, 'barber', 'replaced subscription reflects the updated role');

    // A removed worker's session token stays cryptographically valid (no
    // revocation list) — must not be able to register a device to keep
    // receiving that salon's live booking-notification pushes.
    fake.strings.set('salons_db', JSON.stringify([{ id: 'salonX', name: 'Salon X', workers: [] }]));
    const rRemoved = mkRes();
    await handler({ method: 'POST', headers: { authorization: `Bearer ${barberToken}` }, body: { subscription: { endpoint: 'https://push.test/removed' }, role: 'barber', salonId: 'salonX' } }, rRemoved.obj);
    eq(rRemoved.status, 401, "a removed worker's still-valid token can no longer register a push subscription");
  } finally {
    restoreEnv('SESSION_SECRET', prevSecret);
  }
});

/* ================================================================
   11. OPTIONAL — api/subscribe.js AGAINST THE REAL VERCEL/UPSTASH KV
   OFF BY DEFAULT. This performs a real network write to the production
   database using the credentials in .env.local. Enable explicitly with:
     LIVE_KV_TEST=1 node test-functionality.js
   It writes one clearly-marked, fake-endpoint test subscription, verifies
   the real handler stored it in the real KV, then deletes that one entry
   again so nothing test-related is left behind afterwards.
================================================================ */
function loadDotEnvLocal() {
  const envPath = path.join(__dirname, '.env.local');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"\n\r]*)"?\s*$/i);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
}

if (process.env.LIVE_KV_TEST === '1') {
  section('api/subscribe.js — LIVE Vercel/Upstash KV (real network, .env.local credentials)');
  loadDotEnvLocal();
  const kvUrl = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;

  if (!kvUrl || !kvToken) {
    console.log('  [SKIP] KV_REST_API_URL / KV_REST_API_TOKEN not found in .env.local — cannot run live test');
  } else {
    const testEndpoint = `https://live-test.invalid/TEST-SUBSCRIPTION-DO-NOT-USE-${Date.now()}`;
    try {
      const subMod = await import(pathToFileURL(path.join(__dirname, 'api', 'subscribe.js')).href + `?t=${Date.now()}`);
      const handler = subMod.default;

      let status = null, body = null;
      const res = { setHeader() {}, status(c) { status = c; return this; }, json(b) { body = b; return this; }, end() {} };
      await handler({
        method: 'POST',
        body: {
          subscription: { endpoint: testEndpoint, keys: { p256dh: 'test-key', auth: 'test-auth' } },
          role: 'owner', salonId: 'LIVE_TEST_SALON_DO_NOT_USE'
        }
      }, res);
      ok(status === 200 && body && body.success === true, 'LIVE: real subscribe.js handler accepts and stores a subscription in the real KV');

      // Verify it really landed in the production store
      const getResp = await fetch(`${kvUrl}/get/push_subscriptions`, { headers: { Authorization: `Bearer ${kvToken}` } });
      const getData = await getResp.json();
      let subs = getData.result ? JSON.parse(getData.result) : [];
      if (typeof subs === 'string') subs = JSON.parse(subs);
      const found = Array.isArray(subs) && subs.some(s => s.subscription && s.subscription.endpoint === testEndpoint);
      ok(found, 'LIVE: test subscription is present in the real push_subscriptions list');

      // Clean up: remove only our test entry, leave every real subscription untouched
      const cleaned = (Array.isArray(subs) ? subs : []).filter(s => !(s.subscription && s.subscription.endpoint === testEndpoint));
      const setResp = await fetch(`${kvUrl}/set/push_subscriptions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${kvToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(JSON.stringify(cleaned))
      });
      ok(setResp.ok, 'LIVE: cleanup removed the test subscription from the real KV, other entries untouched');
    } catch (e) {
      ok(false, `LIVE subscribe test threw: ${e.stack || e}`);
    }
  }
} else {
  console.log('\n(Skipping LIVE KV test for api/subscribe.js — set LIVE_KV_TEST=1 to enable it. ' +
    'It performs a real write against the production Vercel/Upstash database and cleans up after itself.)');
}

/* ================================================================
   SUMMARY
================================================================ */
console.log(`\n================ RESULT: ${pass} passed, ${fail} failed ================`);
if (fail > 0) {
  console.log('Failed checks:');
  failures.forEach(f => console.log('  - ' + f));
  process.exit(1);
}
process.exit(0);
