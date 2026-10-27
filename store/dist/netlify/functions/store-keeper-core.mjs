// Dojo Keeper money ledger — card vaults, repairs, burn claims. Shared by /api/vault, /api/repair,
// /api/burnclaim, the payout cron and the /payouts admin desk. NO private key anywhere: the owner pays and
// burns once a week from /payouts with the Treasury wallet; this only RECORDS and VERIFIES.
//
// Owner rules (2026-10-23):
//   • every royalty and every repair payment splits 88% to that NFT's COLLECTION Card Vault / 12% ops (no Reserve share)
//     (three pools: Degen Dojo, Demon Dojo, TETO). Only income after the 2026-10-22 hand-over counts.
//   • an eligible NFT's burn value = its collection's Card Vault ÷ the number of eligible NFTs in that collection now.
//     Eligible: Degen Dojo cards whose Condition is Mint or Framed (Cracked / Mono → 0: repair first); every live
//     Demon Dojo and TETO NFT (they have no Condition). A burn claim takes its share OUT of the pool, so the next
//     burner's share stays fair: (P − P/N) / (N − 1) = P/N.
//   • repair = 0.01 ORE per card, Cracked or Mono → Mint. Mint (and Framed) cards are protected forever.
//     A repair payment is ANY ORE transfer into the Treasury's ORE account by a wallet that holds Cracked/Mono
//     cards — not a credited store coin buy / tip, no ddtip memo, not a mining tx. The paying wallet = the owner of the
//     ORE account the money left (not the fee payer). `ddfix:<mint>` memos (the page's one-click flow) make it a repair
//     whatever anyone POSTs to /api/coinbuy, and pick the cards first, then the rarest. N = floor(ORE / 0.01), capped at
//     the wallet's repairable cards; ORE beyond the repaired cards goes to the Reserve as a direct tip.
//   • a "marketplace transaction" = one that RUNS a marketplace program (top level or inner), never one that merely
//     lists its id; a DAS / RPC failure is never read as "not ours" (retry, then a skip the desk lists for re-decision).
//     (Security review 2026-10-23, lane 7: M-1, M-2, M-3, L-1..L-4, I-2, I-4.)
//   • a burn value is paid only when the NFT is burned — by its holder (a burn tx) or by SENDING it to the
//     Treasury (the weekly batch burns it). The claim is fixed in stORE at that moment and paid weekly in stORE.
//   • BURNING IS NOT LAUNCHED (BURN_ENABLED env, default off): the pools keep filling silently, but no burn value or
//     pool figure is shown publicly, /api/burnclaim refuses, and NFTs sent to the Treasury are only recorded as
//     "held" (no claim). It's a treasure hunt, not a promise of money.
//   • HARD CAP on Mint cards — an admin SETTING (/payouts desk; env MINT_CAP is only the initial default, 888): Degen
//     Dojo cards in Mint / Framed (live) + every repair ever granted may never exceed it. Repairs are granted first come,
//     first served by payment time, each judged against the cap that was in force WHEN IT WAS PAID (lowering the cap
//     later closes repairs for later payments only; it never downgrades a Mint card). A repair over the cap is recorded
//     as a refund (0.01 ORE back to the payer) for the weekly batch — no split is booked for it.
//   • the condition comes from the NFT's own "Condition" trait (Framed / Mint / Cracked / Mono) — whatever the
//     Nov 2 crack batch sets; nothing here decides who cracks.
//
// Raw token amounts are BigInt in code and decimal strings in JSON (house style, see store-payout-core.mjs).
//
// Blobs "keeper":
//   dec:<sig>        what a Treasury transaction meant — decided ONCE (create-only), then applied idempotently
//   pool:<collMint>  { coll, bal: {currencyMint: raw}, ids, claimed: [mint] }   a collection's shared Card Vault
//   repair:<mint>    one repair per card { mint, wallet, from, sig, at, status: "pending" | "applied" }
//   claim:<mint>     one burn claim per card { mint, coll, wallet, kind: "burn"|"sent", storeRaw, store, usd,
//                    vault, sig, at, status: "due"|"paid", inTreasury, burnedAt?, paid? }
//   totals           { reserve, ops, direct, unconverted: {currencyMint: raw}, ids }
//   scan             { newest: {address: sig}, pending: [{ s, t }] }   Treasury history not yet decided
//   paidsig:<sig>:<owner>   a claim-payment transfer counted once
//   held:<mint>      an NFT sent to the Treasury while burning is off { mint, coll, from, sig, at, convertedAt? }
//   skips            { items: [{ sig, why, at, payer, ore, refused, redecided? }] }   skipped payments the desk lists
//   mintcap          { granted: [mint] }   every repair ever granted (the cap's ledger, compare-and-swap)
//   settings         { history: [{ at, cap, prev, ip }] }   the Mint cap over time (latest wins) = its audit log
//   refund:<sig>     { sig, payer, raw, mints, at, status: "due"|"paid", paid? }   repairs refused by the cap
//   refsig:<sig>:<payer>    a refund-payment transfer counted once
import { getStore } from "@netlify/blobs";
import { casUpdate, putIfNew, readWithEtag, pushId } from "./store-cas-core.mjs";
import { rpc } from "./store-draw-core.mjs";
import { getTx, big, tokenDeltas } from "./store-payout-core.mjs";
import { memosOf, TIP_MEMO } from "./store-ref-core.mjs";
import { MARKETPLACES } from "./store-royalty-core.mjs";
import { heliusKey, walkHistory } from "./store-helius-core.mjs";
import RARITY from "./dd-trait-rarity.json" with { type: "json" };

export const COLLS = {
  "2m9DupVeheZ5vfuXZxqV3KSQ7HnVDk2tG6ouH1ZnLwYb": "Degen Dojo",
  WyUy9qjJekjqTAYGanANjhtviwgu1uhCkXx1uas8fWb: "Demon Dojo",
  dgd6We3oS4M5LSVzT6Ep39wwVpjLC336tCpyPZkLAHx: "TETO",
};
export const TREASURY = process.env.TREASURY_WALLET || "5w55F58ia3H71QjBD9bYvNQF2DcNu8K3AfJj9A4WMuWp";
export const ORE_MINT = "oreoU2P8bN6jkk3jbaiVxYnG1dCXcYxwhwyK9jSybcp";
// stORE, ORE's liquid staking token. Verified 2026-10-23: ore.supply's own app lists THIS as "stORE mint";
// sTorERYB6x… is its "Affected stORE mint" (old, replaced) — never use that one.
export const STORE_MINT = "storenSbvkfzircixnaosc5CbzNZVrHJ6S3EKrS1yqR";
export const SOL_MINT = "So11111111111111111111111111111111111111112";
export const DECIMALS = { [ORE_MINT]: 11, [STORE_MINT]: 11, [SOL_MINT]: 9, SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3: 6, EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 6 };
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
export const ORE_PROGRAM = "oreV3EG1i9BEgiAJ8b177Z2S2rMarzak4NMv1kULvWv";
export const TM_PROGRAM = "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s";
// the Treasury's ORE token account (ATA). ORE sent straight to it does NOT list the Treasury wallet itself
// among the tx accounts, so history is read for both addresses.
export const TREASURY_ORE_ATA = process.env.TREASURY_ORE_ATA || "7mapvsQQhHMeRxEbsMUMJUjxUnTy6t8tm7EKizdJZGKv";
export const REPAIR_PRICE_RAW = 1_000_000_000n;   // 0.01 ORE (11 decimals)
export const REPAIRABLE = new Set(["Cracked", "Mono"]);
export const PROTECTED = new Set(["Mint", "Framed"]);
export const SINCE = Date.UTC(2026, 9, 22);       // the hand-over: vaults accrue from here on
export const SPLIT = { vault: 88n, reserve: 0n };   // owner 2026-10-24: 88% Card Vault (was 44 vault / 44 Reserve)   // ops = the rest (12%) — rounding dust goes to ops
// our own wallets (+ the owner's personal wallet): their transfers into the Treasury are not income / claims
const OWN = new Set([TREASURY, "ED3GMCfoX3XNvavnWADvd6oCsohGg1ukdhv3PaUpvwJe", "DfaGo3Qht6MC2bqgFCBHgUWjaeXDNmsbE7XjyRKWM3qS",
  process.env.COSIGNER_PUBKEY || "8KUWwAHMb7TL31JGbucCi8YE1ax7njWi46ajVbWnvDqr",
  ...(process.env.OWNER_WALLETS || "FTrH7Q3jJ2gkPwvpgR8KDGtmewRbB2RKBeKYaZH7hiNy").split(",").map((x) => x.trim()).filter(Boolean)]);
const ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export const SIG_RE = /^[1-9A-HJ-NP-Za-km-z]{64,96}$/;
export const isAddr = (s) => ADDR_RE.test(s || "");
export const MAX_AGE_MS = 48 * 3600e3;   // POST /api/repair & /api/burnclaim only look at recent transactions
const ORE_SETTLE_MS = 10 * 60e3;          // a memo-less ORE payment is decided once it is this old (see decide() step 3)
export const burnEnabled = () => /^(1|true|yes|on)$/i.test(String(process.env.BURN_ENABLED || "").trim());
const envMintCap = () => { const n = parseInt(process.env.MINT_CAP || "888", 10); return n > 0 ? n : 888; };
export async function getSettings() { return (await ks().get("settings", { type: "json" })) || { history: [] }; }
// the cap in force at time t (ms): the last setting made at or before t, else the env default
export async function mintCapAt(t = Date.now(), settings = null) {
  const h = ((settings || (await getSettings())).history || []).filter((x) => x.at <= t);
  return h.length ? h[h.length - 1].cap : envMintCap();
}
export async function setMintCap(cap, { ip = null } = {}) {
  cap = Number(cap);
  if (!Number.isInteger(cap) || cap < 1 || cap > 100000) throw new KeeperError("the Mint cap must be a whole number between 1 and 100000");
  const prev = await mintCapAt();
  const { value } = await casUpdate(ks(), "settings", (st) => {
    st ||= { history: [] };
    st.history = [...(st.history || []), { at: Date.now(), cap, prev, ...(ip ? { ip } : {}) }].slice(-500);
    return st;
  });
  console.log("keeper: Mint cap", prev, "→", cap, ip ? "(" + ip + ")" : "");
  return { cap, prev, history: (value?.history || []).slice(-20) };
}
export const DD_COLL = "2m9DupVeheZ5vfuXZxqV3KSQ7HnVDk2tG6ouH1ZnLwYb";   // Degen Dojo — the Mint cap counts its live Mint / Framed cards

