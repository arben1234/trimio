# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

TRIMIO (formerly "Barbers Block") is a multi-tenant booking system for barber shops: a single-page vanilla-JS frontend backed by Vercel serverless functions and an Upstash Redis (Vercel KV) database. There is no framework, no bundler for the frontend logic, and no client-side build step beyond minification.

## Commands

- **Run locally**: `node dev-server.js` — serves the static app on `:3000` and routes `/api/<name>` requests to the matching `api/<name>.js` handler, reading credentials from `.env.local`.
  - ⚠️ This talks to the **same live production** Upstash/KV database as the real deployment — there is no local/sandboxed DB. Bookings, logins and salon edits made while developing are real.
- **Run the test suite**: `node test-functionality.js` — a read-only harness that loads `js/app.js` and `api/*.js` unmodified into a mocked DOM/fetch/KV sandbox and asserts on real behavior. Never touches the live DB. Add new cases directly in this file (it uses simple local `ok()`/`eq()` assertion helpers, no external test framework).
- **Build the production bundle**: `node build.cjs` — runs `js/app.js` through Terser (mangled, comments stripped, console.log dropped) and injects an anti-debugging/devtools-detection header, writing `js/app.min.js`. **`index.html` loads `app.min.js`, not `app.js`** — you MUST run this after every change to `js/app.js` or the deployed app won't reflect the edit. Bump the `?v=` query string on the `<script src="/js/app.min.js?v=...">` tag in `index.html` when you do, so browsers/PWAs don't serve a stale cached copy.
- **Deploy**: `vercel --prod` (manual only — pushing to GitHub does **not** auto-deploy). Production is aliased to `trimio.org` (and `trimio-two.vercel.app`, which now 307-redirects to `trimio.org`).
- No lint/typecheck config exists in this repo.

## Architecture

### Frontend: one file, four "levels" of user, hash/path-based routing

Almost all client logic lives in `js/app.js` (~4700 lines) rendering into the single `index.html`/`css/style.css`. There is one global `STATE` object (`{salons, bookings, admin, homepageAd}`) and one global `SESSION` object (`{role, salonId, workerId, name}`), synced to `localStorage` and polled against `/api/sync` every 6s.

Four user levels, gated purely by `SESSION.role`:
1. **Admin** (Livello 1) — manages all salons, users, the homepage ad, global stats. Lands on `vHome`.
2. **Owner** (Livello 2, `ownerUsername`/`ownerPassword` per salon) — manages one salon (bookings, services, stats, reviews). Cannot add/delete workers (admin-only) — can only edit a worker's vacation dates.
3. **Barber** (Livello 3, per-worker `username`/`password`) — manages their own calendar/bookings/stats/break-and-rest-day settings ("Le mie Pause").
4. **Customer** — no login; books via a salon's public link/QR code.

Views are plain sibling `<div class="view">` elements (`vHome`, `vLogin`, `vDash`, `vCustomer`) toggled via `showView()`; **always route view changes through `showView()`**, never toggle `.on` classes directly — it carries hard invariants (e.g. an owner/barber session can never render `vHome`) that a direct class toggle would bypass. Dashboard sub-sections (`secOggi`, `secDipendenti`, etc.) are toggled the same way via `showSec()`, and the sidebar nav is rebuilt per-role by `navItems()`/`buildNav()`.

**Salon identity lives in the URL**, two equivalent forms:
- `#SLUG` hash (e.g. `/#BARBER_ART`) — the primary in-app routing mechanism (`hashchange` listener + `checkInitialHash()` in `boot()`).
- `/s/SLUG` real path — required so "Add to Home Screen" on iOS captures a URL that survives (iOS strips hash fragments and ignores `history.replaceState`). `updateManifestLink()` transparently re-navigates from a bare `#SLUG` hash to `/s/SLUG#SLUG` via `location.replace()` so an installed PWA icon reopens the right salon instead of the admin login. `vercel.json` rewrites `/s/:slug` to `api/salon-page.js`, which serves `index.html` with the manifest `<link>` already pointing at `/api/manifest?start=/s/SLUG`.

