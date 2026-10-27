// Weekly payout engine — shared by the payout cron (store-fn-payout-cron.mjs) and the admin API
// (/api/payouts, store-fn-payouts.mjs). NO private key lives here or anywhere on the server:
// this only PLANS the payout and VERIFIES it afterwards. The owner pays from /payouts with their
// own wallet (one approval), and the page posts the signatures back for verification.
//
//   cronTick()          weekly state machine: commit → draw → build plan → notify (+ resumes a
//                       payment settlement a crashed call left in "paying")
//   buildPlan(round)    winners (5 ranks, 40/25/15/10/10% of the round's pot snapshot, per token; unfilled ranks → next week) +
//                       preachers (owed ≥ MIN_PREACHER_PAYOUT_USD) + fraud flags
//   quoteSwaps(round)   SERVER-side Jupiter quote for the SOL/USDC shares → the exact ORE each payee
//                       gets is recorded in the plan's manifest (the browser never says what's due)
//   recordPayment(...)  verify the pay txs on-chain, then two-phase: commit covered payees +
//                       "paying" in ONE conditional write → mark preacher records / roll over /
//                       notify (idempotent) → "partial" | "paid"
//
// Raw token amounts are BigInt in code and decimal strings in JSON (ORE has 11 decimals, so a Number
// stops being exact above ~90,071 ORE). USD stays a float — it is display / fraud-check only.
//
// Blobs "payouts": round:<n> (plan), latest (n), cycle (cron state), sig:<sig> (one round per
// payment signature), notified:paid:<n> (the "Paid ✓" notice went out).
// Env: SOLANA_RPC, DRAW_DAY (0=Sun, default 0), DRAW_HOUR_UTC (default 18), PAYOUT_CAP_USD
// (default 300), MIN_PREACHER_PAYOUT_USD (default 1), TREASURY_WALLET, POT_WALLET,
// ROYALTY_WALLET, COSIGNER_PUBKEY, TEAM_WALLETS (comma list), STORE_URL.
import { getStore } from "@netlify/blobs";
import { getPot, addToPot, LEGACY_POT_FRAC } from "./store-pot-core.mjs";
import { computePreacherOwed, markPreacherPaid, preacherRiskFlags } from "./store-preacher-core.mjs";
import { commitRound, drawRound, latestRound, getPublic, verifyDraw, rpc, DrawError } from "./store-draw-core.mjs";
import { notify } from "./store-notify.mjs";
import { casUpdate, readWithEtag, putIfMatch, putIfNew } from "./store-cas-core.mjs";
import { createHash, randomUUID } from "node:crypto";

export const MINTS = { ORE: "oreoU2P8bN6jkk3jbaiVxYnG1dCXcYxwhwyK9jSybcp", SKR: "SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3", USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", SOL: "So11111111111111111111111111111111111111112" };
export const DEC = { ORE: 11, SKR: 6, SOL: 9, USDC: 6 };
const ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const DAY = 86400e3;
const env = (k, d) => { const v = process.env[k]; return v == null || v === "" ? d : v; };
const num = (k, d) => { const v = Number(process.env[k]); return Number.isFinite(v) && process.env[k] !== "" && process.env[k] != null ? v : d; };
export const storeUrl = () => String(env("STORE_URL", "https://store.degendojo.xyz")).replace(/\/+$/, "");
const payStore = () => getStore("payouts");

// ---------- money helpers (raw integer base units: BigInt in code, decimal strings in JSON) ----------
// A raw value read back from JSON → BigInt. Plans saved before the BigInt change hold integer Numbers.
export function big(v) {
  if (typeof v === "bigint") return v;
  if (typeof v === "string") return /^\s*-?\d+\s*$/.test(v) ? BigInt(v.trim()) : 0n;   // decimal strings only ("1e5", "0x10" → 0)
  return typeof v === "number" && Number.isFinite(v) ? BigInt(Math.trunc(v)) : 0n;
}
const S = (b) => big(b).toString();
const RAW_CURS = ["ORE", "SKR", "SOL", "USDC"];
export const payOf = (p) => Object.fromEntries(RAW_CURS.map((c) => [c, big(p?.pay?.[c])]));
// A UI amount (the pot / preacher ledgers keep floats) → raw BigInt, floored, through its shortest
// round-trip decimal string ("1234567.89", not 1234567.8899999998…) — never `amount * 10 ** dec`.
export function toRaw(amount, cur) {
  const n = Number(amount), d = DEC[cur];
  if (!(n > 0)) return 0n;
  if (n >= 1e21) throw new Error(`amount ${amount} ${cur} out of range`);
  let s = String(n);
  if (/e/i.test(s)) s = n.toFixed(Math.min(100, d + 3));   // tiny amounts print as 1e-7
  const [i, f = ""] = s.split(".");
  return BigInt(i + f.slice(0, d).padEnd(d, "0"));
}
// raw → a float in UI units: for DISPLAY and the float pot ledger only, never for a settlement decision
export const fromRaw = (raw, cur) => Number(big(raw)) / 10 ** DEC[cur];
// Equal integer split; the rounding remainder goes to the first payees one unit each.
export function splitEqual(total, n) {
  total = big(total);
  if (!(n > 0)) return [];
  const N = BigInt(n), base = total / N, out = Array(n).fill(base);
  for (let i = 0, rem = total - base * N; rem > 0n; i++, rem--) out[i % n] += 1n;
  return out;
}
// Proportional integer split of `total` by BigInt weights; the remainder goes one unit at a time to
// the largest weights (ties: plan order). Sum of the result === total.
export function allocate(total, parts) {
  total = big(total);
  const res = {}, sum = parts.reduce((s, p) => s + big(p.weight), 0n);
  if (!(sum > 0n) || !(total > 0n)) { for (const p of parts) res[p.id] = 0n; return res; }
  let given = 0n;
  for (const p of parts) { res[p.id] = (total * big(p.weight)) / sum; given += res[p.id]; }
  const order = parts.map((p, i) => [p, i]).sort((a, b) => (big(b[0].weight) > big(a[0].weight) ? 1 : big(b[0].weight) < big(a[0].weight) ? -1 : a[1] - b[1])).map(([p]) => p);
  for (let k = 0, rem = total - given; rem > 0n && order.length; k++, rem--) res[order[k % order.length].id] += 1n;
  return res;
}
const fmt = (raw, cur, dp = 4) => fromRaw(raw, cur).toLocaleString("en-US", { maximumFractionDigits: dp });

// wallets that must never receive a payout (they're ours)
export function reservedWallets() {
  const m = new Map();
  const add = (w, label) => { if (ADDR_RE.test(w || "")) m.set(w, m.get(w) ? m.get(w) + " / " + label : label); };
  add(env("TREASURY_WALLET", "5w55F58ia3H71QjBD9bYvNQF2DcNu8K3AfJj9A4WMuWp"), "treasury");
  add(env("POT_WALLET", "5w55F58ia3H71QjBD9bYvNQF2DcNu8K3AfJj9A4WMuWp"), "pot wallet");
  add(env("ROYALTY_WALLET", "5w55F58ia3H71QjBD9bYvNQF2DcNu8K3AfJj9A4WMuWp"), "royalty wallet");
  add("DfaGo3Qht6MC2bqgFCBHgUWjaeXDNmsbE7XjyRKWM3qS", "update authority");
  add("ED3GMCfoX3XNvavnWADvd6oCsohGg1ukdhv3PaUpvwJe", "retired authority");
  add("HEyazxpV2wxMUvNx53UZUXthRS9Rjsbv7hoHYJNbVedC", "DD creator");
  add(env("COSIGNER_PUBKEY", "8KUWwAHMb7TL31JGbucCi8YE1ax7njWi46ajVbWnvDqr"), "marketplace cosigner");
  add(env("OPERATOR_WALLET", ""), "operator");
  add(env("OPS_WALLET", ""), "operations wallet");
  // the owner's own wallets (same default as the Keeper's OWN set)
  for (const w of String(env("OWNER_WALLETS", "FTrH7Q3jJ2gkPwvpgR8KDGtmewRbB2RKBeKYaZH7hiNy")).split(/[\s,]+/)) add(w, "owner wallet");
  for (const w of String(env("TEAM_WALLETS", "")).split(/[\s,]+/)) add(w, "team wallet");
  return m;
}

// ---------- weekly clock ----------
// The most recent draw time (DRAW_DAY at DRAW_HOUR_UTC) at or before `now`.
export function lastDrawTime(now = Date.now(), day = num("DRAW_DAY", 0), hour = num("DRAW_HOUR_UTC", 18)) {
  const d = new Date(now);
  let t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hour) - ((d.getUTCDay() - day + 7) % 7) * DAY;
  if (t > now) t -= 7 * DAY;
  return t;
}
export const CATCHUP_MS = 48 * 3600e3;   // a draw missed by more than this (e.g. first deploy mid-week) waits for next week