export class KeeperError extends Error { constructor(msg, status = 400) { super(msg); this.status = status; } }
const ks = () => getStore("keeper");
const S = (b) => big(b).toString();

// ---------- money ----------
export function splitRaw(raw) {   // → { vault, reserve, ops } BigInt, exact (sum === raw)
  raw = big(raw);
  const vault = (raw * SPLIT.vault) / 100n, reserve = (raw * SPLIT.reserve) / 100n;
  return { vault, reserve, ops: raw - vault - reserve };
}
const addTo = (obj, mint, raw) => { if (big(raw) !== 0n) obj[mint] = S(big(obj[mint]) + big(raw)); return obj; };
export function toUi(raw, mint) { const d = DECIMALS[mint] ?? 9; const b = big(raw), neg = b < 0n, a = neg ? -b : b, s = a.toString().padStart(d + 1, "0"); const t = (s.slice(0, -d) + "." + s.slice(-d)).replace(/\.?0+$/, ""); return (neg ? "-" : "") + (t || "0"); }
export function fromUi(ui, mint) {   // decimal string/number → raw BigInt (floored, via its shortest decimal string)
  const d = DECIMALS[mint] ?? 9; let s = typeof ui === "string" ? ui.trim() : String(Number(ui));
  if (/e/i.test(s)) s = Number(ui).toFixed(d + 3);
  if (!/^\d+(\.\d+)?$/.test(s)) return 0n;
  const [i, f = ""] = s.split(".");
  return BigInt(i + f.slice(0, d).padEnd(d, "0"));
}

// ---------- prices (Jupiter, 60s cache) ----------
let PX = { at: 0, p: {}, t: {} };   // t: when each mint's price was last fetched
export async function prices(mints = [SOL_MINT, ORE_MINT, STORE_MINT, ...Object.keys(DECIMALS)]) {
  if (Date.now() - PX.at < 60e3 && mints.every((m) => m in PX.p)) return PX.p;
  const want = [...new Set([...mints, STORE_MINT])];
  try {
    const base = String(process.env.JUPITER_BASE || "https://lite-api.jup.ag").replace(/\/+$/, "");
    const j = await (await fetch(base + "/price/v3?ids=" + want.join(","))).json();
    const p = {}, t = {}; for (const m of want) if (j?.[m]?.usdPrice > 0) { p[m] = j[m].usdPrice; t[m] = Date.now(); }
    PX = { at: Date.now(), p: { ...PX.p, ...p }, t: { ...PX.t, ...t } };
  } catch {}
  return PX.p;
}
export const _setPrices = (p, at = Date.now()) => { PX = { at, p, t: Object.fromEntries(Object.keys(p).map((m) => [m, at])) }; };   // test hook
// Prices a burn CLAIM may be fixed at (review L-3): only ones fetched in the last few minutes (a Jupiter outage never
// fixes a claim at an hours-old price), and stORE — liquid-staked ORE, worth at least one ORE — valued at no less than
// ORE, so a momentary dip in its thin pool can't inflate every claim fixed that minute. null → try again later.
export const CLAIM_PRICE_MAX_AGE_MS = 5 * 60e3;
export async function claimPrices() {
  const p = await prices(), now = Date.now(), out = {};
  for (const [m, v] of Object.entries(p)) if (v > 0 && now - (PX.t[m] || 0) <= CLAIM_PRICE_MAX_AGE_MS) out[m] = v;
  const sp = out[STORE_MINT], op = out[ORE_MINT];
  if (!(sp > 0) || !(op > 0)) return null;
  if (sp > op * 3) return null;   // far off its ORE backing either way = a broken quote, not a price
  out[STORE_MINT] = Math.max(sp, op);
  return out;
}

// What a vault (currencyMint → raw) is worth in stORE at live prices (stORE itself counts 1:1).
// → { storeRaw: BigInt, store: "decimal", usd: number } — null when a needed price is missing.
export function vaultInStore(bal, px) {
  const sp = px[STORE_MINT];
  let usd = 0, storeRaw = 0n;
  for (const [m, raw] of Object.entries(bal || {})) {
    if (!(big(raw) > 0n)) continue;
    if (m === STORE_MINT) { storeRaw += big(raw); usd += Number(toUi(raw, m)) * (sp || 0); continue; }
    const p = px[m]; if (!(p > 0) || !(sp > 0)) return null;
    const v = Number(toUi(raw, m)) * p; usd += v;
    storeRaw += fromUi((v / sp).toFixed(11), STORE_MINT);
  }
  return { storeRaw, store: toUi(storeRaw, STORE_MINT), usd: +usd.toFixed(2) };
}

// ---------- NFTs (DAS) ----------
const ASSETS = new Map();   // mint → { at, a } per warm instance
export async function assetOf(mint, { fresh = false } = {}) {
  const c = ASSETS.get(mint);
  if (!fresh && c && Date.now() - c.at < 60e3) return c.a;
  const a = await rpc("getAsset", { id: mint });
  ASSETS.set(mint, { at: Date.now(), a }); if (ASSETS.size > 3000) ASSETS.clear();
  return a;
}
export const collMintOf = (a) => (a?.grouping || []).find((g) => g.group_key === "collection" && (g.verified !== false))?.group_value || null;
export const collOf = (a) => COLLS[collMintOf(a)] || null;
export const attrOf = (a, k) => ((a?.content?.metadata?.attributes) || []).find((x) => x.trait_type === k)?.value ?? null;
export const conditionOf = (a) => attrOf(a, "Condition");
// weighted rarity, as on the rank page: Σ 1/pct over the card's traits (higher = rarer)
export function rarityScore(a) {
  let s = 0;
  for (const t of (a?.content?.metadata?.attributes) || []) {
    if (!t || t.trait_type === "Condition") continue;
    const r = RARITY?.traits?.[t.trait_type + "|" + t.value];
    if (r?.pct > 0) s += 1 / r.pct;
  }
  return s;
}
export async function holdings(owner) {   // our NFTs the wallet holds now (DAS), ≤ 1000 — .rawCount = every NFT on the page
  const r = await rpc("getAssetsByOwner", { ownerAddress: owner, page: 1, limit: 1000, displayOptions: { showFungible: false } });
  const items = r?.items || [], out = items.filter((a) => !a.burnt && collOf(a));
  out.rawCount = items.length;
  return out;
}

// ---------- records ----------
export const COLL_MINT = Object.fromEntries(Object.entries(COLLS).map(([m, n]) => [n, m]));   // "Degen Dojo" → collection mint
export async function getPool(collMint) { return (await ks().get("pool:" + collMint, { type: "json" })) || { coll: COLLS[collMint] || null, bal: {}, ids: [], claimed: [] }; }
export async function getRepair(mint) { return await ks().get("repair:" + mint, { type: "json" }); }
export async function getClaim(mint) { return await ks().get("claim:" + mint, { type: "json" }); }
export async function getTotals() { return (await ks().get("totals", { type: "json" })) || { reserve: {}, ops: {}, direct: {}, unconverted: {}, ids: [] }; }

// the 88% card share of a royalty / repair → that collection's shared Card Vault (idempotent by id)
async function creditPool(collMint, bal, id) {
  if (!COLLS[collMint]) return;
  await casUpdate(ks(), "pool:" + collMint, (p) => {
    p ||= { coll: COLLS[collMint], bal: {}, ids: [], claimed: [] };
    if ((p.ids || []).includes(id)) return undefined;   // already credited
    for (const [m, raw] of Object.entries(bal)) addTo(p.bal, m, raw);
    p.ids = pushId(p.ids, id, 20000); p.updatedAt = Date.now();
    return p;
  });
}
// a burn claim takes its share out of the pool (once per card; never below zero)
async function debitPool(collMint, share, mint) {
  await casUpdate(ks(), "pool:" + collMint, (p) => {
    p ||= { coll: COLLS[collMint], bal: {}, ids: [], claimed: [] };
    if ((p.claimed || []).includes(mint)) return undefined;
    for (const [m, raw] of Object.entries(share || {})) { const cur = big(p.bal[m]), d = big(raw); p.bal[m] = S(cur > d ? cur - d : 0n); }
    p.claimed = [...(p.claimed || []), mint]; p.updatedAt = Date.now();
    return p;
  });
}

// ---------- burn value: eligibility + shares of the pool ----------
// Eligible = Degen Dojo card in Mint / Framed condition, or any live Demon Dojo / TETO NFT.
// Shares: a Mythic Degen (mythic Race, Mint condition) counts 3, a Framed Degen 2, every other eligible NFT 1.
// Burn value = pool × shares(card) ÷ total eligible shares.
export function eligibleAsset(a) {
  const coll = collOf(a);
  if (!coll) return false;
  return coll === "Degen Dojo" ? PROTECTED.has(conditionOf(a)) : true;
}
export const FRAMED_SHARES = 2, MYTHIC_SHARES = 3;
// the 1/1 and near-1/1 races (same list the site uses for the diamond "Mythic" border)
export const MYTHIC_RACES = new Set(["gods", "senseis", "oni senseis", "rowdy sensei", "pirate", "mutants", "devil", "ruggers", "rugger", "derugger"]);
export const isMythic = (a) => collOf(a) === "Degen Dojo" && conditionOf(a) === "Mint" && MYTHIC_RACES.has(String(attrOf(a, "Race") || "").toLowerCase());
export const sharesOf = (a) => (!eligibleAsset(a) ? 0
  : collOf(a) === "Degen Dojo" && conditionOf(a) === "Framed" ? FRAMED_SHARES
  : isMythic(a) ? MYTHIC_SHARES : 1);
