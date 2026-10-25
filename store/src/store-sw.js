/* Degen Dojo — minimal service worker.
 * Purpose is PWA installability (required to wrap the site as a TWA/APK for the
 * Solana dApp Store), NOT offline caching. It is deliberately network-first so a
 * live marketplace + on-chain economy never serves stale prices, listings, or
 * game state. It only falls back to a cached shell when the network is down.
 *
 * Security review 2026-10-23 (L7): operator pages (/admin, /miner-admin, /preacher-admin, /payouts) and anything
 * sent with Cache-Control: no-store are never written to the cache; /api/* is never touched; and the offline
 * fallback answers page navigations only — a failed script or JSON request gets a real network error, not HTML.
 */
const SHELL = 'dojo-shell-v3';   // bump to purge any stale cached shell (v2 may hold operator pages) on the next deploy
const OFFLINE_URLS = ['/', '/index.html'];
const NO_CACHE_PATH = /^\/(admin|miner-admin|preacher-admin|payouts)(\.html)?(\/|$)/;

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
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;          // outside hosts: the browser's normal path
  if (url.pathname.startsWith('/api/')) return;             // API answers are never cached or substituted
  if (req.mode !== 'navigate') return;                      // scripts, JSON, images: plain network, real errors
  const operator = NO_CACHE_PATH.test(url.pathname);
  e.respondWith(
    fetch(req)
      .then((res) => {
        // keep the navigations' shell fresh for offline fallback only — never operator pages or no-store answers
        const cc = res.headers.get('cache-control') || '';
        if (res.ok && !operator && !/no-store/i.test(cc)) {
          const copy = res.clone();
          caches.open(SHELL).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => (operator ? Response.error() : caches.match(req).then((hit) => hit || caches.match('/'))))
  );
});