// ---------- time-budgeted helpers (Netlify scheduled functions stop at ~30s) ----------
function budget(deadline) {
  return (p) => new Promise((resolve, reject) => {
    const ms = deadline - Date.now();
    if (ms <= 0) return reject(new Error("time budget used up"));
    const t = setTimeout(() => reject(new Error("time budget used up")), ms); t.unref?.();
    Promise.resolve(p).then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}
async function pool(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
  return out;
}

// ---------- on-chain wallet history (bounded) ----------
const keyStr = (k) => (typeof k === "string" ? k : k?.pubkey || String(k));
// getTransaction that also reads v1 transactions (mainnet now has them): ask for v0 first and,
// on -32015 "transaction version not supported", retry allowing v1.
export async function getTx(sig, encoding = "json") {
  const opts = (v) => [sig, { maxSupportedTransactionVersion: v, encoding, commitment: "confirmed" }];
  try { return await rpc("getTransaction", opts(0)); }
  catch (e) { if (e.code === -32015 || /transaction version/i.test(String(e.message))) return await rpc("getTransaction", opts(1)); throw e; }
}
// Oldest signature of a wallet, paging getSignaturesForAddress up to `pages` × 1000.
// complete=false when the wallet has more history than we paged (= not a fresh wallet).
export async function firstActivity(wallet, pages = 3) {
  let before, last = null;
  for (let p = 0; p < pages; p++) {
    const sigs = await rpc("getSignaturesForAddress", [wallet, { limit: 1000, ...(before ? { before } : {}) }]);
    if (!sigs?.length) return last ? { ...last, complete: true } : { sig: null, blockTime: null, complete: true, count: 0 };
    last = { sig: sigs[sigs.length - 1].signature, blockTime: sigs[sigs.length - 1].blockTime || null };
    if (sigs.length < 1000) return { ...last, complete: true };
    before = last.sig;
  }
  return { ...last, complete: false };
}
// Who first sent this wallet SOL: the fee payer of its oldest tx (if not itself), else the
// account whose SOL dropped the most in that tx.
export async function funderOf(wallet, first) {
  if (!first?.sig || !first.complete) return null;
  const tx = await getTx(first.sig, "json");
  if (!tx) return null;
  const keys = [...(tx.transaction?.message?.accountKeys || []), ...(tx.meta?.loadedAddresses?.writable || []), ...(tx.meta?.loadedAddresses?.readonly || [])].map(keyStr);
  if (keys[0] && keys[0] !== wallet) return keys[0];
  let best = null, drop = 0;
  const pre = tx.meta?.preBalances || [], post = tx.meta?.postBalances || [];
  for (let i = 0; i < keys.length; i++) { const d = (pre[i] || 0) - (post[i] || 0); if (keys[i] !== wallet && d > drop) { drop = d; best = keys[i]; } }
  return best;
}

// ---------- records ----------
async function purchaseRecords() {
  const store = getStore("coin-purchases");
  const { blobs } = await store.list({ prefix: "buy:" });
  const out = [];
  for (const b of blobs) { const r = await store.get(b.key, { type: "json" }); if (r) out.push(r); }
  return out;
}
async function potSnapshots() {
  const store = getStore("pot");
  const { blobs } = await store.list({ prefix: "round:" });
  const out = {};
  for (const b of blobs) { const s = await store.get(b.key, { type: "json" }); if (s) out[Number(b.key.slice(6))] = s; }
  return out;
}

// ---------- the plan ----------
// Payee: { id, kind:'winner'|'preacher', wallet, label, usd, pay:{ORE,SKR,SOL,USDC} raw units as
//   decimal strings }. pay.ORE / pay.SKR are transferred as-is; pay.SOL / pay.USDC are swapped to ORE
//   at pay time, and the ORE each payee gets for them is fixed by the server quote (plan.manifest).
export function potTotals(snap) {
  const t = { sol: 0, ore: 0, skr: 0 };
  for (const r of Object.values(snap?.routes || {})) { t.sol += +r.sol || 0; t.ore += +r.ore || 0; t.skr += +r.skr || 0; }
  return t;
}
// Weekly prize tiers (owner 2026-10-27): 1st 40% · 2nd 25% · 3rd 15% · 4th 10% · 5th 10% of the round's pot, per token.
// Rank = the provably-fair pick order (store-draw-core pickWinners). The shares are fixed per rank — a rank nobody filled
// (fewer than 5 entrants) rolls into next week's Pot (unfilledShares + rollUnfilled), it is never shared out.
export const PRIZE_TIERS = [40n, 25n, 15n, 10n, 10n];
// Integer split of `total` base units over the 5 ranks: floor(total × pct / 100) each, the rounding dust to 1st. Sum === total.
export function tierSplit(total) {
  total = big(total);
  const out = PRIZE_TIERS.map((p) => (total * p) / 100n);
  out[0] += total - out.reduce((a, b) => a + b, 0n);
  return out;
}
const drawnWinners = (pub) => (pub?.winners || []).filter((w) => ADDR_RE.test(w.wallet || "")).slice(0, PRIZE_TIERS.length);
const potRaw = (snap) => { const t = potTotals(snap); return { ORE: toRaw(t.ore, "ORE"), SKR: toRaw(t.skr, "SKR"), SOL: toRaw(t.sol, "SOL") }; };
export function winnerPayees(pub, snap) {
  const ws = drawnWinners(pub);
  if (!ws.length) return [];
  const raw = potRaw(snap), sp = { ORE: tierSplit(raw.ORE), SKR: tierSplit(raw.SKR), SOL: tierSplit(raw.SOL) };
  const usdAll = +snap?.usd || 0;
  return ws.map((w, i) => ({ id: "w:" + w.wallet, kind: "winner", rank: i + 1, pct: Number(PRIZE_TIERS[i]), wallet: w.wallet, label: w.name || w.wallet, tickets: w.tickets || 0,
    usd: +(usdAll * Number(PRIZE_TIERS[i]) / 100).toFixed(2), pay: { ORE: S(snap ? sp.ORE[i] : 0n), SKR: S(snap ? sp.SKR[i] : 0n), SOL: S(snap ? sp.SOL[i] : 0n), USDC: "0" } }));
}
// The shares of the ranks nobody filled this round (fewer than 5 winners drawn): what rolls into next week's Pot.
// null when all 5 ranks were drawn, or when there's no snapshot (no entrants → the draw kept the whole pot already).
export function unfilledShares(pub, snap) {
  const n = drawnWinners(pub).length;
  if (!snap || !n || n >= PRIZE_TIERS.length) return null;
  const raw = potRaw(snap), out = { ranks: [], pct: 0, usd: 0, ORE: "0", SKR: "0", SOL: "0" };
  for (const c of ["ORE", "SKR", "SOL"]) out[c] = S(tierSplit(raw[c]).slice(n).reduce((a, b) => a + b, 0n));
  for (let i = n; i < PRIZE_TIERS.length; i++) { out.ranks.push(i + 1); out.pct += Number(PRIZE_TIERS[i]); }
  out.usd = +((+snap.usd || 0) * out.pct / 100).toFixed(2);
  return out;
}
// Add a plan's unfilled shares to the live Pot — once per round: a create-only marker in Blobs "payouts"
// (unfilled:r<n>) is written after the adds, and each add is id-guarded (unfilled:r<n>:<cur>), so a plan rebuilt
// later or a retry after a crash never adds them twice.
export async function rollUnfilled(round, plan) {
  const u = plan?.unfilled;
  if (!u) return null;
  if (await payStore().get("unfilled:r" + round)) return { already: true };
  const curs = ["ORE", "SKR", "SOL"].filter((c) => big(u[c]) > 0n);
  for (const c of curs) await addToPot({ usd: (u.usd || 0) / curs.length, currency: c, native: fromRaw(big(u[c]), c), route: "rollover", id: `unfilled:r${round}:${c}` });
  await putIfNew(payStore(), "unfilled:r" + round, { round, ranks: u.ranks, pct: u.pct, at: Date.now() });
  return { rolled: curs };
}
export function preacherPayees(rows, minUsd = num("MIN_PREACHER_PAYOUT_USD", 1)) {
  const payees = [], skipped = [];
  for (const r of rows || []) {
    if (!(r.owedUsd >= minUsd)) continue;
    if (!ADDR_RE.test(r.wallet || "")) { skipped.push({ code: r.code, owedUsd: r.owedUsd, reason: "no wallet linked" }); continue; }
    const pay = { ORE: 0n, SKR: 0n, SOL: 0n, USDC: 0n }, other = {};
    for (const [cur, amt] of Object.entries(r.owedNative || {})) {
      if (!(amt > 0)) continue;
      if (cur in pay) pay[cur] += toRaw(amt, cur); else other[cur] = amt;
    }
    if (!(pay.ORE + pay.SKR + pay.SOL + pay.USDC > 0n)) { skipped.push({ code: r.code, owedUsd: r.owedUsd, reason: "owed only in unsupported token(s) " + Object.keys(other).join(", ") }); continue; }
    payees.push({ id: "p:" + String(r.code).toLowerCase(), kind: "preacher", wallet: r.wallet, label: r.code, code: r.code, tier: r.tier, share: r.share,
      usd: +(+r.owedUsd).toFixed(2), paidUsdBefore: +(+r.paidUsd || 0).toFixed(2), pay: Object.fromEntries(RAW_CURS.map((c) => [c, S(pay[c])])), unsupported: other,
      sigs: (r.unpaidSigs || []).map((s) => s.sig).filter(Boolean) });
  }
  return { payees, skipped };
}
export function planTotals(payees, excluded = []) {
  const ex = new Set(excluded), raw = { ORE: 0n, SKR: 0n, SOL: 0n, USDC: 0n };
  let usd = 0;
  for (const p of payees) { if (ex.has(p.id)) continue; const pay = payOf(p); for (const c of RAW_CURS) raw[c] += pay[c]; usd += p.usd || 0; }
  return { ...Object.fromEntries(RAW_CURS.map((c) => [c, S(raw[c])])), usd: +usd.toFixed(2) };
}

// ---------- fraud checks ----------
// Each returns flags [{severity:'warn'|'block', who, check, reason}]. `who` is a payee id,
// a wallet, or 'plan'. A check that can't run → a warn "couldn't check …".
const cant = (check, what, e) => ({ severity: "warn", who: "plan", check, reason: `couldn't check ${what}${e ? " (" + (e.message || e) + ")" : ""}` });

export function checkTicketConcentration(entries, totalTickets, winnerIds = new Set(), limit = 0.4) {
  const flags = [];
  if (!(totalTickets > 0)) return flags;
  for (const e of entries) {
    const f = e.tickets / totalTickets;
    if (f > limit) flags.push({ severity: "warn", who: winnerIds.has("w:" + e.wallet) ? "w:" + e.wallet : e.wallet, check: "a",
      reason: `one wallet holds ${(f * 100).toFixed(0)}% of this round's tickets (${e.tickets}/${totalTickets})` });
  }
  return flags;
}
export function checkReserved(payees, reserved = reservedWallets()) {
  return payees.filter((p) => reserved.has(p.wallet)).map((p) => ({ severity: "block", who: p.id, check: "d", reason: `pays our own ${reserved.get(p.wallet)} (${p.wallet.slice(0, 4)}…)` }));
}
// The cap compares what the payout is worth NOW (live spot prices of the raw totals), not just the purchase-time USD
// the pot / preacher ledgers carry — whichever is higher. No live price → the ledger USD.
export async function liveUsd(totals, within = (p) => p) {
  let live = 0;
  try {
    const px = await within(spotPrices(RAW_CURS.map((c) => MINTS[c])));
    for (const c of RAW_CURS) if (big(totals[c]) > 0n && px[MINTS[c]] > 0) live += fromRaw(totals[c], c) * px[MINTS[c]];
  } catch {}
  return Math.max(+totals.usd || 0, +live.toFixed(2));
}
export function checkCap(totalUsd, cap = num("PAYOUT_CAP_USD", 300)) {
  return totalUsd > cap ? [{ severity: "warn", who: "plan", check: "f", reason: `total payout ≈ $${totalUsd.toFixed(2)} is over the $${cap} cap` }] : [];
}
// (b) + (c): new winner wallets and winners funded from the same wallet
export async function checkWinnerWallets(winners, { now = Date.now(), within = budget(Date.now() + 20e3), cache = new Map() } = {}) {
  const flags = [], funders = new Map();
  await pool(winners, 4, async (w) => {
    let first;
    try { first = await within(firstActivity(w.wallet)); cache.set(w.wallet, first); }
    catch (e) { flags.push({ severity: "warn", who: w.id, check: "b", reason: "couldn't check wallet age (" + (e.message || e) + ")" }); return; }
    if (first.complete) {
      if (!first.blockTime) flags.push({ severity: "warn", who: w.id, check: "b", reason: "wallet has no on-chain history" });
      else if (now - first.blockTime * 1000 < 7 * DAY) flags.push({ severity: "warn", who: w.id, check: "b", reason: `new wallet — first activity ${((now - first.blockTime * 1000) / DAY).toFixed(1)} days ago` });
      try { const f = await within(funderOf(w.wallet, first)); if (f) funders.set(w.id, f); }
      catch (e) { flags.push({ severity: "warn", who: w.id, check: "c", reason: "couldn't check who funded this wallet (" + (e.message || e) + ")" }); }
    }
  });
  const byFunder = new Map();
  for (const [id, f] of funders) byFunder.set(f, [...(byFunder.get(f) || []), id]);
  for (const [f, ids] of byFunder) if (ids.length > 1) for (const id of ids)
    flags.push({ severity: "warn", who: id, check: "c", reason: `${ids.length} winners were first funded by the same wallet ${f.slice(0, 4)}…${f.slice(-4)}` });
  return flags;
}
// (g) preacher whose referred buyers were funded by the preacher's own wallet, or whose referred
// spend jumped > 10× vs what they were paid before.
export async function checkPreachers(preachers, records, { within = budget(Date.now() + 20e3), maxBuyersEach = 6, maxBuyers = 30 } = {}) {
  const flags = [];
  const bySig = new Map(records.map((r) => [r.sig, r]));
  const jobs = [];
  for (const p of preachers) {
    if (p.paidUsdBefore > 0 && p.usd > 10 * p.paidUsdBefore)
      flags.push({ severity: "warn", who: p.id, check: "g", reason: `owed $${p.usd} is over 10× everything paid before ($${p.paidUsdBefore})` });
    else if (!(p.paidUsdBefore > 0) && p.usd >= 100)
      flags.push({ severity: "warn", who: p.id, check: "g", reason: `first payout and already $${p.usd}` });
    const buyers = [...new Set(p.sigs.map((s) => bySig.get(s)?.buyer).filter((b) => ADDR_RE.test(b || "") && b !== p.wallet))].slice(0, maxBuyersEach);
    for (const b of buyers) jobs.push({ p, b });
  }
  const capped = jobs.slice(0, maxBuyers);
  if (jobs.length > capped.length) flags.push({ severity: "warn", who: "plan", check: "g", reason: `only ${capped.length} of ${jobs.length} referred buyers were checked for preacher funding (limit)` });
  const failed = new Set();
  await pool(capped, 4, async ({ p, b }) => {
    try {
      const first = await within(firstActivity(b, 1));
      const f = first.complete ? await within(funderOf(b, first)) : null;
      if (f && f === p.wallet) flags.push({ severity: "block", who: p.id, check: "g", reason: `referred buyer ${b.slice(0, 4)}…${b.slice(-4)} was funded by this preacher's own wallet` });
    } catch (e) { failed.add(p.id); }
  });
  for (const id of failed) flags.push({ severity: "warn", who: id, check: "g", reason: "couldn't check who funded some referred buyers" });
  return flags;
}
// (h) the pot ledger's coin-pack + tip totals for the round vs the verified records in its window.
// Records verified since 2026-10-23 carry their exact Pot share (split.pot — a coin buy: 22% until 2026-10-27, then 32–76%;
// a mining tip: 22% when referred until 10-27, 0 since);
// a Dojo Pot tip is 100%; older records (no split) used 65% of a coin pack and 100% of any tip.
export function checkPotLedger(snap, prevClosedAt, records, tol = 0.01) {
  if (!snap) return [];
  const exp = { coinbuy: { sol: 0, ore: 0, skr: 0 }, tip: { sol: 0, ore: 0, skr: 0 }, minetip: { sol: 0, ore: 0, skr: 0 } };
  const k = { SOL: "sol", ORE: "ore", SKR: "skr" };
  for (const r of records) {
    if (!r.verified || r.rejected || !k[r.currency]) continue;
    const t = r.verifiedAt || 0;
    if (!(t > (prevClosedAt || 0) && t <= snap.closedAt)) continue;
    const route = exp[r.route] ? r.route : r.kind === "tip" ? "tip" : "coinbuy";
    const amt = r.split ? Number(BigInt(r.split.pot || "0")) / 10 ** (+r.split.dec || 9)
      : route === "coinbuy" ? (+r.verifiedAmount || 0) * LEGACY_POT_FRAC : (+r.verifiedAmount || 0);
    exp[route][k[r.currency]] += amt;
  }
  const flags = [];
  for (const route of ["coinbuy", "tip", "minetip"]) for (const c of ["sol", "ore", "skr"]) {
    const led = +snap.routes?.[route]?.[c] || 0, want = exp[route][c];
    if (Math.abs(led - want) > Math.max(led, want) * tol + 1e-9)
      flags.push({ severity: "block", who: "plan", check: "h", reason: `pot ledger ${route} ${c.toUpperCase()} = ${+led.toFixed(6)} but verified records add up to ${+want.toFixed(6)}` });
  }
  return flags;
}

// ---------- build ----------
export async function getPlan(round) { return round ? await payStore().get("round:" + round, { type: "json" }) : null; }
export async function latestPlanRound() { return Number((await payStore().get("latest")) || 0); }

export async function buildPlan(round, { budgetMs = 20e3, excluded = [], now = Date.now(), noPreachers = false } = {}) {
  const deadline = Date.now() + budgetMs, within = budget(deadline);
  const pub = await getPublic(round);
  if (!pub || pub.status !== "drawn") throw new DrawError(`round ${round} is not drawn yet`);
  const flags = [];
  const snaps = await potSnapshots();
  const snap = snaps[round] || null;
  const prevClosedAt = Math.max(0, ...Object.entries(snaps).filter(([k]) => Number(k) < round).map(([, s]) => s.closedAt || 0));
  if (!snap && (pub.winners || []).length) flags.push({ severity: "block", who: "plan", check: "h", reason: pub.manualPot ? "manual ?potSol draw — no pot snapshot, so winners get nothing in this plan" : "no pot snapshot for this round" });

  const winners = winnerPayees(pub, snap);
  let rows = [];
  // preachers are owed everything unpaid, so ONLY the newest plan carries them (an older round rebuilt later would
  // otherwise list the same records as the newer plan — both payable = paid twice)
  if (!noPreachers) try { rows = await within(computePreacherOwed()); } catch (e) { flags.push(cant("g", "preacher payouts", e)); }
  const { payees: preachers, skipped } = preacherPayees(rows);
  for (const s of skipped) flags.push({ severity: "warn", who: "p:" + String(s.code).toLowerCase(), check: "g", reason: `owed $${(+s.owedUsd).toFixed(2)} but ${s.reason} — not in this payout` });
  for (const p of preachers) if (Object.keys(p.unsupported).length)
    flags.push({ severity: "warn", who: p.id, check: "g", reason: "owed in unsupported token(s) " + Object.keys(p.unsupported).join(", ") + " — not paid here" });
  const payees = [...winners, ...preachers];

  // fraud checks
  let records = [];
  try { records = await within(purchaseRecords()); } catch (e) { flags.push(cant("h", "purchase records", e)); }
  try {
    const v = await within(verifyDraw(round));
    for (const p of v.problems) flags.push({ severity: "block", who: "plan", check: "e", reason: "draw re-check: " + p });
    for (const u of v.unchecked) flags.push(cant("e", u));
    flags.push(...checkTicketConcentration(v.entries, v.totalTickets, new Set(winners.map((w) => w.id))));
  } catch (e) { flags.push(cant("e", "the draw", e)); }
  flags.push(...checkReserved(payees));
  flags.push(...checkCap(await liveUsd(planTotals(payees), within)));
  flags.push(...checkPotLedger(snap, prevClosedAt, records));
  try { flags.push(...(await checkWinnerWallets(winners, { now, within }))); } catch (e) { flags.push(cant("b", "winner wallets", e)); }
  try { flags.push(...(await checkPreachers(preachers, records, { within }))); } catch (e) { flags.push(cant("g", "preacher funding", e)); }
  // M8: self-referral through a second wallet (few / one buyer, buyer↔preacher transfers, same tx) — store-preacher-core
  try { flags.push(...(await preacherRiskFlags(preachers, records, { within }))); } catch (e) { flags.push(cant("g", "preacher links", e)); }

  const plan = {
    round, builtAt: Date.now(), status: "ready",
    draw: { commitHash: pub.commitHash, seed: pub.seed, blockhash: pub.blockhash, blockSlot: pub.blockSlot, targetSlot: pub.targetSlot,
      totalTickets: pub.totalTickets, entrants: pub.entrants, drawnAt: pub.drawnAt, potRolledOver: !!pub.potRolledOver,
      statusUrl: storeUrl() + "/api/draw?action=status" },
    pot: snap ? { usd: +(+snap.usd || 0).toFixed(2), routes: snap.routes, totals: potTotals(snap), since: snap.since, closedAt: snap.closedAt } : null,
    tiers: PRIZE_TIERS.map(Number), unfilled: unfilledShares(pub, snap),
    payees, excluded: excluded.filter((id) => payees.some((p) => p.id === id)), flags,
    mints: MINTS, decimals: DEC,
  };
  plan.totals = planTotals(payees, plan.excluded);
  plan.status = !payees.length ? "empty" : openFlags(plan).length ? "flagged" : "ready";
  return plan;
}
// flags not yet resolved by excluding the payee they're about
export function openFlags(plan) {
  const ex = new Set(plan.excluded || []), ids = new Set((plan.payees || []).map((p) => p.id));
  // flags about preachers that moved to a newer plan no longer apply here
  return (plan.flags || []).filter((f) => !ex.has(f.who) && !(plan.preachersMovedTo && /^p:/.test(f.who) && !ids.has(f.who)));
}

export function summary(plan) {
  const t = plan.totals || planTotals(plan.payees, plan.excluded);
  const nW = plan.payees.filter((p) => p.kind === "winner" && !(plan.excluded || []).includes(p.id)).length;
  const nP = plan.payees.filter((p) => p.kind === "preacher" && !(plan.excluded || []).includes(p.id)).length;
  const parts = [];
  if (big(t.ORE) > 0n) parts.push(fmt(t.ORE, "ORE") + " ORE");
  if (big(t.SKR) > 0n) parts.push(fmt(t.SKR, "SKR", 2) + " SKR");
  if (big(t.SOL) > 0n) parts.push(fmt(t.SOL, "SOL") + " SOL→ORE");
  if (big(t.USDC) > 0n) parts.push(fmt(t.USDC, "USDC", 2) + " USDC→ORE");
  return `round ${plan.round}: ${nW} winner${nW === 1 ? "" : "s"} + ${nP} preacher${nP === 1 ? "" : "s"}, ${parts.join(" + ") || "nothing to send"} (≈ $${t.usd})`;
}
function flagText(plan) {
  const fl = openFlags(plan);
  if (!fl.length) return "Flags: none ✓";
  const b = fl.filter((f) => f.severity === "block").length, w = fl.length - b;
  return `⚠ FLAGGED (${b} block, ${w} warn) — the Pay button stays locked until you review:\n` + fl.slice(0, 8).map((f) => `• [${f.severity}] ${f.who}: ${f.reason}`).join("\n") + (fl.length > 8 ? `\n• …and ${fl.length - 8} more` : "");
}
export async function buildAndStore(round, opts = {}) {
  const { value: old, etag } = await readWithEtag(payStore(), "round:" + round);
  if (old && (old.status === "paid" || old.payment?.sigs?.length)) throw new DrawError(`round ${round} is already ${old.status === "paid" ? "paid" : "partly paid"} — not rebuilding`);
  const newer = await latestPlanRound();
  const plan = await buildPlan(round, { ...opts, excluded: opts.excluded || old?.excluded || [], noPreachers: newer > round });
  if (newer > round) plan.preachersMovedTo = newer;   // a rebuilt OLDER round never re-adds preachers the newer plan carries
  // Save only if the plan is still the one we read (building takes seconds): a payment recorded in
  // the meantime must never be overwritten by a fresh, unpaid plan — that is how a round gets paid twice.
  const saved = etag ? await putIfMatch(payStore(), "round:" + round, plan, etag) : await putIfNew(payStore(), "round:" + round, plan);
  if (!saved) throw new DrawError(`round ${round}'s plan changed while it was being rebuilt — reload and try again`, 409);
  if (plan.round >= (await latestPlanRound())) await payStore().set("latest", String(plan.round));
  // the ranks nobody filled (fewer than 5 entrants) → next week's Pot, once (marker + id-guarded adds)
  if (plan.unfilled) await rollUnfilled(round, plan);
  // Preachers are owed EVERYTHING unpaid, so the newest plan carries them. Drop unpaid preacher
  // payees from older unpaid plans, or paying both plans would pay the same records twice.
  const { blobs } = await payStore().list({ prefix: "round:" });
  for (const b of blobs) {
    const n = Number(b.key.slice(6)); if (!(n < round)) continue;
    await casUpdate(payStore(), "round:" + n, (o) => {
      if (!o || o.status === "paid" || o.status === "paying") return undefined;
      const paidIds = o.payment?.paidIds || {};
      const drop = o.payees.filter((p) => p.kind === "preacher" && !paidIds[p.id]);
      if (!drop.length) return undefined;
      o.payees = o.payees.filter((p) => !drop.some((d) => d.id === p.id));
      o.excluded = (o.excluded || []).filter((id) => o.payees.some((p) => p.id === id));
      o.preachersMovedTo = round; o.totals = planTotals(o.payees, o.excluded);
      if (o.status !== "partial") o.status = !o.payees.length ? "empty" : openFlags(o).length ? "flagged" : "ready";
      else if (!o.payees.some((p) => !o.excluded.includes(p.id) && !paidIds[p.id])) { o.status = "paid"; o.payment.paidAt = Date.now(); }
      return o;
    });
  }
  if (opts.notify !== false) {
    if (plan.status === "empty") await notify(`Dojo payout round ${round}: nothing to pay this week (no winners, no preacher owed ≥ $${num("MIN_PREACHER_PAYOUT_USD", 1)}).`);
    else await notify(`Weekly payout ready — ${summary(plan)}\n${flagText(plan)}\n${storeUrl()}/payouts`);
  }
  return plan;
}

// ---------- the weekly cron ----------
// One step per run (each step is heavy and scheduled functions stop at ~30s; it runs every 10 min):
//   1. an open round whose target slot finalized → draw it
//   2. past this week's draw time and not committed for it → commit
//   3. a drawn round (after the cron took over) with no plan → build + store + notify
export async function cronTick({ now = Date.now(), budgetMs = 20e3 } = {}) {
  const store = payStore();
  // 0. a payment whose settlement was interrupted (crash between "paying" and "paid") → finish it
  const lp = await latestPlanRound();
  for (let n = lp; n > 0 && n > lp - 3; n--) {
    if ((await getPlan(n))?.status === "paying") { const p = await settlePayment(n); return { step: "settled", round: n, status: p?.status }; }
  }
  const state = (await store.get("cycle", { type: "json" })) || {};
  if (!state.since) { state.since = now; await store.setJSON("cycle", state); }
  const week = lastDrawTime(now);
  const round = await latestRound();
  const pub = await getPublic(round);

  if (pub?.status === "committed") {
    const slot = await rpc("getSlot", [{ commitment: "finalized" }]);
    if (slot < pub.targetSlot) return { step: "waiting-slot", round, slot, targetSlot: pub.targetSlot };
    try { const r = await drawRound(); return { step: "drawn", round, winners: r.winners.length }; }
    catch (e) { if (e instanceof DrawError) return { step: "waiting-block", round, error: e.message }; throw e; }
  }

  // a round committed after this week's draw time (by the cron or by hand) is this week's round
  if (pub?.committedAt >= week && state.committedFor !== week) { state.committedFor = week; await store.setJSON("cycle", state); }
  if (state.committedFor !== week && now >= week) {
    if (now - week > CATCHUP_MS) { state.committedFor = week; state.skipped = [...(state.skipped || []).slice(-5), week]; await store.setJSON("cycle", state); return { step: "skipped-late", week }; }
    const c = await commitRound();
    state.committedFor = week; state.lastCommit = { round: c.round, at: now };
    await store.setJSON("cycle", state);
    return { step: "committed", round: c.round, targetSlot: c.targetSlot };
  }

  if (pub?.status === "drawn" && (pub.drawnAt || 0) >= state.since && !(await getPlan(round))) {
    const plan = await buildAndStore(round, { budgetMs, now });
    return { step: "planned", round, status: plan.status, flags: plan.flags.length };
  }
  return { step: "idle", round };
}

// ---------- the weekly sweep: Blobs stores that anyone can grow ----------
// Deletes ONLY records that are provably dead: sign-in nonces (n:, w:) past their expiry (+1 h), one-time "used:" markers older
// than a day (a replay needs its nonce record, which is deleted on use or expired by then), and the legacy ticket
// sink (never read by the draw — the real ledger is "tickets"). Launch applications and preacher-ledger records are
// left alone (real data, not expired). Runs from the payout cron in small time slices until a pass finds nothing left,
// then rests for a week. State: payouts "sweep".
export const SWEEP_EVERY_MS = 7 * DAY;
// Key formats (store-fn-auth / store-fn-preacher): n:<nonce> {…, exp} · w:<wallet> {nonce, exp} (auth, until 2026-11-09)
// · used:<nonce> {wallet, at}. The "preacher-holds" store (h:*, new:*) is real state and is NEVER swept.
const SWEEPS = (now) => [
  { store: "auth-nonces", prefix: "n:", dead: (r) => Number(r?.exp) > 0 && r.exp < now - 3600e3 },
  { store: "auth-nonces", prefix: "w:", dead: (r) => Number(r?.exp) > 0 && r.exp < now - 3600e3 },
  { store: "auth-nonces", prefix: "used:", dead: (r) => Number(r?.at) > 0 && r.at < now - DAY },
  { store: "preacher-nonces", prefix: "n:", dead: (r) => Number(r?.exp) > 0 && r.exp < now - 3600e3 },
  { store: "preacher-nonces", prefix: "used:", dead: (r) => Number(r?.at) > 0 && r.at < now - DAY },
  { store: "tickets-legacy", prefix: "", dead: () => true },
];
export async function sweepTick({ now = Date.now(), budgetMs = 5e3, force = false } = {}) {
  const deadline = Date.now() + budgetMs, st = (await payStore().get("sweep", { type: "json" })) || {};
  if (!force && st.doneAt && now - st.doneAt < SWEEP_EVERY_MS) return { step: "sweep-idle", next: st.doneAt + SWEEP_EVERY_MS };
  const deleted = {}; let more = false;
  outer: for (const j of SWEEPS(now)) {
    const s = getStore(j.store);
    let blobs = [];
    try { ({ blobs } = await s.list(j.prefix ? { prefix: j.prefix } : {})); } catch { more = true; continue; }
    for (const b of blobs) {
      if (Date.now() > deadline) { more = true; break outer; }
      let r = null;
      if (j.prefix !== "") { try { r = await s.get(b.key, { type: "json" }); } catch { continue; } }
      if (!j.dead(r)) continue;
      try { await s.delete(b.key); deleted[j.store + " " + (j.prefix || "*")] = (deleted[j.store + " " + (j.prefix || "*")] || 0) + 1; } catch {}
    }
  }
  const total = Object.values(deleted).reduce((a, n) => a + n, 0);
  await payStore().setJSON("sweep", more ? { ...st, partialAt: now, partialDeleted: (st.partialDeleted || 0) + total } : { doneAt: now, deleted: (st.partialDeleted || 0) + total, last: deleted });
  return { step: more ? "sweep-partial" : "sweep-done", deleted };
}

// ---------- paying ----------
// Per-owner raw token deltas across txs (jsonParsed or json getTransaction results), as BigInt.
export function tokenDeltas(txs) {
  const out = {};   // owner → mint → BigInt delta
  for (const tx of txs) {
    const add = (b, sign) => {
      if (!b?.owner || !b?.mint) return;
      const v = big(b.uiTokenAmount?.amount ?? 0) * sign;
      const o = (out[b.owner] ||= {}); o[b.mint] = (o[b.mint] || 0n) + v;
    };
    for (const b of tx.meta?.postTokenBalances || []) add(b, 1n);
    for (const b of tx.meta?.preTokenBalances || []) add(b, -1n);
  }
  return out;
}

// ----- server-side swap quote (the manifest) -----
// SOL/USDC shares are swapped to ORE by the owner's wallet. WHAT each payee then gets in ORE is fixed
// here, server-side, from a Jupiter quote: the swap's guaranteed minimum (otherAmountThreshold) split
// by obligation. The browser is never trusted to say what is due — verification compares on-chain
// receipts against plan.manifest.swapOre, and a SOL/USDC share with no recorded amount is never paid.
export const SWAP_SLIPPAGE_BPS = 100;
export const QUOTE_TTL_MS = 5 * 60e3;   // how long the page may still SWAP with a quote (verification doesn't expire)
const jupBase = () => String(env("JUPITER_BASE", "https://lite-api.jup.ag")).replace(/\/+$/, "");
const pendingIds = (plan) => {
  const ex = new Set(plan.excluded || []), paid = plan.payment?.paidIds || {};
  return new Set(plan.payees.filter((p) => !ex.has(p.id) && !paid[p.id]).map((p) => p.id));
};
export function swapBuckets(plan, ids = pendingIds(plan)) {
  const b = { SOL: { total: 0n, parts: [] }, USDC: { total: 0n, parts: [] } };
  for (const p of plan.payees) {
    if (!ids.has(p.id)) continue;
    const pay = payOf(p);
    for (const c of ["SOL", "USDC"]) if (pay[c] > 0n) { b[c].total += pay[c]; b[c].parts.push({ id: p.id, weight: pay[c] }); }
  }
  return b;
}
// Spot USD prices (Jupiter price feed, the same one the Keeper's prices() reads) → { mint: usd } (missing = unknown).
export async function spotPrices(mints) {
  const out = {};
  try {
    const j = await (await fetch(`${jupBase()}/price/v3?ids=${[...new Set(mints)].join(",")}`)).json();
    for (const m of mints) { const p = +j?.[m]?.usdPrice; if (p > 0 && Number.isFinite(p)) out[m] = p; }
  } catch {}
  return out;
}
const MIN_FAIR_FRAC = 0.9;   // a swap quote must give at least 90% of what the spot price says
// The ORE that `amount` raw of `inputMint` is worth at spot, in raw ORE (a Number — a sanity bound, not money).
const fairOreRaw = (inputMint, amount, px) => (Number(big(amount)) / 10 ** (inputMint === MINTS.SOL ? DEC.SOL : DEC.USDC)) * px[inputMint] / px[MINTS.ORE] * 10 ** DEC.ORE;
async function jupQuote(inputMint, amount) {
  const url = `${jupBase()}/swap/v1/quote?inputMint=${inputMint}&outputMint=${MINTS.ORE}&amount=${amount}&swapMode=ExactIn&slippageBps=${SWAP_SLIPPAGE_BPS}`;
  let q = null;
  try { q = await (await fetch(url)).json(); } catch {}
  if (!q || q.error || q.outAmount == null) throw new DrawError("no swap route to ORE right now" + (q?.error ? " (" + q.error + ")" : "") + " — try again in a minute", 502);
  if (q.inputMint !== inputMint || q.outputMint !== MINTS.ORE || String(q.inAmount) !== String(amount) || (q.swapMode && q.swapMode !== "ExactIn"))
    throw new DrawError("the swap quote doesn't match what was asked — not using it", 502);
  if (q.slippageBps != null && Number(q.slippageBps) > SWAP_SLIPPAGE_BPS) throw new DrawError("the swap quote allows more slippage than asked — not using it", 502);
  if (q.platformFee && big(q.platformFee.amount) > 0n) throw new DrawError("the swap quote carries a platform fee — not using it", 502);
  const minOut = big(q.otherAmountThreshold ?? q.outAmount);
  if (!(minOut > 0n) || minOut > big(q.outAmount)) throw new DrawError("the swap quote has no usable minimum output", 502);
  // The payees' ORE is fixed from this quote, so a garbled / hostile quote would pay them dust: compare with spot (L4).
  // No price → no quote (fail closed): the owner just presses Pay again in a minute.
  const px = await spotPrices([inputMint, MINTS.ORE]);
  if (!(px[inputMint] > 0 && px[MINTS.ORE] > 0)) throw new DrawError("can't check the swap price against the market right now — try again in a minute", 502);
  const fair = fairOreRaw(inputMint, amount, px);
  if (Number(minOut) < fair * MIN_FAIR_FRAC)
    throw new DrawError(`the swap quote gives ${fromRaw(minOut, "ORE").toFixed(6)} ORE, more than ${Math.round((1 - MIN_FAIR_FRAC) * 100)}% under the market (≈ ${(fair / 10 ** DEC.ORE).toFixed(6)} ORE) — not using it; try again in a minute`, 502);
  return { quote: q, minOut, outAmount: big(q.outAmount) };
}
export function manifestHash(round, m) {
  const swaps = Object.fromEntries(Object.entries(m.swaps || {}).sort().map(([c, s]) => [c, { inAmount: s.inAmount, minOut: s.minOut, ids: s.ids }]));
  const so = Object.fromEntries(Object.entries(m.swapOre || {}).sort());
  return createHash("sha256").update(JSON.stringify({ round, version: m.version, swaps, swapOre: so })).digest("hex");
}
// (Re)quote the SOL/USDC buckets of the still-unpaid payees and record the allocation in the plan.
// A currency whose quoted payees already received a payment is LOCKED (its swap has evidently been
// done) — its recorded amounts stay as they are.
export async function quoteSwaps(round, { now = Date.now() } = {}) {
  const plan0 = await getPlan(round);
  if (!plan0) throw new DrawError("no payout plan for round " + round, 404);
  if (plan0.status === "paid" || plan0.status === "paying") throw new DrawError(`round ${round} is ${plan0.status} — nothing to quote`);
  // a currency is locked once its swap is recorded (recordSwap) or one of its payees was paid
  const locked = (plan, c) => !!plan.manifest?.swaps?.[c]?.sig || (plan.manifest?.swaps?.[c]?.ids || []).some((id) => plan.payment?.paidIds?.[id]);
  const buckets0 = swapBuckets(plan0), fresh = {};
  for (const c of ["SOL", "USDC"]) {
    if (!(buckets0[c].total > 0n) || locked(plan0, c)) continue;
    fresh[c] = { ...(await jupQuote(MINTS[c], buckets0[c].total.toString())), bucket: buckets0[c] };
  }
  const { value } = await casUpdate(payStore(), "round:" + round, (plan) => {
    if (!plan) throw new DrawError("no payout plan for round " + round, 404);
    if (plan.status === "paid" || plan.status === "paying") throw new DrawError(`round ${round} is ${plan.status} — nothing to quote`);
    const buckets = swapBuckets(plan);
    const old = plan.manifest || { version: 0, swaps: {}, swapOre: {} };
    const m = { version: (old.version || 0) + 1, quotedAt: now, expiresAt: now + QUOTE_TTL_MS, slippageBps: SWAP_SLIPPAGE_BPS, swaps: {}, swapOre: {} };
    // keep what was already paid against an earlier manifest (it is history now)
    for (const [id, v] of Object.entries(old.swapOre || {})) if (plan.payment?.paidIds?.[id]) m.swapOre[id] = v;
    for (const c of ["SOL", "USDC"]) {
      if (locked(plan, c)) { m.swaps[c] = old.swaps[c]; for (const id of old.swaps[c].ids) m.swapOre[id] = old.swapOre[id]; continue; }
      if (!(buckets[c].total > 0n)) continue;
      const f = fresh[c];
      // the plan changed between quoting and saving (an exclusion, a payment) → don't save a mismatched quote
      if (!f || f.bucket.total !== buckets[c].total || f.bucket.parts.map((p) => p.id).join() !== buckets[c].parts.map((p) => p.id).join())
        throw new DrawError(`round ${round}'s plan changed while quoting — press Pay again`, 409);
      const alloc = allocate(f.minOut, buckets[c].parts);
      m.swaps[c] = { inMint: MINTS[c], inAmount: S(buckets[c].total), minOut: S(f.minOut), outAmount: S(f.outAmount), ids: buckets[c].parts.map((p) => p.id), quote: f.quote };
      for (const [id, v] of Object.entries(alloc)) m.swapOre[id] = (big(m.swapOre[id]) + v).toString();
    }
    m.hash = manifestHash(round, m);
    plan.manifest = m;
    return plan;
  });
  return value.manifest;
}

// ----- what's due, what arrived -----
// What each wallet must receive: direct ORE/SKR plus, for SOL/USDC shares, the ORE recorded in the
// server manifest. `unquoted` = payees with a SOL/USDC share and no recorded ORE amount → never covered.
export function dueByOwner(plan, ids) {
  const due = {}, so = plan.manifest?.swapOre || {};
  for (const p of plan.payees) {
    if (!ids.has(p.id)) continue;
    const pay = payOf(p);
    const d = (due[p.wallet] ||= { ORE: 0n, SKR: 0n, ids: [], unquoted: [] });
    d.ORE += pay.ORE; d.SKR += pay.SKR; d.ids.push(p.id);
    if (pay.SOL + pay.USDC > 0n) { if (so[p.id] == null) d.unquoted.push(p.id); else d.ORE += big(so[p.id]); }
  }
  return due;
}
// does what an owner received (exact raw, per mint) cover what they're due? No tolerance.
export function covers(d, got) {
  if (d.unquoted.length) return false;
  return big(got.ORE) >= d.ORE && big(got.SKR) >= d.SKR;
}
// what `owner` received in these txs, per mint, skipping (sig, owner) pairs already credited earlier
export function received(owner, txs, consumed = {}) {
  const got = { ORE: 0n, SKR: 0n }, used = [];
  for (const { sig, tx } of txs) {
    if (consumed[sig + ":" + owner]) continue;
    const del = tokenDeltas([tx])[owner] || {};
    const o = del[MINTS.ORE] || 0n, k = del[MINTS.SKR] || 0n;
    if (o > 0n) got.ORE += o;
    if (k > 0n) got.SKR += k;
    if (o > 0n || k > 0n) used.push(sig);
  }
  return { got, used };
}

// ----- recording a payment: verify → commit ("paying") → settle → "partial" | "paid" -----
class SettleFirst extends Error {}
const MAX_SIGS = 40;
// Verify the pay txs and mark what landed. Incremental: call again with more sigs after a retry.
export async function recordPayment({ round, sigs, payer, reviewed = false }) {
  await settlePayment(round);   // finish a settlement an earlier (crashed) call left behind
  const first = await getPlan(round);
  if (!first) throw new DrawError("no payout plan for round " + round, 404);
  if (first.status === "paid") throw new DrawError("round " + round + " is already paid");
  if (!ADDR_RE.test(payer || "")) throw new DrawError("payer wallet missing", 400);
  if (first.payment?.payer && first.payment.payer !== payer) throw new DrawError(`this round is being paid from ${first.payment.payer} — use the same wallet`, 400);
  const list = [...new Set((sigs || []).filter((s) => typeof s === "string" && /^[1-9A-HJ-NP-Za-km-z]{64,96}$/.test(s)))].slice(0, MAX_SIGS);
  if (!list.length) throw new DrawError("no transaction signatures", 400);

  // 1) read + check every tx (no state change yet)
  const txs = [], bad = [];
  for (const s of list) {
    let tx = null;
    for (let i = 0; i < 3 && !tx; i++) { try { tx = await getTx(s, "jsonParsed"); } catch {} if (!tx && i < 2) await new Promise((r) => setTimeout(r, 1500)); }
    if (!tx) { bad.push({ sig: s, reason: "not found on-chain (yet)" }); continue; }
    if (tx.meta?.err) { bad.push({ sig: s, reason: "failed on-chain" }); continue; }
    const feePayer = keyStr(tx.transaction?.message?.accountKeys?.[0]);
    if (feePayer !== payer) { bad.push({ sig: s, reason: "not sent by " + payer.slice(0, 4) + "…" }); continue; }
    // one signature pays ONE round: claim it (create-only); a sig already claimed by another round is refused
    if (!(await putIfNew(payStore(), "sig:" + s, { round, at: Date.now() }))) {
      const c = await payStore().get("sig:" + s, { type: "json" });
      if (c && c.round !== round) { bad.push({ sig: s, reason: `already counted for round ${c.round}` }); continue; }
    }
    txs.push({ sig: s, tx });
  }

  // a preacher whose records were already paid in ANOTHER payout is not due here (L1): it is excluded (it stays owed
  // for whatever is still unpaid, in the newest plan) instead of being marked paid a second time
  let dupIds = new Set();
  try { dupIds = new Set(Object.keys(await alreadyPaidElsewhere(first))); } catch {}

  // 2) commit: everything newly covered + "paying" (with the settlement work) in ONE conditional write.
  //    Preacher records / pot rollover / notices happen only AFTER this write landed (step 3).
  let out = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const { value: plan } = await casUpdate(payStore(), "round:" + round, (plan) => {
        if (!plan) throw new DrawError("no payout plan for round " + round, 404);
        if (plan.status === "paid") throw new DrawError("round " + round + " is already paid");
        if (plan.status === "paying") throw new SettleFirst();
        const pay = plan.payment ||= { sigs: [], payer, paidIds: {}, consumed: {}, reviewed: false };
        pay.consumed ||= {};
        if (pay.payer !== payer) throw new DrawError(`this round is being paid from ${pay.payer} — use the same wallet`, 400);
        pay.reviewed = pay.reviewed || !!reviewed;
        for (const { sig } of txs) if (!pay.sigs.includes(sig)) pay.sigs.push(sig);
        // every payee not excluded and not already verified must have received what they're due
        const why = {};
        for (const p of plan.payees) if (p.kind === "preacher" && dupIds.has(p.id) && !pay.paidIds[p.id] && !(plan.excluded || []).includes(p.id)) {
          plan.excluded = [...(plan.excluded || []), p.id]; (pay.dupExcluded ||= {})[p.id] = Date.now();
          why[p.id] = "its records were already paid in another payout — excluded here, not marked paid twice";
        }
        if (Object.keys(why).length) plan.totals = planTotals(plan.payees, plan.excluded);
        const ex = new Set(plan.excluded || []);
        const pending = new Set(plan.payees.filter((p) => !ex.has(p.id) && !pay.paidIds[p.id]).map((p) => p.id));
        const due = dueByOwner(plan, pending), newlyPaid = [];
        for (const [owner, d] of Object.entries(due)) {
          const { got, used } = received(owner, txs, pay.consumed);
          if (!covers(d, got)) {
            for (const id of d.unquoted) why[id] = "its SOL/USDC share has no server-recorded ORE amount (no quote) — not counted as paid";
            continue;
          }
          for (const id of d.ids) { pay.paidIds[id] = { sig: used[0] || null, ore: S(got.ORE), skr: S(got.SKR), manifest: plan.manifest?.version || null }; newlyPaid.push(id); }
          for (const s of used) pay.consumed[s + ":" + owner] = true;
        }
        const missing = plan.payees.filter((p) => !ex.has(p.id) && !pay.paidIds[p.id]).map((p) => p.id);
        const final = missing.length ? "partial" : "paid";
        const preachers = newlyPaid.filter((id) => plan.payees.find((p) => p.id === id)?.kind === "preacher" && pay.paidIds[id].sig);
        out = { newlyPaid, missing, why };
        if (!preachers.length && final !== "paid") { plan.status = final; return plan; }   // nothing to settle
        plan.status = "paying";
        plan.settle = { op: randomUUID(), at: Date.now(), final, preachers };
        return plan;
      });
      if (plan.status === "paying") await settlePayment(round);
      break;
    } catch (e) {
      if (!(e instanceof SettleFirst)) throw e;
      await settlePayment(round);   // another call is mid-settlement: finish it (idempotent), then re-check
      if (attempt === 3) throw new DrawError("the plan is busy settling — submit again in a moment (nothing is lost)", 409);
    }
  }
  const now = await getPlan(round);
  if (now.round >= (await latestPlanRound())) await payStore().set("latest", String(now.round));
  return { ok: true, status: now.status, paidIds: Object.keys(now.payment?.paidIds || {}), newlyPaid: out.newlyPaid, missing: out.missing, why: out.why, bad };
}

