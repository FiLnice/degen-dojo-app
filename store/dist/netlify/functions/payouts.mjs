// Netlify Function: /api/payouts — the owner's weekly payout desk (backs /payouts). ADMIN_KEY only.
//
//   GET  ?round= (Bearer ADMIN_KEY)    → plan (default: latest) + open flags + draw status
//   POST {key, action:'rebuild', round}          → rebuild the plan (refused once any payment landed)
//   POST {key, action:'exclude', round, who, undo} → drop (or restore) a flagged payee. An excluded
//        WINNER's share stays in the pot: it's added back to the live pot when the round is paid, so
//        it's in next week's prize. An excluded PREACHER stays owed (records remain unpaid).
//   POST {key, action:'send', tx}                → relay ONE wallet-signed tx (base64) to SOLANA_RPC.
//        /api/rpc deliberately has no sendTransaction; this admin-only relay exists so the batch-signed
//        payout txs can be broadcast in order. It can't sign anything — the tx is already signed.
//   POST {key, action:'quote', round}           → SERVER-side Jupiter quote for the unpaid SOL/USDC shares;
//        the exact ORE each of those payees gets is recorded in plan.manifest (the page swaps with this
//        quote and sends exactly those amounts). A currency whose payees were already paid stays locked.
//   POST {key, action:'paid', round, sigs, payer, reviewed} → verify each sig on-chain (success, fee
//        payer = payer, one round per sig), check every payee received their due EXACTLY (BigInt, per
//        mint; SOL/USDC shares against the manifest — a browser-sent swapOre is ignored), commit
//        "paying", then mark preacher records paid / roll over / notify "Paid ✓" → 'partial' | 'paid'.
//
//   GET  ?statement=1                             → the weekly statement: COMES IN (last 7 days, per source) · GOES OUT
//        (this batch, line by line) · STAYS (the Treasury after the batch, the Pot, the Card Vaults)
//
// Dojo Keeper (card vaults, repairs, burn claims — store-keeper-core.mjs), same key:
//   GET  ?keeper=1                                → this week's Keeper desk: burn claims due (stORE), cards sent in
//        to burn, repairs pending (for keeper-apply-repairs.mjs), reserve / ops / unconverted totals
//   POST {action:'keeper-claims-paid', sigs, payer}  → verify the Treasury's stORE transfers, mark covered claims paid
//   POST {action:'keeper-burned', mints}             → mark sent-in cards burned (token supply is 0 on-chain)
//   POST {action:'keeper-repairs-applied', mints}    → the local apply step set these cards to "Mint"
//   POST {action:'keeper-convert-quote', inputMint}  → server Jupiter quote: unconverted vault+reserve share → stORE
//   POST {action:'keeper-converted', sig}            → verify the conversion swap and book it
//   POST {action:'keeper-scan'}                      → read the Treasury's newest transactions now
//   POST {action:'keeper-ops-quote'}                 → the operations share (12%) due to OPS_WALLET, per currency
//   POST {action:'keeper-ops-moved', sig}            → verify the Treasury → OPS_WALLET transfer and book it
//   POST {action:'keeper-refunds-paid', sigs, payer} → verify the Treasury's ORE refunds (repairs over the Mint cap)
//   POST {action:'keeper-set-mint-cap', cap}         → change the Mint cap NOW (no redeploy); logged with time + IP.
//        Payments already received keep the cap that was in force when they were paid.
//   The admin key travels ONLY in the Authorization header — a browser never attaches it on its own, so another
//   site can't forge these requests (no cookie, nothing ambient).
//
// No private key anywhere: the owner signs in their own wallet on /payouts.
import { limited } from "./store-ratelimit-core.mjs";
import { adminRequestOk } from "./store-session-core.mjs";
import { getStore } from "@netlify/blobs";
import { getPlan, latestPlanRound, buildAndStore, setExcluded, recordPayment, quoteSwaps, settlePayment, openFlags, alreadyPaidElsewhere, reservedWallets, weeklyStatement, MINTS } from "./store-payout-core.mjs";
import { latestRound, getPublic, DrawError } from "./store-draw-core.mjs";
import { keeperSummary, recordClaimsPaid, recordBurned, markRepairsApplied, conversionQuote, recordConversion, scanTreasury, opsMoveQuote, recordOpsMove, recordRefundsPaid, setMintCap, repairActivitySince, KeeperError } from "./store-keeper-core.mjs";
import { getPot } from "./store-pot-core.mjs";