**Golden rule enforced in code** (`showView()` and `initDash()`): the admin page and a salon's owner/barber/customer page must never render for the wrong session — an owner/barber session that can't resolve its salon (not yet synced, deleted, wrong id) logs out cleanly instead of falling back to a generic-looking dashboard. Preserve this invariant when touching routing/session code.

### Backend: Vercel serverless functions + Upstash Redis

`api/*.js` are individual Vercel serverless functions (no framework/router); `lib/kv.js` is the shared data-access layer over Upstash's REST API, and `lib/sms.js` wraps Twilio for SMS/WhatsApp fallback when a customer has no push subscription.

KV layout (see the header comment in `lib/kv.js` for full detail):
- `salons_db` — single JSON blob, all salons/workers/services.
- `admin_db` — single JSON blob, admin credentials.
- `bookings` — a Redis **Hash** (`field = booking.id`), so concurrent booking writes touch only one field, never a read-modify-write of the whole collection.
- `lock:<salonId>:<workerId>:<dateISO>:<time>` — one key per active (non-cancelled) booking, `SET ... NX` as an atomic double-booking guard; `api/sync.js` also does a duration-aware overlap check (`overlapsExisting`) against a barber's other bookings that same day, since the exact-slot lock alone can't see two different start times whose service durations overlap.
- `migrated_v2` — marker for the one-time lazy migration off a legacy single-blob `bookings_db` key (still done automatically, transparently, in `ensureMigratedV2()`).

`api/sync.js` is the core endpoint: `GET` returns the full state, `POST` upserts (never blindly overwrites) bookings and salons — the client's `saveState()` sends its *entire* local snapshot on every save, so salons are merged by id and a stale/partial client can't wipe out another device's concurrent changes. Booking push notifications and staff-cancellation customer notifications are sent from here too, and **must be `await`ed**, not fire-and-forget — Vercel's serverless runtime can freeze the function right after the HTTP response is sent, silently killing in-flight `webPush.sendNotification()` calls otherwise.

Reminders run on two schedules because Vercel Hobby only allows daily crons: `vercel.json`'s cron hits `/api/send-reminders` once daily, and `.github/workflows/hourly-reminders.yml` calls the same endpoint every hour via `curl` for the "~3h before appointment" same-day reminders — the endpoint itself is idempotent (enforces Italy quiet hours 8:00–20:00 and per-booking sent-once flags), so extra calls are harmless no-ops.

Env vars (`.env.local` locally, Vercel project settings in prod): `KV_REST_API_URL`/`KV_REST_API_TOKEN` (Upstash), `VAPID_PRIVATE_KEY` (web push; the matching public key is hardcoded in both `js/app.js` and every `api/*.js` that sends push, since it's meant to ship to browsers), `BLOB_READ_WRITE_TOKEN` (image uploads via `@vercel/blob`), optional `TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN`/`TWILIO_FROM`/`TWILIO_WHATSAPP_FROM` (SMS/WhatsApp fallback — silent no-op when absent).

### Build/deploy pipeline

`index.html` → `<script src="/js/app.min.js">` only. `js/app.js` is the real source of truth; `app.min.js` is a generated artifact (`build.cjs`, Terser) — never hand-edit it. The minified build also injects anti-debugging/right-click-blocking/devtools-detection code (copyright protection), so don't be surprised finding it only in `app.min.js`, not the source.

`vercel.json` also sets a global `no-store`/`no-cache` header on every response except `/api/image` (which is cached forever, since image ids are content-addressed).

### Legacy/exploratory files

`test-npoint.js`, `test-npoint-create.js` are leftover scripts from an earlier npoint.io-based backend, no longer relevant. `test-run.js` is a older CommonJS smoke test (`eval`s `app.js` in a mocked global scope); prefer `test-functionality.js` for anything new.
