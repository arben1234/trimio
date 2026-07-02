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
    remove: () => {}
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
    atob: (s) => Buffer.from(s, 'base64').toString('binary')
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
    normalizeCredentials, bookedTimesFor, bookingsFor, openDays,
    getDistance, deg2rad, dayLabel, initials, isoOf, todayISO, relDay,
    isOnVacation, freqTag, urlBase64ToUint8Array,
    validateCust, custData, doSubmit, custNext,
    doLogin, getSession: function(){ return SESSION; },
    filterByPeriod
  };
  var __uiCallCounts = { showView:0, initDash:0, initPush:0 };
  showView = function(){ __uiCallCounts.showView++; };
  initDash = function(){ __uiCallCounts.initDash++; };
  initPushNotifications = function(){ __uiCallCounts.initPush++; return Promise.resolve(); };
  // boot() auto-runs at the bottom of app.js (real behaviour). Its
  // continuation (after "await loadState()") fires as a microtask the
  // first time our test script itself awaits something. Neutralise the
  // side effects we don't want racing our assertions (thousands of demo
  // bookings, live geolocation, cloud-sync polling) — this only affects
  // how the test drives app.js, it does not modify app.js itself.
  seedDemoBookings = function(){};
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
   3. normalizeCredentials()
================================================================ */
section('normalizeCredentials()');
{
  const s = X.STATE.salons[0];
  const origUser = s.ownerUsername;
  s.ownerUsername = 'weird_owner_name';
  s.ownerPassword = 'owner123';
  const changed = X.normalizeCredentials();
  ok(changed === true, 'reports changed=true when owner username drifts from convention');
  ok(s.ownerUsername === 'owner', 'owner username normalized back to "owner"');
  s.ownerUsername = origUser; // restore

  const w = s.workers[0];
  const savedU = w.username, savedP = w.password;
  w.username = 'totally-wrong'; w.password = 'totally-wrong';
  const changed2 = X.normalizeCredentials();
  ok(changed2 === true, 'reports changed=true when worker credentials drift');
  ok(w.username === savedU && w.password === savedP, 'worker credentials normalized back to firstname/firstname123');

  const changed3 = X.normalizeCredentials();
  ok(changed3 === false, 'idempotent: no changes reported when credentials already normalized');
}

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

  custStepScript(1);
  ok(X.validateCust() === false, 'step 1 rejected without date/time');
  X.custData.dateISO = '2099-01-01'; X.custData.time = '10:00';
  ok(X.validateCust() === true, 'step 1 passes with future date + time');

  custStepScript(2);
  ok(X.validateCust() === false, 'step 2 rejected without a service');
  X.custData.service = 'Taglio';
  ok(X.validateCust() === true, 'step 2 passes once service selected');

  custStepScript(3);
  X.custData.name = 'A';
  ok(X.validateCust() === false, 'step 3 rejected for a 1-character name');
  X.custData.name = 'Mario Rossi';
  ok(X.validateCust() === true, 'step 3 passes with a valid name');
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
  const setLogin = (usr, pwd) => new vm.Script(
    `document.getElementById('lusr').value = ${JSON.stringify(usr)}; document.getElementById('lpw').value = ${JSON.stringify(pwd)};`,
    { filename: 'set-login.js' }
  ).runInContext(context);

  setLogin('admin', 'admin123');
  X.doLogin();
  eq(X.getSession().role, 'admin', 'Level 1 — admin/admin123 authenticates as admin');

  const salon0 = X.STATE.salons[0];
  setLogin(salon0.ownerUsername, salon0.ownerPassword);
  X.doLogin();
  let sess = X.getSession();
  ok(sess.role === 'owner' && sess.salonId === salon0.id, 'Level 2 — owner credentials authenticate as owner of correct salon');

  const worker0 = salon0.workers[0];
  setLogin(worker0.username, worker0.password);
  X.doLogin();
  sess = X.getSession();
  ok(sess.role === 'barber' && sess.workerId === worker0.id, 'Level 3 — barber credentials authenticate as correct worker');

  setLogin('nobody', 'wrongpass');
  X.doLogin();
  sess = X.getSession();
  ok(sess.role === 'barber', 'invalid credentials leave SESSION untouched (still previous barber session)');

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
  const r = { body: null, status: null };
  r.obj = { setHeader() {}, status(c) { r.status = c; return r.obj; }, json(b) { r.body = b; return r.obj; }, end() {} };
  return r;
}

