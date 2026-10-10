// Netlify Function: live listings for a collection at /api/collection?symbol=<sym>
//
// Powers the collection search on the browse page. Returns the collection's real
// Magic Eden listings (mint + price) enriched with images/names from Helius DAS —
// never fabricated. Cached briefly at the edge so a search doesn't hammer ME.
//
// Env: SOLANA_RPC (DAS-capable).
const SYM_RE = /^[a-z0-9_]{2,60}$/i;
// Degen Dojo = the on-chain collection 2m9Dup… only. The Demons + Oni Senseis moved to Demon Dojo
// (WyUy9q…), but Magic Eden still lists them under "degendojonft" — so trust the chain, not ME.
const DD_SYMBOL = "degendojonft";
const DD_COLLECTION = "2m9DupVeheZ5vfuXZxqV3KSQ7HnVDk2tG6ouH1ZnLwYb";
const collOf = (a) => (a?.grouping || []).find((g) => g.group_key === "collection")?.group_value || "";


export default async (request) => {
  const sym = (new URL(request.url).searchParams.get("symbol") || "").trim();
  if (!SYM_RE.test(sym)) return json({ items: [] });
  try {
    // Ask for more than we show: pool listings get dropped below, and we still want ~18 on the shelf.
    const lr = await fetch(`https://api-mainnet.magiceden.dev/v2/collections/${sym}/listings?offset=0&limit=60`, { headers: { accept: "application/json" } });
    const t = await lr.text();
    if (t.startsWith("You have")) return json({ items: [], error: "rate-limited" }, 200, 15);
    const arr = JSON.parse(t);
    // Only listings our buy flow can fill: personal Magic Eden (M2) and Tensor listings. Magic Eden
    // AMM pool listings ("MMM") need a different instruction, so showing them led to a
    // "No longer listed" dead end on click. A shelf must only show what can actually be bought.
    const buyable = (a) => !a.listingSource || a.listingSource === "M2" || /tensor/i.test(a.listingSource);
    const listed = arr.filter(buyable).map((a) => ({ mint: a.tokenMint, price: a.price })).filter((x) => x.mint && x.price).slice(0, 18);
    if (!listed.length) return json({ items: [] }, 200, 60);

    const ba = await fetch(process.env.SOLANA_RPC, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAssetBatch", params: { ids: listed.map((x) => x.mint) } }),
    });
    const assets = (await ba.json()).result || [];
    const img = {}, nm = {}, coll = {};
    for (const a of assets) { if (!a) continue; img[a.id] = a.content?.links?.image || a.content?.files?.[0]?.uri || ""; nm[a.id] = a.content?.metadata?.name || ""; coll[a.id] = collOf(a); }

    const items = listed
      .filter((x) => sym !== DD_SYMBOL || coll[x.mint] === DD_COLLECTION)
      .map((x) => ({ ...x, image: img[x.mint] || "", name: nm[x.mint] || "" })).sort((a, b) => a.price - b.price);
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

export const config = { path: "/api/collection" };