// Step 3 — idempotent, safe to re-run any number of times (a crashed call, a racing call, the cron):
// mark the committed preachers' records paid (keyed by the pay sig, so a repeat overwrites the same
// record), roll excluded winners' shares into the pot (id-guarded) and send "Paid ✓" once, then
// move "paying" → "partial" | "paid" (only for the same settlement op).
export async function settlePayment(round) {
  const plan = await getPlan(round);
  if (!plan || plan.status !== "paying" || !plan.settle) return plan;
  const s = plan.settle, pay = plan.payment, ex = new Set(plan.excluded || []);
  const paidRecs = getStore("preacher-paid");
  for (const id of s.preachers || []) {
    const p = plan.payees.find((x) => x.id === id), paidId = pay.paidIds[id];
    if (!p || !paidId?.sig) continue;
    const paySig = `${paidId.sig}:r${round}:${p.code}`;
    // each referral record is marked paid ONCE (create-only "rec:<sig>" claim): a record some other payout already
    // claimed is left out — a re-run of this same settlement keeps its own claims (idempotent)
    const fresh = [];
    for (const rs of p.sigs || []) {
      if (await putIfNew(paidRecs, "rec:" + rs, { paySig, round, code: p.code, at: Date.now() })) { fresh.push(rs); continue; }
      const c = await paidRecs.get("rec:" + rs, { type: "json" }).catch(() => null);
      if (c?.paySig === paySig) fresh.push(rs);
    }
    if (fresh.length || !(p.sigs || []).length) await markPreacherPaid({ paySig, ref: p.code, wallet: p.wallet, payoutUsd: p.usd, sigs: fresh });
  }
  const rolled = [];
  if (s.final === "paid") {
    // excluded winners' shares stay in the pot: added back to the live pot for next round
    for (const p of plan.payees) {
      if (p.kind !== "winner" || !ex.has(p.id)) continue;
      const pay_ = payOf(p), curs = ["ORE", "SKR", "SOL"].filter((c) => pay_[c] > 0n);
      for (const c of curs) await addToPot({ usd: (p.usd || 0.01) / curs.length, currency: c, native: fromRaw(pay_[c], c), route: "other", id: `rollover:r${round}:${p.id}:${c}` });
      if (curs.length) rolled.push(p.id);
    }
    if (await putIfNew(payStore(), "notified:paid:" + round, { at: Date.now() }))
      await notify(`Paid ✓ — ${summary(plan)}\n${pay.sigs.map((x) => "https://solscan.io/tx/" + x).join("\n")}`);
  }
  const { value } = await casUpdate(payStore(), "round:" + round, (o) => {
    if (!o || o.status !== "paying" || o.settle?.op !== s.op) return undefined;   // already finalized by another call
    o.status = s.final;
    if (s.final === "paid") { o.payment.paidAt ||= Date.now(); o.payment.rolledOver = rolled; }
    delete o.settle;
    return o;
  });
  if (value?.round >= (await latestPlanRound())) await payStore().set("latest", String(value.round));
  return value;
}

