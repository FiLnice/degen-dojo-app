// Netlify Function: top Solana collections by weekly volume at /api/topcollections
//
// Powers the shelf/browse hall — the ~100 cases shown are the real top collections
// by 7-day volume, the same ranking Magic Eden's own "Popular Collections" page
// uses. Source is ME's public stats host (stats-mainnet.magiceden.io), the exact
// endpoint their frontend calls: collection_stats/search, verified-only, sorted by
// volume desc. Nothing is fabricated — these are live market rankings. Each case's
// listings are then filled by /api/collection (also real, live).
//
// Cached ~30 min at the edge: the leaderboard barely moves minute to minute, and
// this keeps us from hammering the stats host.
//
// No API key required. If ME ever gates this, drop in a keyed source here and the
// shelf keeps working unchanged (same normalized shape).
import { limited } from "./store-ratelimit-core.mjs";

const STATS_HOST = "https://stats-mainnet.magiceden.io/collection_stats/search/solana";

export default async (request) => {
  const blocked = limited(request, "topcollections", 60); if (blocked) return blocked;   // 60 / minute / IP (DD-04)
  const url = new URL(request.url);
  const window = (url.searchParams.get("window") || "7d").match(/^(1d|7d|30d)$/) ? url.searchParams.get("window") : "7d";
  const limit = Math.min(100, Math.max(10, Number(url.searchParams.get("limit")) || 100));

  const q = new URLSearchParams({
    window, limit: String(limit), offset: "0", sort: "volume", direction: "desc",
    "filter[timeWindow]": window,
    "filter[collectionType]": "all",
    "filter[sortColumn]": "volume",
    "filter[sortDirection]": "desc",
    "filter[qc][isVerified]": "true",
    "filter[qc][minOwnerCount]": "30",
    "filter[qc][minTxns]": "5",
    "filter[verifiedOnly]": "true",
  });

  try {
    const r = await fetch(`${STATS_HOST}?${q}`, {
      headers: { accept: "application/json", "user-agent": "Mozilla/5.0 (compatible; DegenDojoShelf/1.0)" },
    });
    if (!r.ok) return json({ collections: [], error: `stats ${r.status}` }, 200, 60);
    const arr = await r.json();
    if (!Array.isArray(arr)) return json({ collections: [], error: "unexpected shape" }, 200, 60);

    // Normalize to exactly what the shelf renders: symbol, name, logo, floor, listed, vol7, owners.
    const collections = arr
      .map((c) => ({
        symbol: c.collectionSymbol || c.collectionId,
        name: c.name || c.collectionSymbol,
        logo: c.image || "",
        floor: typeof c.fp === "number" ? c.fp : null,
        listed: c.listedCount || 0,
        supply: c.totalSupply || c.minted || 0,
        vol7: typeof c.vol === "number" ? c.vol : null,
        owners: c.ownerCount || 0,
      }))
      .filter((c) => c.symbol);

    return json({ window, collections }, 200, 1800);
  } catch (e) {
    return json({ collections: [], error: String(e.message || e) }, 200, 60);
  }
};

function json(o, status = 200, sMaxAge = 1800) {
  return new Response(JSON.stringify(o), { status, headers: {
    "content-type": "application/json",
    "cache-control": `public, max-age=0, s-maxage=${sMaxAge}, stale-while-revalidate=600`,
    "netlify-cdn-cache-control": `public, s-maxage=${sMaxAge}, stale-while-revalidate=600`,
  } });
}

export const config = { path: "/api/topcollections" };
