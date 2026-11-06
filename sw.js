// Network-first service worker: always fresh when online, app shell available offline.
const CACHE = 'pt-shell-v1';
const SHELL = [
  './',
  'index.html',
  'css/styles.css',
  'js/app.js',
  'js/auth.js',
  'js/backend-google.js',
  'js/backend-demo.js',
  'js/config.js',
  'js/i18n.js',
  'js/icons.js',
  'js/media.js',
  'js/utils.js',
  'icons/icon.svg',
  'manifest.webmanifest',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return; // Google APIs etc. go straight to network
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match('index.html')))
  );
});
