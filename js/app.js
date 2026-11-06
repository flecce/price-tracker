import { CONFIG } from './config.js';
import { t, setLang, getLang, detectLang, LANGS } from './i18n.js';
import * as auth from './auth.js';
import { GoogleBackend } from './backend-google.js';
import { scanBarcode, readPrices, resizeImage, thumbDataUrl, lookupBarcode } from './media.js';
import { icon, LOGO, GOOGLE_G } from './icons.js';
import { $, $$, esc, uid, normalize, parsePrice, debounce, ls, hashHue, toLocalInput } from './utils.js';

// ─────────────────────────────────────────────────────────
//  Preferences & state
// ─────────────────────────────────────────────────────────
const LOCALES = { it: 'it-IT', de: 'de-DE', en: 'en-GB' };
const ACCENTS = {
  teal: '#0d9488',
  green: '#16a34a',
  blue: '#2563eb',
  violet: '#7c3aed',
  orange: '#ea580c',
  pink: '#db2777',
};
const CURRENCIES = ['EUR', 'CHF', 'USD', 'GBP'];

const prefs = Object.assign(
  { theme: 'system', accent: 'teal', lang: null, currency: 'EUR', lastStore: '', autoOcr: true },
  ls.get('pt.prefs') || {}
);
const savePrefs = () => ls.set('pt.prefs', prefs);

const state = {
  user: null,
  backend: null,
  entries: [],
  stores: [],
  products: new Map(),
  syncing: false,
  lastSync: 0,
  homeLimit: 60,
  searchQ: '',
  view: null,
  navDepth: 0,
};

const app = $('#app');
const enc = encodeURIComponent;

// ─────────────────────────────────────────────────────────
//  Theme
// ─────────────────────────────────────────────────────────
const mq = matchMedia('(prefers-color-scheme: dark)');
function applyTheme() {
  const dark = prefs.theme === 'dark' || (prefs.theme === 'system' && mq.matches);
  const root = document.documentElement;
  root.dataset.theme = dark ? 'dark' : 'light';
  root.style.setProperty('--accent', ACCENTS[prefs.accent] || ACCENTS.teal);
  $('meta[name=theme-color]')?.setAttribute('content', dark ? '#0b0f14' : '#f4f5f7');
}
mq.addEventListener?.('change', applyTheme);

// ─────────────────────────────────────────────────────────
//  Formatting
// ─────────────────────────────────────────────────────────
const loc = () => LOCALES[getLang()] || 'en-GB';
function fmtPrice(n, cur) {
  const v = Number(n);
  const digits = Math.round(v * 100) !== Math.round(v * 1000) / 10 ? 3 : 2; // keep 1.799 € fuel prices
  try {
    return new Intl.NumberFormat(loc(), {
      style: 'currency',
      currency: cur || prefs.currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: digits,
    }).format(v);
  } catch {
    return `${v.toFixed(2)} ${cur || ''}`;
  }
}
function currencySymbol(cur = prefs.currency) {
  try {
    return new Intl.NumberFormat(loc(), { style: 'currency', currency: cur })
      .formatToParts(0)
      .find((p) => p.type === 'currency').value;
  } catch {
    return cur;
  }
}
const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
function fmtDay(date) {
  const d = new Date(date);
  const diff = Math.round((startOfDay(new Date()) - startOfDay(d)) / 864e5);
  if (diff === 0) return t('date.today');
  if (diff === 1) return t('date.yesterday');
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return new Intl.DateTimeFormat(loc(), {
    weekday: diff < 7 ? 'long' : undefined,
    day: 'numeric',
    month: 'long',
    year: sameYear ? undefined : 'numeric',
  }).format(d);
}
const fmtTime = (date) => new Intl.DateTimeFormat(loc(), { hour: '2-digit', minute: '2-digit' }).format(new Date(date));
const fmtShort = (date) =>
  new Intl.DateTimeFormat(loc(), { day: 'numeric', month: 'short', year: '2-digit' }).format(new Date(date));

// ─────────────────────────────────────────────────────────
//  Data indexing
// ─────────────────────────────────────────────────────────
const pkey = (e) => (e.barcode ? 'b:' + e.barcode : 'n:' + normalize(e.product));

function indexData() {
  const E = state.entries;
  E.sort((a, b) => new Date(b.date) - new Date(a.date));
  const lastByKey = new Map();
  for (let i = E.length - 1; i >= 0; i--) {
    const e = E[i];
    e._key = pkey(e);
    e._prev = lastByKey.get(e._key)?.price;
    lastByKey.set(e._key, e);
  }
  const products = new Map();
  for (const e of E) {
    let p = products.get(e._key);
    if (!p) {
      p = { key: e._key, name: e.product, brand: e.brand, barcode: e.barcode, entries: [], thumb: '' };
      products.set(e._key, p);
    }
    p.entries.push(e);
    if (!p.thumb && e.thumb) p.thumb = e.thumb;
    if (!p.brand && e.brand) p.brand = e.brand;
  }
  for (const p of products.values()) {
    p.last = p.entries[0];
    p.min = p.entries.reduce((a, b) => (b.price < a.price ? b : a));
    p.max = p.entries.reduce((a, b) => (b.price > a.price ? b : a));
  }
  state.products = products;
}

/** stores ordered by how often they're used */
function storesByUse() {
  const freq = new Map();
  for (const s of state.stores) freq.set(s, 0);
  for (const e of state.entries) if (e.store) freq.set(e.store, (freq.get(e.store) || 0) + 1);
  return [...freq.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([s]) => s);
}

const cacheKey = () => 'pt.cache.' + (state.user?.email || '');
function saveCache() {
  const data = { entries: state.entries.map(({ _key, _prev, ...e }) => e), stores: state.stores };
  if (!ls.set(cacheKey(), data)) {
    data.entries = data.entries.map((e) => ({ ...e, thumb: e.thumb?.startsWith('data:') ? '' : e.thumb }));
    ls.set(cacheKey(), data);
  }
}
function loadCache() {
  const c = ls.get(cacheKey());
  if (c) {
    state.entries = c.entries || [];
    state.stores = c.stores || [];
    indexData();
  }
}

async function refreshData() {
  if (state.syncing) return;
  state.syncing = true;
  updateSyncBtn();
  try {
    const [entries, stores] = await Promise.all([state.backend.listEntries(), state.backend.listStores()]);
    state.entries = entries;
    state.stores = stores;
    indexData();
    saveCache();
    state.lastSync = Date.now();
    state.viewRefresh?.();
  } catch (e) {
    handleError(e);
  } finally {
    state.syncing = false;
    updateSyncBtn();
  }
}

// ─────────────────────────────────────────────────────────
//  UI helpers: toast, dialog, errors
// ─────────────────────────────────────────────────────────
function toast(msg, type = 'info') {
  const root = $('#toast-root');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `${icon(type === 'error' ? 'x' : type === 'success' ? 'check' : 'tag')}<span>${esc(msg)}</span>`;
  root.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 300);
  }, type === 'error' ? 5000 : 2600);
}

