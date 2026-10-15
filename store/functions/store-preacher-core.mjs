// Shared preacher maths — imported by store-fn-preacher.mjs (dashboard + admin sheet) and the weekly
// payout engine, so every screen and every payout agree on what a preacher is owed.
//
// What a preacher earns on (owner's call, 2026-10), tier share = 20/25/30% by fighters held:
//   coin pack → tier share of the whole verified pack (the pot takes 65%, Degen Dojo the rest)
//   miner tip → tier share of the whole verified tip
//   Degen Dojo NFT sale they referred → tier share of the "preacher-eligible half" (6.5%) of the 13%
//     royalty, i.e. share × 0.5 × the royalty the royalty wallet ACTUALLY received in that sale tx, in the
//     token it arrived in (SOL for Magic Eden / Tensor, ORE/SKR/USDC for our own AuctionHouse listings).
//     Only NFTs in the DD collection count (other collections pay us no royalty); self-referrals never count.
// Only records the server has verified on-chain count (verify-core for coins/tips, verifyReferredSales
// below for NFT sales). Owed amounts are kept in the token actually paid (ORE / SKR / SOL / USDC).
import { getStore } from "@netlify/blobs";
import { livePrice } from "./store-verify-core.mjs";
import { refFromTx } from "./store-ref-core.mjs";

