// Netlify Function: admin stats at /api/admin?key=<ADMIN_KEY>
//
// Aggregates the coin-purchase ledger (and referral ledger) into the numbers the
// admin dashboard shows: coins sold, buyers, revenue by currency, pot funded,
// Degen Dojo profit, affiliate rankings, recent purchases.
//
// Gated by ADMIN_KEY so the books aren't world-readable. Read-only.
//
// NOTE these come from POSTed hints (untrusted). For payouts, verify on-chain
// first — this endpoint is for at-a-glance monitoring, not settlement.
import { getStore } from "@netlify/blobs";
import { adminKeyOk } from "./store-session-core.mjs";

const POT_PCT = 65;          // share of every purchase that funds the weekly pot
const AFFILIATE_RATE = 0.25; // preachers earn 20–30% of a referred coin pack (25% ≈ the middle tier)

export default async (request) => {
  const url = new URL(request.url);
  if (!adminKeyOk(url.searchParams.get("key"), "ADMIN_KEY")) {
    return new Response("forbidden", { status: 403 });
  }

  // ---- read every coin purchase ----
  const store = getStore("coin-purchases");
  const { blobs } = await store.list();
  const buys = [];
  for (const b of blobs) { const v = await store.get(b.key, { type: "json" }); if (v) buys.push(v); }

  const byCurrency = { ORE: 0, SKR: 0, SOL: 0 };
  const buyers = new Set();
  const affMap = {};      // ref → {buyers:Set, volume}
  let coinsSold = 0, revenueUsd = 0;
  for (const b of buys) {
    coinsSold += b.coins || 0;
    revenueUsd += b.usd || 0;
    if (b.currency in byCurrency) byCurrency[b.currency] += b.usd || 0;
    if (b.buyer) buyers.add(b.buyer);
    if (b.ref) {
      const a = affMap[b.ref] || (affMap[b.ref] = { name: b.ref, buyers: new Set(), volume: 0 });
      if (b.buyer) a.buyers.add(b.buyer);
      a.volume += b.usd || 0;
    }
  }

  const pot = revenueUsd * POT_PCT / 100;
  // DD keeps what's left after the pot (65%) and the preachers' cut of referred packs
  const affVolume = Object.values(affMap).reduce((t, a) => t + a.volume, 0);
  const profit = revenueUsd * (1 - POT_PCT / 100) - affVolume * AFFILIATE_RATE;

  const affiliates = Object.values(affMap)
    .map((a) => ({ name: a.name, tier: "Affiliate", buyers: a.buyers.size, volume: Math.round(a.volume), earnings: Math.round(a.volume * AFFILIATE_RATE) }))
    .sort((x, y) => y.volume - x.volume)
    .slice(0, 25);

  const recent = buys
    .sort((a, b) => (b.ts || 0) - (a.ts || 0))
    .slice(0, 12)
    .map((b) => ({ buyer: b.buyer, coins: b.coins, currency: b.currency, usd: b.usd, ts: b.ts, referrer: b.ref }));

  const out = {
    coinsSold, buyers: buyers.size, revenueUsd: Math.round(revenueUsd),
    byCurrency: { ORE: Math.round(byCurrency.ORE), SKR: Math.round(byCurrency.SKR), SOL: Math.round(byCurrency.SOL) },
    pot: Math.round(pot), profit: Math.round(profit),
    affiliates, recent,
  };
  return new Response(JSON.stringify(out), { headers: { "content-type": "application/json", "cache-control": "no-store" } });
};

export const config = { path: "/api/admin" };
