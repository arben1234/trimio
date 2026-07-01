# BARBERS BLOCK
Sistema di prenotazione online per barbieri — single-page app, nessun backend richiesto.

## Struttura cartella

```
barbers-block/
├── index.html        ← pagina principale
├── css/
│   └── style.css     ← tutti gli stili
├── js/
│   └── app.js        ← tutta la logica applicativa
└── README.md
```

## 4 Livelli utente

| Livello | Ruolo          | Accesso               | Credenziali demo   |
|---------|----------------|-----------------------|--------------------|
| 1       | Amministratore | Tutti i saloni        | admin / admin123   |
| 2       | Proprietario   | Il proprio salone     | owner / owner123   |
| 3       | Barbiere       | Il proprio calendario | shqipe / barber123 |
| 4       | Cliente        | Prenotazione online   | (nessuna password) |

## Installazione sul server

1. Carica l'intera cartella `barbers-block/` sul tuo server tramite FTP/SFTP/cPanel
2. Il file `index.html` deve trovarsi nella root pubblica (es. `public_html/`)
3. Apri il browser:
   - `https://tuodominio.com/` → homepage con tutti i saloni
   - `https://tuodominio.com/#BARBER_ART` → salone diretto

## Link per Instagram / WhatsApp

Dalla homepage, usa il pulsante **Copia** accanto a ogni salone.
Formato: `https://tuodominio.com/#NOME_SALONE`

## Requisiti server

- Qualsiasi hosting web (Apache, Nginx, cPanel, Plesk...)
- Nessun PHP, Node.js o database necessario
- HTTPS raccomandato (serve per il pulsante "Copia link")
- Nessuna dipendenza esterna — tutto funziona offline dopo il primo caricamento
