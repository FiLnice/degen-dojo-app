// Netlify Function: /api/reserve — everything that came INTO and went OUT of the Degen Dojo Reserve over the last 7 days.
//
//   GET → { at, partial, sources: { royalties, coins, mining, tips, direct, team, out }, payouts: [{ s, t, d, to }] }
//         each source = { <mint>: uiAmount }; payouts = the week's payout transactions with who received what (Solscan-linkable)
//         (SOL is reported under the wrapped-SOL mint; the page prices everything with Jupiter; "out" holds SIGNED net
//         deltas of the Reserve's own transactions — negative = paid out, so a swap nets to ~0)
//
// Read straight from the Reserve wallet's own on-chain history. Each payment IN is sorted:
//   royalties — a marketplace program paid the wallet (DD AuctionHouse, Magic Eden, Tensor)
//   mining    — it rode in an ORE program transaction (the /mine page's tip goes in the auto-mine tx)
//   tips      — it carries the ddtip memo (Dojo Pot tips)
//   coins     — a game-coin purchase the store verified (coin-purchases record for that signature)
//   direct    — anything else anyone sends straight to the Reserve (tips/donations, other fees)
//   team      — sent by the Dojo's own wallets or the owner (top-ups, not income)
// OUT — every transaction the Reserve signs itself (payouts, swaps…), as its net change.
//
// HISTORY (the Reserve page's 30-day "mountain"): every tx that touches the Treasury keeps its FULL signed change per mint
// (dd — payouts, swaps, top-ups, fees, failed txs' fees, everything), 30 days deep. The answer adds
//   daily: [{ day: "YYYY-MM-DD", holdings: { <mint>: uiAmount } }]   oldest → newest, end-of-day UTC
// rebuilt by taking the wallet's CURRENT balances and stepping backwards through those changes. A day is only returned
// once every tx after its end has been read (historyPartial: true while older days are still being backfilled).
//
// Incremental: classified signatures are kept in Blobs ("reserve-flow"), so each call reads only what's new
// (bounded by PER_CALL and a time budget; while a backlog inside the week remains the answer says partial: true).
// Cached for CACHE_MS.
import { getStore } from "@netlify/blobs";
import { limited } from "./store-ratelimit-core.mjs";
import { memosOf, TIP_MEMO } from "./store-ref-core.mjs";
import { MARKETPLACES } from "./store-royalty-core.mjs";
import { heliusKey, walkHistory } from "./store-helius-core.mjs";   // shared with the Dojo Keeper's Treasury reader

// Income lands in the Reserve wallet since the 2026-10-22 hand-over (royalties, coin buys, tips). ED3GMC (the old wallet behind shamanchef.sol — the name now points at the Treasury 5w55) only
// holds mined ORE now, so it isn't scanned — it is still "ours" for the internal-transfer rule.
const RESERVE = ["5w55F58ia3H71QjBD9bYvNQF2DcNu8K3AfJj9A4WMuWp"];
// the Dojo's own wallets + the owner's personal wallet (FTrH7Q) — money moved between these is not income
const OWN = new Set([...RESERVE, "ED3GMCfoX3XNvavnWADvd6oCsohGg1ukdhv3PaUpvwJe", "DfaGo3Qht6MC2bqgFCBHgUWjaeXDNmsbE7XjyRKWM3qS",
  ...(process.env.OWNER_WALLETS || "FTrH7Q3jJ2gkPwvpgR8KDGtmewRbB2RKBeKYaZH7hiNy").split(",").map((x) => x.trim()).filter(Boolean)]);
const COSIGNER = process.env.COSIGNER_PUBKEY || "8KUWwAHMb7TL31JGbucCi8YE1ax7njWi46ajVbWnvDqr";   // co-signs store sales; alone it's ours
// accounts that are still the Dojo's money: our wallets + the ORE miner / auto-mine accounts of the Reserve wallets
// (moving SOL into auto-mining or claiming back is "internal", not a payout)
const OURS = new Set([...OWN, COSIGNER,
  "7SSYaNT1iAh2L5WbwmJ4vNeQ2RGnSDumn98k8naFBGDD", "7u53XF8q8Axoy9gtFAqEGeZHCFnEevwRhogrM3qKsmce",   // Treasury: ORE miner, auto-mine
  "Gus9HWzX9x6oKvWr1Z6GyoV4TBUAPLAhDV5X8He4K5ws", "2nYhMAbfLKtNQhRtJcaWBv5SaFUm8GGjbz7DKowFPpwZ"]);   // Mining wallet: ORE miner, auto-mine
