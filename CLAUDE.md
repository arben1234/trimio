# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

**Backend**
```bash
cd backend
npm install
npm run dev        # nodemon, porta 3001
npm start          # produzione
```

**Frontend**
```bash
cd frontend
npm install
npm run dev        # Vite, porta 5173
npm run build
```

Avviare sempre prima il backend poi il frontend. Vite fa proxy di `/api` → `http://localhost:3001`.

## Architettura

Monorepo con due cartelle indipendenti:

```
backend/   Node.js + Express + better-sqlite3
frontend/  React + Vite (mobile-first, UI italiana)
```

### URL routing (logica core)

Ogni salone ha uno slug unico. **Tutti** i percorsi staff/cliente sono sempre prefissati con `/s/:salonSlug`:

| Percorso | Chi accede |
|---|---|
| `/` | Login super admin |
| `/admin` | Pannello super admin |
| `/s/:slug` | Pagina pubblica salone (cliente prenota) |
| `/s/:slug/login` | Login staff (barber/owner) |
| `/s/:slug/barber` | Dashboard barbiere |
| `/s/:slug/owner` | Dashboard proprietario |

### Isolamento sessioni (problema risolto)

Il bug originale (un barber vedeva il salone sbagliato) era dovuto a token globali in localStorage. La soluzione:

- `frontend/src/utils/storage.js` usa chiavi con salonId: `trimio_token_{salonId}`
- Il middleware `backend/src/middleware/auth.js` valida che il `salonId` nel JWT coincida con lo slug nella URL
- `useAuth.js` resetta lo stato quando cambia `salonId` nell'URL

### Backend

- `src/server.js` — entry point, monta tutti i router su `/api`
- `src/database/schema.sql` — schema completo con seed super admin (password: `admin123`)
- `src/middleware/auth.js` — `requireAuth(roles[])` e `requireSuperAdmin`; firma token con `{ userId, role, salonId, name }`
- Route scoped al salone: `GET/POST /api/salons/:salonSlug/bookings`, `/barbers/:id/availability`, ecc.
- Route admin: `/api/admin/salons` (CRUD + genera slug + QR code automatici)

### Frontend

- `src/hooks/useAuth.js` — `useSalonAuth(salonSlug, salonId)` e `useAdminAuth()`
- `src/utils/api.js` — wrapper fetch centralizato; passa sempre il `salonId` corretto per selezionare il token giusto
- `src/utils/storage.js` — lettura/scrittura token isolati per salone
- `src/styles/global.css` — design system completo (variabili CSS, componenti riutilizzabili)

### Node.js version

Richiede Node.js 22.5+ per il modulo built-in `node:sqlite` (nessuna dipendenza esterna, nessuna compilazione nativa). Testato su Node 24.

### Database (SQLite)

Tabelle principali: `salons`, `users` (barber/owner/super_admin), `services`, `bookings`, `working_hours`, `holidays`, `ratings`.

Constraint importante: `UNIQUE(salon_id, username)` — lo stesso username può esistere in saloni diversi.

### Push notifications

Richiede variabili VAPID in `.env`. Il service worker è in `frontend/public/sw.js`. La push subscription viene salvata in `users.push_sub`.

### Credenziali default

- Super admin: `admin` / `admin123`
- Ogni salone creato riceve automaticamente owner: `owner` / `owner123`
- Ogni barber creato: password default `{username}123`