function confirmDialog(message, { ok = t('common.confirm'), danger = false } = {}) {
  return new Promise((resolve) => {
    const root = $('#modal-root');
    root.innerHTML = `
      <div class="modal-backdrop">
        <div class="modal" role="dialog" aria-modal="true">
          <p>${esc(message)}</p>
          <div class="modal-actions">
            <button class="btn ghost" data-r="0">${t('common.cancel')}</button>
            <button class="btn ${danger ? 'danger' : 'primary'}" data-r="1">${esc(ok)}</button>
          </div>
        </div>
      </div>`;
    const close = (v) => {
      root.innerHTML = '';
      resolve(v);
    };
    root.querySelector('.modal-backdrop').onclick = (e) => e.target === e.currentTarget && close(false);
    $$('[data-r]', root).forEach((b) => (b.onclick = () => close(b.dataset.r === '1')));
    root.querySelector('[data-r="1"]').focus();
  });
}

function handleError(e) {
  console.error(e);
  if (e?.code === 'auth') {
    if (e.type === 'scope') toast(t('err.scope'), 'error');
    else if (e.type !== 'popup_closed') showReconnect();
    return;
  }
  toast(`${t('err.generic')}: ${e?.message || e}`, 'error');
}

function showReconnect() {
  const b = $('#banner');
  if (!b) return renderLogin({ message: t('login.expired') });
  b.innerHTML = `<div class="banner">${icon('refresh')}<span>${t('err.sessionExpired')}</span><button class="btn sm primary" id="reconnect">${t('err.reconnect')}</button></div>`;
  $('#reconnect').onclick = async () => {
    try {
      await auth.requestToken();
      b.innerHTML = '';
      refreshData();
    } catch (e) {
      handleError(e);
    }
  };
}

const thumbHtml = (src, name, size = '') =>
  src
    ? `<div class="thumb ${size}"><img src="${esc(src)}" alt="" loading="lazy" referrerpolicy="no-referrer"></div>`
    : `<div class="thumb ${size} letter" style="--h:${hashHue(normalize(name))}">${esc((name || '?').trim().charAt(0).toUpperCase())}</div>`;

function avatarHtml(user, cls = '') {
  if (user?.picture) return `<img class="avatar ${cls}" src="${esc(user.picture)}" alt="" referrerpolicy="no-referrer">`;
  return `<span class="avatar ${cls} letter">${esc((user?.name || '?').charAt(0).toUpperCase())}</span>`;
}

function trendBadge(e) {
  if (e._prev == null || !isFinite(e._prev)) return '';
  const diff = e.price - e._prev;
  if (Math.abs(diff) < 0.005) return `<span class="trend same">${icon('equal')}</span>`;
  const pct = e._prev ? Math.round((diff / e._prev) * 100) : 0;
  const up = diff > 0;
  return `<span class="trend ${up ? 'up' : 'down'}">${icon(up ? 'up' : 'down')}${Math.abs(pct)}%</span>`;
}

function entryRow(e, mode = 'product') {
  const toProduct = mode === 'product';
  const href = toProduct ? '#product/' + enc(e._key) : '#edit/' + enc(e.id);
  const title = toProduct ? e.product : e.store || t('common.noStore');
  const sub = toProduct
    ? `${e.store ? `${icon('store', 'xs')}<span>${esc(e.store)}</span><span class="dot">·</span>` : ''}<span>${fmtTime(e.date)}</span>`
    : `${icon('calendar', 'xs')}<span>${fmtShort(e.date)}</span>${e.notes ? `<span class="dot">·</span><span class="ellipsis">${esc(e.notes)}</span>` : ''}${e.photoId ? icon('camera', 'xs') : ''}`;
  return `<a class="entry" href="${href}">
    ${toProduct ? thumbHtml(e.thumb, e.product) : `<div class="thumb letter store-ic" style="--h:${hashHue(normalize(e.store))}">${icon('store')}</div>`}
    <div class="entry-main"><div class="entry-title">${esc(title)}</div><div class="entry-sub">${sub}</div></div>
    <div class="entry-price"><div class="price">${fmtPrice(e.price, e.currency)}</div>${trendBadge(e)}</div>
  </a>`;
}

// ─────────────────────────────────────────────────────────
//  Login
// ─────────────────────────────────────────────────────────
function langSwitch() {
  return `<div class="lang-switch">${LANGS.map(
    (l) => `<button class="${l === getLang() ? 'active' : ''}" data-lang="${l}">${l.toUpperCase()}</button>`
  ).join('')}</div>`;
}

function renderLogin(opts = {}) {
  state.view = 'login';
  const notConfigured = !CONFIG.GOOGLE_CLIENT_ID;
  app.innerHTML = `
    <div class="login">
      <div class="login-card">
        <div class="login-logo">${LOGO}</div>
        <h1>Price Tracker</h1>
        <p class="muted">${t('login.tagline')}</p>
        <ul class="login-features">
          <li>${icon('scan')}<span>${t('login.f1')}</span></li>
          <li>${icon('trend')}<span>${t('login.f2')}</span></li>
          <li>${icon('sheet')}<span>${t('login.f3')}</span></li>
        </ul>
        ${opts.message ? `<div class="notice">${esc(opts.message)}</div>` : ''}
        ${opts.error ? `<div class="notice error">${esc(opts.error)}</div>` : ''}
        ${
          notConfigured
            ? `<div class="notice">${t('login.notConfigured')}</div>`
            : `<button class="btn google block lg" id="login-btn">${GOOGLE_G}<span>${t('login.google')}</span></button>`
        }
        ${langSwitch()}
      </div>
    </div>`;
  $('#login-btn')?.addEventListener('click', async (ev) => {
    const btn = ev.currentTarget;
    btn.disabled = true;
    try {
      await auth.requestToken();
      await startGoogle();
    } catch (e) {
      btn.disabled = false;
      if (e?.type === 'popup_closed') return;
      renderLogin({ error: e?.type === 'scope' ? t('err.scope') : `${t('err.login')}: ${e?.message || e}` });
    }
  });
  $$('[data-lang]').forEach(
    (b) =>
      (b.onclick = () => {
        prefs.lang = b.dataset.lang;
        savePrefs();
        setLang(prefs.lang);
        renderLogin(opts);
      })
  );
}

// ─────────────────────────────────────────────────────────
//  Session start
// ─────────────────────────────────────────────────────────
async function startGoogle() {
  state.user = auth.cachedUser() || (await auth.fetchUser());
  if (!state.user?.email) state.user = await auth.fetchUser();
  state.backend = new GoogleBackend(state.user);
  enterApp();
  auth.fetchUser().then((u) => (state.user = u)).catch(() => {});
  try {
    await state.backend.ready;
  } catch (e) {
    return handleError(e);
  }
  refreshData();
}

function enterApp() {
  loadCache();
  renderShell();
  route();
}