const ORE_PROGRAM = "oreV3EG1i9BEgiAJ8b177Z2S2rMarzak4NMv1kULvWv";
const SOL = "So11111111111111111111111111111111111111112";
const DAY_MS = 86400e3, WEEK_MS = 7 * DAY_MS, HIST_DAYS = 30, HIST_MS = HIST_DAYS * DAY_MS;
const CACHE_MS = 5 * 60e3, PER_CALL = 200, CONCURRENCY = 4, TIME_BUDGET_MS = 6500;
const STATE_V = 3;   // v3 = 30 days deep + each tx's full signed change (dd) + resumable gaps; an older state is rebuilt from scratch
const TOKEN_PROGRAMS = ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"];

async function rpc(method, params, tries = 3) {
  const r = await fetch(process.env.SOLANA_RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json().catch(() => ({ error: { code: r.status, message: "HTTP " + r.status } }));
  if (j.error && tries > 1 && (r.status === 429 || j.error.code === 429 || j.error.code === -32429)) {   // provider rate limit → back off
    await new Promise((res) => setTimeout(res, 400 * (4 - tries)));
    return rpc(method, params, tries - 1);
  }
  if (j.error) {
    if (method === "getTransaction" && params?.[1]?.maxSupportedTransactionVersion === 0 && (j.error.code === -32015 || /transaction version/i.test(j.error.message || "")))
      return rpc(method, [params[0], { ...params[1], maxSupportedTransactionVersion: 1 }]);
    throw new Error(j.error.message || method + " failed");
  }
  return j.result;
}

const keysOf = (tx) => [...(tx.transaction.message.accountKeys || []), ...(tx.meta?.loadedAddresses?.writable || []), ...(tx.meta?.loadedAddresses?.readonly || [])];
const signersOf = (tx) => (tx.transaction.message.accountKeys || []).slice(0, tx.transaction.message.header?.numRequiredSignatures || 1);
// the programs the tx actually RAN (top level + inner) — a marketplace id merely listed as an unused account in a plain
// transfer doesn't make it a royalty (security review 2026-10-23, M-1; same rule as the Keeper)
const invokedOf = (tx) => { const keys = keysOf(tx);
  return new Set([...(tx.transaction.message.instructions || []), ...(tx.meta?.innerInstructions || []).flatMap((x) => x.instructions || [])].map((ix) => (ix.programId != null ? String(ix.programId) : keys[ix.programIdIndex])).filter(Boolean)); };

/** The tx's full signed change to `wallet` per mint (SOL under the wrapped-SOL mint + fungible tokens; NFTs
 *  excluded) — fees included, and for a FAILED tx just the fee it still cost. {} when nothing changed. */
export function walletDelta(tx, wallet) {
  const delta = {};
  if (!tx || !tx.meta) return delta;
  const keys = keysOf(tx), i = keys.indexOf(wallet);
  if (i >= 0) { const sol = ((tx.meta.postBalances[i] || 0) - (tx.meta.preBalances[i] || 0)) / 1e9; if (sol) delta[SOL] = sol; }
  for (const [arr, sign] of [[tx.meta.preTokenBalances || [], -1], [tx.meta.postTokenBalances || [], 1]])
    for (const b of arr) if (b.owner === wallet && b.uiTokenAmount && b.uiTokenAmount.decimals > 0)
      delta[b.mint] = (delta[b.mint] || 0) + sign * Number(b.uiTokenAmount.uiAmountString || b.uiTokenAmount.uiAmount || 0);
  for (const m of Object.keys(delta)) if (Math.abs(delta[m]) < 1e-12) delete delta[m];
  return delta;
}

/** End-of-day (UTC) holdings for the last `days` days, oldest → newest: start from `current` (the wallet's balances
 *  at time `asOf`) and undo every recorded change (items[*].dd) made after each day's end. A day is returned only if
 *  no unread tx (`unknownAfter` = newest time of a tx not read yet) falls after its end — older days are dropped
 *  rather than shown wrong. */
export function reconstructDaily(current, items, asOf, { days = HIST_DAYS, unknownAfter = 0 } = {}) {
  const txs = Object.values(items || {}).filter((it) => it && it.dd && it.t <= asOf).sort((a, b) => b.t - a.t);
  const hold = { ...(current || {}) };
  const d0 = new Date(asOf), dayStart = Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth(), d0.getUTCDate());
  const out = [];
  let k = 0;
  for (let i = 0; i < days; i++) {
    const end = dayStart + DAY_MS - i * DAY_MS;                          // exclusive end of that day
    while (k < txs.length && txs[k].t >= end) { for (const [m, v] of Object.entries(txs[k].dd)) hold[m] = (hold[m] || 0) - v; k++; }
    if (unknownAfter && unknownAfter >= end) break;                      // a tx after this day is still unread → stop here
    const h = {};
    for (const [m, v] of Object.entries(hold)) if (v > 1e-9) h[m] = +v.toFixed(12);
    out.push({ day: new Date(end - 1).toISOString().slice(0, 10), holdings: h });
  }
  return out.reverse();
}

