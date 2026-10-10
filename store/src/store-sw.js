/* Degen Dojo — minimal service worker.
 * Purpose is PWA installability (required to wrap the site as a TWA/APK for the
 * Solana dApp Store), NOT offline caching. It is deliberately network-first so a
 * live marketplace + on-chain economy never serves stale prices, listings, or
 * game state. It only falls back to a cached shell when the network is down.
 */
const SHELL = 'dojo-shell-v2';   // bump to purge any stale cached shell on the next deploy
const OFFLINE_URLS = ['/', '/index.html'];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(OFFLINE_URLS)).catch(() => {}));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;                         // never touch API POSTs
  e.respondWith(
    fetch(req)
      .then((res) => {
        // keep the navigations' shell fresh for offline fallback only
        if (req.mode === 'navigate') {
          const copy = res.clone();
          caches.open(SHELL).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match('/')))
  );
});
