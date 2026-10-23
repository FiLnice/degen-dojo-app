// Per-client request limiter for the store's public functions (audit DD-04).
//
// Netlify's own code-defined rate limits (`config.rateLimit`) are the strong, global layer, but a site only
// gets 2 rules on the Free/Personal plans (5 on Pro) — they are spent on /api/rpc and /api/collection. Every
// function also runs this cheap in-memory sliding window: it is per WARM INSTANCE (not shared across
// instances), so it isn't a global quota, but it stops one client hammering an endpoint from burning paid
// upstream calls (Helius, Magic Eden, Tensor) or filling Blobs — at zero cost and with no extra storage.
//
//   import { limited } from "./store-ratelimit-core.mjs";
//   const blocked = limited(request, "rpc", 240); if (blocked) return blocked;   // 240 requests / minute / IP
const WINDOW_MS = 60_000;
const MAX_KEYS = 5000;
const hits = new Map();   // "<route>|<ip>" → ascending request timestamps inside the window

/** Best-effort client IP: Netlify's connection IP header, then the first X-Forwarded-For hop. */
export function clientIp(request) {
  const h = (n) => (request && request.headers && request.headers.get(n)) || "";
  return h("x-nf-client-connection-ip").trim() || h("x-forwarded-for").split(",")[0].trim() || "unknown";
}

/** true when this client already made `limit` requests to `route` in the last minute (and records this one otherwise). */
export function tooMany(request, route, limit, now = Date.now()) {
  const k = route + "|" + clientIp(request);
  let arr = hits.get(k);
  if (!arr) { arr = []; hits.set(k, arr); }
  while (arr.length && arr[0] <= now - WINDOW_MS) arr.shift();
  if (arr.length >= limit) return true;
  arr.push(now);
  if (hits.size > MAX_KEYS) {   // keep memory bounded: drop clients idle for a full window
    for (const [key, a] of hits) if (!a.length || a[a.length - 1] <= now - WINDOW_MS) hits.delete(key);
  }
  return false;
}

/** A 429 Response when over the limit, else null. */
export function limited(request, route, limit, headers = {}) {
  if (!tooMany(request, route, limit)) return null;
  return new Response(JSON.stringify({ error: "too many requests — please slow down and try again in a minute" }), {
    status: 429,
    headers: { "content-type": "application/json", "cache-control": "no-store", "retry-after": "60", ...headers },
  });
}

/** test hook */
export const _resetLimits = () => hits.clear();