export const burnNoteOf = (a) => (collOf(a) === "Degen Dojo" && REPAIRABLE.has(conditionOf(a)) ? "Repair it to Mint first — Cracked and Mono cards have no burn value" : null);
const ELIG = new Map();   // collMint → { at, mints: Map(mint → shares) } per warm instance
const ELIG_TTL = 3 * 60e3;
export async function eligibleMints(collMint, { fresh = false } = {}) {
  const c = ELIG.get(collMint);
  if (!fresh && c && Date.now() - c.at < ELIG_TTL) return c.mints;
  const mints = new Map();
  for (let page = 1; page <= 10; page++) {
    const r = await rpc("getAssetsByGroup", { groupKey: "collection", groupValue: collMint, page, limit: 1000 });
    const items = r?.items || [];
    for (const a of items) { const w = a.burnt ? 0 : sharesOf(a); if (w) mints.set(a.id, w); }
    if (items.length < 1000) break;
  }
  ELIG.set(collMint, { at: Date.now(), mints });
  return mints;
}
export const _resetEligible = () => ELIG.clear();   // test hook
// The collection's eligible live NFTs that haven't claimed yet → { nfts, shares }, counting `includeMint` (the card
// being valued / burned, worth `includeShares`) once even if it is already burnt in the index.
export async function eligibleCount(collMint, { includeMint = null, includeShares = 1, pool = null, fresh = false } = {}) {
  const map = await eligibleMints(collMint, { fresh });
  const claimed = new Set((pool || (await getPool(collMint))).claimed || []);
  let nfts = 0, shares = 0;
  for (const [m, w] of map) if (!claimed.has(m)) { nfts++; shares += w; }
  if (includeMint && !claimed.has(includeMint) && !map.has(includeMint)) { nfts++; shares += includeShares; }
  return { nfts, shares };
}
export function shareOf(bal, n, w = 1) {   // per currency floor(bal × w / n) — exact BigInt
  const out = {};
  if (!(n > 0) || !(w > 0)) return out;
  for (const [m, raw] of Object.entries(bal || {})) { const v = (big(raw) * BigInt(w)) / BigInt(n); if (v > 0n) out[m] = S(v); }
  return out;
}
// one NFT's burn value right now: { eligible, share: {mint: raw}, w: its shares, n: total eligible shares, pool }
export async function burnShare(a, { fresh = false, pool = null } = {}) {
  const collMint = collMintOf(a);
  pool ||= await getPool(collMint);
  const w = sharesOf(a);
  if (!w) return { eligible: false, share: {}, w: 0, n: 0, pool };
  const { shares: n } = await eligibleCount(collMint, { includeMint: a.id, includeShares: w, pool, fresh });
  return { eligible: true, share: shareOf(pool.bal, n, w), w, n, pool };
}
// also used by store-verify-core.mjs for the Reserve + ops parts of coin buys and mining tips (ids "game:<sig>")
export async function creditTotals(parts, id) {
  await casUpdate(ks(), "totals", (t) => {
    t ||= { reserve: {}, ops: {}, direct: {}, unconverted: {}, ids: [] };
    if ((t.ids || []).includes(id)) return undefined;
    for (const k of ["reserve", "ops", "direct", "unconverted"]) for (const [m, raw] of Object.entries(parts[k] || {})) addTo(t[k] ||= {}, m, raw);
    t.ids = pushId(t.ids, id, 20000);
    return t;
  });
}

// ---------- reading a transaction ----------
const keyStr = (k) => (typeof k === "string" ? k : k?.pubkey || String(k));
const keysOf = (tx) => [...(tx.transaction?.message?.accountKeys || []), ...(tx.meta?.loadedAddresses?.writable || []), ...(tx.meta?.loadedAddresses?.readonly || [])].map(keyStr);
const signersOf = (tx) => {
  const ak = tx.transaction?.message?.accountKeys || [];
  if (ak.length && typeof ak[0] === "object" && "signer" in ak[0]) return ak.filter((k) => k.signer).map(keyStr);   // jsonParsed
  return ak.slice(0, tx.transaction?.message?.header?.numRequiredSignatures || 1).map(keyStr);
};
// SOL gained by `wallet` (raw lamports, BigInt)
function solGain(tx, wallet) {
  const i = keysOf(tx).indexOf(wallet);
  return i < 0 ? 0n : BigInt((tx.meta?.postBalances?.[i] || 0) - (tx.meta?.preBalances?.[i] || 0));
}
// NFT (decimals 0) holders before / after: mint → { pre, post } owner
function nftMoves(tx) {
  const m = {};
  for (const [arr, k] of [[tx.meta?.preTokenBalances || [], "pre"], [tx.meta?.postTokenBalances || [], "post"]])
    for (const b of arr) if (b.uiTokenAmount?.decimals === 0 && String(b.uiTokenAmount?.amount) === "1") (m[b.mint] ||= {})[k] = b.owner;
  return m;
}
const txTime = (tx) => (tx.blockTime || 0) * 1000;
// The programs a transaction actually RAN (top level + inner instructions) — never its plain account list: a System
// transfer accepts unused extra accounts, so a marketplace id merely LISTED in a payment proves nothing (security review
// 2026-10-23, M-1: a coin buy listing Tensor as a decoy was booked a second time as a royalty). json or jsonParsed.
export function invokedPrograms(tx) {
  const keys = keysOf(tx);
  const ixs = [...(tx?.transaction?.message?.instructions || []), ...(tx?.meta?.innerInstructions || []).flatMap((x) => x?.instructions || [])];
  return new Set(ixs.map((ix) => (ix?.programId != null ? keyStr(ix.programId) : keys[ix?.programIdIndex])).filter(Boolean));
}
// Who paid ORE: the owner of the ORE account the money left (the largest drop) — not the fee payer, so a sponsored-fee
// or multisig payment is still judged (and refunded) as the holder's own (review L-1). null if no one's ORE dropped.
function orePayer(tx) {
  let who = null, drop = 0n;
  for (const [owner, byMint] of Object.entries(tokenDeltas([tx]))) {
    if (owner === TREASURY) continue;
    const v = -(byMint[ORE_MINT] || 0n);
    if (v > drop) { drop = v; who = owner; }
  }
  return who;
}
// A DAS / RPC answer we couldn't get is NOT a fact about the NFT or its holder (review M-3): decide() then answers
// "retry" (nothing stored) instead of a permanent skip. Only DAS's own "not found" means "not one of ours".
class Transient extends Error {}
const notFound = (e) => /not\s*found|could ?not find|no asset/i.test(String(e?.message || e));
async function assetSafe(mint, opts) {
  try { return await assetOf(mint, opts); }
  catch (e) { if (notFound(e)) return null; throw new Transient("couldn't read an NFT from DAS (" + String(e?.message || e).slice(0, 80) + ")"); }
}
// What the store's coin ledger holds for this signature (strong reads — the verify cron runs in another function):
// "credited" (a coin buy / tip verified or being credited), "pending" (a record nobody has judged yet), "rejected", or null.
// One inflow is booked once: a credited coin buy is never also a repair or a royalty; a rejected record blocks nothing.
async function coinStatus(sig) {
  try {
    if (await getStore("coin-credits").get("credited:" + sig, { type: "json", consistency: "strong" })) return "credited";
    const rec = await getStore("coin-purchases").get("buy:" + sig, { type: "json", consistency: "strong" });
    return !rec ? null : rec.verified ? "credited" : rec.rejected ? "rejected" : "pending";
  } catch (e) { throw new Transient("couldn't read the coin-purchase ledger"); }
}
const EMPTY_RETRY_MS = 30 * 60e3;   // an empty NFT list for a wallet that just paid ORE is re-read for this long
export const GIVE_UP_MS = 24 * 3600e3;   // a transient failure is retried for a day, then decided as a skip the desk lists

