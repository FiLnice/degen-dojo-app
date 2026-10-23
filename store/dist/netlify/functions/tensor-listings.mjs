// Netlify Function: /api/tensor-listings — the CURRENT live Tensor book for Degen Dojo, so the
// store tower shows Tensor listings in real time (not just the deploy-time snapshot). Uses Tensor's
// aggregator API. Written defensively: it resolves the collection id, pages through active listings,
// and pulls each item's mint + price + seller across the field names Tensor may use — and if nothing
// parses, it echoes the raw shape in `debug` so the field mapping can be corrected in one shot.
//
// Env: TENSOR_API_KEY (dev.tensor.trade). Optional: TENSOR_COLL_VOC (collection mint, defaulted).
import { limited } from "./store-ratelimit-core.mjs";
const TENSOR = "https://api.mainnet.tensordev.io/api/v1";
const VOC = process.env.TENSOR_COLL_VOC || "2m9DupVeheZ5vfuXZxqV3KSQ7HnVDk2tG6ouH1ZnLwYb";
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store", "access-control-allow-origin": "*" } });
const CACHE = { collId: null, items: null, at: 0 };
const TTL = 30_000;
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

async function tget(path, key) {
  const r = await fetch(TENSOR + path, { headers: { "x-tensor-api-key": key, accept: "application/json" } });
  const t = await r.text();
  if (!r.ok) throw new Error("Tensor " + r.status + ": " + t.slice(0, 200));
  try { return JSON.parse(t); } catch { throw new Error("Tensor non-JSON: " + t.slice(0, 120)); }
}

// Pull mint + price(SOL) + seller from a listing item whose exact shape we can't assume.
function parseItem(it) {
  const m = it.onchainId || it.mint?.onchainId || (typeof it.mint === "string" ? it.mint : null) || it.mintOnchainId || null;
  const praw = it.listing?.price ?? it.grossAmount ?? it.price ?? it.listPrice ?? it.listing?.grossAmount ?? it.priceInfo?.grossAmount ?? null;
  let price = praw != null ? Number(praw) : null;
  if (price != null && price > 1e5) price = price / 1e9;                 // lamports → SOL (heuristic: real SOL prices are < 100k)
  const seller = it.listing?.seller ?? it.owner ?? it.seller ?? null;
  const source = (it.listing?.source || it.source || "tensor").toString().toLowerCase().includes("mmm") ? "magiceden" : "tensor";
  return (m && B58.test(m) && price > 0) ? { mint: m, price, seller, source } : null;
}

export default async (request) => {
  const blocked = limited(request, "tensor-listings", 60); if (blocked) return blocked;   // 60 / minute / IP (DD-04)
  const key = process.env.TENSOR_API_KEY;
  if (!key) return json({ error: "Tensor API key not set", needKey: true }, 501);
  if (CACHE.items && Date.now() - CACHE.at < TTL) return json({ items: CACHE.items, cached: true, collId: CACHE.collId });
  try {
    if (!CACHE.collId) {
      const fc = await tget("/collections/find_collection?filter=" + VOC, key);
      CACHE.collId = fc.collId || fc.collection?.collId || fc.collections?.[0]?.collId || fc.data?.collId || null;
      if (!CACHE.collId) return json({ error: "could not resolve collId", debug: { keys: Object.keys(fc), fc } }, 502);
    }
    let items = [], cursor = null, pages = 0, firstRaw = null;
    do {
      const q = new URLSearchParams({ collId: CACHE.collId, sortBy: "ListingPriceAsc", limit: "250" });
      if (cursor) q.set("cursor", cursor);
      const d = await tget("/mint/active_listings?" + q.toString(), key);
      const arr = d.mints || d.listings || d.data || d.results || (Array.isArray(d) ? d : []);
      if (pages === 0) firstRaw = { keys: Object.keys(d), sample: arr[0] || d };
      for (const it of arr) { const p = parseItem(it); if (p) items.push(p); }
      cursor = d.page?.endCursor || d.cursor || d.nextCursor || d.page?.cursor || null;
      pages++;
    } while (cursor && pages < 10);
    if (!items.length) return json({ items: [], note: "parsed 0 — check field mapping", debug: firstRaw });
    CACHE.items = items; CACHE.at = Date.now();
    return json({ items, collId: CACHE.collId });
  } catch (e) { return json({ error: e.message || String(e) }, 502); }
};

export const config = { path: "/api/tensor-listings" };
