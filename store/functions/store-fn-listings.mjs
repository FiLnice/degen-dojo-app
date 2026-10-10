// Netlify Function: /api/listings?symbol=<meSymbol>&limit=N
//   → the CURRENT live Magic Eden listings for a collection, cheapest first, so the
//     shelves show only real, buyable NFTs (never a stale/delisted snapshot).
//   → 501 {needKey:true} when MAGICEDEN_API_KEY isn't set (client keeps its snapshot).
//
// Every listing returned is a live ME (M2) listing, so the store's existing buy path
// (/api/mebuy + DojoBuy) can complete it. A short warm-instance cache keeps us well
// under ME's rate limit when many visitors browse the same case.
//
// Env: MAGICEDEN_API_KEY (magiceden.dev).
const ME = "https://api-mainnet.magiceden.dev/v2";
const json = (o, s = 200, extra = {}) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store", "access-control-allow-origin": "*", ...extra } });
const SYM = /^[A-Za-z0-9_]{1,64}$/;
// Degen Dojo = the on-chain collection 2m9Dup… only. The Demons + Oni Senseis moved to Demon Dojo
// (WyUy9q…), but Magic Eden still lists them under "degendojonft" — so trust the chain, not ME.
const DD_SYMBOL = "degendojonft";
const DD_COLLECTION = "2m9DupVeheZ5vfuXZxqV3KSQ7HnVDk2tG6ouH1ZnLwYb";
const collOf = (a) => (a?.grouping || []).find((g) => g.group_key === "collection")?.group_value || "";
const CACHE = new Map();          // symbol → { at, items }  (per warm instance)
const TTL = 30_000;               // 30s freshness

export default async (request) => {
  const url = new URL(request.url);
  const symbol = url.searchParams.get("symbol") || "";
  const limit = Math.min(40, Math.max(1, Number(url.searchParams.get("limit")) || 24));
  const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
  const key = process.env.MAGICEDEN_API_KEY;   // optional — the public listings endpoint works keyless (a key just raises the rate limit)
  if (!SYM.test(symbol)) return json({ error: "bad symbol" }, 400);

  const ck = symbol + ":" + offset + ":" + limit;   // page-aware cache key (load-more pages cache separately)
  const hit = CACHE.get(ck);
  if (hit && Date.now() - hit.at < TTL) return json({ symbol, items: hit.items, cached: true });

  let arr;
  try {
    const r = await fetch(`${ME}/collections/${encodeURIComponent(symbol)}/listings?offset=${offset}&limit=${limit}`, { headers: { ...(key ? { Authorization: "Bearer " + key } : {}), accept: "application/json" } });
    if (!r.ok) return json({ error: "Magic Eden returned " + r.status }, 502);
    arr = await r.json();
  } catch (e) { return json({ error: "listings fetch failed: " + (e.message || e) }, 502); }

  let items = (Array.isArray(arr) ? arr : [])
    .map((l) => ({ mint: l.tokenMint, price: l.price, seller: l.seller, tokenATA: l.tokenAddress, name: "", image: "", attrs: [] }))
    .filter((x) => x.mint && x.price > 0)
    .sort((a, b) => a.price - b.price);

  // Enrich with image/name/traits from Helius DAS (same source the snapshot build uses).
  // ME's /listings omits token metadata, so without this live cards would be imageless.
  const RPC = process.env.SOLANA_RPC;
  if (RPC && items.length) {
    try {
      const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAssetBatch", params: { ids: items.map((i) => i.mint) } }) });
      const assets = (await r.json()).result || [];
      const meta = {};
      for (const a of assets) {
        if (!a) continue;
        meta[a.id] = {
          image: a.content?.links?.image || a.content?.files?.[0]?.uri || "",
          name: a.content?.metadata?.name || "",
          attrs: (a.content?.metadata?.attributes || []).filter((x) => x && x.trait_type != null).slice(0, 12).map((x) => ({ t: String(x.trait_type), v: String(x.value) })),
          std: a.interface !== "ProgrammableNFT" && a.interface !== "MplCoreAsset",
          iface: a.interface,
          decimals: a.token_info?.decimals,
          coll: collOf(a),
        };
      }
      // Show the whole live ME book (with images). Standard NFTs buy via our own M2 engine now;
      // pNFT/Core open Magic Eden until the ME buy key activates, then buy inline too. Each item
      // carries `std` so the client knows which path to use.
      for (const it of items) { const m = meta[it.mint]; if (m) { it.image = m.image; it.name = m.name; it.attrs = m.attrs; it.std = m.std; it.iface = m.iface; it.decimals = m.decimals; } }
      // Drop only what CLEARLY isn't a single NFT: fractional tokens (decimals > 0) or a fungible
      // interface. Keep everything else — many legit collections (e.g. Bobos of War) report a
      // "Custom" interface, so an allow-list wrongly hid them. SPL-404 collections that still slip
      // through are caught by the symbol blocklist in the shelf.
      const NON_NFT = new Set(["FungibleToken", "FungibleAsset"]);
      items = items.filter((it) => (it.decimals == null || it.decimals === 0) && !NON_NFT.has(it.iface));
      if (symbol === DD_SYMBOL) items = items.filter((it) => meta[it.mint]?.coll === DD_COLLECTION);
    } catch { /* metadata is best-effort — cards without an image fall back to the placeholder */ }
  }

  CACHE.set(ck, { at: Date.now(), items });
  return json({ symbol, items });
};

export const config = { path: "/api/listings" };