/** The wallet's balances right now: { <mint>: uiAmount } (SOL under the wrapped-SOL mint; NFTs excluded). */
async function currentHoldings(wallet) {
  const [bal, ...tas] = await Promise.all([rpc("getBalance", [wallet]),
    ...TOKEN_PROGRAMS.map((programId) => rpc("getTokenAccountsByOwner", [wallet, { programId }, { encoding: "jsonParsed" }]))]);
  const h = { [SOL]: (bal && bal.value != null ? bal.value : bal || 0) / 1e9 };
  for (const res of tas) for (const x of (res?.value || [])) {
    const ta = x.account?.data?.parsed?.info?.tokenAmount;
    if (!ta || !(ta.decimals > 0)) continue;
    const m = x.account.data.parsed.info.mint;
    h[m] = (h[m] || 0) + Number(ta.uiAmountString || ta.uiAmount || 0);
  }
  return h;
}

/** How this tx changed `wallet` and why: { src, d } (d = mint → amount), or null (nothing counted).
 *  "coins" here means "a plain payment from an outside wallet" — the handler keeps it as a coin buy only when
 *  the store holds a verified purchase for that signature, otherwise it becomes "direct". */
export function classify(tx, wallet) {
  if (!tx || tx.meta?.err) return null;
  const keys = keysOf(tx), signers = signersOf(tx), ran = invokedOf(tx);
  const market = [...ran].some((p) => MARKETPLACES.has(p));
  const delta = walletDelta(tx, wallet);                                  // signed change per mint (SOL + fungible tokens)
  if (!Object.keys(delta).length) return null;
  if (signers.includes(wallet)) {                                        // the Reserve's own transaction: net change + who got paid
    const to = [];
    keys.forEach((k, j) => { if (k !== wallet && j < tx.meta.postBalances.length) { const v = ((tx.meta.postBalances[j] || 0) - (tx.meta.preBalances[j] || 0)) / 1e9; if (v > 0) to.push({ a: k, m: SOL, v }); } });
    const tok = {};
    for (const [arr, sign] of [[tx.meta.preTokenBalances || [], -1], [tx.meta.postTokenBalances || [], 1]])
      for (const b of arr) if (b.owner && b.owner !== wallet && b.uiTokenAmount && b.uiTokenAmount.decimals > 0) {
        const k = b.owner + "|" + b.mint; tok[k] = (tok[k] || 0) + sign * Number(b.uiTokenAmount.uiAmountString || b.uiTokenAmount.uiAmount || 0);
      }
    for (const [k, v] of Object.entries(tok)) if (v > 1e-12) { const [a, m] = k.split("|"); to.push({ a, m, v }); }
    const outside = to.filter((r) => !OURS.has(r.a));
    if (!outside.length) return { src: "internal", d: delta };             // into our own auto-miner / a claim back: still ours
    return { src: "out", d: delta, to: outside.sort((x, y) => y.v - x.v).slice(0, 6) };
  }
  const d = Object.fromEntries(Object.entries(delta).filter(([, v]) => v > 0));
  if (!Object.keys(d).length) return null;
  if (signers.some((x) => OWN.has(x)) || (signers.includes(COSIGNER) && !market)) return { src: "team", d };   // our wallets / the owner
  const src = memosOf(tx).some((m) => m === TIP_MEMO || m.startsWith(TIP_MEMO)) ? "tips"
    : market ? "royalties" : ran.has(ORE_PROGRAM) ? "mining" : "coins";
  return { src, d };
}

