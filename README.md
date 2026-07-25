# TRIMIO

Sistema di prenotazione online multi-tenant per saloni (barbieri, parrucchieri, centri estetici) — single-page app in vanilla JS con backend Vercel serverless e database Upstash Redis (Vercel KV).

## Struttura cartella

```
trimio/
├── index.html        ← pagina principale (carica js/app.min.js)
├── css/style.css      ← tutti gli stili
├── js/app.js           ← logica applicativa (sorgente)
├── js/app.min.js       ← bundle minificato servito in produzione (generato, non modificare a mano)
├── api/                ← funzioni serverless Vercel (backend)
├── lib/                ← moduli condivisi lato backend (KV, auth, email, SMS, PayPal...)
└── build.cjs            ← build/minificazione di js/app.js
```

Guida completa per sviluppatori/AI: vedi `CLAUDE.md`.

## 4 livelli utente

| Livello | Ruolo          | Accesso                    |
|---------|----------------|-----------------------------|
| 1       | Amministratore | Tutti i saloni              |
| 2       | Proprietario   | Il proprio salone           |
| 3       | Operatore      | Il proprio calendario       |
| 4       | Cliente        | Prenotazione online (nessun login) |

## Sviluppo locale

```
node dev-server.js
```

Serve l'app su `:3000`, leggendo le credenziali da `.env.local`. ⚠️ Si collega allo stesso database di produzione — non esiste un ambiente sandbox separato.

Dopo ogni modifica a `js/app.js`, rigenera il bundle e aggiorna la versione in `index.html`:

```
node build.cjs
```

## Test

```
node test-functionality.js
```

Suite di test read-only, non tocca mai il database live.

## Deploy

```
vercel --prod
```

Il push su GitHub **non** effettua il deploy automatico.
