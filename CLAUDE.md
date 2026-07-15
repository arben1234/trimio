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
2. **Owner** (Livello 2, `ownerUsername`/`ownerPassword` per salon) — manages one salon (bookings, services, stats, reviews). Can create new workers and fully edit existing ones (name, username, phone, role, photo, password, vacation dates) — deleting a worker stays admin-only, enforced both client-side (delete button hidden) and server-side (`api/sync.js`'s bulk salon-save restores any worker a non-admin payload omits, so an owner can't delete one even via a crafted request).
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

Env vars (`.env.local` locally, Vercel project settings in prod): `KV_REST_API_URL`/`KV_REST_API_TOKEN` (Upstash), `VAPID_PRIVATE_KEY` (web push; the matching public key is hardcoded in both `js/app.js` and every `api/*.js` that sends push, since it's meant to ship to browsers), `BLOB_READ_WRITE_TOKEN` (image uploads via `@vercel/blob`), optional `TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN`/`TWILIO_FROM`/`TWILIO_WHATSAPP_FROM` (SMS/WhatsApp fallback — silent no-op when absent), optional `RESEND_API_KEY`/`RESEND_FROM` (`lib/email.js` — monthly billing warning/suspension emails for self-signed-up salons; silent no-op when absent, and Resend's shared sandbox sender can only reach the Resend account's own verified address until a sending domain is verified in their dashboard), optional `STRIPE_SECRET_KEY`/`STRIPE_WEBHOOK_SECRET` (`lib/stripe.js` — automatic monthly card billing, see below; silent no-op when absent).

### Self-service salon signup + monthly billing

A salon owner can self-register from the public homepage ("Registra il tuo salone" in `vLogin`'s footer, a step wizard in `js/app.js`'s `suGoto`/`suSubmit`) instead of only being admin-created. This posts `action: 'signup_salon'` to `/api/sync` (`handleSignupSalon`) — the one path where a brand-new salon can be written without an admin session, since the generic bulk `salons[]` save otherwise rejects unauthenticated writes for unknown ids. New signups are created `inactive: true` with `billing.pendingApproval: true`; an admin reviews and brings them live with the existing Attiva button (`api/toggle-salon.js`, which also clears `pendingApproval`/`suspendedByBilling` on reactivation).

Each self-signup salon carries a `billing` object: `declaredWorkerCount` (drives the fee tier — €50 for 1-5 barbers, €100 for 6-10, €150 for 11-15, `feeForWorkerCount()` in `lib/billing.js` server-side / duplicated in `js/app.js` client-side, since there's no bundler to share code with the browser, extrapolates the same +€50-per-5 band beyond that), `paidThroughMonth` ('YYYY-MM', initialized to the signup month so the first partial month is free), `contractSignedAt`/`contractSignedName` (the typed-name e-signature on the in-wizard contract template — not a notarized signature, and the contract text is a placeholder, not reviewed legal language), `lastWarningEmailSentDate`/`suspendedByBilling` used by the manual-track billing cron below, and `autopay`/`stripeCustomerId`/`stripeSubscriptionId`/`paymentFailing` used by the Stripe auto-pay track. Payment is manual by default (bank transfer + an admin's 💶 `mark_salon_paid` action in `api/sync.js`) — an owner can additionally opt into automatic recurring card billing (see below), which is optional and never required.

`api/daily-health-check.js`'s existing daily cron does the billing check too (no new serverless function — Hobby's 12-function cap is already maxed out): for every non-pending, non-`autopay` salon with a `billing` object, days 2-5 of the month send one warning email/day if unpaid, day 6+ auto-suspends (`inactive: true`) if still unpaid. Salons with `billing.autopay: true` are skipped here entirely — see below.

**Automatic card billing (Stripe)**: an owner of a self-signup salon can activate recurring monthly card payment from a "Fatturazione" dashboard section (only shown when `salon.billing` exists), via `action: 'create_billing_checkout_session'` in `api/sync.js` — creates a Stripe Checkout Session (subscription mode, a dynamic `price_data` line item computed from `feeForWorkerCount()`, so no Stripe Price objects need to be predefined per tier) and redirects there; `action: 'create_billing_portal_session'` opens a Stripe-hosted Billing Portal for managing/cancelling. `api/stripe-webhook.js` (raw body, signature-verified via `STRIPE_WEBHOOK_SECRET`, one of the 12 Vercel functions — `api/reset-all-data.js` was folded into `api/sync.js` as `action: 'reset_all_data'` to free the slot) handles `checkout.session.completed` (sets `stripeCustomerId`/`stripeSubscriptionId`/`autopay: true`), `invoice.paid` (sets `paidThroughMonth`, clears any suspension — correlates by `stripeCustomerId` first, falling back to the subscription's `metadata.salonId` since Stripe webhook delivery isn't ordered and `invoice.paid` for the first invoice can arrive before `checkout.session.completed`), `invoice.payment_failed` (sets `paymentFailing: true`; actively suspends on final-retry exhaustion rather than relying on Stripe Dashboard dunning config, since the cron skips autopay salons entirely), `customer.subscription.updated` (reflects `past_due`/`unpaid` into `paymentFailing`), and `customer.subscription.deleted` (clears `autopay`, falling back to the manual cron track). Every salon mutation in the webhook is wrapped in a per-salon KV lock (`acquireBillingLock`/`releaseBillingLock` in `lib/kv.js`) since `getSalonsDb`/`setSalonsDb` is a full-blob read-modify-write, and each Stripe event is idempotency-guarded (`claimStripeEventOnce`) against redelivery. The subscription's price is locked in at whatever fee tier applied when autopay was activated — it does not auto-resync if the salon's worker count crosses a tier later (documented tradeoff, not a bug). The Stripe Dashboard's Customer Portal configuration must be activated once (Settings → Billing → Customer portal) before `create_billing_portal_session` will work.

### Build/deploy pipeline

`index.html` → `<script src="/js/app.min.js">` only. `js/app.js` is the real source of truth; `app.min.js` is a generated artifact (`build.cjs`, Terser) — never hand-edit it. The minified build also injects anti-debugging/right-click-blocking/devtools-detection code (copyright protection), so don't be surprised finding it only in `app.min.js`, not the source.

`vercel.json` also sets a global `no-store`/`no-cache` header on every response except `/api/image` (which is cached forever, since image ids are content-addressed).

### Legacy/exploratory files

`test-npoint.js`, `test-npoint-create.js` are leftover scripts from an earlier npoint.io-based backend, no longer relevant. `test-run.js` is a older CommonJS smoke test (`eval`s `app.js` in a mocked global scope); prefer `test-functionality.js` for anything new.
