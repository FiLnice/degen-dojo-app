// Shared: the CURRENT live Tensor book for Degen Dojo, from Tensor's aggregator API (key server-side),
// cached 30 s per warm instance. Used by /api/tensor-listings (the tower) and /api/collection (the
// market's Dojo cases — Magic Eden's listings API no longer carries Tensor listings).
// Written defensively: it resolves the collection id, pages through active listings, and pulls each
// item's mint + price + seller across the field names Tensor may use.
//
// Env: TENSOR_API_KEY (dev.tensor.trade). Optional: TENSOR_COLL_VOC (collection mint, defaulted).
const TENSOR = "https://api.mainnet.tensordev.io/api/v1";
const VOC = process.env.TENSOR_COLL_VOC || "2m9DupVeheZ5vfuXZxqV3KSQ7HnVDk2tG6ouH1ZnLwYb";
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

// → { items, collId, cached } · { items: [], collId, debug } when nothing parsed · throws on a Tensor error
export async function tensorBook(key) {
  if (CACHE.items && Date.now() - CACHE.at < TTL) return { items: CACHE.items, collId: CACHE.collId, cached: true };
  if (!CACHE.collId) {
    const fc = await tget("/collections/find_collection?filter=" + VOC, key);
    CACHE.collId = fc.collId || fc.collection?.collId || fc.collections?.[0]?.collId || fc.data?.collId || null;
    if (!CACHE.collId) { const e = new Error("could not resolve collId"); e.debug = { keys: Object.keys(fc), fc }; throw e; }
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
  if (!items.length) return { items: [], collId: CACHE.collId, debug: firstRaw };
  CACHE.items = items; CACHE.at = Date.now();
  return { items, collId: CACHE.collId };
}
