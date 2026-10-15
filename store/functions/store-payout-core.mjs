// Weekly payout engine — shared by the payout cron (store-fn-payout-cron.mjs) and the admin API
// (/api/payouts, store-fn-payouts.mjs). NO private key lives here or anywhere on the server:
// this only PLANS the payout and VERIFIES it afterwards. The owner pays from /payouts with their
// own wallet (one approval), and the page posts the signatures back for verification.
//
//   cronTick()          weekly state machine: commit → draw → build plan → notify
//   buildPlan(round)    winners (equal split of the round's pot snapshot, per token) +
//                       preachers (owed ≥ MIN_PREACHER_PAYOUT_USD) + fraud flags
//   recordPayment(...)  verify the pay txs on-chain, mark the plan + preacher records paid
//
// Blobs "payouts": round:<n> (plan), latest (n), cycle (cron state).
// Env: SOLANA_RPC, DRAW_DAY (0=Sun, default 0), DRAW_HOUR_UTC (default 18), PAYOUT_CAP_USD
// (default 300), MIN_PREACHER_PAYOUT_USD (default 1), TREASURY_WALLET, POT_WALLET,
// ROYALTY_WALLET, COSIGNER_PUBKEY, TEAM_WALLETS (comma list), STORE_URL.
import { getStore } from "@netlify/blobs";
import { getPot, addToPot, POT_FRAC } from "./store-pot-core.mjs";
import { computePreacherOwed, markPreacherPaid } from "./store-preacher-core.mjs";
import { commitRound, drawRound, latestRound, getPublic, verifyDraw, rpc, DrawError } from "./store-draw-core.mjs";
import { notify } from "./store-notify.mjs";
import { casUpdate, readWithEtag, putIfMatch, putIfNew } from "./store-cas-core.mjs";