// ---------- deciding what a Treasury transaction means (ONCE per signature) ----------
// → { kind: "skip"|"royalty"|"repair"|"sent"|"held"|"retry", … } — pure data, stored as dec:<sig>; apply() acts on it.
// "retry" is never stored: the signature is decided again on the next read.
export async function decide(sig, tx, { now = Date.now() } = {}) {
  if (!tx) return { kind: "retry", why: "the transaction isn't readable yet", transient: true };
  if (tx.meta?.err) return { kind: "skip", why: "failed tx" };
  const t = txTime(tx);
  if (t && t < SINCE) return { kind: "skip", why: "before the hand-over" };
  try { return await decideTx(sig, tx, t, now); }
  catch (e) { if (e instanceof Transient) return { kind: "retry", why: e.message, transient: true, at: t || null }; throw e; }
}
async function decideTx(sig, tx, t, now) {
  const signers = signersOf(tx);
  if (signers.includes(TREASURY)) return { kind: "skip", why: "the Treasury's own transaction" };
  // Dojo Sweep's fees (memo "ddsweep:fee": the 1% in SOL, the 0.01 ORE GemFarm rescue fee) and older ddsweep tips: decided
  // by the memo FIRST, so an ORE fee is never read as a memo-less card repair
  if (memosOf(tx).some((m) => m.startsWith("ddsweep:"))) return { kind: "skip", why: "a Dojo Sweep fee or tip (ddsweep memo) — not a royalty, repair or card" };
  const progs = invokedPrograms(tx);
  const market = [...progs].some((p) => MARKETPLACES.has(p));
  const deltas = tokenDeltas([tx])[TREASURY] || {};
  const moves = nftMoves(tx);

  // 1) NFTs of ours arriving in the Treasury from their holder → burn claims (the weekly batch burns them). Decided
  //    BEFORE the marketplace check (review L-4): a wallet that routes a plain send through a marketplace program still
  //    sent the card in. Only a marketplace SALE to the Treasury (the sender got paid in that tx) isn't a send-in.
  const arrived = [];
  for (const [mint, mv] of Object.entries(moves)) if (mv.post === TREASURY && mv.pre && mv.pre !== TREASURY) arrived.push({ mint, from: mv.pre });
  if (arrived.length) {
    const sent = [];
    for (const x of arrived) {
      if (OWN.has(x.from)) continue;
      const a = await assetSafe(x.mint); const coll = collOf(a);
      if (coll) sent.push({ mint: x.mint, coll, from: x.from });
    }
    const gotPaid = (w) => solGain(tx, w) > 0n || Object.entries(tokenDeltas([tx])[w] || {}).some(([m, d]) => d > 0n && DECIMALS[m] != null);
    if (sent.length && market && sent.some((x) => gotPaid(x.from))) return { kind: "skip", why: "the Treasury bought this NFT on a marketplace (not a card sent in)", cards: sent.map((x) => x.mint) };
    if (sent.length && !burnEnabled()) return { kind: "held", at: t || now, cards: sent };   // recorded only — no claim while burning is off
    if (sent.length) {
      const px = await claimPrices();
      if (!px) return { kind: "retry", why: "no fresh stORE / ORE price to fix the claim at" };
      const snaps = [];
      for (const x of sent) {
        const a = await assetSafe(x.mint, { fresh: true });
        if (!a) return { kind: "retry", why: "couldn't re-read the card sent in", transient: true, at: t || null };
        const b = await burnShare(a, { fresh: true }).catch(() => null);
        if (!b) return { kind: "retry", why: "couldn't count the collection's eligible NFTs", transient: true, at: t || null };
        const val = vaultInStore(b.share, px);
        if (!val) return { kind: "retry", why: "no fresh price for the stORE snapshot" };
        snaps.push({ ...x, collMint: collMintOf(a), vault: b.share, eligible: b.eligible, w: b.w, n: b.n, storeRaw: S(val.storeRaw), store: val.store, usd: val.usd });
      }
      return { kind: "sent", at: t || now, cards: snaps };
    }
  }

  // 2) a marketplace sale paid the Treasury its royalty → 88% to the sold NFT's collection vault
  if (market) {
    // the Treasury SOLD one of its own NFTs (a listed card the buyer bought): the proceeds are the Treasury's, not a
    // royalty for a Card Vault (review I-4)
    if (Object.values(moves).some((mv) => mv.pre === TREASURY && mv.post && mv.post !== TREASURY)) return { kind: "skip", why: "the Treasury's own sale (proceeds, not a royalty)" };
    const gains = {};
    const sg = solGain(tx, TREASURY); if (sg > 0n) gains[SOL_MINT] = S(sg);
    // currencies only — an NFT (decimals 0) landing in the Treasury is never "money" owed to ops (review L-4)
    for (const [m, d] of Object.entries(deltas)) if (d > 0n && m !== SOL_MINT && DECIMALS[m] != null) gains[m] = S(d);
    if (!Object.keys(gains).length) return { kind: "skip", why: "marketplace tx, nothing received" };
    const cs = await coinStatus(sig);
    if (cs === "credited") return { kind: "skip", why: "already a store coin purchase / tip" };
    if (cs === "pending") return { kind: "retry", why: "a coin-purchase record for this signature is still being checked" };
    const sold = [];
    for (const [mint, mv] of Object.entries(moves)) if (mv.pre && mv.post && mv.pre !== mv.post) {
      const a = await assetSafe(mint); const coll = collOf(a);
      if (coll) sold.push({ mint, coll, collMint: collMintOf(a) });
    }
    return { kind: "royalty", at: t || now, gains, sold };
  }

  // 3) ORE into the Treasury's ORE account → a repair payment if the payer holds Cracked/Mono cards
  const ore = deltas[ORE_MINT] || 0n;
  if (ore > 0n) {
    const memos = memosOf(tx), feePayer = signers[0], payer = orePayer(tx) || feePayer;
    const fix = memos.some((m) => m.startsWith("ddfix:"));
    // our own wallets' ORE into the Treasury is a top-up — unless it names cards to repair (ddfix memos: the owner
    // repairing cards he holds, e.g. the pre-Nov 2 test)
    if (OWN.has(payer) && !fix) return { kind: "skip", why: "from our own wallet" };
    if (progs.has(ORE_PROGRAM)) return { kind: "skip", why: "mining tip" };
    if (memos.some((m) => m === TIP_MEMO || m.startsWith(TIP_MEMO))) return { kind: "skip", why: "Pot tip" };
    if (!fix) {
      if (memos.some((m) => m.startsWith("ddq:"))) return { kind: "skip", why: "store coin purchase (price-locked quote)" };
      // A plain ORE transfer with no ddfix memo may be a game-coin purchase whose /api/coinbuy record lands a few
      // seconds after it confirms — decide it only once it is ORE_SETTLE_MS old, so it is never read as a repair first.
      if (t && now - t < ORE_SETTLE_MS) return { kind: "retry", why: "waiting for a possible coin-purchase record" };
    }
    // The coin ledger (review M-2). A ddfix: payment is a repair whatever anyone POSTed to /api/coinbuy — only coins
    // actually credited for it stop it (never both). A memo-less payment waits while a record is unjudged; a REJECTED
    // record (e.g. a stranger's junk POST) no longer blocks the holder's repair.
    const cs = await coinStatus(sig);
    if (cs === "credited") return { kind: "skip", why: "store coin purchase / tip record", ...(fix ? { payer, ddfix: true } : {}) };
    if (cs === "pending" && !fix) return { kind: "retry", why: "waiting for a possible coin-purchase record to be checked" };
    const asked = [...new Set(memos.map((m) => /^ddfix:([1-9A-HJ-NP-Za-km-z]{32,44})$/.exec(m)?.[1]).filter(Boolean))];
    let held;
    try { held = await holdings(payer); } catch { return { kind: "retry", why: "couldn't read the payer's cards", transient: true, at: t || null }; }
    const byMint = new Map(held.map((a) => [a.id, a]));
    // DAS's owner index can lag or come back empty — a card the payment names is re-checked on its own (getAsset)
    for (const mint of asked) if (!byMint.has(mint)) {
      const a = await assetSafe(mint, { fresh: true });
      if (a && !a.burnt && collOf(a) && a.ownership?.owner === payer) { byMint.set(mint, a); held.push(a); }
    }
    // an EMPTY NFT list for a wallet that just paid ORE is more likely a DAS hiccup than a holder of nothing: read it
    // again for a while (then it is decided as read, and the skip is listed on the desk for the owner to re-decide)
    if (!held.length && !held.rawCount && !asked.length && t && now - t < EMPTY_RETRY_MS) return { kind: "retry", why: "the payer's NFT list came back empty — reading it again shortly", transient: true, at: t };
    const refused = [], candidates = [];
    const repairable = async (a) => {
      const c = conditionOf(a);
      if (!REPAIRABLE.has(c)) return c ? `condition is ${c} — nothing to repair` : "no Condition trait";
      if (await getRepair(a.id)) return "already repaired";
      return null;
    };
    for (const mint of asked) {
      const a = byMint.get(mint);
      if (!a) { refused.push({ mint, reason: "not held by the paying wallet (or not a Dojo NFT)" }); continue; }
      const why = await repairable(a); if (why) { refused.push({ mint, reason: why }); continue; }
      candidates.push(a);
    }
    const rest = [];
    for (const a of held) if (!asked.includes(a.id) && !(await repairable(a))) rest.push(a);
    rest.sort((x, y) => rarityScore(y) - rarityScore(x) || (x.id < y.id ? -1 : 1));   // rarest first
    const queue = [...candidates, ...rest];
    const who = { payer, ...(feePayer !== payer ? { feePayer } : {}), ore: S(ore) };
    if (!queue.length) return asked.length ? { kind: "skip", why: "no repairable card in this payment", refused, ...who } : { kind: "skip", why: "payer holds no Cracked/Mono cards", ...who };
    const n = Number(ore / REPAIR_PRICE_RAW < BigInt(queue.length) ? ore / REPAIR_PRICE_RAW : BigInt(queue.length));
    const cards = queue.slice(0, n).map((a) => ({ mint: a.id, coll: collOf(a), from: conditionOf(a) }));
    for (const a of candidates.slice(n)) refused.push({ mint: a.id, reason: "the payment didn't cover this card (0.01 ORE each)" });
    if (!cards.length) return { kind: "skip", why: "payment below 0.01 ORE", refused, ...who };
    return { kind: "repair", at: t || now, ...who, cards, refused, leftover: S(ore - REPAIR_PRICE_RAW * BigInt(cards.length)) };
  }
  return { kind: "skip", why: "not a royalty, repair or card arrival" };
}

// ---------- applying a decision (idempotent; safe to re-run after a crash) ----------
export async function apply(sig, d) {
  if (d.kind === "royalty") {
    const reserve = {}, ops = {}, unconverted = {}, perCard = {};
    for (const [m, raw] of Object.entries(d.gains)) {
      const sp = splitRaw(raw);
      addTo(reserve, m, sp.reserve); addTo(ops, m, sp.ops);
      if (d.sold.length) {   // the vault share, split evenly over the Dojo NFTs that sold in this tx
        const N = BigInt(d.sold.length), each = sp.vault / N; let rem = sp.vault - each * N;
        for (const c of d.sold) { const v = each + (rem > 0n ? 1n : 0n); if (rem > 0n) rem--; addTo((perCard[c.mint] ||= {}), m, v); }
        addTo(unconverted, m, sp.vault + sp.reserve);
      } else { addTo(reserve, m, sp.vault); addTo(unconverted, m, sp.vault + sp.reserve); }   // no card to credit → Reserve
    }
    const perPool = {};   // the sold NFTs' shares, summed per collection pool
    for (const c of d.sold) { const cm = c.collMint || COLL_MINT[c.coll]; for (const [m, raw] of Object.entries(perCard[c.mint] || {})) addTo((perPool[cm] ||= {}), m, raw); }
    for (const [cm, bal] of Object.entries(perPool)) await creditPool(cm, bal, sig);
    await creditTotals({ reserve, ops, unconverted }, sig);
  } else if (d.kind === "repair") {
    const sp = splitRaw(REPAIR_PRICE_RAW), reserve = {}, ops = {}, direct = {}, unconverted = {};
    const done = [], capped = [];
    const prior = await ks().get("refund:" + sig, { type: "json" });   // a re-run keeps the refund it already decided
    for (const c of d.cards) {
      if (prior?.mints?.includes(c.mint)) { capped.push(c.mint); continue; }
      if (!(await grantMintSpot(c.mint, d.at))) { capped.push(c.mint); continue; }   // over the Mint cap (as it stood when paid) → refund, no split
      const rec = { mint: c.mint, coll: c.coll, wallet: d.payer, from: c.from, to: "Mint", sig, at: d.at, status: "pending" };
      const mine = (await putIfNew(ks(), "repair:" + c.mint, rec)) || (await getRepair(c.mint))?.sig === sig;
      if (!mine) { addTo(reserve, ORE_MINT, REPAIR_PRICE_RAW); addTo(direct, ORE_MINT, REPAIR_PRICE_RAW); addTo(unconverted, ORE_MINT, REPAIR_PRICE_RAW); continue; }   // raced: another payment repaired it first → its price goes to the Reserve
      await creditPool(COLL_MINT[c.coll], { [ORE_MINT]: sp.vault }, sig + ":" + c.mint);
      addTo(reserve, ORE_MINT, sp.reserve); addTo(ops, ORE_MINT, sp.ops); addTo(unconverted, ORE_MINT, sp.vault + sp.reserve);
      done.push(c.mint);
    }
    if (big(d.leftover) > 0n) { addTo(reserve, ORE_MINT, d.leftover); addTo(direct, ORE_MINT, d.leftover); addTo(unconverted, ORE_MINT, d.leftover); }
    await creditTotals({ reserve, ops, direct, unconverted }, sig);
    if (capped.length && !prior) await putIfNew(ks(), "refund:" + sig, { sig, payer: d.payer, raw: S(REPAIR_PRICE_RAW * BigInt(capped.length)), mints: capped, at: d.at, status: "due" });
    return { repaired: done, refunded: capped };
  } else if (d.kind === "held") {
    for (const c of d.cards) await putIfNew(ks(), "held:" + c.mint, { mint: c.mint, coll: c.coll, from: c.from, sig, at: d.at });
  } else if (d.kind === "sent") {
    for (const c of d.cards) await createClaim({ mint: c.mint, coll: c.coll, collMint: c.collMint || COLL_MINT[c.coll], wallet: c.from, kind: "sent", storeRaw: c.storeRaw, store: c.store, usd: c.usd, vault: c.vault, eligible: c.eligible, w: c.w, n: c.n, sig, at: d.at, inTreasury: true });
  }
  return {};
}