const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store", "x-robots-tag": "noindex" } });
// admin key from the Authorization header only (constant-time, length-hiding compare in store-session-core)
const keyOk = (request) => adminRequestOk(request, "ADMIN_KEY");

async function view(round) {
  let plan = await getPlan(round);
  if (plan?.status === "paying") { try { plan = (await settlePayment(round)) || plan; } catch {} }   // finish an interrupted settlement
  const pub = await getPublic(round);
  const out = { round, latestDrawRound: await latestRound(), latestPlanRound: await latestPlanRound(), draw: pub, plan, reserved: [...reservedWallets().keys()] };
  if (plan) {
    out.openFlags = openFlags(plan);
    try {
      const dup = await alreadyPaidElsewhere(plan);
      for (const [id, n] of Object.entries(dup)) out.openFlags.push({ severity: "block", who: id, check: "g", reason: `${n} of this preacher's records were already marked paid elsewhere since this plan was built — rebuild the plan` });
    } catch {}
  } else out.canBuild = pub?.status === "drawn";
  return out;
}

// The weekly statement (GET ?statement=1): COMES IN (last 7 days) · GOES OUT (this batch) · STAYS — see
// store-payout-core.mjs weeklyStatement().
const WEEK = 7 * 86400e3;
// The Reserve's own 7-day reading of the Treasury = /api/reserve on this same site (public, cached a minute): income
// by source + today's balances. Read over HTTP — the deploy ships that function as reserve.mjs, so it isn't imported.
async function reserveWeek(request) {
  try {
    const r = await fetch(new URL("/api/reserve", request.url), { headers: { "user-agent": "dojo-payouts-statement" } });
    if (!r.ok) return null;
    const j = await r.json();
    const daily = Array.isArray(j.daily) ? j.daily : [];
    return { at: j.at || null, partial: !!j.partial, sources: j.sources || {}, holdings: daily.length ? daily[daily.length - 1].holdings || null : null };
  } catch { return null; }
}
// mining tips that came through a preacher link this week (verified records), per currency mint, UI units
async function minetipViaPreacher(since) {
  const store = getStore("coin-purchases"), out = {};
  const { blobs } = await store.list({ prefix: "buy:" });
  for (const b of blobs.slice(-3000)) {
    const r = await store.get(b.key, { type: "json" }).catch(() => null);
    if (!r || !r.verified || r.route !== "minetip" || !(r.split?.preacherPct > 0)) continue;
    if ((r.verifiedAt || r.ts || 0) < since) continue;
    const m = MINTS[r.split.currency || r.currency]; if (!m) continue;
    out[m] = (out[m] || 0) + (+r.verifiedAmount || 0);
  }
  return out;
}
async function statement(request) {
  const now = Date.now(), since = now - WEEK;
  const [reserve, keeper, pot, repairs, planRound, drawRound] = await Promise.all([
    reserveWeek(request), keeperSummary(), getPot().catch(() => null),
    repairActivitySince(since).catch(() => ({ granted: [], refunded: [] })), latestPlanRound(), latestRound().catch(() => 0)]);
  const plan = planRound ? await getPlan(planRound) : null;
  let drawNote = null;
  if (drawRound && drawRound > (planRound || 0)) {
    const pub = await getPublic(drawRound).catch(() => null);
    drawNote = pub?.status === "drawn" ? "Round " + drawRound + " is drawn — press Build plan below" : pub?.status === "committed" ? "Round " + drawRound + " draws automatically on draw day" : null;
  }
  const viaPreacher = await minetipViaPreacher(since).catch(() => ({}));
  return weeklyStatement({ now, reserve, viaPreacher, repairs, plan, drawNote, keeper, pot, prices: keeper.prices || {}, burnEnabled: !!keeper.burnEnabled, opsWallet: keeper.ops?.wallet || null });
}