// Mark exclusion (or undo). Excluded winners' shares roll into next week's pot when the round is
// paid; excluded preachers simply stay owed (their records remain unpaid).
export async function setExcluded(round, who, exclude = true) {
  const { value } = await casUpdate(payStore(), "round:" + round, (plan) => {   // atomic vs a concurrent "paid"
    if (!plan) throw new DrawError("no payout plan for round " + round, 404);
    if (plan.status === "paid" || plan.payment?.paidIds?.[who]) throw new DrawError("already paid — can't change");
    if (plan.status === "paying") throw new DrawError("a payment is being settled — reload in a moment");
    if (!plan.payees.some((p) => p.id === who)) throw new DrawError("unknown payee " + who, 400);
    const s = new Set(plan.excluded || []);
    exclude ? s.add(who) : s.delete(who);
    plan.excluded = [...s];
    plan.totals = planTotals(plan.payees, plan.excluded);
    if (plan.status !== "partial") plan.status = openFlags(plan).length ? "flagged" : "ready";
    return plan;
  });
  return value;
}

// ---------- L3: a currency's swap is recorded SERVER-side the moment it lands ----------
// "The swap never runs twice" used to live in one browser's localStorage: a second device (or cleared site data) would
// re-quote and swap the same SOL/USDC bucket again. Now the page reports each landed swap; the server checks it on-chain
// (Treasury-signed, succeeded, after this quote, ORE in ≥ the quoted minimum, the bucket out ≤ quoted) and pins its
// signature in the manifest — that currency is then LOCKED (never re-quoted, never swapped again, from any device).
const SIG_RE = /^[1-9A-HJ-NP-Za-km-z]{64,96}$/;
export const treasuryWallet = () => env("TREASURY_WALLET", "5w55F58ia3H71QjBD9bYvNQF2DcNu8K3AfJj9A4WMuWp");
export async function recordSwap({ round, cur, sig }) {
  if (cur !== "SOL" && cur !== "USDC") throw new DrawError("unknown swap currency", 400);
  if (!SIG_RE.test(String(sig || ""))) throw new DrawError("bad signature", 400);
  const plan0 = await getPlan(round);
  if (!plan0) throw new DrawError("no payout plan for round " + round, 404);
  const ms = plan0.manifest?.swaps?.[cur];
  if (!ms) throw new DrawError(`round ${round} has no ${cur} swap quote`, 400);
  if (ms.sig) return { ok: true, cur, sig: ms.sig, already: true, same: ms.sig === sig };
  let tx = null;
  for (let i = 0; i < 3 && !tx; i++) { try { tx = await getTx(sig, "jsonParsed"); } catch {} if (!tx && i < 2) await new Promise((r) => setTimeout(r, 1500)); }
  if (!tx) throw new DrawError("that swap isn't on-chain yet — try again in a moment", 404);
  if (tx.meta?.err) throw new DrawError("that swap failed on-chain", 400);
  const treasury = treasuryWallet(), keys = tx.transaction?.message?.accountKeys || [];
  if (keyStr(keys[0]) !== treasury) throw new DrawError("that swap was not sent by the Treasury", 400);
  if (tx.blockTime && plan0.manifest.quotedAt && tx.blockTime * 1000 < plan0.manifest.quotedAt - 120e3) throw new DrawError("that swap is older than this round's quote", 400);
  const d = tokenDeltas([tx])[treasury] || {};
  const gotOre = d[MINTS.ORE] || 0n;
  if (gotOre < big(ms.minOut)) throw new DrawError(`that swap brought ${fmt(gotOre > 0n ? gotOre : 0n, "ORE", 6)} ORE, less than the quoted ${fmt(ms.minOut, "ORE", 6)}`, 400);
  const spent = cur === "USDC" ? -(d[MINTS.USDC] || 0n) : BigInt(tx.meta?.preBalances?.[0] || 0) - BigInt(tx.meta?.postBalances?.[0] || 0);
  const slack = cur === "SOL" ? 20000000n : 0n;   // SOL also pays the fee + temporary deposits
  if (!(spent > 0n) || spent > big(ms.inAmount) + slack) throw new DrawError(`that swap doesn't spend this round's ${cur} bucket`, 400);
  // one round per signature (the same claim recordPayment makes)
  if (!(await putIfNew(payStore(), "sig:" + sig, { round, at: Date.now(), swap: cur }))) {
    const c = await payStore().get("sig:" + sig, { type: "json" });
    if (c && c.round !== round) throw new DrawError(`that signature is already counted for round ${c.round}`, 400);
  }
  const { value } = await casUpdate(payStore(), "round:" + round, (plan) => {
    const s = plan?.manifest?.swaps?.[cur];
    if (!s || s.sig) return undefined;
    s.sig = sig; s.swappedAt = Date.now(); s.gotOre = S(gotOre);
    return plan;
  });
  const now = value || (await getPlan(round));
  return { ok: true, cur, sig: now?.manifest?.swaps?.[cur]?.sig || sig };
}

