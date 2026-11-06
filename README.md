# Price Tracker

Web app mobile-first (HTML + CSS + JS puri, nessun build) per tracciare i prezzi di qualsiasi cosa.
Accesso con Google; tutti i dati finiscono in un **Google Sheet nel tuo Drive** e le foto in una cartella Drive.

## Funzioni

- Login Google (OAuth, permesso minimo `drive.file`: l'app vede **solo** i file che crea lei)
- Home con gli ultimi prezzi inseriti, raggruppati per giorno, con trend ↑↓ rispetto alla rilevazione precedente
- Aggiunta prezzo: scansione barcode/QR (fotocamera o da foto), foto del cartellino con **lettura automatica del prezzo (OCR)**, data/ora automatica, negozio con autocompletamento (i nuovi negozi vengono salvati nel foglio `Stores`), note
- Nome/marca del prodotto compilati in automatico da Open Food Facts (se il codice è noto)
- Ricerca per nome, marca, negozio o codice a barre (anche scansionandolo)
- Scheda prodotto: ultimo / min / max / media, grafico dell'andamento, confronto per negozio, storico (tocca una riga per modificarla o eliminarla)
- Tema chiaro / scuro / sistema + 6 colori d'accento
- Lingue: italiano, deutsch, english
- Installabile come app (PWA)

## Struttura su Google Drive

Al primo accesso l'app crea tutto dentro un'unica cartella:

```
PriceTracker/
├── Price Tracker Data   (Google Sheet con i dati)
└── Photos/              (foto dei prodotti / cartellini)
```

I file sono riconosciuti tramite una proprietà interna (non dal nome): puoi rinominarli o spostare la cartella senza problemi.
Da **Impostazioni → Google Drive** ci sono i link diretti a cartella, foglio e foto.

Lo spreadsheet ha due fogli:

| Foglio   | Colonne |
|----------|---------|
| `Prices` | ID, Date (ISO), Barcode, Product, Brand, Price, Currency, Store, Notes, Photo ID, Thumbnail |
| `Stores` | Name, Created |

Le foto originali (ridimensionate a 1600 px) vanno in **PriceTracker/Photos**; nel foglio resta una miniatura piccola per la lista.
Puoi modificare il foglio a mano: l'app lo rilegge a ogni sincronizzazione. Non rinominare i fogli né riordinare le colonne.

## Configurazione Google

Già fatta: progetto Google Cloud **`price-tracker-513915`**, app OAuth in modalità *Testing*
(solo gli utenti di test elencati in *Google Auth Platform → Audience* possono accedere), origini
`https://lecce.dev` e `http://localhost:8080`. Il Client ID è in [`js/config.js`](js/config.js).

Per aggiungere altre persone: *Google Auth Platform → Audience → Test users → Add users*.

Per rifarla da zero su un altro progetto:

1. Vai su <https://console.cloud.google.com/> e crea un progetto (es. "Price Tracker").
2. **API e servizi → Libreria**: abilita **Google Sheets API** e **Google Drive API**.
3. **API e servizi → Schermata consenso OAuth** (Google Auth Platform):
   - tipo utente **Esterno**, nome app, email di supporto;
   - in **Accesso ai dati / Ambiti** aggiungi `.../auth/drive.file` (oltre a `openid`, `email`, `profile`);
   - in **Pubblico / Utenti di test** aggiungi il tuo indirizzo Gmail (finché l'app è "In test" possono accedere solo gli utenti elencati).
4. **API e servizi → Credenziali → Crea credenziali → ID client OAuth** → tipo **Applicazione web**.
   In **Origini JavaScript autorizzate** aggiungi:
   - `http://localhost:8080` (sviluppo)
   - l'URL dove pubblichi l'app, es. `https://tuonome.github.io`
5. Copia il Client ID in [`js/config.js`](js/config.js):

   ```js
   GOOGLE_CLIENT_ID: '1234567890-xxxx.apps.googleusercontent.com',
   ```

## Avvio in locale

```bash
node dev-server.js
```

Poi apri <http://localhost:8080>. (Aprire `index.html` con doppio clic non funziona: Google richiede un'origine http(s).)

## Pubblicazione

Versione online: **<https://lecce.dev/price-tracker/>** (GitHub Pages, branch `main`, cartella root).
È tutto statico: basta qualunque hosting **HTTPS** (la fotocamera richiede HTTPS), ad esempio GitHub Pages, Netlify o Cloudflare Pages.
Ricordati di aggiungere l'URL finale alle *Origini JavaScript autorizzate* del Client ID.

## Note tecniche

- Il token Google dura circa 1 ora; quando scade compare il banner **Riconnetti** (un tocco, nessuna password se sei già loggato in Google).
- Librerie esterne caricate solo quando servono: [html5-qrcode](https://github.com/mebjas/html5-qrcode) per lo scanner (usa il `BarcodeDetector` nativo dove c'è), [Tesseract.js](https://tesseract.projectnaptha.com/) per l'OCR (la prima lettura scarica qualche MB, poi resta in cache).
- I dati sono anche in cache nel browser, così la home si apre subito e poi si aggiorna dal foglio.

## File

```
index.html            entry point
css/styles.css        stile (tema chiaro/scuro, mobile-first)
js/config.js          ← Client ID Google
js/app.js             UI, routing, viste
js/auth.js            login Google (Identity Services)
js/backend-google.js  lettura/scrittura Sheets + foto su Drive
js/media.js           scanner, OCR, immagini, Open Food Facts
js/i18n.js            traduzioni IT / DE / EN
sw.js                 service worker (PWA)
dev-server.js         server statico per lo sviluppo
```