// ---------- the Mint cap ----------
// Grant one Mint spot to a card being repaired (atomic). Count = |live Mint/Framed Degens ∪ every repair ever granted|
// — the union never double-counts a repaired card once the index shows it as Mint, and never dips while it doesn't.
// A repaired card that was later burned for its claim is no Mint card any more — its granted spot is free again.
const goneMints = async () => new Set((await getPool(DD_COLL)).claimed || []);
export async function grantMintSpot(mint, paidAt = Date.now()) {
  const live = [...(await eligibleMints(DD_COLL, { fresh: true })).keys()];
  const cap = await mintCapAt(paidAt), gone = await goneMints();
  let granted = false;
  await casUpdate(ks(), "mintcap", (c) => {
    c ||= { granted: [] };
    if (c.granted.includes(mint)) { granted = true; return undefined; }   // a re-run: already granted
    const all = new Set([...live, ...c.granted.filter((m) => !gone.has(m))]);
    if (all.size >= cap) { granted = false; return undefined; }
    c.granted = [...c.granted, mint]; granted = true; c.updatedAt = Date.now();
    return c;
  });
  return granted;
}
export async function mintSpots({ fresh = false } = {}) {
  const [live, c, gone] = await Promise.all([eligibleMints(DD_COLL, { fresh }), ks().get("mintcap", { type: "json" }), goneMints()]);
  const count = new Set([...live.keys(), ...((c && c.granted) || []).filter((m) => !gone.has(m))]).size, cap = await mintCapAt();
  return { mintCount: count, mintCap: cap, mintSpotsLeft: Math.max(0, cap - count) };
}
// Weekly refunds: verify the Treasury's ORE transfers, then mark the covered refunds paid (oldest first per payer,
// never on a partial amount; each (sig, payer) transfer counted once ever).
export async function recordRefundsPaid({ sigs, payer }) {
  if (payer !== TREASURY) throw new KeeperError("refunds are paid from the Treasury " + TREASURY.slice(0, 4) + "…", 400);
  const list = [...new Set((sigs || []).filter((x) => SIG_RE.test(x || "")))].slice(0, 40);
  if (!list.length) throw new KeeperError("no transaction signatures");
  const txs = [], bad = [];
  for (const x of list) {
    const tx = await getTx(x, "jsonParsed").catch(() => null);
    if (!tx) { bad.push({ sig: x, reason: "not found on-chain (yet)" }); continue; }
    if (tx.meta?.err) { bad.push({ sig: x, reason: "failed on-chain" }); continue; }
    if (keyStr(tx.transaction?.message?.accountKeys?.[0]) !== TREASURY) { bad.push({ sig: x, reason: "not paid by the Treasury" }); continue; }
    txs.push({ sig: x, tx });
  }
  const due = (await listJson("refund:")).filter((r) => r.status === "due").sort((a, b) => a.at - b.at);
  const byPayer = new Map(); for (const r of due) byPayer.set(r.payer, [...(byPayer.get(r.payer) || []), r]);
  const paid = [], short = [];
  for (const [who, refunds] of byPayer) {
    let got = 0n; const used = [];
    for (const { sig, tx } of txs) {
      const d = tokenDeltas([tx])[who]?.[ORE_MINT] || 0n;
      if (d > 0n && (await ks().get("refsig:" + sig + ":" + who))) continue;
      if (d > 0n) { got += d; used.push(sig); }
    }
    if (!(got > 0n)) continue;
    let left = got; const mine = [];
    for (const r of refunds) {
      const need = big(r.raw);
      if (need > left) { short.push({ sig: r.sig, payer: who, need: toUi(need, ORE_MINT), left: toUi(left, ORE_MINT) }); break; }
      left -= need;
      const { value } = await casUpdate(ks(), "refund:" + r.sig, (x) => { if (!x || x.status !== "due") return undefined; x.status = "paid"; x.paid = { sigs: used, at: Date.now() }; return x; });
      if (value?.status === "paid") { paid.push(r.sig); mine.push(r.sig); }
    }
    if (mine.length) for (const x of used) await putIfNew(ks(), "refsig:" + x + ":" + who, { at: Date.now(), refunds: mine });
  }
  return { paid, short, bad };
}

export async function createClaim(c) {
  // an empty vault owes nothing: the card is still burned (if it was sent in), but there is nothing to pay
  const rec = { ...c, status: big(c.storeRaw) > 0n ? "due" : "nothing" };
  const created = await putIfNew(ks(), "claim:" + c.mint, rec);
  const cm = c.collMint || COLL_MINT[c.coll];
  // take the share out of the pool (also re-run safely if a crashed call created the claim but didn't debit)
  if (created || (await getClaim(c.mint))?.sig === c.sig) await debitPool(cm, c.vault || {}, c.mint);
  return created ? rec : await getClaim(c.mint);
}

// Decide (once) + apply one Treasury signature. → the stored decision (with .applied).
export async function processSig(sig, { tx = null, now = Date.now(), giveUp = true } = {}) {
  const store = ks();
  let d = await store.get("dec:" + sig, { type: "json" });
  if (!d) {
    if (!tx) { try { tx = await getTx(sig, "jsonParsed"); } catch { return { kind: "retry", why: "couldn't read the transaction (RPC) — trying again later" }; } }
    let fresh = await decide(sig, tx, { now });
    // a transient failure (DAS / RPC) is retried for a day — then decided as a skip that the desk lists (re-decide there)
    if (giveUp && fresh.kind === "retry" && fresh.transient && fresh.at && now - fresh.at > GIVE_UP_MS) fresh = { kind: "skip", why: "gave up after 24 h: " + fresh.why };
    if (fresh.kind === "retry") return fresh;   // decide again later (nothing stored)
    fresh.decidedAt = now;
    if (!(await putIfNew(store, "dec:" + sig, fresh))) d = await store.get("dec:" + sig, { type: "json" });   // another call decided first
    else { d = fresh; if (d.kind === "skip") await noteSkip(sig, d); }
  }
  if (d && !d.applied && d.kind !== "skip") {
    const res = await apply(sig, d);
    const { value } = await casUpdate(store, "dec:" + sig, (x) => { if (!x || x.applied) return undefined; x.applied = true; x.result = res; return x; });
    d = value || d;
  }
  return d;
}

// ---------- skipped payments: listed on the desk, re-decided by the owner (review M-3) ----------
// A skip is final — so every skip that may hide someone's money (anything but our own / failed / mining / tip / quoted
// coin-buy transactions) goes on the desk's list ("skips", newest 300) with its reason, payer and refused cards.
const ROUTINE_SKIPS = new Set(["failed tx", "before the hand-over", "the Treasury's own transaction", "from our own wallet", "mining tip", "Pot tip", "store coin purchase (price-locked quote)"]);
async function noteSkip(sig, d) {
  if (ROUTINE_SKIPS.has(d.why) || (d.why === "store coin purchase / tip record" && !d.ddfix)) return;
  await casUpdate(ks(), "skips", (x) => {
    x ||= { items: [] };
    if (x.items.some((i) => i.sig === sig)) return undefined;
    x.items = [...x.items, { sig, why: d.why, at: d.decidedAt || Date.now(), payer: d.payer || null, ore: d.ore || null, refused: (d.refused || []).slice(0, 10) }].slice(-300);
    return x;
  }).catch((e) => console.log("keeper: couldn't list skip", sig, e?.message));
}
export async function listSkips() { return ((await ks().get("skips", { type: "json" }))?.items || []).slice().sort((a, b) => (b.at || 0) - (a.at || 0)); }
// The owner re-decides ONE signature with today's rules and data (e.g. after a DAS outage, or a payment skipped before
// the 2026-10-24 fixes). Only a skip can be re-decided — a royalty / repair / claim already booked never is. If it
// still can't be decided right now, the old decision is put back untouched.
export async function redecide(sig) {
  if (!SIG_RE.test(sig || "")) throw new KeeperError("bad signature");
  const store = ks(), prev = await store.get("dec:" + sig, { type: "json" });
  if (prev && prev.kind !== "skip") throw new KeeperError(`only a skipped payment can be re-decided — this one is "${prev.kind}"`);
  if (prev) await store.delete("dec:" + sig);
  let d;
  try { d = await processSig(sig, { giveUp: false }); }   // a manual re-decision never "gives up" — it keeps the old one
  catch (e) { if (prev) await putIfNew(store, "dec:" + sig, prev); throw e; }
  if (d.kind === "retry") {
    if (prev) await putIfNew(store, "dec:" + sig, prev);
    throw new KeeperError("couldn't decide it right now (" + (d.why || "try again") + ") — the old decision is kept", 503);
  }
  await casUpdate(store, "skips", (x) => {
    const it = x?.items?.find((i) => i.sig === sig); if (!it) return undefined;
    it.redecided = { at: Date.now(), kind: d.kind, why: d.why || null };
    return x;
  }).catch(() => {});
  console.log("keeper: re-decided", sig, prev ? prev.why : "(no decision)", "→", d.kind, d.why || "");
  return { sig, before: prev ? { kind: prev.kind, why: prev.why } : null, after: { kind: d.kind, why: d.why || null, cards: (d.cards || []).map((c) => c.mint), result: d.result || null } };
}

