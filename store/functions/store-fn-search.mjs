// Netlify Function: live collection name-search at /api/search?q=<name>
//
// Lets the browse page find ANY collection (not a bundled list) by querying Magic
// Eden's collection search, normalised to {symbol,name,logo,floor}. Cached at the
// edge so typing doesn't hammer ME. Add a MAGICEDEN_API_KEY env var to raise limits.
import { limited } from "./store-ratelimit-core.mjs";
export default async (request) => {
  const blocked = limited(request, "search", 60); if (blocked) return blocked;   // 60 / minute / IP (DD-04)
  const q = (new URL(request.url).searchParams.get("q") || "").trim();
  if (q.length < 2) return json({ results: [] });
  try {
    const headers = { accept: "application/json" };
    if (process.env.MAGICEDEN_API_KEY) headers.Authorization = `Bearer ${process.env.MAGICEDEN_API_KEY}`;
    const r = await fetch(`https://api-mainnet.magiceden.dev/v2/collections/search?q=${encodeURIComponent(q)}&limit=8`, { headers });
    const t = await r.text();
    if (t.startsWith("You have")) return json({ results: [], error: "rate-limited" }, 200, 10);
    const j = JSON.parse(t);
    const arr = Array.isArray(j) ? j : (j.collections || j.results || []);
    const results = arr
      .map((c) => ({ symbol: c.symbol || c.collectionSymbol, name: c.name, logo: c.image || "", floor: c.floorPrice != null ? c.floorPrice / 1e9 : (c.floor ?? null) }))
      .filter((c) => c.symbol && c.name);
    return json({ results }, 200, 120);
  } catch (e) {
    return json({ results: [], error: String(e.message || e) }, 200, 10);
  }
};

function json(o, status = 200, sMaxAge = 60) {
  return new Response(JSON.stringify(o), { status, headers: {
    "content-type": "application/json",
    "cache-control": `public, max-age=0, s-maxage=${sMaxAge}, stale-while-revalidate=300`,
    "netlify-cdn-cache-control": `public, s-maxage=${sMaxAge}, stale-while-revalidate=300`,
  } });
}

export const config = { path: "/api/search" };