export const DD_COLLECTION = "2m9DupVeheZ5vfuXZxqV3KSQ7HnVDk2tG6ouH1ZnLwYb";
// Where every DD royalty lands (same wallet + env var as store-royalty-core.mjs).
export const ROYALTY_WALLET = process.env.ROYALTY_WALLET || "ED3GMCfoX3XNvavnWADvd6oCsohGg1ukdhv3PaUpvwJe";
export const NFT_ELIGIBLE_HALF = 0.5;   // preachers share in half the royalty (6.5% of 13%); the other half feeds the pot
const ROY_TOKENS = {
  ORE:  { mint: "oreoU2P8bN6jkk3jbaiVxYnG1dCXcYxwhwyK9jSybcp", dec: 11 },
  SKR:  { mint: "SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3", dec: 6 },
  USDC: { mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", dec: 6 },
};
const VERIFY_PER_CALL = 40;              // bound the RPC work per computePreacherOwed call; the rest show as 'checking'
const LATE_ATTR_MS = 6 * 3600e3;         // a ref recorded >6h after the sale landed is not a real checkout attribution
const MISSING_TX_GIVEUP_MS = 24 * 3600e3; // a sig the chain never returns (forged/typo) is rejected after a day
// Tiers (verified against LIVE holdings at claim AND before every payout):
//   Wanderer 0–1 fighters = 20% · Disciple 2–4 = 25% · Sensei 5+ OR holds a Mythic = 30%.
export const tierShare = (h, m) => (h >= 5 || m ? 0.30 : h >= 2 ? 0.25 : 0.20);
export const tierName  = (h, m) => (h >= 5 || m ? "Sensei" : h >= 2 ? "Disciple" : "Wanderer");
export const earnedUsd = (rec, share) => !rec?.verified ? 0 : (rec.verifiedUsd || 0) * share;

async function das(method, params) {
  const r = await fetch(process.env.SOLANA_RPC, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  return (await r.json()).result;
}
const MYTHIC_RE = /gods?|devil|sensei|mutants?|pirate|rowdy|rugger/i;   // mythic Body/Race values
const bodyOf = (a) => ((a.content?.metadata?.attributes || []).find((x) => /^(body|race)$/i.test(x.trait_type || x.key)) || {}).value;
// Returns live { count, mythic } — recomputed on every claim and before every payout, so a
// preacher who sold their fighters drops a tier (or out of the pot) automatically.
export async function ddHeld(wallet) {
  let page = 1, count = 0, mythic = false;
  for (;;) {
    const res = await das("getAssetsByOwner", { ownerAddress: wallet, page, limit: 1000 });
    const items = res?.items || [];
    for (const a of items) {
      if ((a.grouping || []).some((g) => g.group_key === "collection" && g.group_value === DD_COLLECTION)) {
        count++;
        if (MYTHIC_RE.test(String(bodyOf(a) || ""))) mythic = true;
      }
    }
    if (items.length < 1000) break; page++;
  }
  return { count, mythic };
}

// Every coin-pack / tip record (Blobs "coin-purchases", written by /api/coinbuy, verified by verify-core).
export async function purchases() {
  const store = getStore("coin-purchases");
  const { blobs } = await store.list({ prefix: "buy:" });
  const out = [];
  for (const b of blobs) { const r = await store.get(b.key, { type: "json" }); if (r) out.push(r); }
  return out;
}

// ── referred NFT sales: on-chain verification ─────────────────────────────────────────────────
// Raw JSON-RPC call that distinguishes "RPC failed" (throw → retry later) from "null result".
async function rpcRaw(method, params) {
  const r = await fetch(process.env.SOLANA_RPC, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  if (!r.ok) throw new Error("rpc http " + r.status);
  const j = await r.json();
  if (j.error) { const e = new Error(j.error.message || "rpc error"); e.code = j.error.code; throw e; }
  return j.result;
}
// getTransaction, jsonParsed. Asks for v0 first; if the node says the tx is a newer version, re-asks
// for that version (same parsed shape). Returns the tx, or null when the chain doesn't know the sig.
export async function fetchTx(sig) {
  const opts = (v) => [sig, { encoding: "jsonParsed", maxSupportedTransactionVersion: v, commitment: "confirmed" }];
  try { return await rpcRaw("getTransaction", opts(0)); }
  catch (e) {
    const m = String(e.message || "");
    if (e.code === -32015 || /transaction version/i.test(m)) return await rpcRaw("getTransaction", opts(1));
    throw e;
  }
}
// Every account key of a tx as a base58 string, in balance-array order. jsonParsed already lists the
// lookup-table keys in accountKeys; a plain-json tx doesn't, so append meta.loadedAddresses then.
export function txKeys(tx) {
  const keys = (tx?.transaction?.message?.accountKeys || []).map((k) => (typeof k === "string" ? k : k.pubkey));
  if (keys.length < (tx?.meta?.preBalances || []).length)
    keys.push(...(tx.meta.loadedAddresses?.writable || []), ...(tx.meta.loadedAddresses?.readonly || []));
  return keys;
}
// What `wallet` gained in this tx, per currency: { SOL, ORE, SKR, USDC } (native units; may be ≤ 0).
export function royaltyDeltas(tx, wallet = ROYALTY_WALLET) {
  const keys = txKeys(tx), out = { SOL: 0, ORE: 0, SKR: 0, USDC: 0 };
  const i = keys.indexOf(wallet);
  if (i >= 0) out.SOL = ((tx.meta.postBalances[i] || 0) - (tx.meta.preBalances[i] || 0)) / 1e9;
  const raw = (arr, mint) => (arr || []).filter((b) => b.mint === mint && b.owner === wallet)
    .reduce((s, b) => s + BigInt(b.uiTokenAmount?.amount || "0"), 0n);
  for (const [cur, t] of Object.entries(ROY_TOKENS))
    out[cur] = Number(raw(tx.meta.postTokenBalances, t.mint) - raw(tx.meta.preTokenBalances, t.mint)) / 10 ** t.dec;
  return out;
}
// The royalty this sale paid: the currency with a positive delta (tokens first — an ORE sale can carry
// a stray lamport movement, an SOL sale never moves our tokens). null → no royalty arrived.
export function royaltyOf(tx, wallet = ROYALTY_WALLET) {
  const d = royaltyDeltas(tx, wallet);
  for (const cur of ["ORE", "SKR", "USDC", "SOL"]) if (d[cur] > 0) return { currency: cur, amount: d[cur] };
  return null;
}
// Who bought: the fee payer (first signer) and whoever holds the NFT after the tx.
export function buyerOf(tx, mint) {
  const ak = tx?.transaction?.message?.accountKeys || [];
  const signer = ak.find((k) => typeof k === "object" && k.signer);
  const feePayer = signer ? signer.pubkey : (typeof ak[0] === "string" ? ak[0] : ak[0]?.pubkey) || null;
  const post = (tx?.meta?.postTokenBalances || []).find((b) => b.mint === mint && b.uiTokenAmount?.amount === "1");
  return { feePayer, recipient: post?.owner || null };
}
export const mintInTx = (tx, mint) => txKeys(tx).includes(mint)
  || [...(tx?.meta?.preTokenBalances || []), ...(tx?.meta?.postTokenBalances || [])].some((b) => b.mint === mint);

// Is this mint a Degen Dojo NFT? true/false, or throws on an RPC failure (→ retry later).
async function isDDMint(mint) {
  const a = await rpcRaw("getAsset", { id: mint });
  if (!a) return false;
  return (a.grouping || []).some((g) => g.group_key === "collection" && g.group_value === DD_COLLECTION);
}

// Verify one ledger record. Returns the updated record (verified:true, or rejected:true + rejectReason),
// or null to leave it unverified and retry next time (RPC error / tx not propagated yet / no price).
export async function verifyNftSale(rec, preacherWallet = null) {
  if (!process.env.SOLANA_RPC) return null;
  const now = Date.now();
  const reject = (reason) => ({ ...rec, verified: false, rejected: true, rejectReason: reason, nftVerifiedAt: now });
  let tx;
  try { tx = await fetchTx(rec.sig); } catch { return null; }                    // RPC trouble → retry
  if (!tx) return now - (rec.recordedAt || rec.ts || now) > MISSING_TX_GIVEUP_MS ? reject("tx not found") : null;
  if (tx.meta?.err != null) return reject("tx failed on chain");
  if (!rec.mint || !mintInTx(tx, rec.mint)) return reject("mint not in tx");
  let isDD = rec.isDD;
  if (isDD == null) { try { isDD = await isDDMint(rec.mint); } catch { return null; } }
  if (!isDD) return { ...reject("not a Degen Dojo NFT"), isDD: false };
  const roy = royaltyOf(tx);
  if (!roy) return { ...reject("no royalty reached the royalty wallet"), isDD: true };
  // The referral is the "ddref:<code>" memo signed into the buy itself; the POSTed ref only told us to look.
  const memoRef = refFromTx(tx);
  if (!memoRef) return { ...reject("no referral memo in the purchase"), isDD: true };
  const { feePayer, recipient } = buyerOf(tx, rec.mint);
  // A record naming a different preacher is re-attributed to the one in the memo (the buyer's own signed choice).
  const postedRef = String(rec.ref || "").toLowerCase();
  const base = { ...rec, ref: memoRef, isDD: true, memoRef, txBuyer: feePayer, txRecipient: recipient, blockTime: tx.blockTime || null,
    ...(postedRef !== memoRef ? { postedRef } : {}) };
  // self-referral is judged against the preacher the memo names (look their wallet up if it differs)
  let pw = preacherWallet;
  if (postedRef !== memoRef) { try { pw = await getStore("preacher-codes").get("code:" + memoRef, { type: "text" }); } catch { return null; } }
  if (pw && (feePayer === pw || recipient === pw))
    return { ...base, verified: false, rejected: true, rejectReason: "self-referral", nftVerifiedAt: now };
  if (tx.blockTime && rec.recordedAt && rec.recordedAt - tx.blockTime * 1000 > LATE_ATTR_MS)
    return { ...base, verified: false, rejected: true, rejectReason: "attributed long after the sale", nftVerifiedAt: now };
  const px = await livePrice(roy.currency);
  if (px == null) return null;                                                   // fail-closed on price → retry
  return { ...base, verified: true, rejected: false, royaltyCurrency: roy.currency, royaltyAmount: roy.amount,
    royaltyUsd: roy.amount * px, nftVerifiedAt: now };
}

// Walk unverified referred-sale records (Blobs 'preacher-ledger', sale:<sig>, oldest first) and verify up to
// `max` of them on-chain, caching the outcome on the record so each sale is checked once.
// `ref` limits it to one preacher's records (dashboard). Returns { checked, verified, rejected, pending }.
export async function verifyReferredSales({ max = VERIFY_PER_CALL, ref = null, walletOf = null } = {}) {
  const ledger = getStore("preacher-ledger");
  const { blobs } = await ledger.list({ prefix: "sale:" });
  const todo = [];
  for (const b of blobs) {
    const s = await ledger.get(b.key, { type: "json" });
    if (!s?.ref || s.verified || s.rejected) continue;
    if (ref && String(s.ref).toLowerCase() !== ref) continue;
    todo.push([b.key, s]);
  }
  todo.sort((a, b) => (a[1].recordedAt || a[1].ts || 0) - (b[1].recordedAt || b[1].ts || 0));
  if (!walletOf) {
    walletOf = {};
    const codes = getStore("preacher-codes");
    for (const [, s] of todo) { const lc = String(s.ref).toLowerCase(); if (!(lc in walletOf)) walletOf[lc] = await codes.get("code:" + lc, { type: "text" }); }
  }
  let checked = 0, verified = 0, rejected = 0;
  for (const [key, s] of todo.slice(0, max)) {
    checked++;
    const out = await verifyNftSale(s, walletOf[String(s.ref).toLowerCase()] || null);
    if (!out) continue;
    await ledger.setJSON(key, out);
    if (out.verified) verified++; else if (out.rejected) rejected++;
  }
  return { checked, verified, rejected, pending: todo.length - verified - rejected };
}

// The payout sheet: one row per preacher code that has referred anything —
//   { code, wallet, held, tier, share, packs, tips, referredUsd, checking, nftBuys, nftSol, nftVerified,
//     nftRejected, nftUsdEarned, paidUsd, owedUsd, owedNative:{ORE,SKR,SOL,USDC},
//     unpaidSigs:[{sig, kind:'coins'|'tip'|'nft', usd, currency, amount, earnUsd, earnAmount}] }
// unpaidSigs[].usd / .amount are the BASE the tier share applies to (same meaning as before):
//   coins/tip → the whole verified pack/tip;  nft → the preacher-eligible half of the royalty received.
// earnUsd / earnAmount = share × base = what this preacher earns on that record.
// owedUsd / owedNative cover only verified, unpaid, non-self-referred records. Sorted by owedUsd desc.
export async function computePreacherOwed({ verify = true } = {}) {
  const codes = getStore("preacher-codes");
  const paidS = getStore("preacher-paid");
  const { blobs: cb } = await codes.list({ prefix: "code:" });
  const walletOf = {};
  for (const b of cb) { const w = await codes.get(b.key, { type: "text" }); if (w) walletOf[b.key.slice(5)] = w; }
  const paidSigs = new Map();   // record sig → payment sig
  const paidTotals = {};        // ref → usd
  const { blobs: pb } = await paidS.list({ prefix: "paid:" });
  for (const b of pb) {
    const p = await paidS.get(b.key, { type: "json" }); if (!p) continue;
    const ref = String(p.ref || "").toLowerCase();
    paidTotals[ref] = (paidTotals[ref] || 0) + (+p.payoutUsd || 0);
    for (const s of p.sigs || []) paidSigs.set(s, b.key.slice(5));
  }
  const rows = {};
  const row = (ref) => (rows[ref] ||= { code: ref, wallet: walletOf[ref] || null, packs: 0, tips: 0, referredUsd: 0, owedUsd: 0,
    owedNative: { ORE: 0, SKR: 0, SOL: 0, USDC: 0 }, unpaidSigs: [], checking: 0, nftBuys: 0, nftSol: 0,
    nftVerified: 0, nftRejected: 0, nftUsdEarned: 0, _nftBaseUsd: 0, paidUsd: paidTotals[ref] || 0 });
  for (const rec of await purchases()) {
    const ref = String(rec.ref || "").toLowerCase(); if (!ref || rec.rejected) continue;
    const r = row(ref);
    if (r.wallet && rec.buyer === r.wallet) continue;            // self-referral
    if (!rec.verified) { r.checking++; continue; }
    if (rec.kind === "tip") r.tips++; else r.packs++;
    r.referredUsd += rec.verifiedUsd || 0;
    if (!paidSigs.has(rec.sig)) r.unpaidSigs.push({ sig: rec.sig, kind: rec.kind === "tip" ? "tip" : "coins", usd: rec.verifiedUsd || 0, currency: rec.currency, amount: rec.verifiedAmount || 0 });
  }
  // referred Degen Dojo NFT sales → share × the eligible half of the royalty actually received.
  // Verify a bounded batch of new records first (each is checked on-chain once, then cached).
  if (verify) { try { await verifyReferredSales({ walletOf }); } catch {} }
  try {
    const ledger = getStore("preacher-ledger");
    const { blobs: lb } = await ledger.list({ prefix: "sale:" });
    for (const b of lb) {
      const s = await ledger.get(b.key, { type: "json" }); if (!s?.ref) continue;
      const r = row(String(s.ref).toLowerCase());
      r.nftBuys++; r.nftSol += (s.priceLamports || 0) / 1e9;
      if (s.rejected) { r.nftRejected++; continue; }
      if (!s.verified) { r.checking++; continue; }
      if (r.wallet && (s.txBuyer === r.wallet || s.txRecipient === r.wallet)) { r.nftRejected++; continue; }   // self-referral (code rebound since)
      r.nftVerified++;
      const baseUsd = (s.royaltyUsd || 0) * NFT_ELIGIBLE_HALF;
      r._nftBaseUsd += baseUsd;
      if (!paidSigs.has(s.sig)) r.unpaidSigs.push({ sig: s.sig, kind: "nft", usd: baseUsd, currency: s.royaltyCurrency,
        amount: (s.royaltyAmount || 0) * NFT_ELIGIBLE_HALF, mint: s.mint, royaltyAmount: s.royaltyAmount || 0, royaltyUsd: s.royaltyUsd || 0 });
    }
  } catch {}
  for (const r of Object.values(rows)) {
    if (r.wallet) { try { const { count, mythic } = await ddHeld(r.wallet); r.held = count; r.tier = tierName(count, mythic); r.share = tierShare(count, mythic); } catch { r.tier = "?"; r.share = 0.20; } }
    else { r.tier = "no wallet"; r.share = 0; }
    for (const u of r.unpaidSigs) {
      u.earnUsd = u.usd * r.share; u.earnAmount = u.amount * r.share;
      r.owedUsd += u.earnUsd;
      if (u.currency) r.owedNative[u.currency] = (r.owedNative[u.currency] || 0) + u.earnAmount;
    }
    r.nftUsdEarned = r._nftBaseUsd * r.share; delete r._nftBaseUsd;
  }
  return Object.values(rows).sort((a, b) => b.owedUsd - a.owedUsd);
}

// Record a payment to a preacher: it covers the listed record sigs (so they never count as owed again).
export async function markPreacherPaid({ paySig, ref, wallet, payoutUsd, payoutSol, sigs }) {
  await getStore("preacher-paid").setJSON("paid:" + paySig, { ref, wallet, payoutSol: +payoutSol || 0,
    ...(payoutUsd != null ? { payoutUsd: +payoutUsd || 0 } : {}), sigs: sigs || [], at: Date.now() });
}
