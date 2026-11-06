// Local-only backend (localStorage) used for the demo mode — same interface as GoogleBackend
import { ls, uid } from './utils.js';

const K_ENTRIES = 'pt.demo.entries';
const K_STORES = 'pt.demo.stores';
const K_PHOTOS = 'pt.demo.photos';

function seed() {
  const now = Date.now();
  const day = 864e5;
  const rows = [
    ['8076800195057', 'Spaghetti n.5 500 g', 'Barilla', 1.29, 'Coop', 0.1],
    ['8076800195057', 'Spaghetti n.5 500 g', 'Barilla', 1.19, 'Lidl', 3],
    ['8076800195057', 'Spaghetti n.5 500 g', 'Barilla', 1.35, 'Esselunga', 12],
    ['8000500310427', 'Nutella 450 g', 'Ferrero', 4.49, 'Esselunga', 0.2],
    ['8000500310427', 'Nutella 450 g', 'Ferrero', 4.19, 'Coop', 9],
    ['', 'Latte intero 1 L', 'Granarolo', 1.65, 'Coop', 1],
    ['', 'Latte intero 1 L', 'Granarolo', 1.59, 'Coop', 15],
    ['', 'Benzina (litro)', '', 1.799, 'Q8', 2],
    ['', 'Benzina (litro)', '', 1.839, 'Q8', 16],
    ['', 'Caffè espresso al bar', '', 1.3, 'Bar Centrale', 4],
  ];
  const entries = rows.map(([barcode, product, brand, price, store, ago]) => ({
    id: uid(),
    date: new Date(now - ago * day).toISOString(),
    barcode,
    product,
    brand,
    price,
    currency: 'EUR',
    store,
    notes: '',
    photoId: '',
    thumb: '',
  }));
  ls.set(K_ENTRIES, entries);
  ls.set(K_STORES, ['Coop', 'Esselunga', 'Lidl', 'Q8', 'Bar Centrale']);
}

export class DemoBackend {
  constructor() {
    this.kind = 'demo';
    this.spreadsheetUrl = null;
    if (!ls.get(K_ENTRIES)) seed();
    this.ready = Promise.resolve();
  }
  async listEntries() {
    return ls.get(K_ENTRIES, []);
  }
  async addEntry(e) {
    const all = ls.get(K_ENTRIES, []);
    all.push(e);
    this._save(all);
  }
  async updateEntry(e) {
    this._save(ls.get(K_ENTRIES, []).map((x) => (x.id === e.id ? e : x)));
  }
  async deleteEntry(id) {
    this._save(ls.get(K_ENTRIES, []).filter((x) => x.id !== id));
  }
  _save(all) {
    if (!ls.set(K_ENTRIES, all)) throw new Error('Spazio locale esaurito (demo)');
  }
  async listStores() {
    return ls.get(K_STORES, []);
  }
  async addStore(name) {
    ls.set(K_STORES, [...ls.get(K_STORES, []), name]);
  }
  async uploadPhoto(blob) {
    const dataUrl = await new Promise((res) => {
      const r = new FileReader();
      r.onload = () => res(r.result);
      r.readAsDataURL(blob);
    });
    const id = 'demo-' + uid();
    const photos = ls.get(K_PHOTOS, {});
    photos[id] = dataUrl;
    if (!ls.set(K_PHOTOS, photos)) throw new Error('Spazio locale esaurito (demo)');
    return id;
  }
  async getPhotoUrl(id) {
    return ls.get(K_PHOTOS, {})[id] || null;
  }
  async deletePhoto(id) {
    const photos = ls.get(K_PHOTOS, {});
    delete photos[id];
    ls.set(K_PHOTOS, photos);
  }
  static reset() {
    [K_ENTRIES, K_STORES, K_PHOTOS].forEach(ls.del);
  }
}
