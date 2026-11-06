// ─────────────────────────────────────────────────────────────
//  Configurazione — vedi README.md per come ottenere il Client ID
// ─────────────────────────────────────────────────────────────
export const CONFIG = {
  // OAuth 2.0 Client ID (tipo "Applicazione web") da Google Cloud Console.
  // È un identificativo pubblico: può stare nel repository.
  GOOGLE_CLIENT_ID: '197366066739-3tj8te00j13q23c340ohnu7iahg68ko6.apps.googleusercontent.com',

  // Tutto finisce in un'unica cartella nel tuo Drive:
  //   Price Tracker/
  //   ├── Price Tracker   (Google Sheet con i dati)
  //   ├── Price Tracker Data (Google Sheet con i dati)
  //   └── Photos/            (foto dei prodotti/cartellini)
  FOLDER_NAME: 'PriceTracker',
  SPREADSHEET_NAME: 'Price Tracker Data',
  PHOTOS_FOLDER_NAME: 'Photos',

  VERSION: '1.1.0',
};
