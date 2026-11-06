export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

export const uid = () =>
  Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

export const normalize = (s) =>
  String(s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/** Accepts "1,29", "1.29", "€ 1,29", "1.234,50", "1,234.50" */
export function parsePrice(input) {
  let s = String(input ?? '').replace(/[^\d.,-]/g, '');
  if (!s) return null;
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma > -1 && lastDot > -1) {
    // the last separator is the decimal one
    if (lastComma > lastDot) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
  } else if (lastComma > -1) {
    s = s.replace(',', '.');
  }
  const n = parseFloat(s);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

export function debounce(fn, ms = 200) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

/** localStorage wrapper that never throws */
export const ls = {
  get(key, fallback = null) {
    try {
      const v = localStorage.getItem(key);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  },
  del(key) {
    try {
      localStorage.removeItem(key);
    } catch {}
  },
};

const scriptCache = new Map();
export function loadScript(src) {
  if (!scriptCache.has(src)) {
    scriptCache.set(
      src,
      new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = src;
        s.async = true;
        s.onload = resolve;
        s.onerror = () => {
          scriptCache.delete(src);
          reject(new Error('Impossibile caricare ' + src));
        };
        document.head.appendChild(s);
      })
    );
  }
  return scriptCache.get(src);
}

export function hashHue(str) {
  let h = 0;
  for (const c of String(str)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % 360;
}

export const pad2 = (n) => String(n).padStart(2, '0');

/** Date -> value for <input type="datetime-local"> (local time) */
export function toLocalInput(d) {
  const x = new Date(d);
  if (isNaN(x)) return '';
  return `${x.getFullYear()}-${pad2(x.getMonth() + 1)}-${pad2(x.getDate())}T${pad2(x.getHours())}:${pad2(x.getMinutes())}`;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