// ---------- L2: "I reviewed the flags" lives on the server, and the relay refuses while BLOCK flags are unreviewed ----------
export async function setReviewed(round, reviewed) {
  const { value } = await casUpdate(payStore(), "round:" + round, (plan) => {
    if (!plan) throw new DrawError("no payout plan for round " + round, 404);
    if (plan.status === "paid") return undefined;
    if (reviewed) plan.review = { at: Date.now(), flags: openFlags(plan).length }; else delete plan.review;
    return plan;
  });
  return value;
}
// Preacher records of THIS plan's unpaid, non-excluded preachers that another payout already paid → { id: n }
const DUP_CACHE = new Map();
export async function duplicatePreachers(plan) {
  // keyed by the plan's state too: an exclusion or a payment takes effect at once (only other payouts' records are cached)
  const k = [plan.round, plan.builtAt, (plan.excluded || []).slice().sort().join("|"), Object.keys(plan.payment?.paidIds || {}).length].join(":"), hit = DUP_CACHE.get(k);
  if (hit && Date.now() - hit.at < 60e3) return hit.v;
  const all = await alreadyPaidElsewhere(plan), ex = new Set(plan.excluded || []), paid = plan.payment?.paidIds || {}, v = {};
  for (const [id, n] of Object.entries(all)) if (!ex.has(id) && !paid[id]) v[id] = n;
  DUP_CACHE.set(k, { at: Date.now(), v }); if (DUP_CACHE.size > 50) DUP_CACHE.delete(DUP_CACHE.keys().next().value);
  return v;
}
// Why the relay must NOT broadcast a Treasury transaction right now (null = fine). Checked on EVERY /api/payouts send,
// so a stale tab, a UI bug or a script can't move money past an unreviewed BLOCK flag or a double-paying plan.
export async function sendBlocked(round) {
  const plan = round ? await getPlan(round) : null;
  if (!plan || plan.status === "paid") return null;
  let dup = {};
  try { dup = await duplicatePreachers(plan); } catch { return "couldn't check the preachers against earlier payouts — try again in a moment"; }
  const d = Object.keys(dup);
  if (d.length) return `round ${round}: ${d.map((id) => id.replace(/^p:/, "preacher ")).join(", ")} — records already paid in another payout. Exclude them or Rebuild plan, then pay again.`;
  const blocks = openFlags(plan).filter((f) => f.severity === "block");
  if (blocks.length && !plan.review) return `round ${round} has ${blocks.length} open BLOCK flag${blocks.length === 1 ? "" : "s"} — tick "I reviewed the flags" (or exclude the flagged payees) first.`;
  return null;
}