// ─────────────────────────────────────────────────────────
//  Shell & routing
// ─────────────────────────────────────────────────────────
function renderShell() {
  app.innerHTML = `
    <div class="shell">
      <header class="topbar" id="topbar"></header>
      <div id="banner"></div>
      <main id="view" class="view"></main>
      <nav class="bottombar" aria-label="Main">
        <div class="bottombar-inner">
          <a href="#search" class="nav-btn" data-nav="search">${icon('search')}<span>${t('nav.search')}</span></a>
          <a href="#add" class="nav-fab" data-nav="add" aria-label="${t('nav.add')}">${icon('plus')}</a>
          <a href="#settings" class="nav-btn" data-nav="settings">${icon('settings')}<span>${t('nav.settings')}</span></a>
        </div>
      </nav>
    </div>`;
  $$('[data-nav]').forEach((a) =>
    a.addEventListener('click', (ev) => {
      // tapping the active tab brings you back home
      if (state.view === a.dataset.nav) {
        ev.preventDefault();
        goHome();
      }
    })
  );
}

function goHome() {
  if (location.hash && location.hash !== '#') location.hash = '';
  else route();
}
function goBack() {
  if (state.navDepth > 0) history.back();
  else goHome();
}
/** After edit/delete: pop back to the page we came from (the product), or replace if opened directly */
function returnTo(hash) {
  if (state.navDepth > 0) history.back();
  else {
    replacing = true;
    location.replace(hash);
  }
}

function setTopbar({ title = '', back = false, actions = '' } = {}) {
  const el = $('#topbar');
  el.innerHTML = back
    ? `<button class="icon-btn" id="back-btn" aria-label="${t('common.back')}">${icon('chevronLeft')}</button>
       <h1 class="topbar-title">${esc(title)}</h1>
       <div class="topbar-actions">${actions}</div>`
    : `<a class="brand" href="#">${LOGO}<span>Price Tracker</span></a>
       <div class="topbar-actions">${actions}</div>`;
  $('#back-btn')?.addEventListener('click', goBack);
  bindSyncBtn();
}

const syncBtn = () =>
  `<button class="icon-btn" id="sync-btn" aria-label="${t('set.sync')}">${icon('refresh', state.syncing ? 'spin' : '')}</button>`;
function bindSyncBtn() {
  $('#sync-btn')?.addEventListener('click', refreshData);
}
function updateSyncBtn() {
  $('#sync-btn .ic')?.classList.toggle('spin', state.syncing);
}

