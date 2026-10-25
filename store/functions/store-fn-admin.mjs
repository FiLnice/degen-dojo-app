// Netlify Function: admin stats at /api/admin (header Authorization: Bearer <ADMIN_KEY>)
//
// Aggregates the coin-purchase ledger into the numbers the admin dashboard shows: coins sold, buyers, revenue by
// currency, pot funded, Degen Dojo's part, preacher rankings, recent purchases.
//
// Gated by ADMIN_KEY so the books aren't world-readable. Read-only.
//
// Only VERIFIED records count (security review L2): a POST is an unverified hint anyone can send, so its coins / usd /
// ref fields are never summed. The totals use what verify-core wrote after reading the chain — creditedCoins,
// verifiedUsd, the locked split (Pot / preacher shares) and the memo referral (split.ref). Pending and rejected records
// are only counted, and shown in the recent list with their status.
import { limited } from "./store-ratelimit-core.mjs";
import { getStore } from "@netlify/blobs";
import { adminRequestOk } from "./store-session-core.mjs";

const POT_PCT = 22;          // share of every coin buy / referred mining tip that funds the weekly pot (since 2026-10-23)
const frac = (s, part) => (s && Number(s.gainRaw) > 0 ? Number(s[part] || 0) / Number(s.gainRaw) : null);

export default async (request) => {
  const blocked = limited(request, "admin", 10); if (blocked) return blocked;   // 10 / minute / IP (DD-04)
  if (!adminRequestOk(request, "ADMIN_KEY")) {
    return new Response("forbidden", { status: 403 });
  }

  // ---- read every coin purchase record (buy:<sig> only — not the pending / purge index keys) ----
  const store = getStore("coin-purchases");
  const { blobs } = await store.list({ prefix: "buy:" });
  const buys = [];
  for (const b of blobs) { const v = await store.get(b.key, { type: "json" }); if (v) buys.push(v); }

  const byCurrency = { ORE: 0, SKR: 0, SOL: 0 };
  const buyers = new Set();
  const affMap = {};      // memo ref → {buyers:Set, volume, earnings}
  let coinsSold = 0, revenueUsd = 0, pot = 0, preacherUsd = 0, pending = 0, rejected = 0;
  for (const b of buys) {
    if (!b.verified) { if (b.rejected) rejected++; else pending++; continue; }
    const usd = +b.verifiedUsd || 0, cur = b.split?.currency || b.currency;
    coinsSold += b.creditedCoins || 0;
    revenueUsd += usd;
    if (cur in byCurrency) byCurrency[cur] += usd;
    if (b.buyer) buyers.add(b.buyer);
    // the Pot's part: a Pot tip is all Pot; a split record its locked Pot share (22%, or 0 for an unreferred mining tip)
    pot += b.route === "tip" ? (+b.toPotUsd || usd) : usd * (frac(b.split, "pot") ?? POT_PCT / 100);
    const pr = usd * (frac(b.split, "preacher") || 0);
    preacherUsd += pr;
    const ref = b.split?.ref;
    if (ref && pr > 0) {
      const a = affMap[ref] || (affMap[ref] = { name: ref, tier: b.split.tier || "Preacher", buyers: new Set(), volume: 0, earnings: 0 });
      a.buyers.add(b.buyer); a.volume += usd; a.earnings += pr;
    }
  }
  const profit = revenueUsd - pot - preacherUsd;   // Reserve + ops: what stays with Degen Dojo

  const affiliates = Object.values(affMap)
    .map((a) => ({ name: a.name, tier: a.tier, buyers: a.buyers.size, volume: Math.round(a.volume), earnings: Math.round(a.earnings) }))
    .sort((x, y) => y.volume - x.volume)
    .slice(0, 25);

  const recent = buys
    .sort((a, b) => (b.recordedAt || b.ts || 0) - (a.recordedAt || a.ts || 0))
    .slice(0, 12)
    .map((b) => ({ buyer: b.buyer, coins: b.verified ? b.creditedCoins || 0 : 0, currency: b.split?.currency || b.currency,
      usd: b.verified ? +b.verifiedUsd || 0 : 0, ts: b.recordedAt || b.ts, referrer: b.verified ? b.split?.ref || null : null,
      status: b.verified ? "verified" : b.rejected ? "rejected" : "pending" }));

  const out = {
    coinsSold, buyers: buyers.size, revenueUsd: Math.round(revenueUsd),
    byCurrency: { ORE: Math.round(byCurrency.ORE), SKR: Math.round(byCurrency.SKR), SOL: Math.round(byCurrency.SOL) },
    pot: Math.round(pot), preachers: Math.round(preacherUsd), profit: Math.round(profit), pending, rejected,
    affiliates, recent,
  };
  return new Response(JSON.stringify(out), { headers: { "content-type": "application/json", "cache-control": "no-store" } });
};

export const config = { path: "/api/admin" };
