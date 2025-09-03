// Service Worker v6 — cache-busting + network-first for JS to avoid stale app
const CACHE = 'ai-shot-tracker-v6';
const ASSETS = [
  './',
  './index.html?v=6',
  './style.css?v=6',
  './app.js?v=6',
  './mec.js?v=6',
  './geometry.js?v=6',
  './logger.js?v=6',
  './worker.js?v=6',
  './manifest.webmanifest?v=6',
  './assets/icon-512.png?v=6'
];

self.addEventListener('install', event => {
  self.skipWaiting(); // activate new SW immediately
  event.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS)).catch(()=>{})
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.map(k => k !== CACHE && caches.delete(k)));
      await self.clients.claim(); // take control of existing pages
    })()
  );
});

// Strategy:
// - For JS modules and worker: NETWORK-FIRST (to pick up fresh code)
// - For everything else: CACHE-FIRST (fast, works offline)
self.addEventListener('fetch', event => {
  const req = event.request;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return; // ignore cross-origin

  const isJS = url.pathname.endsWith('.js') || url.search.includes('.js?v=');

  if (isJS) {
    event.respondWith(networkFirst(req));
  } else {
    event.respondWith(cacheFirst(req));
  }
});

async function networkFirst(req) {
  try {
    const fresh = await fetch(req, { cache: 'no-store' });
    const cache = await caches.open(CACHE);
    cache.put(req, fresh.clone());
    return fresh;
  } catch {
    const cached = await caches.match(req);
    return cached || new Response('/* offline */', { status: 200, headers: { 'Content-Type': 'text/plain' } });
  }
}
async function cacheFirst(req) {
  const cached = await caches.match(req);
  if (cached) return cached;
  const fresh = await fetch(req);
  const cache = await caches.open(CACHE);
  cache.put(req, fresh.clone());
  return fresh;
}