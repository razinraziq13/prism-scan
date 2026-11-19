// Prism Scan service worker: makes the app open and work offline.
const VERSION = 'prism-scan-v4';
const SHELL = [
  './', './index.html', './styles.css', './app.js', './manifest.webmanifest',
  './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png',
  './icons/icon-maskable-192.png', './icons/icon-maskable-512.png',
];
const LIB_HOSTS = ['docs.opencv.org', 'cdn.jsdelivr.net', 'tessdata.projectnaptha.com', 'unpkg.com'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION && k !== 'prism-libs').map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Big libraries (edge finder, PDF maker, text reader): cache forever after first download.
  if (LIB_HOSTS.includes(url.hostname)) {
    e.respondWith(caches.open('prism-libs').then(async c => {
      const hit = await c.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok || res.type === 'opaque') c.put(req, res.clone());
      return res;
    }));
    return;
  }

  // App files: serve from cache instantly, refresh in the background.
  if (url.origin === self.location.origin) {
    e.respondWith(caches.open(VERSION).then(async c => {
      const hit = await c.match(req, { ignoreSearch: true });
      const net = fetch(req).then(res => { if (res.ok) c.put(req, res.clone()); return res; }).catch(() => null);
      if (hit) return hit;
      const res = await net;
      if (res) return res;
      if (req.mode === 'navigate') { const home = await c.match('./index.html'); if (home) return home; }
      return new Response('Offline', { status: 503 });
    }));
  }
});