// Preacher record sigs in this plan that were paid ELSEWHERE since it was built (e.g. by hand on
// /preacher-admin) — paying them again would double-pay. Cheap: one list of preacher-paid.
export async function alreadyPaidElsewhere(plan) {
  const s = getStore("preacher-paid");
  const { blobs } = await s.list({ prefix: "paid:" });
  const paid = new Set();
  for (const b of blobs) { if (b.key.includes(`:r${plan.round}:`)) continue; const p = await s.get(b.key, { type: "json" }); for (const x of p?.sigs || []) paid.add(x); }
  const out = {};
  for (const p of plan.payees) if (p.kind === "preacher") { const n = p.sigs.filter((x) => paid.has(x)).length; if (n) out[p.id] = n; }
  return out;
}

// ---------- the owner's weekly statement (/payouts): what COMES IN · what GOES OUT · what STAYS ----------
// Pure — every input is already read by /api/payouts?statement=1:
//   reserve   the Reserve's own 7-day reading of the Treasury (store-fn-reserve.mjs: sources per mint + balances now)
//   viaPreacher  mining tips that came through a preacher link this week (verified coin-purchase records), per mint
//   repairs   { granted: [repair records], refunded: [refund records] } this week (store-keeper-core.mjs)
//   plan      the round's payout plan (winners + preachers) — null when no draw is waiting
//   keeper    keeperSummary(): refunds due, burn claims, the 12% operations share, unconverted shares, Card Vaults
//   pot       the live Pot (next draw's prize) · prices: mint → USD
// Amounts here are DISPLAY numbers (UI units, ≈USD); the money itself only ever moves by the plan's / Keeper's exact
// raw amounts, and every transfer is verified on-chain afterwards.
export const STATEMENT_SYMBOLS = {
  [MINTS.SOL]: "SOL", [MINTS.ORE]: "ORE", [MINTS.SKR]: "SKR", [MINTS.USDC]: "USDC",
  storenSbvkfzircixnaosc5CbzNZVrHJ6S3EKrS1yqR: "stORE", G1jonmoSEbMJSwEg1AmgDAJq2utmuBSZct8oqttBf9rT: "GRAMS",
};
const STORE_MINT_ = "storenSbvkfzircixnaosc5CbzNZVrHJ6S3EKrS1yqR";
export function weeklyStatement({ now = Date.now(), reserve = null, viaPreacher = {}, repairs = { granted: [], refunded: [] }, plan = null, drawNote = null,
  keeper = {}, pot = null, prices = {}, burnEnabled = false, opsWallet = null } = {}) {
  const px = (m) => (+prices[m] > 0 ? +prices[m] : 0);
  const clean = (o) => { const r = {}; for (const [m, v] of Object.entries(o || {})) { const n = +v; if (n > 1e-12) r[m] = n; } return r; };
  const usd = (o) => +Object.entries(o || {}).reduce((s, [m, v]) => s + (+v || 0) * px(m), 0).toFixed(2);
  const plus = (a, b) => { const r = { ...clean(a) }; for (const [m, v] of Object.entries(clean(b))) r[m] = (r[m] || 0) + v; return r; };
  const minus = (a, b) => { const r = {}; for (const [m, v] of Object.entries(clean(a))) { const n = v - (+(b || {})[m] || 0); if (n > 1e-9) r[m] = n; } return r; };
  const capAt = (a, cap) => (cap ? Object.fromEntries(Object.entries(clean(a)).map(([m, v]) => [m, Math.min(v, +cap[m] || 0)])) : clean(a));
  const amt = (amounts) => { const a = clean(amounts); return { amounts: a, usd: usd(a) }; };
  const fromPay = (p) => clean({ [MINTS.ORE]: fromRaw(p.pay?.ORE, "ORE"), [MINTS.SKR]: fromRaw(p.pay?.SKR, "SKR"), [MINTS.SOL]: fromRaw(p.pay?.SOL, "SOL"), [MINTS.USDC]: fromRaw(p.pay?.USDC, "USDC") });
  const src = reserve?.sources || {};

  // ---- COMES IN (the last 7 days) ----
  const via = reserve ? capAt(viaPreacher, src.mining) : clean(viaPreacher);
  const repairOre = (repairs.granted || []).length * 0.01 + (repairs.refunded || []).reduce((s, r) => s + fromRaw(r.raw, "ORE"), 0);
  const repairIn = clean({ [MINTS.ORE]: repairOre });
  const nCards = (repairs.granted || []).length + (repairs.refunded || []).reduce((n, r) => n + ((r.mints || []).length || 0), 0);
  const IN = [
    { key: "royalties", label: "Marketplace royalties", note: "sales on Magic Eden, Tensor and our store", ...amt(src.royalties) },
    { key: "coins", label: "Game-coin buys", ...amt(src.coins) },
    { key: "mineRef", label: "Mining tips via a preacher (locked before 27 Oct 2026)", note: "the preacher's share is paid out below", ...amt(via) },
    { key: "mineNoRef", label: "Mining tips, no preacher", note: "100% Reserve", ...amt(minus(src.mining, via)) },
    { key: "potTips", label: "Pot tips", note: "100% to the Pot", ...amt(src.tips) },
    { key: "repairs", label: "Card repairs", note: nCards ? nCards + " card" + (nCards === 1 ? "" : "s") + " × 0.01 ORE" : "", ...amt(repairIn) },
    { key: "direct", label: "Direct tips & other", ...amt(minus(src.direct, repairIn)) },
  ];
  const topUps = { key: "team", label: "Your own top-ups", note: "money you moved in — not income", ...amt(src.team) };

  // ---- GOES OUT (what this batch pays) ----
  const paidIds = plan?.payment?.paidIds || {}, excluded = new Set(plan?.excluded || []);
  const open = plan && plan.status !== "paid" ? (plan.payees || []).filter((p) => !excluded.has(p.id) && !paidIds[p.id]) : [];
  const group = (key, label, why, lines, extra = {}) => {
    const amounts = lines.reduce((a, l) => plus(a, l.amounts), {});
    return { key, label, why, lines, amounts, usd: +lines.reduce((s, l) => s + (+l.usd || 0), 0).toFixed(2), ...extra };
  };
  const winnerLines = open.filter((p) => p.kind === "winner").map((p) => ({ to: p.wallet, amounts: fromPay(p), usd: +(+p.usd || 0).toFixed(2), note: (p.tickets || 0) + " ticket" + (p.tickets === 1 ? "" : "s") }));
  const preacherLines = open.filter((p) => p.kind === "preacher").map((p) => ({ to: p.wallet, amounts: fromPay(p), usd: +(+p.usd || 0).toFixed(2), note: (p.code ? p.code + " · " : "") + (p.tier || "") + (p.share ? " " + Math.round(p.share * 100) + "%" : "") }));
  const swapped = (lines) => lines.some((l) => l.amounts[MINTS.SOL] || l.amounts[MINTS.USDC]);
  const OUT = [];
  OUT.push(group("winners", plan ? "Pot winners — round " + plan.round : "Pot winners", "this week's draw", winnerLines,
    { none: winnerLines.length ? null : (drawNote || (plan && plan.status === "paid" ? "Round " + plan.round + " is already paid ✓" : "No draw to pay right now")), swapNote: swapped(winnerLines) ? "SOL / USDC parts are swapped to ORE in the same batch" : null }));
  OUT.push(group("preachers", "Preacher shares", "28–44% of the coin buys they brought in (mining tips locked before 27 Oct 2026 still pay)", preacherLines,
    { none: preacherLines.length ? null : "No preacher is owed $1 or more", swapNote: swapped(preacherLines) ? "SOL / USDC parts are swapped to ORE in the same batch" : null }));
  const refundLines = (keeper.refundsDue || []).map((r) => { const a = clean({ [MINTS.ORE]: fromRaw(r.raw, "ORE") }); return { to: r.payer, amounts: a, usd: usd(a), note: ((r.mints || []).length || 0) + " card(s) paid after the Mint cap was full" }; });
  OUT.push(group("refunds", "Repair refunds", "repairs paid when every Mint spot was taken", refundLines, { none: refundLines.length ? null : "None" }));
  const claimLines = burnEnabled ? (keeper.claimsDue || []).map((c) => ({ to: c.wallet, amounts: clean({ [STORE_MINT_]: +c.store || 0 }), usd: +(+c.usd || 0).toFixed(2), note: (c.coll || "") + (c.kind === "sent" ? " · sent to the Treasury" : " · burned by the holder") })) : [];
  OUT.push(group("claims", "Burn claims", "a burned card's share of its Card Vault, in stORE", claimLines, { none: burnEnabled ? (claimLines.length ? null : "None") : "Burning is off — no claims" }));
  const opsDue = clean(keeper.ops?.due);
  const opsLines = Object.keys(opsDue).length && opsWallet ? [{ to: opsWallet, amounts: opsDue, usd: usd(opsDue), note: "12% of royalties, repairs, coin buys and referred mining tips" }] : [];
  OUT.push(group("ops", "Operations share (12%)", "hosting, tools, the team", opsLines,
    { none: !Object.keys(opsDue).length ? "Nothing due" : opsWallet ? null : "Operations wallet not set — set OPS_WALLET in Netlify", waiting: !opsWallet && Object.keys(opsDue).length ? amt(opsDue) : null }));
  const OUT_USD = +OUT.reduce((s, g) => s + g.usd, 0).toFixed(2);
  // the Card Vault + Reserve shares are swapped to stORE — that money stays with us
  const unconv = clean(Object.fromEntries(Object.entries(keeper.totals?.unconverted || {}).filter(([m]) => m !== STORE_MINT_)));
  const convUsd = usd(unconv), sp = px(STORE_MINT_);
  const convert = { key: "convert", label: "Swapped to stORE (stays with us)", why: "the Card Vault and Reserve shares, as Staked ORE", amounts: unconv, usd: convUsd,
    becomes: sp > 0 && convUsd > 0 ? { [STORE_MINT_]: +(convUsd / sp).toFixed(6) } : {}, none: Object.keys(unconv).length ? null : "Nothing to convert" };

  // ---- STAYS ----
  const now_ = clean(reserve?.holdings);
  let leaving = {};
  for (const g of OUT) leaving = plus(leaving, g.amounts);
  const after = plus(minus(minus(now_, leaving), unconv), convert.becomes);
  const potAmts = clean({ [MINTS.ORE]: Object.values(pot?.routes || {}).reduce((s, r) => s + (+r.ore || 0), 0), [MINTS.SOL]: Object.values(pot?.routes || {}).reduce((s, r) => s + (+r.sol || 0), 0), [MINTS.SKR]: Object.values(pot?.routes || {}).reduce((s, r) => s + (+r.skr || 0), 0) });
  const vaults = Object.entries(keeper.pools || {}).map(([name, p]) => ({ name, amounts: clean(p.pool), usd: usd(p.pool), nfts: p.eligible ?? null }));
  const potUsd = +(+(pot?.usd) || 0).toFixed(2), vaultUsd = +vaults.reduce((s, v) => s + v.usd, 0).toFixed(2), afterUsd = usd(after);
  const opsWaiting = OUT.find((g) => g.key === "ops")?.waiting || null;
  return {
    at: now, from: now - 7 * DAY, partial: !reserve || !!reserve.partial, reserveAt: reserve?.at || null,
    in: IN, inUsd: +IN.reduce((s, l) => s + l.usd, 0).toFixed(2), topUps,
    out: OUT, outUsd: OUT_USD, convert,
    stays: { now: now_, nowUsd: usd(now_), after, afterUsd, pot: { amounts: potAmts, usd: potUsd }, vaults, vaultUsd,
      reserveFreeUsd: +Math.max(0, afterUsd - potUsd - vaultUsd - (opsWaiting ? opsWaiting.usd : 0)).toFixed(2), opsWaiting },
    symbols: STATEMENT_SYMBOLS, prices,
  };
}
