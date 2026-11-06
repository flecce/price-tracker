// Storage on Google Sheets (data) + Google Drive (photos)
import { CONFIG } from './config.js';
import * as auth from './auth.js';
import { ls } from './utils.js';

const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';
const DRIVE = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';

export const COLS = ['id', 'date', 'barcode', 'product', 'brand', 'price', 'currency', 'store', 'notes', 'photoId', 'thumb'];
const HEADERS = ['ID', 'Date', 'Barcode', 'Product', 'Brand', 'Price', 'Currency', 'Store', 'Notes', 'Photo ID', 'Thumbnail'];
const LAST = 'K';
const T_PRICES = 'Prices';
const T_STORES = 'Stores';
const APP_PROP = 'priceTracker';

async function api(url, opts = {}, retry = true) {
  const tk = await auth.getToken();
  const headers = { Authorization: `Bearer ${tk}`, ...(opts.headers || {}) };
  if (typeof opts.body === 'string' && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  const res = await fetch(url, { ...opts, headers });
  if (res.status === 401 && retry) {
    auth.invalidate();
    return api(url, opts, false);
  }
  if (!res.ok) {
    let msg = res.statusText;
    try {
      msg = (await res.json()).error?.message || msg;
    } catch {}
    throw Object.assign(new Error(msg), { status: res.status });
  }
  if (opts.as === 'blob') return res.blob();
  const txt = await res.text();
  return txt ? JSON.parse(txt) : null;
}

const enc = encodeURIComponent;
const toRow = (e) => COLS.map((c) => (c === 'price' ? Number(e.price) : e[c] ?? ''));
function fromRow(row) {
  const o = {};
  COLS.forEach((c, i) => (o[c] = row[i] ?? ''));
  o.id = String(o.id);
  o.barcode = String(o.barcode);
  o.price = Number(o.price);
  return o;
}

export class GoogleBackend {
  constructor(user) {
    this.kind = 'google';
    this.user = user;
    this.id = null;
    this.sheetIds = {};
    this.photoUrls = new Map();
    this.ready = this._init();
    this.ready.catch(() => {}); // surfaced by callers
  }

  get spreadsheetUrl() {
    return this.id ? `https://docs.google.com/spreadsheets/d/${this.id}/edit` : null;
  }
  get folderUrl() {
    return this.rootId ? `https://drive.google.com/drive/folders/${this.rootId}` : null;
  }
  get photosUrl() {
    return this._folder ? `https://drive.google.com/drive/folders/${this._folder}` : null;
  }

  /**
   * Drive layout (everything inside one folder):
   *   Price Tracker/            ← appProperties.priceTracker = 'root'
   *   ├── Price Tracker (Sheet) ← 'data'
   *   └── Foto/                 ← 'photos'
   * Files are found by appProperties, so renaming them in Drive is fine.
   */
  async _init() {
    this.rootId = await this._ensureFolder('root', CONFIG.FOLDER_NAME, null);
    const key = 'pt.sheetId.' + this.user.email;
    let id = ls.get(key);
    if (id) {
      try {
        await this._loadMeta(id);
      } catch (e) {
        if (e.code === 'auth') throw e;
        id = null;
      }
    }
    if (!id) {
      const f = await this._findByTag('data');
      if (f) {
        id = f.id;
        await this._loadMeta(id);
      } else {
        id = await this._create();
      }
    }
    ls.set(key, id);
    await this._moveInto(id, this.rootId);
    this._folder = await this._ensureFolder('photos', CONFIG.PHOTOS_FOLDER_NAME, this.rootId);
  }

  async _findByTag(tag, extra = '') {
    const q = enc(`appProperties has { key='${APP_PROP}' and value='${tag}' } and trashed=false${extra}`);
    const r = await api(`${DRIVE}/files?q=${q}&fields=files(id,parents)&orderBy=createdTime`);
    return r.files?.[0] || null;
  }

  /** Make sure `fileId` lives inside `folderId` (moves it if needed). */
  async _moveInto(fileId, folderId, parents) {
    if (!parents) parents = (await api(`${DRIVE}/files/${fileId}?fields=parents`)).parents || [];
    if (parents.includes(folderId)) return;
    await api(
      `${DRIVE}/files/${fileId}?addParents=${folderId}${parents.length ? `&removeParents=${parents.join(',')}` : ''}&fields=id`,
      { method: 'PATCH', body: '{}' }
    );
  }

  async _ensureFolder(tag, name, parentId) {
    const found = await this._findByTag(tag, ` and mimeType='application/vnd.google-apps.folder'`);
    if (found) {
      if (parentId) await this._moveInto(found.id, parentId, found.parents || []);
      return found.id;
    }
    const f = await api(`${DRIVE}/files?fields=id`, {
      method: 'POST',
      body: JSON.stringify({
        name,
        mimeType: 'application/vnd.google-apps.folder',
        appProperties: { [APP_PROP]: tag },
        ...(parentId ? { parents: [parentId] } : {}),
      }),
    });
    return f.id;
  }

  async _loadMeta(id) {
    const r = await api(`${SHEETS}/${id}?fields=sheets.properties(sheetId,title)`);
    this.id = id;
    this.sheetIds = {};
    r.sheets.forEach((s) => (this.sheetIds[s.properties.title] = s.properties.sheetId));
    // re-create missing tabs (e.g. user deleted one)
    const missing = [T_PRICES, T_STORES].filter((t) => !(t in this.sheetIds));
    if (missing.length) {
      const res = await api(`${SHEETS}/${id}:batchUpdate`, {
        method: 'POST',
        body: JSON.stringify({
          requests: missing.map((title) => ({ addSheet: { properties: { title, gridProperties: { frozenRowCount: 1 } } } })),
        }),
      });
      res.replies.forEach((rep) => (this.sheetIds[rep.addSheet.properties.title] = rep.addSheet.properties.sheetId));
      await this._writeHeaders(missing);
    }
  }

  async _writeHeaders(tabs = [T_PRICES, T_STORES]) {
    const data = [];
    if (tabs.includes(T_PRICES)) data.push({ range: `${T_PRICES}!A1:${LAST}1`, values: [HEADERS] });
    if (tabs.includes(T_STORES)) data.push({ range: `${T_STORES}!A1:B1`, values: [['Name', 'Created']] });
    await api(`${SHEETS}/${this.id}/values:batchUpdate`, {
      method: 'POST',
      body: JSON.stringify({ valueInputOption: 'RAW', data }),
    });
    await api(`${SHEETS}/${this.id}:batchUpdate`, {
      method: 'POST',
      body: JSON.stringify({
        requests: tabs.map((t) => ({
          repeatCell: {
            range: { sheetId: this.sheetIds[t], startRowIndex: 0, endRowIndex: 1 },
            cell: { userEnteredFormat: { textFormat: { bold: true } } },
            fields: 'userEnteredFormat.textFormat.bold',
          },
        })),
      }),
    });
  }

  async _create() {
    const r = await api(SHEETS, {
      method: 'POST',
      body: JSON.stringify({
        properties: { title: CONFIG.SPREADSHEET_NAME },
        sheets: [T_PRICES, T_STORES].map((title) => ({ properties: { title, gridProperties: { frozenRowCount: 1 } } })),
      }),
    });
    this.id = r.spreadsheetId;
    r.sheets.forEach((s) => (this.sheetIds[s.properties.title] = s.properties.sheetId));
    await this._writeHeaders();
    await api(`${DRIVE}/files/${this.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ appProperties: { [APP_PROP]: 'data' } }),
    });
    return this.id;
  }

  // ── Prices ───────────────────────────────────────────
  async listEntries() {
    await this.ready;
    const r = await api(`${SHEETS}/${this.id}/values/${enc(`${T_PRICES}!A2:${LAST}`)}?valueRenderOption=UNFORMATTED_VALUE`);
    return (r.values || []).filter((row) => row[0]).map(fromRow);
  }

  async addEntry(e) {
    await this.ready;
    await api(
      `${SHEETS}/${this.id}/values/${enc(`${T_PRICES}!A:${LAST}`)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
      { method: 'POST', body: JSON.stringify({ values: [toRow(e)] }) }
    );
  }

  async _rowOf(id) {
    const r = await api(`${SHEETS}/${this.id}/values/${enc(`${T_PRICES}!A:A`)}`);
    const idx = (r.values || []).findIndex((row) => String(row[0]) === String(id));
    if (idx < 1) throw new Error('Record non trovato nel foglio');
    return idx + 1; // 1-based row number
  }

  async updateEntry(e) {
    await this.ready;
    const row = await this._rowOf(e.id);
    await api(
      `${SHEETS}/${this.id}/values/${enc(`${T_PRICES}!A${row}:${LAST}${row}`)}?valueInputOption=RAW`,
      { method: 'PUT', body: JSON.stringify({ values: [toRow(e)] }) }
    );
  }

  async deleteEntry(id) {
    await this.ready;
    const row = await this._rowOf(id);
    await api(`${SHEETS}/${this.id}:batchUpdate`, {
      method: 'POST',
      body: JSON.stringify({
        requests: [
          { deleteDimension: { range: { sheetId: this.sheetIds[T_PRICES], dimension: 'ROWS', startIndex: row - 1, endIndex: row } } },
        ],
      }),
    });
  }

  // ── Stores ───────────────────────────────────────────
  async listStores() {
    await this.ready;
    const r = await api(`${SHEETS}/${this.id}/values/${enc(`${T_STORES}!A2:A`)}`);
    return (r.values || []).map((row) => String(row[0] || '').trim()).filter(Boolean);
  }

  async addStore(name) {
    await this.ready;
    await api(
      `${SHEETS}/${this.id}/values/${enc(`${T_STORES}!A:B`)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
      { method: 'POST', body: JSON.stringify({ values: [[name, new Date().toISOString()]] }) }
    );
  }

  // ── Photos (Drive) ───────────────────────────────────
  async _folderId() {
    if (!this._folder) this._folder = await this._ensureFolder('photos', CONFIG.PHOTOS_FOLDER_NAME, this.rootId);
    return this._folder;
  }

  async uploadPhoto(blob, name) {
    await this.ready;
    const folder = await this._folderId();
    const boundary = 'pt' + Math.random().toString(36).slice(2);
    const meta = { name, parents: [folder], mimeType: blob.type || 'image/jpeg' };
    const body = new Blob([
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n`,
      `--${boundary}\r\nContent-Type: ${meta.mimeType}\r\n\r\n`,
      blob,
      `\r\n--${boundary}--`,
    ]);
    const r = await api(`${UPLOAD}/files?uploadType=multipart&fields=id`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body,
    });
    this.photoUrls.set(r.id, URL.createObjectURL(blob));
    return r.id;
  }

  async getPhotoUrl(id) {
    if (!id) return null;
    if (!this.photoUrls.has(id)) {
      const blob = await api(`${DRIVE}/files/${id}?alt=media`, { as: 'blob' });
      this.photoUrls.set(id, URL.createObjectURL(blob));
    }
    return this.photoUrls.get(id);
  }

  async deletePhoto(id) {
    if (!id) return;
    await api(`${DRIVE}/files/${id}`, { method: 'PATCH', body: JSON.stringify({ trashed: true }) });
    this.photoUrls.delete(id);
  }
}