function route() {
  if (!$('#view')) return;
  const h = decodeURIComponent(location.hash.slice(1));
  const [name, ...rest] = h.split('/');
  const arg = rest.join('/');
  state.viewRefresh = null;
  $('#modal-root').innerHTML = '';
  switch (name) {
    case 'search':
      renderSearch();
      break;
    case 'add':
      renderForm('add', arg);
      break;
    case 'edit':
      renderForm('edit', arg);
      break;
    case 'product':
      renderProduct(arg);
      break;
    case 'settings':
      renderSettings();
      break;
    default:
      renderHome();
  }
  $$('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === state.view));
  window.scrollTo(0, 0);
}
// Track our position in the history stack, so "back" never leaves the app
// and edit → save returns to the page we came from.
if (history.state?.i == null) history.replaceState({ i: 0 }, '');
let histIdx = history.state.i;
let replacing = false;
window.addEventListener('hashchange', () => {
  if (history.state?.i == null) history.replaceState({ i: replacing ? histIdx : histIdx + 1 }, '');
  replacing = false;
  histIdx = state.navDepth = history.state.i;
  route();
});

// ─────────────────────────────────────────────────────────
//  Home — latest prices
// ─────────────────────────────────────────────────────────
function renderHome() {
  state.view = 'home';
  state.viewRefresh = renderHome;
  setTopbar({
    actions: `${syncBtn()}<a href="#settings" class="avatar-btn" aria-label="${t('nav.settings')}">${avatarHtml(state.user)}</a>`,
  });
  const view = $('#view');
  const E = state.entries;

  if (!E.length) {
    view.innerHTML = state.syncing
      ? `<div class="skeleton-list">${'<div class="skeleton"></div>'.repeat(6)}</div>`
      : `<div class="empty">
          <div class="empty-art">${icon('cart')}</div>
          <h2>${t('home.emptyTitle')}</h2>
          <p class="muted">${t('home.emptyText')}</p>
          <a class="btn primary lg" href="#add">${icon('plus')} ${t('home.addFirst')}</a>
        </div>`;
    if (state.syncing) state.viewRefresh = renderHome;
    return;
  }

  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  const thisMonth = E.filter((e) => new Date(e.date) >= monthStart).length;
  const storeCount = new Set(E.map((e) => normalize(e.store)).filter(Boolean)).size;

  const shown = E.slice(0, state.homeLimit);
  const groups = [];
  for (const e of shown) {
    const label = fmtDay(e.date);
    if (groups.at(-1)?.label !== label) groups.push({ label, items: [] });
    groups.at(-1).items.push(e);
  }

  view.innerHTML = `
    <section class="hero">
      <div class="hero-title">${t('home.title')}</div>
      <div class="hero-stats">
        <div><b>${E.length}</b><span>${t('home.prices')}</span></div>
        <div><b>${state.products.size}</b><span>${t('home.products')}</span></div>
        <div><b>${storeCount}</b><span>${t('home.stores')}</span></div>
        <div><b>${thisMonth}</b><span>${t('home.thisMonth')}</span></div>
      </div>
    </section>
    ${groups
      .map(
        (g) => `<div class="day-label">${esc(g.label)}</div>
                <div class="card-list">${g.items.map((e) => entryRow(e)).join('')}</div>`
      )
      .join('')}
    ${E.length > shown.length ? `<button class="btn ghost block" id="more-btn">${t('home.more')}</button>` : ''}`;
  $('#more-btn')?.addEventListener('click', () => {
    state.homeLimit += 60;
    const y = scrollY;
    renderHome();
    scrollTo(0, y);
  });
}

// ─────────────────────────────────────────────────────────
//  Search
// ─────────────────────────────────────────────────────────
function renderSearch() {
  state.view = 'search';
  setTopbar({ title: t('nav.search'), back: true });
  $('#view').innerHTML = `
    <div class="search-sticky">
      <div class="search-box">
        ${icon('search')}
        <input id="q" type="search" placeholder="${t('search.placeholder')}" autocomplete="off" enterkeyhint="search">
        <button class="icon-btn solid" id="q-scan" aria-label="${t('scan.title')}">${icon('scan')}</button>
      </div>
    </div>
    <div id="results"></div>`;
  const q = $('#q');
  q.value = state.searchQ;
  q.addEventListener(
    'input',
    debounce(() => {
      state.searchQ = q.value;
      renderResults();
    }, 120)
  );
  if (matchMedia('(pointer: fine)').matches) q.focus();
  $('#q-scan').onclick = async () => {
    const code = await scanBarcode();
    if (!code) return;
    q.value = state.searchQ = code;
    const p = state.products.get('b:' + code);
    if (p) location.hash = '#product/' + enc(p.key);
    else renderResults();
  };
  state.viewRefresh = renderResults;
  renderResults();
}

function renderResults() {
  const box = $('#results');
  if (!box) return;
  const raw = state.searchQ.trim();
  const q = normalize(raw);
  let list = [...state.products.values()];
  if (q) {
    list = list.filter(
      (p) =>
        normalize(p.name).includes(q) ||
        normalize(p.brand).includes(q) ||
        (p.barcode || '').includes(raw) ||
        p.entries.some((e) => normalize(e.store).includes(q))
    );
  }
  list.sort((a, b) => new Date(b.last.date) - new Date(a.last.date));

  if (!list.length) {
    const isCode = /^\d{6,}$/.test(raw);
    box.innerHTML = `<div class="empty small">
        <div class="empty-art">${icon('search')}</div>
        <p class="muted">${q ? t('search.noResults') : t('search.empty')}</p>
        ${q ? `<a class="btn primary" href="#add/${enc(raw)}">${icon('plus')} ${isCode ? t('search.addCode') : t('search.addName')}</a>` : ''}
      </div>`;
    return;
  }
  box.innerHTML = `
    <div class="day-label">${t(q ? 'search.found' : 'search.all', { n: list.length })}</div>
    <div class="card-list">${list
      .map(
        (p) => `<a class="entry" href="#product/${enc(p.key)}">
          ${thumbHtml(p.thumb, p.name)}
          <div class="entry-main">
            <div class="entry-title">${esc(p.name)}</div>
            <div class="entry-sub">${[p.brand && esc(p.brand), p.barcode && `<span class="mono">${esc(p.barcode)}</span>`, t('search.count', { n: p.entries.length })]
              .filter(Boolean)
              .join('<span class="dot">·</span>')}</div>
          </div>
          <div class="entry-price">
            <div class="price">${fmtPrice(p.last.price, p.last.currency)}</div>
            ${p.entries.length > 1 ? `<div class="min-label">${t('stat.min')} ${fmtPrice(p.min.price, p.min.currency)}</div>` : ''}
          </div>
        </a>`
      )
      .join('')}</div>`;
}

// ─────────────────────────────────────────────────────────
//  Product detail
// ─────────────────────────────────────────────────────────
function chartSvg(entries, W) {
  const pts = [...entries].sort((a, b) => new Date(a.date) - new Date(b.date));
  const H = 190, pl = 52, pr = 14, pt = 14, pb = 26;
  const ts = pts.map((e) => +new Date(e.date));
  const t0 = Math.min(...ts), t1 = Math.max(...ts);
  const ps = pts.map((e) => e.price);
  let lo = Math.min(...ps), hi = Math.max(...ps);
  if (hi === lo) { hi += Math.max(0.1, hi * 0.1); lo = Math.max(0, lo - Math.max(0.1, lo * 0.1)); }
  const pad = (hi - lo) * 0.12;
  lo = Math.max(0, lo - pad);
  hi += pad;
  const x = (i) => (t1 === t0 ? pl + ((W - pl - pr) * i) / Math.max(1, pts.length - 1) : pl + ((W - pl - pr) * (ts[i] - t0)) / (t1 - t0));
  const y = (v) => pt + (H - pt - pb) * (1 - (v - lo) / (hi - lo));
  const c = pts.map((e, i) => [x(i), y(e.price)]);
  const line = 'M' + c.map(([a, b]) => `${a.toFixed(1)} ${b.toFixed(1)}`).join(' L');
  const area = `${line} L${c.at(-1)[0].toFixed(1)} ${H - pb} L${c[0][0].toFixed(1)} ${H - pb} Z`;
  const ticks = [lo + (hi - lo) * 0.1, (lo + hi) / 2, hi - (hi - lo) * 0.1];
  const minP = Math.min(...ps);
  const cur = pts.at(-1).currency;
  const fmtAxis = (v) => new Intl.NumberFormat(loc(), { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v);
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${t('product.trend')}">
    <defs><linearGradient id="cg" x1="0" x2="0" y1="0" y2="1">
      <stop offset="0" class="cg-a"/><stop offset="1" class="cg-b"/>
    </linearGradient></defs>
    ${ticks
      .map(
        (v) => `<line class="grid" x1="${pl}" x2="${W - pr}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/>
                <text class="axis" x="${pl - 8}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end">${fmtAxis(v)}</text>`
      )
      .join('')}
    <path d="${area}" fill="url(#cg)"/>
    <path d="${line}" class="line"/>
    ${c
      .map(
        ([a, b], i) =>
          `<circle cx="${a.toFixed(1)}" cy="${b.toFixed(1)}" r="4.5" class="pt ${pts[i].price === minP ? 'min' : ''}"><title>${esc(
            `${fmtShort(pts[i].date)} · ${pts[i].store || ''} · ${fmtPrice(pts[i].price, cur)}`
          )}</title></circle>`
      )
      .join('')}
    <text class="axis" x="${pl}" y="${H - 6}">${fmtShort(pts[0].date)}</text>
    <text class="axis" x="${W - pr}" y="${H - 6}" text-anchor="end">${fmtShort(pts.at(-1).date)}</text>
  </svg>`;
}

function renderProduct(key) {
  state.view = 'product';
  state.viewRefresh = () => renderProduct(key);
  const p = state.products.get(key);
  if (!p) {
    setTopbar({ title: t('product.title'), back: true });
    $('#view').innerHTML = `<div class="empty small"><p class="muted">${t('product.notFound')}</p></div>`;
    return;
  }
  setTopbar({
    title: p.name,
    back: true,
    actions: `<a class="icon-btn" href="#add/${enc(key)}" aria-label="${t('product.addPrice')}">${icon('plus')}</a>`,
  });
  const cur = p.last.currency;
  const avgRaw = p.entries.reduce((s, e) => s + e.price, 0) / p.entries.length;
  // keep 3 decimals only if the product itself uses them (e.g. fuel)
  const avg = p.entries.some((e) => Math.round(e.price * 100) !== e.price * 100)
    ? Math.round(avgRaw * 1000) / 1000
    : Math.round(avgRaw * 100) / 100;

  // latest price per store
  const byStore = new Map();
  for (const e of p.entries) {
    const s = e.store || t('common.noStore');
    if (!byStore.has(s)) byStore.set(s, e);
  }
  const stores = [...byStore.entries()].sort((a, b) => a[1].price - b[1].price);
  const maxStore = Math.max(...stores.map(([, e]) => e.price));

  const stat = (label, e, sub, cls = '') => `
    <div class="stat ${cls}">
      <span class="stat-label">${label}</span>
      <b>${fmtPrice(typeof e === 'number' ? e : e.price, cur)}</b>
      <span class="stat-sub">${sub}</span>
    </div>`;

  const view = $('#view');
  view.innerHTML = `
    <section class="card product-hero">
      ${thumbHtml(p.thumb, p.name, 'lg')}
      <div class="product-info">
        <h2>${esc(p.name)}</h2>
        ${p.brand ? `<div class="muted">${esc(p.brand)}</div>` : ''}
        ${p.barcode ? `<div class="pill mono">${icon('barcode', 'xs')}${esc(p.barcode)}</div>` : ''}
      </div>
    </section>
    <div class="stats-grid">
      ${stat(t('stat.last'), p.last, `${esc(p.last.store || '—')} · ${fmtShort(p.last.date)}`, 'accent')}
      ${stat(t('stat.min'), p.min, `${esc(p.min.store || '—')} · ${fmtShort(p.min.date)}`, 'good')}
      ${stat(t('stat.max'), p.max, `${esc(p.max.store || '—')} · ${fmtShort(p.max.date)}`, 'bad')}
      ${stat(t('stat.avg'), avg, t('search.count', { n: p.entries.length }))}
    </div>
    ${p.entries.length > 1 ? `<section class="card"><h3>${t('product.trend')}</h3><div class="chart-wrap" id="chart"></div></section>` : ''}
    ${
      stores.length > 1
        ? `<section class="card"><h3>${t('product.byStore')}</h3>
            <div class="store-bars">${stores
              .map(
                ([s, e], i) => `<div class="store-bar ${i === 0 ? 'best' : ''}">
                  <div class="store-bar-head"><span>${esc(s)}${i === 0 ? ` <em>${t('product.cheapest')}</em>` : ''}</span><b>${fmtPrice(e.price, e.currency)}</b></div>
                  <div class="bar"><i style="width:${Math.max(6, (e.price / maxStore) * 100).toFixed(1)}%"></i></div>
                  <small class="muted">${fmtShort(e.date)}</small>
                </div>`
              )
              .join('')}</div></section>`
        : ''
    }
    <div class="day-label">${t('product.history')}</div>
    <div class="card-list">${p.entries.map((e) => entryRow(e, 'edit')).join('')}</div>
    <a class="btn primary block lg" href="#add/${enc(key)}">${icon('plus')} ${t('product.addPrice')}</a>`;
  const chart = $('#chart');
  if (chart) chart.innerHTML = chartSvg(p.entries, Math.max(280, Math.min(720, chart.clientWidth)));
}

// ─────────────────────────────────────────────────────────
//  Add / Edit form
// ─────────────────────────────────────────────────────────
function renderForm(mode, arg) {
  state.view = mode;
  const editing = mode === 'edit' ? state.entries.find((e) => e.id === arg) : null;
  if (mode === 'edit' && !editing) {
    setTopbar({ title: t('form.editTitle'), back: true });
    $('#view').innerHTML = `<div class="empty small"><p class="muted">${t('product.notFound')}</p></div>`;
    state.viewRefresh = () => state.entries.some((e) => e.id === arg) && renderForm(mode, arg);
    return;
  }
  setTopbar({ title: editing ? t('form.editTitle') : t('form.addTitle'), back: true });

  const fs = { photoFile: null, photoRemoved: false, offImage: '', previewUrl: null };
  const cur = editing?.currency || prefs.currency;

  $('#view').innerHTML = `
    <form class="form" id="entry-form" novalidate>
      <section class="card photo-box">
        <div class="photo-preview" id="photo-preview"><div class="photo-empty">${icon('camera')}<span>${t('form.photoHint')}</span></div></div>
        <div class="photo-actions">
          <label class="chip-btn">${icon('camera')}<span>${t('form.takePhoto')}</span><input type="file" accept="image/*" capture="environment" id="photo-cam" hidden></label>
          <label class="chip-btn">${icon('image')}<span>${t('form.gallery')}</span><input type="file" accept="image/*" id="photo-gal" hidden></label>
          <button type="button" class="chip-btn accent" id="ocr-btn" hidden>${icon('sparkles')}<span>${t('form.readPrice')}</span></button>
          <button type="button" class="chip-btn danger" id="photo-remove" hidden aria-label="${t('form.removePhoto')}">${icon('trash')}</button>
        </div>
        <div id="ocr-result" class="ocr-result"></div>
      </section>

      <section class="card fields">
        <div class="field">
          <label for="f-barcode">${t('form.barcode')}</label>
          <div class="input-group">
            <input id="f-barcode" inputmode="numeric" autocomplete="off" placeholder="${t('form.barcodePh')}">
            <button type="button" class="icon-btn solid" id="scan-btn" aria-label="${t('scan.title')}">${icon('scan')}</button>
          </div>
          <div class="hint" id="barcode-hint"></div>
        </div>
        <div class="field">
          <label for="f-product">${t('form.product')} <i>*</i></label>
          <input id="f-product" list="dl-products" autocomplete="off" placeholder="${t('form.productPh')}">
        </div>
        <div class="field">
          <label for="f-brand">${t('form.brand')}</label>
          <input id="f-brand" autocomplete="off">
        </div>
        <div class="field">
          <label for="f-price">${t('form.price')} <i>*</i></label>
          <div class="price-input"><span>${esc(currencySymbol(cur))}</span><input id="f-price" inputmode="decimal" autocomplete="off" placeholder="0,00"></div>
          <div class="hint" id="price-hint"></div>
        </div>
        <div class="field">
          <label for="f-store">${t('form.store')}</label>
          <input id="f-store" list="dl-stores" autocomplete="off" placeholder="${t('form.storePh')}">
          <div class="chips" id="store-chips"></div>
        </div>
        <div class="field">
          <label for="f-date">${t('form.date')}</label>
          <input id="f-date" type="datetime-local">
        </div>
        <div class="field">
          <label for="f-notes">${t('form.notes')}</label>
          <textarea id="f-notes" rows="2" placeholder="${t('form.notesPh')}"></textarea>
        </div>
      </section>

      <div class="form-actions">
        <button class="btn primary block lg" type="submit" id="save-btn">${icon('check')}<span>${t('form.save')}</span></button>
        ${editing ? `<button type="button" class="btn danger-ghost block" id="delete-btn">${icon('trash')}<span>${t('form.delete')}</span></button>` : ''}
      </div>
    </form>
    <datalist id="dl-products"></datalist>
    <datalist id="dl-stores"></datalist>`;

  const F = {
    barcode: $('#f-barcode'),
    product: $('#f-product'),
    brand: $('#f-brand'),
    price: $('#f-price'),
    store: $('#f-store'),
    date: $('#f-date'),
    notes: $('#f-notes'),
  };
  const form = $('#entry-form');

  // ── datalists & store chips
  function fillLists() {
    const names = [...new Set([...state.products.values()].map((p) => p.name))].slice(0, 400);
    $('#dl-products').innerHTML = names.map((n) => `<option value="${esc(n)}">`).join('');
    const stores = storesByUse();
    $('#dl-stores').innerHTML = stores.map((s) => `<option value="${esc(s)}">`).join('');
    $('#store-chips').innerHTML = stores
      .slice(0, 6)
      .map((s) => `<button type="button" class="chip ${normalize(s) === normalize(F.store.value) ? 'active' : ''}" data-store="${esc(s)}">${esc(s)}</button>`)
      .join('');
  }
  $('#store-chips').addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-store]');
    if (!b) return;
    F.store.value = b.dataset.store;
    fillLists();
  });
  F.store.addEventListener('input', debounce(fillLists, 150));
  state.viewRefresh = fillLists;

  // ── initial values
  if (editing) {
    F.barcode.value = editing.barcode;
    F.product.value = editing.product;
    F.brand.value = editing.brand;
    F.price.value = new Intl.NumberFormat(loc(), { minimumFractionDigits: 2, maximumFractionDigits: 3, useGrouping: false }).format(editing.price);
    F.store.value = editing.store;
    F.date.value = toLocalInput(editing.date);
    F.notes.value = editing.notes;
  } else {
    F.date.value = toLocalInput(new Date());
    F.store.value = prefs.lastStore || '';
    if (arg) {
      if (arg.startsWith('b:')) F.barcode.value = arg.slice(2);
      else if (arg.startsWith('n:')) {
        const p = state.products.get(arg);
        if (p) {
          F.product.value = p.name;
          F.brand.value = p.brand || '';
        }
      } else if (/^\d{6,}$/.test(arg)) F.barcode.value = arg;
      else F.product.value = arg;
    }
  }
  fillLists();

  // ── photo
  const preview = $('#photo-preview');
  function showPreview(src) {
    preview.innerHTML = src
      ? `<img src="${esc(src)}" alt="" referrerpolicy="no-referrer">`
      : `<div class="photo-empty">${icon('camera')}<span>${t('form.photoHint')}</span></div>`;
    preview.classList.toggle('has-img', !!src);
  }
  function updatePhotoButtons() {
    const has = !!fs.photoFile || (!!editing?.photoId && !fs.photoRemoved);
    $('#photo-remove').hidden = !has;
    $('#ocr-btn').hidden = !fs.photoFile;
  }
  if (editing && (editing.photoId || editing.thumb)) {
    showPreview(editing.thumb);
    if (editing.photoId)
      state.backend
        .getPhotoUrl(editing.photoId)
        .then((u) => u && !fs.photoFile && !fs.photoRemoved && showPreview(u))
        .catch(() => {});
  }
  updatePhotoButtons();

  async function onPhoto(ev) {
    const file = ev.target.files[0];
    ev.target.value = '';
    if (!file) return;
    fs.photoFile = file;
    fs.photoRemoved = false;
    if (fs.previewUrl) URL.revokeObjectURL(fs.previewUrl);
    fs.previewUrl = URL.createObjectURL(file);
    showPreview(fs.previewUrl);
    updatePhotoButtons();
    if (prefs.autoOcr && !F.price.value.trim()) runOcr();
  }
  $('#photo-cam').addEventListener('change', onPhoto);
  $('#photo-gal').addEventListener('change', onPhoto);
  $('#photo-remove').onclick = () => {
    fs.photoFile = null;
    fs.photoRemoved = true;
    $('#ocr-result').innerHTML = '';
    showPreview(fs.offImage || '');
    updatePhotoButtons();
  };

  let ocrRunning = false;
  async function runOcr() {
    if (!fs.photoFile || ocrRunning) return;
    ocrRunning = true;
    const out = $('#ocr-result');
    out.innerHTML = `<div class="ocr-progress"><span class="spinner"></span><span id="ocr-pct">${t('form.ocrLoading')}</span></div>`;
    try {
      const values = await readPrices(fs.photoFile, (p) => {
        const el = $('#ocr-pct');
        if (el) el.textContent = `${t('form.ocrReading')} ${Math.round(p * 100)}%`;
      });
      if (!document.body.contains(out)) return;
      if (!values.length) {
        out.innerHTML = `<div class="hint">${t('form.ocrNone')}</div>`;
        return;
      }
      if (!F.price.value.trim()) {
        F.price.value = new Intl.NumberFormat(loc(), { minimumFractionDigits: 2, useGrouping: false }).format(values[0]);
        F.price.classList.add('flash');
        setTimeout(() => F.price.classList.remove('flash'), 900);
        updatePriceHint();
      }
      out.innerHTML = `<div class="hint">${icon('sparkles', 'xs')} ${t('form.ocrFound')}</div>
        <div class="chips">${values
          .map((v) => `<button type="button" class="chip" data-price="${v}">${fmtPrice(v, cur)}</button>`)
          .join('')}</div>`;
    } catch (e) {
      console.warn(e);
      out.innerHTML = `<div class="hint error">${t('form.ocrError')}</div>`;
    } finally {
      ocrRunning = false;
    }
  }
  $('#ocr-btn').onclick = runOcr;
  $('#ocr-result').addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-price]');
    if (!b) return;
    F.price.value = new Intl.NumberFormat(loc(), { minimumFractionDigits: 2, useGrouping: false }).format(+b.dataset.price);
    updatePriceHint();
  });

  // ── barcode
  const bHint = $('#barcode-hint');
  let lookupSeq = 0;
  async function onBarcode(fromScan = false) {
    const code = F.barcode.value.trim();
    bHint.innerHTML = '';
    if (!code) return updatePriceHint();
    const known = state.products.get('b:' + code);
    if (known) {
      if (!F.product.value.trim() || fromScan) F.product.value = known.name;
      if (!F.brand.value.trim() && known.brand) F.brand.value = known.brand;
      bHint.innerHTML = `${icon('check', 'xs')} ${t('form.known')}`;
      updatePriceHint();
      if (fromScan) F.price.focus();
      return;
    }
    updatePriceHint();
    if (!/^\d{8,14}$/.test(code)) return;
    const seq = ++lookupSeq;
    bHint.innerHTML = `<span class="spinner sm"></span> ${t('form.lookingUp')}`;
    const info = await lookupBarcode(code, getLang());
    if (seq !== lookupSeq || !document.body.contains(bHint)) return;
    if (info?.name) {
      if (!F.product.value.trim() || fromScan) F.product.value = info.name;
      if (!F.brand.value.trim() && info.brand) F.brand.value = info.brand;
      fs.offImage = info.image;
      if (info.image && !fs.photoFile && !(editing?.photoId && !fs.photoRemoved)) showPreview(info.image);
      bHint.innerHTML = `${icon('globe', 'xs')} ${t('form.foundOff')}`;
      if (fromScan) F.price.focus();
    } else {
      bHint.innerHTML = t('form.notFoundOff');
      if (fromScan) F.product.focus();
    }
  }
  F.barcode.addEventListener('change', () => onBarcode(false));
  $('#scan-btn').onclick = async () => {
    const code = await scanBarcode();
    if (code) {
      F.barcode.value = code;
      onBarcode(true);
    }
  };
  if (!editing && F.barcode.value) onBarcode(false);

  // ── last price hint
  function updatePriceHint() {
    const hint = $('#price-hint');
    if (!hint) return;
    const key = F.barcode.value.trim() ? 'b:' + F.barcode.value.trim() : 'n:' + normalize(F.product.value);
    const p = state.products.get(key);
    const others = p?.entries.filter((e) => e.id !== editing?.id) || [];
    if (!others.length) return (hint.innerHTML = '');
    const last = others[0];
    const min = others.reduce((a, b) => (b.price < a.price ? b : a));
    hint.innerHTML = `${t('form.lastPrice')}: <b>${fmtPrice(last.price, last.currency)}</b> ${last.store ? `@ ${esc(last.store)}` : ''} · ${fmtShort(last.date)}${
      others.length > 1 ? ` — ${t('stat.min')}: <b>${fmtPrice(min.price, min.currency)}</b>` : ''
    }`;
  }
  F.product.addEventListener('input', debounce(updatePriceHint, 200));
  updatePriceHint();

  // ── save
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const product = F.product.value.trim();
    const price = parsePrice(F.price.value);
    let ok = true;
    for (const [el, bad] of [
      [F.product, !product],
      [F.price, price == null || price < 0],
    ]) {
      el.closest('.field').classList.toggle('invalid', bad);
      if (bad && ok) {
        el.focus();
        ok = false;
      }
    }
    if (!ok) return toast(t('form.required'), 'error');

    const btn = $('#save-btn');
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner"></span><span>${t('form.saving')}</span>`;
    try {
      const be = state.backend;
      let photoId = editing?.photoId || '';
      let thumb = editing?.thumb || '';
      const oldPhoto = photoId;
      if (fs.photoRemoved || fs.photoFile) {
        photoId = '';
        thumb = '';
      }
      if (fs.photoFile) {
        const blob = await resizeImage(fs.photoFile, 1600, 0.82);
        thumb = await thumbDataUrl(fs.photoFile, 112);
        const slug = normalize(product).replace(/[^a-z0-9]+/g, '-').slice(0, 40);
        photoId = await be.uploadPhoto(blob, `${slug || 'photo'}-${Date.now()}.jpg`);
      }
      if (oldPhoto && oldPhoto !== photoId) be.deletePhoto(oldPhoto).catch(() => {});
      if (!thumb && fs.offImage) thumb = fs.offImage;
      if (!thumb && editing?.thumb && !fs.photoRemoved && !fs.photoFile) thumb = editing.thumb;

      let store = F.store.value.trim();
      if (store) {
        const existing = storesByUse().find((s) => normalize(s) === normalize(store));
        if (existing) store = existing;
        if (!state.stores.some((s) => normalize(s) === normalize(store))) {
          await be.addStore(store);
          state.stores.push(store);
        }
      }
      const d = F.date.value ? new Date(F.date.value) : new Date();
      const entry = {
        id: editing?.id || uid(),
        date: (isNaN(d) ? new Date() : d).toISOString(),
        barcode: F.barcode.value.trim(),
        product,
        brand: F.brand.value.trim(),
        price,
        currency: cur,
        store,
        notes: F.notes.value.trim(),
        photoId,
        thumb,
      };
      if (editing) {
        await be.updateEntry(entry);
        state.entries = state.entries.map((e) => (e.id === entry.id ? entry : e));
      } else {
        await be.addEntry(entry);
        state.entries.push(entry);
      }
      if (store) {
        prefs.lastStore = store;
        savePrefs();
      }
      indexData();
      saveCache();
      navigator.vibrate?.(30);
      toast(t('form.saved'), 'success');
      if (editing) returnTo('#product/' + enc(pkey(entry)));
      else {

        location.hash = '';
      }
    } catch (e) {
      handleError(e);
      btn.disabled = false;
      btn.innerHTML = `${icon('check')}<span>${t('form.save')}</span>`;
    }
  });

  $('#delete-btn')?.addEventListener('click', async () => {
    if (!(await confirmDialog(t('form.deleteConfirm'), { ok: t('form.delete'), danger: true }))) return;
    try {
      await state.backend.deleteEntry(editing.id);
      if (editing.photoId) state.backend.deletePhoto(editing.photoId).catch(() => {});
      state.entries = state.entries.filter((e) => e.id !== editing.id);
      indexData();
      saveCache();
      toast(t('form.deleted'), 'success');
      const key = pkey(editing);
      if (state.products.has(key)) returnTo('#product/' + enc(key));
      else {

        location.hash = '';
      }
    } catch (e) {
      handleError(e);
    }
  });
}