function aggregate(state, now) {
  const sources = { royalties: {}, coins: {}, mining: {}, tips: {}, direct: {}, team: {}, out: {} };
  const payouts = [];   // every payout of the week, newest first: { s: signature, t, d: net change, to: [{ a, m, v }] }
  for (const [s, it] of Object.entries(state.items)) {
    if (!it.c || now - it.t > WEEK_MS || !sources[it.c.src]) continue;   // "internal" moves aren't shown
    for (const [m, v] of Object.entries(it.c.d)) sources[it.c.src][m] = (sources[it.c.src][m] || 0) + v;
    if (it.c.src === "out") payouts.push({ s, t: it.t, d: it.c.d, to: it.c.to || [] });
  }
  payouts.sort((a, b) => b.t - a.t);
  return { sources, payouts: payouts.slice(0, 50) };
}

export default async (request) => {
  const H = { "content-type": "application/json", "cache-control": "public, max-age=60" };
  if (request.method !== "GET") return new Response(JSON.stringify({ error: "GET only" }), { status: 405, headers: H });
  const blocked = limited(request, "reserve", 30); if (blocked) return blocked;   // 30 / minute / IP (DD-04)
  if (!process.env.SOLANA_RPC) return new Response(JSON.stringify({ error: "SOLANA_RPC is not set" }), { status: 500, headers: H });
  const store = getStore("reserve-flow"), now = Date.now(), since = now - HIST_MS;
  let state = await store.get("state", { type: "json" }).catch(() => null);
  if (!state || state.v !== STATE_V) state = { v: STATE_V, items: {}, newest: {}, pending: [], gaps: {}, at: 0, cur: null };
  state.pending = (state.pending || []).filter((p) => p.t >= since);
  if (now - state.at < CACHE_MS && !outstanding(state, now)) return answer(state, now);

  const started = Date.now(), key = heliusKey();
  try {
    // 0. the Treasury's balances right now — the History chart steps backwards from these
    state.cur = { at: Date.now(), h: await currentHoldings(RESERVE[0]) };
    if (key) {
      // Helius: read the history 100 txs per request with each tx's balance changes (the Treasury's own auto-mining
      // puts it in ~1,000+ txs a day, nearly none of which change its balances), then read in full only the
      // balance-changing ones inside the week, to sort the income
      for (const w of RESERVE) await ingestEnhanced(state, w, key, since, started);
      await classifyWeek(state, now, started);
    } else await ingestOneByOne(state, since, started);
  } catch (e) { /* RPC trouble: answer with what we have */ }

  for (const [s, it] of Object.entries(state.items)) if (now - it.t > HIST_MS) delete state.items[s];   // keep 30 days
  state.at = now;
  await store.setJSON("state", state).catch(() => {});
  return answer(state, now);
};

/** A Helius parsed tx's signed change to `wallet` (same meaning as walletDelta: SOL incl. fees + fungible tokens). */
export function enhancedDelta(e, wallet) {
  const d = {};
  for (const a of e?.accountData || []) {
    if (a.account === wallet && a.nativeBalanceChange) d[SOL] = (d[SOL] || 0) + a.nativeBalanceChange / 1e9;
    for (const c of a.tokenBalanceChanges || []) {
      const dec = c?.rawTokenAmount?.decimals;
      if (c.userAccount !== wallet || !(dec > 0)) continue;
      d[c.mint] = (d[c.mint] || 0) + Number(c.rawTokenAmount.tokenAmount) / 10 ** dec;
    }
  }
  for (const m of Object.keys(d)) if (Math.abs(d[m]) < 1e-12) delete d[m];
  return d;
}

/** Newest txs first back to the last one already read (or 30 days), via the shared reader; whatever doesn't fit in the
 *  time budget is left as a "gap" that later calls keep filling. Only txs that change the wallet are kept (the
 *  auto-mining noise is skipped; nothing is re-read). */
async function ingestEnhanced(state, w, key, since, started) {
  await walkHistory(state, w, key, { since, budgetOk: () => Date.now() - started < TIME_BUDGET_MS,
    onTx: (e, t) => { const dd = enhancedDelta(e, w); if (Object.keys(dd).length && !state.items[e.signature]) state.items[e.signature] = { t, dd }; } });
}