section('api/sync.js — booking sync + merge logic (fake KV, no live network)');
await withFakeKv(makeFakeRedis(), async () => {
  const handler = await freshImport('api/sync.js');

  const r1 = mkRes();
  await handler({ method: 'GET' }, r1.obj);
  ok(r1.status === 200 && Array.isArray(r1.body.bookings) && r1.body.bookings.length === 0, 'GET returns empty bookings initially');

  const newBooking = { id: 'bk1', status: 'confirmed', salonId: 'salonX', workerId: 'w1', dateISO: '2030-01-01', service: 'Taglio', time: '10:00', dateLabel: 'oggi', name: 'Test' };
  const r2 = mkRes();
  await handler({ method: 'POST', body: { bookings: [newBooking], salons: [] } }, r2.obj);
  ok(r2.status === 200 && r2.body.success === true, 'POST accepts a new booking');
  ok(r2.body.bookings.some(b => b.id === 'bk1'), 'POST response includes the newly merged booking');
  eq(r2.body.conflicts, [], 'no conflicts reported for a genuinely new booking');

  const r3 = mkRes();
  await handler({ method: 'GET' }, r3.obj);
  ok(r3.body.bookings.length === 1 && r3.body.bookings[0].id === 'bk1', 'subsequent GET reflects the persisted booking (proves the Hash round-trip works)');

  const r4 = mkRes();
  await handler({ method: 'POST', body: { bookings: [{ ...newBooking, status: 'cancelled' }], salons: [] } }, r4.obj);
  ok(r4.body.bookings.length === 1 && r4.body.bookings[0].status === 'cancelled', 'POST updates existing booking by id instead of duplicating');

  const r5 = mkRes();
  await handler({ method: 'OPTIONS' }, r5.obj);
  eq(r5.status, 200, 'OPTIONS preflight returns 200');
});