// ─────────────────────────────────────────────────────────
//  Install as app (PWA)
// ─────────────────────────────────────────────────────────
let installPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault(); // keep it for our own button
  installPrompt = e;
});
window.addEventListener('appinstalled', () => {
  installPrompt = null;
  toast(t('install.done'), 'success');
  if (state.view === 'settings') renderSettings();
});
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

async function installApp() {
  if (installPrompt) {
    installPrompt.prompt();
    const { outcome } = await installPrompt.userChoice;
    if (outcome === 'accepted') installPrompt = null;
    return;
  }
  // No native prompt available (iOS Safari, Firefox, or already dismissed): explain how to do it by hand
  infoDialog(t('install.button'), isIOS() ? t('install.iosSteps') : t('install.otherSteps'));
}

function infoDialog(title, html) {
  const root = $('#modal-root');
  root.innerHTML = `
    <div class="modal-backdrop">
      <div class="modal" role="dialog" aria-modal="true">
        <h3 class="modal-title">${esc(title)}</h3>
        <div class="modal-body">${html}</div>
        <button class="btn primary block" data-close>${t('common.ok')}</button>
      </div>
    </div>`;
  const close = () => (root.innerHTML = '');
  root.querySelector('.modal-backdrop').onclick = (e) => e.target === e.currentTarget && close();
  root.querySelector('[data-close]').onclick = close;
}