/** Sort the week's balance-changing txs into income sources (reads only those in full). */
async function classifyWeek(state, now, started) {
  const coinStore = getStore("coin-purchases");
  const todo = Object.entries(state.items).filter(([, it]) => now - it.t <= WEEK_MS && it.c === undefined && it.dd && Object.keys(it.dd).length)
    .sort((a, b) => b[1].t - a[1].t);
  for (let k = 0; k < todo.length && Date.now() - started < TIME_BUDGET_MS + 1500; k += CONCURRENCY) {
    await Promise.all(todo.slice(k, k + CONCURRENCY).map(async ([sig, it]) => {
      try {
        const tx = await rpc("getTransaction", [sig, { maxSupportedTransactionVersion: 0, encoding: "json" }]);
        if (!tx) return;                                                       // not readable yet → next call
        const c = classify(tx, RESERVE[0]);
        if (c && c.src === "coins") { const rec = await coinStore.get("buy:" + sig, { type: "json" }).catch(() => null); if (!rec) c.src = "direct"; }
        it.c = c;
      } catch { /* next call */ }
    }));
  }
}

/** Is there still work that a cached answer would hide? */
function outstanding(state, now) {
  if (state.pending.length) return true;
  if (Object.values(state.gaps || {}).some((g) => g.length)) return true;
  return Object.values(state.items).some((it) => now - it.t <= WEEK_MS && it.c === undefined && it.dd && Object.keys(it.dd).length);
}

// Without a Helius key: list every signature and read each tx in full (slow for a busy wallet, but exact)
async function ingestOneByOne(state, since, started) {
    // 1. discover new signatures per wallet (cheap), newest first, back to the cursor or 30 days.
    //    Failed txs are kept too: they still cost the fee payer its fee (History needs it; classify ignores them).
    for (const w of RESERVE) {
      let before, first = null, done = false;
      for (let page = 0; page < 5 && !done; page++) {
        const sigs = await rpc("getSignaturesForAddress", [w, { limit: 1000, ...(before ? { before } : {}) }]);
        if (!sigs?.length) break;
        for (const s of sigs) {
          if (s.signature === state.newest[w] || (s.blockTime || 0) * 1000 < since) { done = true; break; }
          first = first || s.signature;
          if (!state.items[s.signature] && !state.pending.some((p) => p.s === s.signature)) state.pending.push({ s: s.signature, w, t: (s.blockTime || 0) * 1000 });
        }
        before = sigs[sigs.length - 1].signature;
        if (sigs.length < 1000) break;
      }
      if (first) state.newest[w] = first;
    }
    // 2. read + classify, newest first, up to PER_CALL and inside the time budget (a backfill takes a few calls)
    const coinStore = getStore("coin-purchases");
    state.pending.sort((a, b) => b.t - a.t);
    const batch = state.pending.splice(0, PER_CALL), retry = [];
    for (let k = 0; k < batch.length; k += CONCURRENCY) {
      if (Date.now() - started > TIME_BUDGET_MS) { retry.push(...batch.slice(k)); break; }
      await Promise.all(batch.slice(k, k + CONCURRENCY).map(async (p) => {
        try {
          const tx = await rpc("getTransaction", [p.s, { maxSupportedTransactionVersion: 0, encoding: "json" }]);
          if (!tx) { retry.push(p); return; }                               // not readable yet → next call
          const c = classify(tx, p.w);
          // a plain outside payment is a coin buy only if the store verified it as one; anything else is "direct"
          if (c && c.src === "coins") { const rec = await coinStore.get("buy:" + p.s, { type: "json" }).catch(() => null); if (!rec) c.src = "direct"; }
          state.items[p.s] = { t: p.t, c, dd: walletDelta(tx, p.w) };
        } catch { retry.push(p); }
      }));
    }
    state.pending.push(...retry);
}

// sources/payouts = the last 7 days (unchanged); daily = the 30-day History, only the days that are fully read
function answer(state, now) {
  const H = { "content-type": "application/json", "cache-control": "public, max-age=60" };
  const gapList = Object.values(state.gaps || {}).flat();
  const unknownAfter = Math.max(state.pending.reduce((m, p) => Math.max(m, p.t), 0), gapList.reduce((m, g) => Math.max(m, g.t || 0), 0));
  const daily = state.cur ? reconstructDaily(state.cur.h, state.items, state.cur.at, { unknownAfter }) : [];
  const weekUnsorted = Object.values(state.items).some((it) => now - it.t <= WEEK_MS && it.c === undefined && it.dd && Object.keys(it.dd).length);
  return new Response(JSON.stringify({
    at: state.at,
    // the WEEK still has unread or unsorted txs
    partial: state.pending.some((p) => now - p.t <= WEEK_MS) || gapList.some((g) => now - (g.t || 0) <= WEEK_MS) || weekUnsorted,
    ...aggregate(state, now),
    daily, historyPartial: state.pending.length > 0 || gapList.length > 0,
  }), { headers: H });
}

export const config = { path: "/api/reserve" };