// ---------- cards held while burning was off → claims (review I-2; the owner's choice, card by card) ----------
// Once burning is open, a card sent in earlier (held:<mint>) can be turned into a claim at TODAY's value for the wallet
// that sent it — only while the card is still in the Treasury (or already burned) and has no claim yet.
export async function convertHeld(mints) {
  if (!burnEnabled()) throw new KeeperError("Burning isn't open yet — held cards can become claims only once it is", 409);
  const px = await claimPrices();
  if (!px) throw new KeeperError("no fresh stORE / ORE price right now — try again in a minute", 503);
  const done = [], refused = [];
  for (const mint of [...new Set(mints || [])].slice(0, 50)) {
    if (!isAddr(mint)) continue;
    const h = await ks().get("held:" + mint, { type: "json" });
    if (!h) { refused.push({ mint, reason: "not a held card" }); continue; }
    if (h.convertedAt || (await getClaim(mint))) { refused.push({ mint, reason: "already a claim" }); continue; }
    const a = await assetOf(mint, { fresh: true }).catch(() => null);
    if (!a || !collOf(a)) { refused.push({ mint, reason: "couldn't read the card" }); continue; }
    if (!a.burnt && a.ownership?.owner !== TREASURY) { refused.push({ mint, reason: "no longer in the Treasury" }); continue; }
    const b = await burnShare(a, { fresh: true }).catch(() => null), val = b && vaultInStore(b.share, px);
    if (!val) { refused.push({ mint, reason: "couldn't value it right now" }); continue; }
    const c = await createClaim({ mint, coll: collOf(a), collMint: collMintOf(a), wallet: h.from, kind: "sent", storeRaw: S(val.storeRaw), store: val.store, usd: val.usd, vault: b.share, eligible: b.eligible, w: b.w, n: b.n, sig: h.sig, at: Date.now(), heldSince: h.at, inTreasury: !a.burnt });
    await casUpdate(ks(), "held:" + mint, (x) => { if (!x || x.convertedAt) return undefined; x.convertedAt = Date.now(); return x; });
    done.push({ mint, wallet: h.from, store: c.store, usd: c.usd, status: c.status });
  }
  return { converted: done, refused };
}

// ---------- reading the Treasury's history (bounded per call) ----------
// The Treasury auto-mines ORE: the ORE executor's deploys list it as the authority, so it is in ~1,250 txs a day and
// almost none change its balances. Only a tx that changes the Treasury's SOL, its tokens / NFTs or its ORE account can
// be a royalty, a repair or a card sent in, so only those are queued and decided (one getTransaction each):
//   • Helius key in SOLANA_RPC → its batch history (store-helius-core walkHistory, 100 txs a request WITH their balance
//     changes) for the wallet and its ORE account; the noise is skipped without ever being read. At most `maxPages`
//     history requests per address per call; an unfinished walk is kept as a resumable gap.
//   • no Helius key → getSignaturesForAddress + read each tx (exact but slow); one that changes none of the Treasury's
//     balances is dropped without storing a decision.
// The queue is decided OLDEST first, at most `max` per call. Used by the payout cron (every 10 min) and lazily by /api/vault.
const SCAN_V = 2;   // v2 = the queue only ever holds balance-changing txs (Helius); an older queue is rebuilt from SINCE
// a Helius parsed tx: does it change the Treasury's SOL, any of its token / NFT balances, or its ORE account?
export function enhancedTouchesTreasury(e) {
  if (!e || e.transactionError) return false;   // a failed tx is never a payment
  for (const a of e.accountData || []) {
    if (a.account === TREASURY && Number(a.nativeBalanceChange || 0) !== 0) return true;
    for (const c of a.tokenBalanceChanges || [])
      if ((c.userAccount === TREASURY || c.tokenAccount === TREASURY_ORE_ATA) && Number(c.rawTokenAmount?.tokenAmount || 0) !== 0) return true;
  }
  return false;
}
// the same question for a full (jsonParsed) tx — the no-Helius fallback
export function changesTreasury(tx) {
  if (!tx || tx.meta?.err) return false;
  return solGain(tx, TREASURY) !== 0n || Object.values(tokenDeltas([tx])[TREASURY] || {}).some((d) => d !== 0n);
}
export async function scanTreasury({ max = 25, budgetMs = 8000, maxPages = 8 } = {}) {
  const deadline = Date.now() + budgetMs, key = heliusKey();
  const { value: st0 } = await readWithEtag(ks(), "scan");
  let st = st0 || { v: SCAN_V, newest: {}, pending: [], gaps: {} };
  if (key && st.v !== SCAN_V) st = { v: SCAN_V, newest: {}, pending: [], gaps: {} };   // re-discover noise-free (decided txs aren't re-read)
  st.gaps ||= {};
  const startNewest = { ...(st.newest || {}) }, startGaps = JSON.parse(JSON.stringify(st.gaps));   // a cursor another call moved meanwhile is never moved back
  const known = new Set(st.pending.map((p) => p.s));
  const queue = (sig, t) => { if (!known.has(sig)) { known.add(sig); st.pending.push({ s: sig, t }); } };
  let skipped = 0;
  if (key) {
    for (const addr of [TREASURY, TREASURY_ORE_ATA])
      await walkHistory(st, addr, key, { since: SINCE, maxPages, budgetOk: () => Date.now() < deadline,
        onTx: (e, t) => { if (enhancedTouchesTreasury(e)) queue(e.signature, t); else skipped++; } }).catch(() => {});   // RPC trouble: the gap / cursor resumes next call
  } else {
    for (const addr of [TREASURY, TREASURY_ORE_ATA]) {
      let before, first = null, done = false;
      for (let page = 0; page < 4 && !done; page++) {
        const sigs = await rpc("getSignaturesForAddress", [addr, { limit: 1000, ...(before ? { before } : {}) }]).catch(() => null);
        if (!sigs?.length) break;
        for (const x of sigs) {
          if (x.signature === st.newest[addr] || (x.blockTime || 0) * 1000 < SINCE) { done = true; break; }
          first ||= x.signature;
          if (!x.err) queue(x.signature, (x.blockTime || 0) * 1000); else skipped++;
        }
        before = sigs[sigs.length - 1].signature;
        if (sigs.length < 1000) break;
      }
      if (first) st.newest[addr] = first;
    }
  }
  st.pending.sort((a, b) => a.t - b.t);
  const left = [], results = [];
  for (const p of st.pending) {
    if (results.length >= max || Date.now() > deadline) { left.push(p); continue; }
    try {
      let d;
      if (!key && !(await ks().get("dec:" + p.s))) {   // fallback: read it first — a tx that changes nothing of ours stores nothing
        const tx = await getTx(p.s, "jsonParsed").catch(() => null);
        if (!tx) { left.push(p); continue; }
        if (!changesTreasury(tx)) { skipped++; results.push({ s: p.s, kind: "skip" }); continue; }
        d = await processSig(p.s, { tx });
      } else d = await processSig(p.s);
      if (d.kind === "retry") left.push(p);
      results.push({ s: p.s, kind: d.kind });
    } catch { left.push(p); }
  }
  // merge with whatever another call stored meanwhile (never lose a pending signature)
  await casUpdate(ks(), "scan", (cur) => {
    const sameV = !!cur && (cur.v || 1) === (st.v || 1);
    if (!sameV) cur = { v: st.v, newest: {}, pending: [], gaps: {} };
    const keep = new Map(left.map((p) => [p.s, p]));
    const handled = new Set(results.filter((r) => r.kind !== "retry").map((r) => r.s));
    for (const p of cur.pending || []) if (!handled.has(p.s) && !keep.has(p.s) && !st.pending.some((q) => q.s === p.s)) keep.set(p.s, p);
    const newest = { ...(cur.newest || {}) }, gaps = { ...(cur.gaps || {}) };
    for (const addr of [TREASURY, TREASURY_ORE_ATA]) {
      // this call's cursor + gaps for an address win only if no other call moved them meanwhile
      const untouched = (cur.newest || {})[addr] === startNewest[addr] && JSON.stringify((cur.gaps || {})[addr] || []) === JSON.stringify(startGaps[addr] || []);
      if (!sameV || untouched) { if (st.newest?.[addr]) newest[addr] = st.newest[addr]; gaps[addr] = st.gaps[addr] || []; }
    }
    return { v: st.v || 1, newest, gaps, pending: [...keep.values()].sort((a, b) => a.t - b.t), at: Date.now() };
  });
  return { processed: results.length, pending: left.length, skipped, helius: !!key, gaps: Object.values(st.gaps).reduce((n, g) => n + g.length, 0) };
}