section('api/sync.js — CONCURRENCY: same-slot double-booking is rejected atomically');
await withFakeKv(makeFakeRedis(), async (fake) => {
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
await withFakeKv(makeFakeRedis(), async () => {
  const handler = await freshImport('api/sync.js');
  const bk = { id: 'cancel-1', salonId: 'sX', workerId: 'wX', dateISO: '2030-03-03', time: '11:00', status: 'confirmed', name: 'First' };

  await handler({ method: 'POST', body: { bookings: [bk], salons: [] } }, mkRes().obj);

  const rBlocked = mkRes();
  await handler({ method: 'POST', body: { bookings: [{ ...bk, id: 'cancel-2', name: 'Second' }], salons: [] } }, rBlocked.obj);
  ok(rBlocked.body.conflicts.some(c => c.id === 'cancel-2'), 'a second booking for the same slot is rejected while the first is still active');

  await handler({ method: 'POST', body: { bookings: [{ ...bk, status: 'cancelled' }], salons: [] } }, mkRes().obj);

  const rReuse = mkRes();
  await handler({ method: 'POST', body: { bookings: [{ ...bk, id: 'cancel-3', name: 'Third' }], salons: [] } }, rReuse.obj);
  eq(rReuse.body.conflicts, [], 'after cancellation, the freed slot can be booked again without conflict');
});

section('api/sync.js — one-time migration from the legacy bookings_db blob');
await withFakeKv(makeFakeRedis(), async (fake) => {
  const legacyBooking = { id: 'legacy-1', salonId: 'sLegacy', workerId: 'wLegacy', dateISO: '2030-04-04', time: '09:00', status: 'confirmed', name: 'Legacy Customer' };
  const legacySalons = [{ id: 'sLegacy', name: 'Legacy Salon' }];
  fake.strings.set('bookings_db', JSON.stringify({ bookings: [legacyBooking], salons: legacySalons }));

  const handler = await freshImport('api/sync.js');
  const rGet = mkRes();
  await handler({ method: 'GET' }, rGet.obj);
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
  const handler = await freshImport('api/sync.js');
  const goodBooking = { id: 'good-1', salonId: 'sX', workerId: 'wX', dateISO: '2030-05-05', time: '09:00', status: 'confirmed', name: 'Good' };
  const malformedBooking = { id: 'bad-1', salonId: 'sX' }; // missing workerId/dateISO/time
  const noIdBooking = { salonId: 'sX', workerId: 'wX', dateISO: '2030-05-05', time: '10:00' };

  const r1 = mkRes();
  await handler({ method: 'POST', body: { bookings: [goodBooking, malformedBooking, noIdBooking], salons: [] } }, r1.obj);
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
  const handler = await freshImport('api/toggle-salon.js');

  const r1 = mkRes();
  await handler({ method: 'POST', body: { salonId: 'salonX', inactive: true } }, r1.obj);
  ok(r1.status === 200 && r1.body.success === true, 'toggle-salon marks an existing salon inactive');

  const parsed = JSON.parse(fake.strings.get('salons_db'));
  ok(parsed.find(s => s.id === 'salonX').inactive === true, 'inactive flag persisted into fake KV store');

  const r2 = mkRes();
  await handler({ method: 'POST', body: { salonId: 'does-not-exist', inactive: true } }, r2.obj);
  eq(r2.status, 404, 'toggle-salon returns 404 for an unknown salonId');

  const r3 = mkRes();
  await handler({ method: 'GET' }, r3.obj);
  eq(r3.status, 405, 'toggle-salon rejects non-POST methods with 405');
});

section('api/sync.js — CRITICAL: a stale/partial salons snapshot never deletes other salons');
await withFakeKv(makeFakeRedis(), async (fake) => {
  fake.strings.set('salons_db', JSON.stringify([
    { id: 'salonA', name: 'Salon A' },
    { id: 'salonB', name: 'Salon B' }
  ]));
  const handler = await freshImport('api/sync.js');

  // A client with a stale local copy (only knows about salonA, e.g. it
  // loaded before salonB was created) saves for an unrelated reason
  // (confirming a booking) and sends its whole local salons snapshot.
  const staleClientSalons = [{ id: 'salonA', name: 'Salon A Edited' }];
  const r1 = mkRes();
  await handler({ method: 'POST', body: { bookings: [], salons: staleClientSalons } }, r1.obj);
  ok(r1.status === 200, 'sync accepts a save from a client with a partial salons snapshot');

  const salonsAfter = JSON.parse(fake.strings.get('salons_db'));
  ok(salonsAfter.some(s => s.id === 'salonB'), 'salonB (absent from the stale payload) is NOT deleted');
  ok(salonsAfter.find(s => s.id === 'salonA')?.name === 'Salon A Edited', 'salonA is still updated with the fields the client actually sent');
  eq(salonsAfter.length, 2, 'total salon count is unchanged — nothing silently lost');
});

section('api/delete-salon.js — explicit, targeted salon deletion (fake KV, no live network)');
await withFakeKv(makeFakeRedis(), async (fake) => {
  fake.strings.set('salons_db', JSON.stringify([
    { id: 'salonA', name: 'Salon A' },
    { id: 'salonB', name: 'Salon B' }
  ]));
  const handler = await freshImport('api/delete-salon.js');

  // Seed a booking + lock belonging to salonA to confirm cleanup.
  fake.hashes.set('bookings', new Map([
    ['bkA1', JSON.stringify({ id: 'bkA1', salonId: 'salonA', workerId: 'w1', dateISO: '2030-01-01', time: '10:00', status: 'confirmed' })],
    ['bkB1', JSON.stringify({ id: 'bkB1', salonId: 'salonB', workerId: 'w2', dateISO: '2030-01-01', time: '11:00', status: 'confirmed' })]
  ]));
  fake.strings.set('lock:salonA:w1:2030-01-01:10:00', 'bkA1');
  fake.strings.set('lock:salonB:w2:2030-01-01:11:00', 'bkB1');

  const r1 = mkRes();
  await handler({ method: 'POST', body: { salonId: 'salonA' } }, r1.obj);
  ok(r1.status === 200 && r1.body.success === true, 'delete-salon succeeds for an existing salon');
  eq(r1.body.removedBookings, 1, 'reports exactly the one booking removed for that salon');

  const salonsAfter = JSON.parse(fake.strings.get('salons_db'));
  ok(!salonsAfter.some(s => s.id === 'salonA'), 'salonA is removed from salons_db');
  ok(salonsAfter.some(s => s.id === 'salonB'), 'salonB is untouched');
  ok(!fake.hashes.get('bookings').has('bkA1'), 'salonA\'s booking is removed from the bookings hash');
  ok(fake.hashes.get('bookings').has('bkB1'), 'salonB\'s booking is untouched');
  ok(!fake.strings.has('lock:salonA:w1:2030-01-01:10:00'), 'salonA\'s slot lock is released');

  const r2 = mkRes();
  await handler({ method: 'POST', body: { salonId: 'does-not-exist' } }, r2.obj);
  eq(r2.status, 404, 'delete-salon returns 404 for an unknown salonId');
});

section('api/subscribe.js — push subscription storage (fake KV, no live network)');
await withFakeKv(makeFakeRedis(), async (fake) => {
  const handler = await freshImport('api/subscribe.js');

  const r1 = mkRes();
  await handler({ method: 'POST', body: { subscription: {} } }, r1.obj);
  eq(r1.status, 400, 'rejects a subscription payload missing an endpoint');

  const sub = { subscription: { endpoint: 'https://push.test/abc' }, role: 'owner', salonId: 'salonX' };
  const r2 = mkRes();
  await handler({ method: 'POST', body: sub }, r2.obj);
  ok(r2.status === 200 && r2.body.success === true, 'valid subscription accepted and stored');

  const stored = JSON.parse(fake.strings.get('push_subscriptions'));
  ok(stored.length === 1 && stored[0].subscription.endpoint === sub.subscription.endpoint, 'subscription persisted to fake KV with correct endpoint');

  // re-subscribing with the same endpoint should replace, not duplicate
  const r3 = mkRes();
  await handler({ method: 'POST', body: { ...sub, role: 'barber' } }, r3.obj);
  const stored2 = JSON.parse(fake.strings.get('push_subscriptions'));
  eq(stored2.length, 1, 'duplicate endpoint replaces existing subscription instead of appending');
  eq(stored2[0].role, 'barber', 'replaced subscription reflects the updated role');
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
