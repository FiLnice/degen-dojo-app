// Netlify Function: /api/vault — what a Dojo card is worth to its holder (read-only, public).
//
//   GET ?mint=<mint>    → { mint, collection, name, image, condition, repair, repairPending, protected, vault,
//                           burnValue: { store, usd }, burned, claim?, storeMint, treasury, treasuryOreAccount, … }
//   GET ?owner=<wallet> → { items: [ same per Dojo NFT the wallet holds ], storeMint, treasury, … }
//   GET ?spots=1        → { mintCount, mintCap, mintSpotsLeft, … }
//
//   repair  = { price: "0.01", currency: "ORE", to: "Mint" } for a Cracked / Mono card not yet repaired, else null
//   vault   = { <currencyMint>: "<decimal>" } — this NFT's share of its collection's Card Vault (the pool that gets
//             44% of every royalty and repair across the collection) = pool × shares ÷ eligible shares right now
//             (shares: a Framed Degen 2, every other eligible NFT 1); shares / eligibleShares say which
//   burnValue = that share in stORE at live prices (what a burn claim would be fixed at right now); 0 + burnNote for a
//             Cracked / Mono Degen ("repair it to Mint first")
//   pools   = { "Degen Dojo" | "Demon Dojo" | "TETO": { pool, eligible (NFTs), shares, perShare: { store, usd }, claimed } }
//   vault / burnValue / eligible / shares / eligibleShares / burnNote / pools are sent ONLY while burning is open (BURN_ENABLED) — until then no
//   money figure about the Card Vaults is public.
//   mintCount / mintCap / mintSpotsLeft — the Mint cap (Mint/Framed Degens + repairs granted vs the admin's cap)
//
// Each call also nudges the Treasury reader (store-keeper-core scanTreasury), so a repair payment or a card
// sent in is picked up within moments of someone looking — the payout cron does the same every 10 minutes.
import { limited } from "./store-ratelimit-core.mjs";
import { assetOf, holdings, vaultItem, prices, pagePublic, poolsPublic, scanTreasury, isAddr, collOf, burnEnabled, mintSpots } from "./store-keeper-core.mjs";

const json = (o, s = 200, cache = "no-store") => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": cache } });
let lastScan = 0;   // per warm instance: at most one lazy Treasury read every 20s
const OWNERS = new Map();   // owner → { at, items } short cache (30s)

export default async (request) => {
  const blocked = limited(request, "vault", 60); if (blocked) return blocked;   // 60 / minute / IP (DD-04)
  if (request.method !== "GET") return json({ error: "GET only" }, 405);
  if (!process.env.SOLANA_RPC) return json({ error: "SOLANA_RPC is not set" }, 500);
  const url = new URL(request.url), mint = url.searchParams.get("mint"), owner = url.searchParams.get("owner");
  // ?spots=1 → just the Mint cap figures (the /repair page shows them before any lookup)
  if (url.searchParams.get("spots")) { try { return json({ ...(await mintSpots()), ...pagePublic() }, 200, "public, max-age=30"); } catch { return json({ error: "couldn't read the Mint count right now" }, 502); } }
  if (!isAddr(mint) && !isAddr(owner)) return json({ error: "pass ?mint=<mint> or ?owner=<wallet>" }, 400);
  if (Date.now() - lastScan > 20e3) { lastScan = Date.now(); try { await scanTreasury({ max: 6, budgetMs: 3500, maxPages: 1 }); } catch {} }   // newest history page only — the cron backfills
  try {
    const px = await prices();
    const on = burnEnabled();
    const spots = await mintSpots().catch(() => ({}));
    const extras = async () => ({ ...pagePublic(), ...spots, burnOpen: on, ...(on ? { pools: await poolsPublic(px).catch(() => null) } : {}) });
    if (isAddr(mint)) {
      const a = await assetOf(mint, { fresh: true });
      if (!a || !collOf(a)) return json({ mint, collection: null, name: a?.content?.metadata?.name || "", condition: null, repair: null, repairPending: false, protected: false, burned: !!a?.burnt, ...(await extras()) });
      return json({ ...(await vaultItem(a, px)), ...(await extras()) });
    }
    const c = OWNERS.get(owner);
    if (c && Date.now() - c.at < 30e3) return json({ items: c.items, ...c.extras });
    const held = await holdings(owner);
    const items = [];
    for (let i = 0; i < held.length; i += 20) items.push(...(await Promise.all(held.slice(i, i + 20).map((a) => vaultItem(a, px)))));
    const ex = await extras();
    OWNERS.set(owner, { at: Date.now(), items, extras: ex }); if (OWNERS.size > 500) OWNERS.clear();
    return json({ items, ...ex });
  } catch (e) {
    return json({ error: "couldn't read that right now — try again in a minute" }, 502);
  }
};

export const config = { path: "/api/vault" };