// ─────────────────────────────────────────────────────────
//  Settings
// ─────────────────────────────────────────────────────────
function renderSettings() {
  state.view = 'settings';
  state.viewRefresh = renderSettings;
  setTopbar({ title: t('nav.settings'), back: true });
  const u = state.user;
  const be = state.backend;
  const seg = (group, value, ic, label, active) =>
    `<button class="${active ? 'active' : ''}" data-${group}="${value}">${ic ? icon(ic) : ''}<span>${label}</span></button>`;
  const stores = storesByUse();

  $('#view').innerHTML = `
    <div class="section-title">${t('set.account')}</div>
    <section class="card">
      <div class="account">
        ${avatarHtml(u, 'lg')}
        <div class="account-info">
          <b>${esc(u.name)}</b>
          <span class="muted">${esc(u.email)}</span>
          <span class="badge">${GOOGLE_G}${t('set.connectedGoogle')}</span>
        </div>
      </div>
      <div class="account-meta">
        <div><span>${t('set.session')}</span><b>${
          auth.tokenExpiresAt() > Date.now()
            ? t('set.sessionUntil', { time: fmtTime(auth.tokenExpiresAt()) })
            : t('set.sessionExpired')
        }</b></div>
        <div><span>${t('set.records')}</span><b>${state.entries.length} · ${state.products.size} ${t('home.products')}</b></div>
        <div><span>${t('set.lastSync')}</span><b>${state.lastSync ? fmtTime(state.lastSync) : '—'}</b></div>
      </div>
    </section>

    <div class="section-title">${t('set.drive')}</div>
    <section class="card">
      ${
        be.folderUrl
          ? `<a class="set-row link" href="${esc(be.folderUrl)}" target="_blank" rel="noopener">${icon('folder')}<span>${t('set.openFolder')}<small>${esc(CONFIG.FOLDER_NAME)}</small></span>${icon('external', 'xs')}</a>`
          : ''
      }
      ${
        be.spreadsheetUrl
          ? `<a class="set-row link" href="${esc(be.spreadsheetUrl)}" target="_blank" rel="noopener">${icon('sheet')}<span>${t('set.openSheet')}<small>${esc(CONFIG.FOLDER_NAME)} / ${esc(CONFIG.DATA_FOLDER_NAME)} / ${esc(CONFIG.SPREADSHEET_NAME)}</small></span>${icon('external', 'xs')}</a>`
          : ''
      }
      ${
        be.photosUrl
          ? `<a class="set-row link" href="${esc(be.photosUrl)}" target="_blank" rel="noopener">${icon('image')}<span>${t('set.openPhotos')}<small>${esc(CONFIG.FOLDER_NAME)} / ${esc(CONFIG.PHOTOS_FOLDER_NAME)}</small></span>${icon('external', 'xs')}</a>`
          : ''
      }
      ${!be.folderUrl ? `<div class="set-row"><span class="muted">${t('set.driveLoading')}</span><span class="spinner sm"></span></div>` : ''}
    </section>

    <div class="section-title">${t('set.appearance')}</div>
    <section class="card">
      <div class="set-row col">
        <span class="set-label">${t('set.theme')}</span>
        <div class="segmented">
          ${seg('theme', 'system', 'monitor', t('set.system'), prefs.theme === 'system')}
          ${seg('theme', 'light', 'sun', t('set.light'), prefs.theme === 'light')}
          ${seg('theme', 'dark', 'moon', t('set.dark'), prefs.theme === 'dark')}
        </div>
      </div>
      <div class="set-row col">
        <span class="set-label">${t('set.accent')}</span>
        <div class="swatches">${Object.entries(ACCENTS)
          .map(([k, c]) => `<button class="swatch ${k === prefs.accent ? 'active' : ''}" data-accent="${k}" style="--c:${c}" aria-label="${k}">${icon('check')}</button>`)
          .join('')}</div>
      </div>
    </section>

    <div class="section-title">${t('set.language')}</div>
    <section class="card">
      <div class="segmented">
        ${seg('lang', 'it', '', 'Italiano', getLang() === 'it')}
        ${seg('lang', 'de', '', 'Deutsch', getLang() === 'de')}
        ${seg('lang', 'en', '', 'English', getLang() === 'en')}
      </div>
    </section>

    <div class="section-title">${t('set.prices')}</div>
    <section class="card">
      <label class="set-row">
        <span>${t('set.currency')}<small>${t('set.currencyHint')}</small></span>
        <select id="cur-select">${CURRENCIES.map((c) => `<option ${c === prefs.currency ? 'selected' : ''}>${c}</option>`).join('')}</select>
      </label>
      <label class="set-row">
        <span>${t('set.autoOcr')}<small>${t('set.autoOcrHint')}</small></span>
        <input type="checkbox" class="switch" id="auto-ocr" ${prefs.autoOcr ? 'checked' : ''}>
      </label>
    </section>

    <div class="section-title">${t('set.app')}</div>
    <section class="card">
      ${
        isStandalone()
          ? `<div class="set-row link">${icon('check')}<span>${t('install.installed')}<small>${t('install.installedHint')}</small></span></div>`
          : `<button class="set-row link" id="install-btn">${icon('download')}<span>${t('install.button')}<small>${t('install.hint')}</small></span>${icon('chevronRight', 'xs')}</button>`
      }
    </section>

    <div class="section-title">${t('set.data')}</div>
    <section class="card">
      <button class="set-row link" id="sync-now">${icon('refresh')}<span>${t('set.sync')}</span></button>
      <div class="set-row col">
        <span class="set-label">${t('set.stores')} · ${stores.length}</span>
        <div class="chips">${stores.length ? stores.map((s) => `<span class="chip static">${esc(s)}</span>`).join('') : `<span class="muted">—</span>`}</div>
      </div>
    </section>

    <button class="btn danger-ghost block" id="logout-btn">${icon('logout')}<span>${t('set.logout')}</span></button>
    <p class="footer muted">Price Tracker v${CONFIG.VERSION} · build ${esc(CONFIG.BUILD)}</p>`;

  $$('[data-theme]', $('#view')).forEach(
    (b) =>
      (b.onclick = () => {
        prefs.theme = b.dataset.theme;
        savePrefs();
        applyTheme();
        renderSettings();
      })
  );
  $$('[data-accent]').forEach(
    (b) =>
      (b.onclick = () => {
        prefs.accent = b.dataset.accent;
        savePrefs();
        applyTheme();
        renderSettings();
      })
  );
  $$('[data-lang]').forEach(
    (b) =>
      (b.onclick = () => {
        prefs.lang = b.dataset.lang;
        savePrefs();
        setLang(prefs.lang);
        renderShell();
        route();
      })
  );
  $('#cur-select').onchange = (e) => {
    prefs.currency = e.target.value;
    savePrefs();
  };
  $('#auto-ocr').onchange = (e) => {
    prefs.autoOcr = e.target.checked;
    savePrefs();
  };
  $('#install-btn')?.addEventListener('click', installApp);
  $('#sync-now').onclick = async () => {
    await refreshData();
    toast(t('set.synced'), 'success');
  };
  $('#logout-btn').onclick = async () => {
    if (!(await confirmDialog(t('set.logoutConfirm')))) return;
    ls.del(cacheKey());
    auth.signOut();
    Object.assign(state, { user: null, backend: null, entries: [], stores: [], products: new Map(), navDepth: 0 });
    history.replaceState({ i: 0 }, '', location.pathname);
    renderLogin();
  };
}