export const MINTS = { ORE: "oreoU2P8bN6jkk3jbaiVxYnG1dCXcYxwhwyK9jSybcp", SKR: "SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3", USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", SOL: "So11111111111111111111111111111111111111112" };
export const DEC = { ORE: 11, SKR: 6, SOL: 9, USDC: 6 };
const ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const DAY = 86400e3;
const env = (k, d) => { const v = process.env[k]; return v == null || v === "" ? d : v; };
const num = (k, d) => { const v = Number(process.env[k]); return Number.isFinite(v) && process.env[k] !== "" && process.env[k] != null ? v : d; };
export const storeUrl = () => String(env("STORE_URL", "https://store.degendojo.xyz")).replace(/\/+$/, "");
const payStore = () => getStore("payouts");

// ---------- money helpers (raw integer base units, Number is exact below 2^53) ----------
export const toRaw = (amount, cur) => Math.max(0, Math.floor((+amount || 0) * 10 ** DEC[cur] + 1e-6));
export const fromRaw = (raw, cur) => (+raw || 0) / 10 ** DEC[cur];
// Equal integer split; the rounding remainder goes to the first payees one unit each.
export function splitEqual(total, n) {
  if (!(n > 0)) return [];
  const base = Math.floor(total / n), out = Array(n).fill(base);
  for (let i = 0, rem = total - base * n; rem > 0; i++, rem--) out[i % n] += 1;
  return out;
}
const fmt = (raw, cur, dp = 4) => fromRaw(raw, cur).toLocaleString("en-US", { maximumFractionDigits: dp });

// wallets that must never receive a payout (they're ours)
export function reservedWallets() {
  const m = new Map();
  const add = (w, label) => { if (ADDR_RE.test(w || "")) m.set(w, m.get(w) ? m.get(w) + " / " + label : label); };
  add(env("TREASURY_WALLET", "5w55F58ia3H71QjBD9bYvNQF2DcNu8K3AfJj9A4WMuWp"), "treasury");
  add(env("POT_WALLET", "ED3GMCfoX3XNvavnWADvd6oCsohGg1ukdhv3PaUpvwJe"), "pot wallet");
  add(env("ROYALTY_WALLET", "ED3GMCfoX3XNvavnWADvd6oCsohGg1ukdhv3PaUpvwJe"), "royalty wallet");
  add("HEyazxpV2wxMUvNx53UZUXthRS9Rjsbv7hoHYJNbVedC", "DD creator");
  add(env("COSIGNER_PUBKEY", ""), "marketplace cosigner");
  add(env("OPERATOR_WALLET", ""), "operator");
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
// Payee: { id, kind:'winner'|'preacher', wallet, label, usd, pay:{ORE,SKR,SOL,USDC} raw units }
//   pay.ORE / pay.SKR are transferred as-is; pay.SOL / pay.USDC are swapped to ORE at pay time.
export function potTotals(snap) {
  const t = { sol: 0, ore: 0, skr: 0 };
  for (const r of Object.values(snap?.routes || {})) { t.sol += +r.sol || 0; t.ore += +r.ore || 0; t.skr += +r.skr || 0; }
  return t;
}
export function winnerPayees(pub, snap) {
  const ws = (pub?.winners || []).filter((w) => ADDR_RE.test(w.wallet || ""));
  if (!ws.length) return [];
  const t = potTotals(snap);
  const sp = { ORE: splitEqual(toRaw(t.ore, "ORE"), ws.length), SKR: splitEqual(toRaw(t.skr, "SKR"), ws.length), SOL: splitEqual(toRaw(t.sol, "SOL"), ws.length) };
  const usd = (+snap?.usd || 0) / ws.length;
  return ws.map((w, i) => ({ id: "w:" + w.wallet, kind: "winner", wallet: w.wallet, label: w.name || w.wallet, tickets: w.tickets || 0,
    usd: +usd.toFixed(2), pay: { ORE: snap ? sp.ORE[i] : 0, SKR: snap ? sp.SKR[i] : 0, SOL: snap ? sp.SOL[i] : 0, USDC: 0 } }));
}
export function preacherPayees(rows, minUsd = num("MIN_PREACHER_PAYOUT_USD", 1)) {
  const payees = [], skipped = [];
  for (const r of rows || []) {
    if (!(r.owedUsd >= minUsd)) continue;
    if (!ADDR_RE.test(r.wallet || "")) { skipped.push({ code: r.code, owedUsd: r.owedUsd, reason: "no wallet linked" }); continue; }
    const pay = { ORE: 0, SKR: 0, SOL: 0, USDC: 0 }, other = {};
    for (const [cur, amt] of Object.entries(r.owedNative || {})) {
      if (!(amt > 0)) continue;
      if (cur in pay) pay[cur] += toRaw(amt, cur); else other[cur] = amt;
    }
    if (!(pay.ORE + pay.SKR + pay.SOL + pay.USDC > 0)) { skipped.push({ code: r.code, owedUsd: r.owedUsd, reason: "owed only in unsupported token(s) " + Object.keys(other).join(", ") }); continue; }
    payees.push({ id: "p:" + String(r.code).toLowerCase(), kind: "preacher", wallet: r.wallet, label: r.code, code: r.code, tier: r.tier, share: r.share,
      usd: +(+r.owedUsd).toFixed(2), paidUsdBefore: +(+r.paidUsd || 0).toFixed(2), pay, unsupported: other,
      sigs: (r.unpaidSigs || []).map((s) => s.sig).filter(Boolean) });
  }
  return { payees, skipped };
}
export function planTotals(payees, excluded = []) {
  const ex = new Set(excluded), t = { ORE: 0, SKR: 0, SOL: 0, USDC: 0, usd: 0 };
  for (const p of payees) { if (ex.has(p.id)) continue; for (const c of ["ORE", "SKR", "SOL", "USDC"]) t[c] += p.pay[c] || 0; t.usd += p.usd || 0; }
  t.usd = +t.usd.toFixed(2);
  return t;
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
// (h) the pot ledger's coin-pack + tip totals for the round vs the verified records in its window
export function checkPotLedger(snap, prevClosedAt, records, tol = 0.01) {
  if (!snap) return [];
  const exp = { coinbuy: { sol: 0, ore: 0, skr: 0 }, tip: { sol: 0, ore: 0, skr: 0 } };
  const k = { SOL: "sol", ORE: "ore", SKR: "skr" };
  for (const r of records) {
    if (!r.verified || r.rejected || !k[r.currency]) continue;
    const t = r.verifiedAt || 0;
    if (!(t > (prevClosedAt || 0) && t <= snap.closedAt)) continue;
    if (r.kind === "tip") exp.tip[k[r.currency]] += +r.verifiedAmount || 0;
    else exp.coinbuy[k[r.currency]] += (+r.verifiedAmount || 0) * POT_FRAC;
  }
  const flags = [];
  for (const route of ["coinbuy", "tip"]) for (const c of ["sol", "ore", "skr"]) {
    const led = +snap.routes?.[route]?.[c] || 0, want = exp[route][c];
    if (Math.abs(led - want) > Math.max(led, want) * tol + 1e-9)
      flags.push({ severity: "block", who: "plan", check: "h", reason: `pot ledger ${route} ${c.toUpperCase()} = ${+led.toFixed(6)} but verified records add up to ${+want.toFixed(6)}` });
  }
  return flags;
}

// ---------- build ----------
export async function getPlan(round) { return round ? await payStore().get("round:" + round, { type: "json" }) : null; }
export async function latestPlanRound() { return Number((await payStore().get("latest")) || 0); }

export async function buildPlan(round, { budgetMs = 20e3, excluded = [], now = Date.now() } = {}) {
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
  try { rows = await within(computePreacherOwed()); } catch (e) { flags.push(cant("g", "preacher payouts", e)); }
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
  flags.push(...checkCap(planTotals(payees).usd));
  flags.push(...checkPotLedger(snap, prevClosedAt, records));
  try { flags.push(...(await checkWinnerWallets(winners, { now, within }))); } catch (e) { flags.push(cant("b", "winner wallets", e)); }
  try { flags.push(...(await checkPreachers(preachers, records, { within }))); } catch (e) { flags.push(cant("g", "preacher funding", e)); }

  const plan = {
    round, builtAt: Date.now(), status: "ready",
    draw: { commitHash: pub.commitHash, seed: pub.seed, blockhash: pub.blockhash, blockSlot: pub.blockSlot, targetSlot: pub.targetSlot,
      totalTickets: pub.totalTickets, entrants: pub.entrants, drawnAt: pub.drawnAt, potRolledOver: !!pub.potRolledOver,
      statusUrl: storeUrl() + "/api/draw?action=status" },
    pot: snap ? { usd: +(+snap.usd || 0).toFixed(2), routes: snap.routes, totals: potTotals(snap), since: snap.since, closedAt: snap.closedAt } : null,
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
  if (t.ORE) parts.push(fmt(t.ORE, "ORE") + " ORE");
  if (t.SKR) parts.push(fmt(t.SKR, "SKR", 2) + " SKR");
  if (t.SOL) parts.push(fmt(t.SOL, "SOL") + " SOL→ORE");
  if (t.USDC) parts.push(fmt(t.USDC, "USDC", 2) + " USDC→ORE");
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
  const plan = await buildPlan(round, { ...opts, excluded: opts.excluded || old?.excluded || [] });
  // Save only if the plan is still the one we read (building takes seconds): a payment recorded in
  // the meantime must never be overwritten by a fresh, unpaid plan — that is how a round gets paid twice.
  const saved = etag ? await putIfMatch(payStore(), "round:" + round, plan, etag) : await putIfNew(payStore(), "round:" + round, plan);
  if (!saved) throw new DrawError(`round ${round}'s plan changed while it was being rebuilt — reload and try again`, 409);
  if (plan.round >= (await latestPlanRound())) await payStore().set("latest", String(plan.round));
  // Preachers are owed EVERYTHING unpaid, so the newest plan carries them. Drop unpaid preacher
  // payees from older unpaid plans, or paying both plans would pay the same records twice.
  const { blobs } = await payStore().list({ prefix: "round:" });
  for (const b of blobs) {
    const n = Number(b.key.slice(6)); if (!(n < round)) continue;
    await casUpdate(payStore(), "round:" + n, (o) => {
      if (!o || o.status === "paid") return undefined;
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

// ---------- paying ----------
// Per-owner raw token deltas across txs (jsonParsed or json getTransaction results).
export function tokenDeltas(txs) {
  const out = {};   // owner → mint → raw delta
  for (const tx of txs) {
    const add = (b, sign) => { if (!b?.owner || !b?.mint) return; const v = Number(b.uiTokenAmount?.amount || 0) * sign; ((out[b.owner] ||= {})[b.mint] = (out[b.owner][b.mint] || 0) + v); };
    for (const b of tx.meta?.postTokenBalances || []) add(b, 1);
    for (const b of tx.meta?.preTokenBalances || []) add(b, -1);
  }
  return out;
}
// What each wallet must receive: direct ORE/SKR, plus ORE bought by the swaps (client-reported
// per payee as swapOre, only trusted as "> direct" when absent).
export function dueByOwner(plan, ids, swapOre = {}) {
  const due = {};
  for (const p of plan.payees) {
    if (!ids.has(p.id)) continue;
    const d = (due[p.wallet] ||= { ORE: 0, SKR: 0, swap: false, swapUnreported: false, ids: [] });
    d.ORE += (p.pay.ORE || 0) + (+swapOre[p.id] || 0); d.SKR += p.pay.SKR || 0; d.ids.push(p.id);
    if ((p.pay.SOL || 0) + (p.pay.USDC || 0) > 0) { d.swap = true; if (!(+swapOre[p.id] > 0)) d.swapUnreported = true; }
  }
  return due;
}
// does what an owner received cover what they're due?
export function covers(d, gotOre, gotSkr) {
  if (d.ORE + d.SKR === 0 && !d.swap) return true;                       // nothing to send
  const oreOk = gotOre >= Math.floor(d.ORE * 0.999) && (!d.swapUnreported || gotOre > d.ORE);
  return oreOk && gotSkr >= Math.floor(d.SKR * 0.999);
}
// Verify the pay txs and mark what landed. Incremental: call again with more sigs after a retry.
export async function recordPayment({ round, sigs, payer, swapOre = {}, reviewed = false }) {
  const { value: plan, etag } = await readWithEtag(payStore(), "round:" + round);
  if (!plan) throw new DrawError("no payout plan for round " + round, 404);
  if (plan.status === "paid") throw new DrawError("round " + round + " is already paid");
  if (!ADDR_RE.test(payer || "")) throw new DrawError("payer wallet missing", 400);
  const list = [...new Set((sigs || []).filter((s) => /^[1-9A-HJ-NP-Za-km-z]{64,96}$/.test(s)))];
  if (!list.length) throw new DrawError("no transaction signatures", 400);
  const pay = plan.payment ||= { sigs: [], payer, paidIds: {}, reviewed: false };
  if (pay.payer !== payer) throw new DrawError(`this round is being paid from ${pay.payer} — use the same wallet`, 400);
  pay.reviewed = pay.reviewed || !!reviewed;
  const txs = [], bad = [];
  for (const s of list) {
    let tx = null;
    for (let i = 0; i < 3 && !tx; i++) { try { tx = await getTx(s, "jsonParsed"); } catch {} if (!tx && i < 2) await new Promise((r) => setTimeout(r, 1500)); }
    if (!tx) { bad.push({ sig: s, reason: "not found on-chain (yet)" }); continue; }
    if (tx.meta?.err) { bad.push({ sig: s, reason: "failed on-chain" }); continue; }
    const feePayer = keyStr(tx.transaction?.message?.accountKeys?.[0]);
    if (feePayer !== payer) { bad.push({ sig: s, reason: "not sent by " + payer.slice(0, 4) + "…" }); continue; }
    txs.push({ sig: s, tx });
    if (!pay.sigs.includes(s)) pay.sigs.push(s);
  }
  // every payee not excluded and not already verified must have received what they're due
  const ex = new Set(plan.excluded || []);
  const pending = new Set(plan.payees.filter((p) => !ex.has(p.id) && !pay.paidIds[p.id]).map((p) => p.id));
  const due = dueByOwner(plan, pending, swapOre);
  const newlyPaid = [];
  for (const [owner, d] of Object.entries(due)) {
    let gotOre = 0, gotSkr = 0, sigOf = null;
    for (const { sig, tx } of txs) {
      const del = tokenDeltas([tx])[owner] || {};
      if ((del[MINTS.ORE] || 0) > 0 || (del[MINTS.SKR] || 0) > 0) sigOf ||= sig;
      gotOre += Math.max(0, del[MINTS.ORE] || 0); gotSkr += Math.max(0, del[MINTS.SKR] || 0);
    }
    if (covers(d, gotOre, gotSkr)) for (const id of d.ids) { pay.paidIds[id] = { sig: sigOf, ore: gotOre, skr: gotSkr }; newlyPaid.push(id); }
  }
  // preachers: their covered record sigs are now paid (never owed again)
  for (const id of newlyPaid) {
    const p = plan.payees.find((x) => x.id === id);
    if (p?.kind === "preacher" && pay.paidIds[id].sig) await markPreacherPaid({ paySig: `${pay.paidIds[id].sig}:r${round}:${p.code}`, ref: p.code, wallet: p.wallet, payoutUsd: p.usd, sigs: p.sigs });
  }
  const missing = plan.payees.filter((p) => !ex.has(p.id) && !pay.paidIds[p.id]).map((p) => p.id);
  const rollover = [];
  if (!missing.length) {
    plan.status = "paid"; pay.paidAt = Date.now();
    // excluded winners' shares stay in the pot: added back to the live pot for next round (below)
    for (const p of plan.payees) {
      if (p.kind !== "winner" || !ex.has(p.id)) continue;
      const curs = [["ORE", p.pay.ORE], ["SKR", p.pay.SKR], ["SOL", p.pay.SOL]].filter(([, v]) => v > 0);
      if (curs.length) rollover.push({ p, curs });
    }
    pay.rolledOver = rollover.map(({ p }) => p.id);
  } else plan.status = "partial";
  // Save only if nobody changed the plan since we read it (a concurrent "paid" / exclude / rebuild):
  // exactly ONE call makes the partial→paid transition, so the rollover + "Paid" notice happen once.
  // (Preacher records marked above are keyed by the payment sig, so a repeat is a harmless overwrite.)
  if (!(await putIfMatch(payStore(), "round:" + round, plan, etag)))
    throw new DrawError("the plan changed while the payment was being verified — submit again (nothing is lost)", 409);
  if (plan.round >= (await latestPlanRound())) await payStore().set("latest", String(plan.round));
  for (const { p, curs } of rollover)
    for (const [c, v] of curs) await addToPot({ usd: (p.usd || 0.01) / curs.length, currency: c, native: fromRaw(v, c), route: "other", id: `rollover:r${round}:${p.id}:${c}` });
  if (plan.status === "paid") await notify(`Paid ✓ — ${summary(plan)}\n${pay.sigs.map((s) => "https://solscan.io/tx/" + s).join("\n")}`);
  return { ok: true, status: plan.status, paidIds: Object.keys(pay.paidIds), newlyPaid, missing, bad };
}

// Mark exclusion (or undo). Excluded winners' shares roll into next week's pot when the round is
// paid; excluded preachers simply stay owed (their records remain unpaid).
export async function setExcluded(round, who, exclude = true) {
  const { value } = await casUpdate(payStore(), "round:" + round, (plan) => {   // atomic vs a concurrent "paid"
    if (!plan) throw new DrawError("no payout plan for round " + round, 404);
    if (plan.status === "paid" || plan.payment?.paidIds?.[who]) throw new DrawError("already paid — can't change");
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
