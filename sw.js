// Network-first service worker: always fresh when online, app shell available offline.
// The CI build (scripts/build.js) renames CACHE and adds ?v=<commit> to the URLs below,
// so every release gets a brand-new cache and the old one is deleted.
const CACHE = 'pt-dev';
const SHELL = [
  './',
  'index.html',
  'css/styles.css',
  'js/app.js',
  'js/auth.js',
  'js/backend-google.js',
  'js/config.js',
  'js/i18n.js',
  'js/icons.js',
  'js/media.js',
  'js/utils.js',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return; // Google APIs etc. go straight to network
  // The page itself is always revalidated with the server (bypassing the browser's HTTP cache),
  // so a new release is picked up immediately; versioned assets can come from any cache.
  const req = e.request.mode === 'navigate' ? fetch(e.request.url, { cache: 'no-cache', credentials: 'same-origin' }) : fetch(e.request);
  e.respondWith(
    req
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match('index.html')))
  );
});