// ---------- what a page sees ----------
// `ctx` (from recordsFor) = the repair / claim records already read for a batch of cards + one pool read per
// collection, so a big holder's /api/vault costs a couple of reads instead of 2–3 per card (review L-2).
export async function vaultItem(a, px, ctx = null) {
  const mint = a.id, coll = collOf(a), condition = conditionOf(a);
  const on = burnEnabled();
  const poolOf = async () => { const cm = collMintOf(a); if (!ctx) return null; if (!ctx.pools.has(cm)) ctx.pools.set(cm, getPool(cm)); return ctx.pools.get(cm); };
  const [b, rep, claim] = await Promise.all([on ? poolOf().then((pool) => burnShare(a, { pool })) : { eligible: false, share: {}, w: 0, n: 0 },
    ctx ? ctx.repairs.get(mint) ?? null : getRepair(mint), ctx ? ctx.claims.get(mint) ?? null : getClaim(mint)]);
  const val = claim ? null : b.eligible ? vaultInStore(b.share, px) : { store: "0", usd: 0 };
  const repairPending = !!rep && rep.status !== "applied";
  const note = claim ? null : burnNoteOf(a);
  return {
    mint, collection: coll, name: a.content?.metadata?.name || "", image: a.content?.links?.image || "",
    condition,   // the NFT's own trait — a paid repair shows as repairPending until the weekly apply sets "Mint"
    repair: REPAIRABLE.has(condition) && !rep ? { price: "0.01", currency: "ORE", to: "Mint" } : null,
    repairPending, protected: PROTECTED.has(condition) || repairPending,
    // burn value / Card Vault share — only once burning is open (BURN_ENABLED); until then no money figure is shown
    ...(on ? {
      vault: Object.fromEntries(Object.entries(claim ? claim.vault || {} : b.share).map(([m, raw]) => [m, toUi(raw, m)])),   // this NFT's share of its collection's Card Vault
      burnValue: claim ? { store: claim.store, usd: claim.usd } : val ? { store: val.store, usd: val.usd } : null,
      eligible: !claim && b.eligible, shares: b.w || 0, eligibleShares: b.n || null, ...(note ? { burnNote: note } : {}),
    } : {}),
    burned: !!a.burnt || !!claim,
    ...(claim && on ? { claim: { status: claim.status, store: claim.store, usd: claim.usd, kind: claim.kind, wallet: claim.wallet, at: claim.at, paid: claim.paid || null } } : {}),
  };
}
// The repair / claim records of a batch of cards → a vaultItem ctx. ≤ 10 cards: read each (as before); more: list the
// record keys once and read only the cards that have one (a 271-card holder was ~550 reads per call before).
export async function recordsFor(mints) {
  const ctx = { repairs: new Map(), claims: new Map(), pools: new Map() }, want = new Set(mints);
  const read = async (prefix, map, list) => { for (let i = 0; i < list.length; i += 25) await Promise.all(list.slice(i, i + 25).map(async (m) => { const v = await ks().get(prefix + m, { type: "json" }); if (v) map.set(m, v); })); };
  if (want.size <= 10) { await Promise.all([read("repair:", ctx.repairs, [...want]), read("claim:", ctx.claims, [...want])]); return ctx; }
  const [r, c] = await Promise.all([ks().list({ prefix: "repair:" }), ks().list({ prefix: "claim:" })]);
  const hits = (blobs, p) => blobs.map((b) => b.key.slice(p.length)).filter((m) => want.has(m));
  await Promise.all([read("repair:", ctx.repairs, hits(r.blobs, "repair:")), read("claim:", ctx.claims, hits(c.blobs, "claim:"))]);
  return ctx;
}
export const pagePublic = () => ({ storeMint: STORE_MINT, treasury: TREASURY, treasuryOreAccount: TREASURY_ORE_ATA, oreMint: ORE_MINT, repairPrice: "0.01" });
// the three Card Vault pools: what each holds, how many NFTs / shares split it now, and what ONE share is worth in
// stORE (a Mint card or any Demon / TETO = 1 share, a Framed Degen = 2)
export async function poolsPublic(px = null) {
  px ||= await prices();
  const out = {};
  for (const [collMint, name] of Object.entries(COLLS)) {
    const pool = await getPool(collMint);
    const e = await eligibleCount(collMint, { pool }).catch(() => null);
    const v = e?.shares ? vaultInStore(shareOf(pool.bal, e.shares), px) : null;
    out[name] = { collection: collMint, pool: Object.fromEntries(Object.entries(pool.bal || {}).map(([m, raw]) => [m, toUi(raw, m)])), eligible: e ? e.nfts : null,
      shares: e ? e.shares : null, perShare: v ? { store: v.store, usd: v.usd } : { store: "0", usd: 0 }, claimed: (pool.claimed || []).length };
  }
  return out;
}

// ---------- holder's own burn (page one-click) ----------
// The holder burned the NFT themselves: verify, then fix the claim at today's stORE value.
export async function claimFromBurn(sig, tx) {
  if (!burnEnabled()) throw new KeeperError("Burning isn't open yet", 409);
  if (!tx || tx.meta?.err) throw new KeeperError("that transaction failed or isn't on-chain yet");
  const signers = signersOf(tx), keys = keysOf(tx);
  if (!keys.includes(TM_PROGRAM)) throw new KeeperError("not a burn transaction");
  const moves = nftMoves(tx), out = [];
  for (const [mint, mv] of Object.entries(moves)) {
    if (!mv.pre || mv.post || !signers.includes(mv.pre)) continue;   // held by a signer before, gone after
    const supply = await rpc("getTokenSupply", [mint]).catch(() => null);
    if (String(supply?.value?.amount ?? "x") !== "0") continue;       // not actually burned
    const a = await assetOf(mint, { fresh: true }).catch(() => null); const coll = collOf(a);
    if (!coll) continue;
    const px = await claimPrices();
    if (!px) throw new KeeperError("no fresh stORE price right now — try again in a minute", 503);
    const b = await burnShare(a, { fresh: true }), val = vaultInStore(b.share, px);
    if (!val) throw new KeeperError("no fresh stORE price right now — try again in a minute", 503);
    out.push(await createClaim({ mint, coll, collMint: collMintOf(a), wallet: mv.pre, kind: "burn", storeRaw: S(val.storeRaw), store: val.store, usd: val.usd, vault: b.share, eligible: b.eligible, w: b.w, n: b.n, sig, at: txTime(tx) || Date.now(), inTreasury: false }));
  }
  if (!out.length) throw new KeeperError("no Dojo NFT was burned by its holder in that transaction");
  return out;
}

// ---------- the weekly admin desk ----------
async function listJson(prefix) {
  const { blobs } = await ks().list({ prefix });
  const out = [];
  for (const b of blobs) { const v = await ks().get(b.key, { type: "json" }); if (v) out.push(v); }
  return out;
}
export async function keeperSummary() {
  const [claims, repairs, totals, px, scan, refunds, heldAll, skips] = await Promise.all([listJson("claim:"), listJson("repair:"), getTotals(), prices(), ks().get("scan", { type: "json" }), listJson("refund:"), listJson("held:"), listSkips().catch(() => [])]);
  const held = heldAll.filter((h) => !h.convertedAt);
  const refundsDue = refunds.filter((r) => r.status === "due").sort((a, b) => a.at - b.at);
  const due = claims.filter((c) => c.status === "due"), toBurn = claims.filter((c) => c.inTreasury && !c.burnedAt);
  const dueRaw = due.reduce((s, c) => s + big(c.storeRaw), 0n);
  const fmt = (o) => Object.fromEntries(Object.entries(o || {}).map(([m, raw]) => [m, toUi(raw, m)]));
  return {
    storeMint: STORE_MINT, treasury: TREASURY, prices: px,
    claimsDue: due.sort((a, b) => a.at - b.at), claimsDueStore: toUi(dueRaw, STORE_MINT), claimsDueStoreRaw: S(dueRaw),
    toBurn: toBurn.map((c) => ({ mint: c.mint, coll: c.coll, wallet: c.wallet, at: c.at })),
    claimsPaid: claims.filter((c) => c.status === "paid").length,
    repairsPending: repairs.filter((r) => r.status !== "applied").sort((a, b) => a.at - b.at),
    repairsApplied: repairs.filter((r) => r.status === "applied").length,
    totals: { reserve: fmt(totals.reserve), ops: fmt(totals.ops), direct: fmt(totals.direct), unconverted: fmt(totals.unconverted), unconvertedRaw: totals.unconverted || {} },
    ops: { wallet: opsWallet(), due: fmt(opsDue(totals)), dueRaw: opsDue(totals), moved: fmt(totals.opsMoved) },
    pools: await poolsPublic().catch(() => null),
    burnEnabled: burnEnabled(), held: held.sort((a, b) => a.at - b.at),
    refundsDue: refundsDue.map((r) => ({ ...r, ore: toUi(r.raw, ORE_MINT) })), refundsDueOre: toUi(refundsDue.reduce((t, r) => t + big(r.raw), 0n), ORE_MINT),
    mint: await mintSpots().catch(() => null), mintCapHistory: ((await getSettings().catch(() => null))?.history || []).slice(-10),
    scan: { pending: scan?.pending?.length || 0, gaps: Object.values(scan?.gaps || {}).reduce((n, g) => n + g.length, 0), at: scan?.at || null },
    // payments the reader skipped that may hide someone's money (newest first) — the owner can re-decide each
    skips: skips.slice(0, 60).map((s) => ({ ...s, oreUi: s.ore ? toUi(s.ore, ORE_MINT) : null })),
  };
}

// The owner's weekly statement (/payouts): repairs granted, and repair payments refunded, since `t`
export async function repairActivitySince(t) {
  const [reps, refs] = await Promise.all([listJson("repair:"), listJson("refund:")]);
  return { granted: reps.filter((r) => (r.at || 0) >= t), refunded: refs.filter((r) => (r.at || 0) >= t) };
}

// Repairs the owner applied locally (keeper-apply-repairs.mjs) → "applied"
export async function markRepairsApplied(mints) {
  const done = [];
  for (const m of mints || []) {
    if (!isAddr(m)) continue;
    const { value } = await casUpdate(ks(), "repair:" + m, (r) => { if (!r || r.status === "applied") return undefined; r.status = "applied"; r.appliedAt = Date.now(); return r; });
    if (value?.status === "applied") done.push(m);
  }
  return done;
}

// Weekly claim payment: verify the Treasury's stORE transfers, then mark the covered claims paid.
// Per wallet: what it received in stORE across these txs (each (sig, owner) counted once ever) must cover
// its due claims, oldest first; a claim is never marked paid on a partial amount.
export async function recordClaimsPaid({ sigs, payer }) {
  if (payer !== TREASURY) throw new KeeperError("claims are paid from the Treasury " + TREASURY.slice(0, 4) + "…", 400);
  const list = [...new Set((sigs || []).filter((s) => SIG_RE.test(s || "")))].slice(0, 40);
  if (!list.length) throw new KeeperError("no transaction signatures");
  const txs = [], bad = [];
  for (const s of list) {
    const tx = await getTx(s, "jsonParsed").catch(() => null);
    if (!tx) { bad.push({ sig: s, reason: "not found on-chain (yet)" }); continue; }
    if (tx.meta?.err) { bad.push({ sig: s, reason: "failed on-chain" }); continue; }
    if (keyStr(tx.transaction?.message?.accountKeys?.[0]) !== TREASURY) { bad.push({ sig: s, reason: "not paid by the Treasury" }); continue; }
    txs.push({ sig: s, tx });
  }
  const due = (await listJson("claim:")).filter((c) => c.status === "due").sort((a, b) => a.at - b.at);
  const byWallet = new Map(); for (const c of due) byWallet.set(c.wallet, [...(byWallet.get(c.wallet) || []), c]);
  const paid = [], short = [];
  for (const [wallet, claims] of byWallet) {
    let got = 0n; const used = [];
    for (const { sig, tx } of txs) {
      const d = tokenDeltas([tx])[wallet]?.[STORE_MINT] || 0n;
      if (d > 0n && (await ks().get("paidsig:" + sig + ":" + wallet))) continue;   // already counted for earlier claims
      if (d > 0n) { got += d; used.push(sig); }
    }
    if (!(got > 0n)) continue;
    let left = got; const mine = [];
    for (const c of claims) {
      const need = big(c.storeRaw);
      if (need > left) { short.push({ mint: c.mint, wallet, need: toUi(need, STORE_MINT), left: toUi(left, STORE_MINT) }); break; }
      left -= need;
      const { value } = await casUpdate(ks(), "claim:" + c.mint, (x) => { if (!x || x.status !== "due") return undefined; x.status = "paid"; x.paid = { sigs: used, at: Date.now() }; return x; });
      if (value?.status === "paid") { paid.push(c.mint); mine.push(c.mint); }
    }
    // these transfers are spent only once they actually paid a claim (a short transfer can be topped up)
    if (mine.length) for (const s of used) await putIfNew(ks(), "paidsig:" + s + ":" + wallet, { at: Date.now(), claims: mine });
  }
  return { paid, short, bad };
}

