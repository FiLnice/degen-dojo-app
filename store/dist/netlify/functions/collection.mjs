// Netlify Function: live listings for a collection at /api/collection?symbol=<sym>
//
// Powers the collection search on the browse page. Returns the collection's real
// Magic Eden listings (mint + price) enriched with images/names from Helius DAS —
// never fabricated. Cached briefly at the edge so a search doesn't hammer ME.
//
// Env: SOLANA_RPC (DAS-capable).
import { limited } from "./store-ratelimit-core.mjs";
const SYM_RE = /^[a-z0-9_]{2,60}$/i;
// Degen Dojo = the on-chain collection 2m9Dup… only. The Demons + Oni Senseis moved to Demon Dojo
// (WyUy9q…), but Magic Eden still lists them under "degendojonft" — so trust the chain, not ME.
const DD_SYMBOL = "degendojonft";
const DD_COLLECTION = "2m9DupVeheZ5vfuXZxqV3KSQ7HnVDk2tG6ouH1ZnLwYb";
// Our own collections can share a Magic Eden symbol (Demons are still listed under degendojonft), so a case can
// ask for one on-chain collection: ?symbol=degendojonft&collection=<Demon Dojo>. Only these are accepted.
const DOJO_COLLECTIONS = new Set([DD_COLLECTION, "WyUy9qjJekjqTAYGanANjhtviwgu1uhCkXx1uas8fWb", "dgd6We3oS4M5LSVzT6Ep39wwVpjLC336tCpyPZkLAHx"]);
const collOf = (a) => (a?.grouping || []).find((g) => g.group_key === "collection")?.group_value || "";


export default async (request) => {
  const blocked = limited(request, "collection", 60); if (blocked) return blocked;   // 60 / minute / IP (DD-04)
  const q = new URL(request.url).searchParams;
  const sym = (q.get("symbol") || "").trim();
  if (!SYM_RE.test(sym)) return json({ items: [] });
  const only = (q.get("collection") || "").trim() || (sym === DD_SYMBOL ? DD_COLLECTION : "");
  if (only && !DOJO_COLLECTIONS.has(only)) return json({ items: [] });
  try {
    // Magic Eden returns listings cheapest-first, 100 per page — read up to 3 pages so the case shows every
    // price, not just the cheapest handful (it used to stop at ~18, i.e. nothing above ~1 ORE).
    const arr = [];
    for (let offset = 0; offset < 300; offset += 100) {
      const lr = await fetch(`https://api-mainnet.magiceden.dev/v2/collections/${sym}/listings?offset=${offset}&limit=100`, { headers: { accept: "application/json" } });
      const t = await lr.text();
      if (t.startsWith("You have")) { if (!arr.length) return json({ items: [], error: "rate-limited" }, 200, 15); break; }
      const page = JSON.parse(t);
      if (!Array.isArray(page) || !page.length) break;
      arr.push(...page);
      if (page.length < 100) break;
    }
    // Only listings our buy flow can fill: personal Magic Eden (M2) and Tensor listings. Magic Eden
    // AMM pool listings ("MMM") need a different instruction, so showing them led to a
    // "No longer listed" dead end on click. A shelf must only show what can actually be bought.
    const buyable = (a) => !a.listingSource || a.listingSource === "M2" || /tensor/i.test(a.listingSource);
    const listed = arr.filter(buyable).map((a) => ({ mint: a.tokenMint, price: a.price })).filter((x) => x.mint && x.price);
    if (!listed.length) return json({ items: [] }, 200, 60);

    const ba = await fetch(process.env.SOLANA_RPC, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAssetBatch", params: { ids: listed.map((x) => x.mint) } }),
    });
    const assets = (await ba.json()).result || [];
    const img = {}, nm = {}, coll = {}, roy = {};
    for (const a of assets) { if (!a) continue; img[a.id] = a.content?.links?.image || a.content?.files?.[0]?.uri || ""; nm[a.id] = a.content?.metadata?.name || ""; coll[a.id] = collOf(a); roy[a.id] = a.royalty?.basis_points ?? 0; }

    const items = listed
      .filter((x) => !only || coll[x.mint] === only)
      // priceAllIn = what the buyer actually pays: list price + the creator royalty + Magic Eden's 2% taker fee
      // (same formula as /api/resolve, which prices the buy drawer)
      .map((x) => ({ ...x, image: img[x.mint] || "", name: nm[x.mint] || "", coll: coll[x.mint] || "", royaltyBps: roy[x.mint] ?? 0,
        priceAllIn: +(x.price * (1 + (roy[x.mint] ?? 0) / 1e4 + 0.02)).toFixed(6) }))
      .sort((a, b) => a.priceAllIn - b.priceAllIn);
    return json({ items }, 200, 60);
  } catch (e) {
    return json({ items: [], error: String(e.message || e) }, 200, 15);
  }
};

function json(o, status = 200, sMaxAge = 30) {
  return new Response(JSON.stringify(o), { status, headers: {
    "content-type": "application/json",
    "cache-control": `public, max-age=0, s-maxage=${sMaxAge}, stale-while-revalidate=120`,
    "netlify-cdn-cache-control": `public, s-maxage=${sMaxAge}, stale-while-revalidate=120`,
  } });
}

// Netlify platform rate limit (global, per IP + domain) — one of the site's 2 code-defined rules.
export const config = { path: "/api/collection", rateLimit: { windowLimit: 90, windowSize: 60, aggregateBy: ["ip", "domain"] } };