export default async (request) => {
  const blocked = limited(request, "payouts", 30); if (blocked) return blocked;   // 30 / minute / IP (DD-04)
  const url = new URL(request.url);
  try {
    if (request.method === "GET") {
      if (!keyOk(request)) return json({ error: "forbidden" }, 403);
      if (url.searchParams.get("keeper")) return json(await keeperSummary());
      if (url.searchParams.get("statement")) return json(await statement(request));
      const round = Number(url.searchParams.get("round")) || (await latestPlanRound()) || (await latestRound());
      return json(await view(round));
    }
    if (request.method !== "POST") return json({ error: "GET or POST" }, 405);
    let body; try { body = await request.json(); } catch { return json({ error: "bad json" }, 400); }
    if (!keyOk(request)) return json({ error: "forbidden" }, 403);
    const round = Number(body.round) || (await latestPlanRound()) || (await latestRound());

    if (body.action === "rebuild") {
      await buildAndStore(round, { budgetMs: 8e3, notify: body.notify !== false });
      return json({ ok: true, ...(await view(round)) });
    }
    if (body.action === "exclude") {
      await setExcluded(round, String(body.who || ""), !body.undo);
      return json({ ok: true, ...(await view(round)) });
    }
    if (body.action === "send") {
      if (typeof body.tx !== "string" || body.tx.length > 2000 || !/^[A-Za-z0-9+/=]+$/.test(body.tx)) return json({ error: "bad tx" }, 400);
      const upstream = [process.env.SOLANA_RPC, process.env.HELIUS_RPC, "https://api.mainnet-beta.solana.com"].find((v) => typeof v === "string" && /^https?:\/\//.test(v.trim()));
      const r = await fetch(upstream.trim(), { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "sendTransaction", params: [body.tx, { encoding: "base64", skipPreflight: !!body.skipPreflight, maxRetries: 5 }] }) });
      const j = await r.json().catch(() => ({}));
      if (j.error) return json({ error: j.error.message || "send failed", logs: j.error.data?.logs || null }, 502);
      return json({ ok: true, signature: j.result });
    }
    if (body.action === "quote") {
      await quoteSwaps(round);
      return json({ ok: true, ...(await view(round)) });
    }
    if (body.action === "paid") {
      const res = await recordPayment({ round, sigs: body.sigs, payer: body.payer, reviewed: !!body.reviewed });
      return json({ ...res, ...(await view(round)) });
    }
    // ---- Dojo Keeper ----
    if (body.action === "keeper-claims-paid") return json({ ok: true, ...(await recordClaimsPaid({ sigs: body.sigs, payer: body.payer })), keeper: await keeperSummary() });
    if (body.action === "keeper-burned") return json({ ok: true, burned: await recordBurned(body.mints), keeper: await keeperSummary() });
    if (body.action === "keeper-repairs-applied") return json({ ok: true, applied: await markRepairsApplied(body.mints) });
    if (body.action === "keeper-convert-quote") return json({ ok: true, ...(await conversionQuote(String(body.inputMint || ""))) });
    if (body.action === "keeper-converted") return json({ ok: true, ...(await recordConversion(String(body.sig || ""))), keeper: await keeperSummary() });
    if (body.action === "keeper-scan") return json({ ok: true, scan: await scanTreasury({ max: 40, budgetMs: 8e3 }), keeper: await keeperSummary() });
    if (body.action === "keeper-ops-quote") return json({ ok: true, ...(await opsMoveQuote()) });
    if (body.action === "keeper-ops-moved") return json({ ok: true, ...(await recordOpsMove(String(body.sig || ""))), keeper: await keeperSummary() });
    if (body.action === "keeper-refunds-paid") return json({ ok: true, ...(await recordRefundsPaid({ sigs: body.sigs, payer: body.payer })), keeper: await keeperSummary() });
    if (body.action === "keeper-set-mint-cap") {
      const ip = request.headers.get("x-nf-client-connection-ip") || request.headers.get("x-forwarded-for") || null;
      return json({ ok: true, ...(await setMintCap(body.cap, { ip })), keeper: await keeperSummary() });
    }
    return json({ error: "unknown action" }, 400);
  } catch (e) {
    if (e instanceof DrawError || e instanceof KeeperError) return json({ error: e.message }, e.status);
    return json({ error: String(e?.message || e) }, 500);
  }
};

export const config = { path: "/api/payouts" };
