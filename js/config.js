// ─────────────────────────────────────────────────────────────
//  Configurazione — vedi README.md
// ─────────────────────────────────────────────────────────────
export const CONFIG = {
  // OAuth 2.0 Client ID (tipo "Applicazione web") — progetto Google Cloud "price-tracker-513915".
  // È un identificativo pubblico: può stare nel repository.
  GOOGLE_CLIENT_ID: '197366066739-3tj8te00j13q23c340ohnu7iahg68ko6.apps.googleusercontent.com',

  // Tutto finisce in un'unica cartella nel tuo Drive:
  //   PriceTracker/
  //   ├── Data/
  //   │   └── Price Tracker   (Google Sheet con i dati)
  //   └── Photos/             (foto dei prodotti/cartellini)
  FOLDER_NAME: 'PriceTracker',
  DATA_FOLDER_NAME: 'Data',
  PHOTOS_FOLDER_NAME: 'Photos',
  SPREADSHEET_NAME: 'Price Tracker',

  VERSION: '1.3.0',
  // Replaced with the commit hash by scripts/build.js at every release
  BUILD: 'dev',
};