// Weekly burn of the cards holders sent in: mark the ones whose supply is now 0.
export async function recordBurned(mints) {
  const done = [];
  for (const m of mints || []) {
    if (!isAddr(m)) continue;
    const supply = await rpc("getTokenSupply", [m]).catch(() => null);
    if (String(supply?.value?.amount ?? "x") !== "0") continue;
    const { value } = await casUpdate(ks(), "claim:" + m, (c) => { if (!c || c.burnedAt) return undefined; c.burnedAt = Date.now(); c.inTreasury = false; return c; });
    if (value?.burnedAt) done.push(m);
  }
  return done;
}

// ---------- stORE conversion of the vault + reserve shares ----------
// Server-side Jupiter quote X → stORE for what is still unconverted in that currency; the owner swaps with it.
export async function conversionQuote(inputMint) {
  const t = await getTotals();
  const amount = big(t.unconverted?.[inputMint]);
  if (!(amount > 0n)) throw new KeeperError("nothing to convert in that currency");
  const base = String(process.env.JUPITER_BASE || "https://lite-api.jup.ag").replace(/\/+$/, "");
  const q = await (await fetch(`${base}/swap/v1/quote?inputMint=${inputMint}&outputMint=${STORE_MINT}&amount=${amount}&swapMode=ExactIn&slippageBps=100`)).json().catch(() => null);
  if (!q || q.error || q.outAmount == null || q.outputMint !== STORE_MINT || String(q.inAmount) !== amount.toString()) throw new KeeperError("no swap route to stORE right now" + (q?.error ? " (" + q.error + ")" : ""), 502);
  if ((q.inputMint && q.inputMint !== inputMint) || (q.swapMode && q.swapMode !== "ExactIn") || Number(q.slippageBps) > 100 || (q.platformFee && big(q.platformFee.amount) > 0n))
    throw new KeeperError("the swap quote doesn't match what was asked — not using it", 502);
  // The quote's minimum is what the Treasury accepts on-chain (payout-tx.js checks the signed swap against it), so a
  // garbled or hostile quote must not pass as fair: compare with the spot feed, and fail closed without prices (review L4).
  const px = await prices([inputMint, STORE_MINT]), pin = px[inputMint], pst = px[STORE_MINT];
  if (!(pin > 0 && pst > 0)) throw new KeeperError("can't check the swap price against the market right now — try again in a minute", 502);
  const fair = (Number(amount) / 10 ** (DECIMALS[inputMint] ?? 9)) * pin / pst * 10 ** DECIMALS[STORE_MINT];
  if (!(Number(q.otherAmountThreshold ?? q.outAmount) >= fair * 0.9)) throw new KeeperError("the swap quote is more than 10% under the market price — not using it; try again in a minute", 502);
  return { inputMint, amount: amount.toString(), quote: q };
}
// The owner's conversion landed: verify (Treasury signed, spent the input, received stORE), then book it.
// `sigs` = one swap, or the steps of a conversion done by hand (e.g. SOL→ORE on Jupiter, then ORE→stORE on the ORE site):
// the Treasury's balance changes are added up across all of them, so the in-between token (ORE) nets out and what
// counts is what was finally spent and the stORE that arrived. Each signature can be booked once, ever.
export async function recordConversion(sigs) {
  const list = [...new Set((Array.isArray(sigs) ? sigs : [sigs]).map((s) => String(s || "").trim()).filter(Boolean))];
  if (!list.length || list.length > 4 || !list.every((s) => SIG_RE.test(s))) throw new KeeperError("give 1 to 4 transaction signatures");
  for (const s of list) if (await ks().get("convsig:" + s)) throw new KeeperError("that conversion was already recorded");
  const txs = [];
  for (const s of list) {
    const tx = await getTx(s, "jsonParsed").catch(() => null);
    if (!tx || tx.meta?.err) throw new KeeperError("a transaction failed or isn't on-chain yet");
    if (!signersOf(tx).includes(TREASURY)) throw new KeeperError("not signed by the Treasury");
    txs.push(tx);
  }
  for (const s of list) if (!(await putIfNew(ks(), "convsig:" + s, { at: Date.now(), with: list }))) throw new KeeperError("that conversion was already recorded");
  const sig = list.join("+");
  const d = tokenDeltas(txs)[TREASURY] || {};
  const gotStore = d[STORE_MINT] || 0n;
  if (!(gotStore > 0n)) throw new KeeperError("the Treasury received no stORE in " + (list.length > 1 ? "those transactions" : "that transaction"));
  const spent = {};
  for (const [m, v] of Object.entries(d)) if (v < 0n && m !== STORE_MINT) spent[m] = -v;
  let sol = 0n; for (const tx of txs) sol += -solGain(tx, TREASURY) - BigInt(tx.meta?.fee || 0);
  if (sol > 0n) spent[SOL_MINT] = (spent[SOL_MINT] || 0n) + sol;
  const { value } = await casUpdate(ks(), "totals", (t) => {
    t ||= { reserve: {}, ops: {}, direct: {}, unconverted: {}, ids: [] };
    if ((t.ids || []).includes("conv:" + sig)) return undefined;
    for (const [m, v] of Object.entries(spent)) { const cur = big(t.unconverted?.[m]); t.unconverted[m] = S(cur > v ? cur - v : 0n); }
    t.converted = [...(t.converted || []), { sig, at: Date.now(), spent: Object.fromEntries(Object.entries(spent).map(([m, v]) => [m, S(v)])), store: S(gotStore) }].slice(-200);
    t.ids = pushId(t.ids, "conv:" + sig, 20000);
    return t;
  });
  return { store: toUi(gotStore, STORE_MINT), spent: Object.fromEntries(Object.entries(spent).map(([m, v]) => [m, toUi(v, m)])), unconverted: value?.unconverted || {} };
}

// ---------- the operations share (12%) → the Operations wallet (weekly) ----------
// OPS_WALLET (Netlify env) = the dedicated Operations wallet. Until it is set, the ops share just accumulates in the
// Treasury's books (totals.ops); the weekly desk then moves what is due in one Treasury-signed transfer.
export const opsWallet = () => (isAddr(process.env.OPS_WALLET) && process.env.OPS_WALLET !== TREASURY ? process.env.OPS_WALLET : null);
export function opsDue(t) {   // per currency mint: booked ops − already moved (raw strings, only > 0)
  const due = {};
  for (const [m, raw] of Object.entries(t?.ops || {})) { const left = big(raw) - big(t?.opsMoved?.[m]); if (left > 0n) due[m] = S(left); }
  return due;
}
export async function opsMoveQuote() {
  const w = opsWallet();
  if (!w) throw new KeeperError("OPS_WALLET is not set — add the Operations wallet address in Netlify first");
  const due = opsDue(await getTotals());
  if (!Object.keys(due).length) throw new KeeperError("no operations share to move yet");
  return { opsWallet: w, due, dueUi: Object.fromEntries(Object.entries(due).map(([m, raw]) => [m, toUi(raw, m)])) };
}
// The owner's move landed: verify (Treasury signed, the Operations wallet received it), then book what arrived —
// never more than was due per currency. Idempotent per signature.
export async function recordOpsMove(sig) {
  const w = opsWallet();
  if (!w) throw new KeeperError("OPS_WALLET is not set");
  if (!SIG_RE.test(sig || "")) throw new KeeperError("bad signature");
  const tx = await getTx(sig, "jsonParsed").catch(() => null);
  if (!tx || tx.meta?.err) throw new KeeperError("that transaction failed or isn't on-chain yet");
  if (!signersOf(tx).includes(TREASURY)) throw new KeeperError("not signed by the Treasury");
  const got = { ...(tokenDeltas([tx])[w] || {}) };
  const sg = solGain(tx, w); if (sg > 0n) got[SOL_MINT] = (got[SOL_MINT] || 0n) + sg;
  for (const m of Object.keys(got)) if (!(got[m] > 0n)) delete got[m];
  if (!Object.keys(got).length) throw new KeeperError("the Operations wallet received nothing in that transaction");
  const moved = {};
  const { value, changed } = await casUpdate(ks(), "totals", (t) => {
    t ||= { reserve: {}, ops: {}, direct: {}, unconverted: {}, ids: [] };
    if ((t.ids || []).includes("ops:" + sig)) return undefined;   // already booked
    const due = opsDue(t);
    t.opsMoved ||= {};
    for (const k of Object.keys(moved)) delete moved[k];   // casUpdate may re-run this function on a conflict
    for (const [m, v] of Object.entries(got)) { const cap = big(due[m]); const take = v < cap ? v : cap; if (take > 0n) { t.opsMoved[m] = S(big(t.opsMoved[m]) + take); moved[m] = take; } }
    t.opsMoves = [...(t.opsMoves || []), { sig, at: Date.now(), moved: Object.fromEntries(Object.entries(moved).map(([m, v]) => [m, S(v)])) }].slice(-200);
    t.ids = pushId(t.ids, "ops:" + sig, 20000);
    return t;
  });
  if (!changed) throw new KeeperError("that move was already recorded");
  return { moved: Object.fromEntries(Object.entries(moved).map(([m, v]) => [m, toUi(v, m)])), due: Object.fromEntries(Object.entries(opsDue(value)).map(([m, raw]) => [m, toUi(raw, m)])) };
}