// ─────────────────────────────────────────────────────────
//  Boot
// ─────────────────────────────────────────────────────────
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !state.backend) return;
  if (Date.now() - state.lastSync < 5 * 60e3) return;
  if (state.backend.kind === 'google' && !auth.hasValidToken()) return showReconnect();
  refreshData();
});

async function boot() {
  prefs.lang = prefs.lang || detectLang();
  setLang(prefs.lang);
  applyTheme();

  ls.del('pt.demo');
  if (!CONFIG.GOOGLE_CLIENT_ID) return renderLogin();

  app.innerHTML = `<div class="splash">${LOGO}<span class="spinner"></span></div>`;
  try {
    await auth.init(CONFIG.GOOGLE_CLIENT_ID);
  } catch (e) {
    return renderLogin({ error: e.message });
  }
  if (auth.hasValidToken() && auth.cachedUser()) {
    try {
      return await startGoogle();
    } catch (e) {
      console.warn(e);
    }
  }
  const cu = auth.cachedUser();
  renderLogin(cu ? { message: t('login.welcomeBack', { name: cu.name }) } : {});
}

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
  // A new release activated its service worker: reload to run the new code,
  // but never in the middle of filling the add/edit form.
  let hadController = !!navigator.serviceWorker.controller;
  let pendingReload = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController) return void (hadController = true);
    if (state.view === 'add' || state.view === 'edit') pendingReload = true;
    else location.reload();
  });
  window.addEventListener('hashchange', () => pendingReload && location.reload());
}

boot();
