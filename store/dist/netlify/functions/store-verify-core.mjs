// Shared coin-purchase verification — the ONE place a purchase turns into coins.
// Imported by BOTH /api/verify (admin-triggered) and verify-cron (every minute) so
// the crediting rule can never drift between the two paths.
//
// Rule: re-read the purchase's signature on-chain, confirm the TREASURY actually
// received the tokens, value that REAL amount in USD at the live price, and mint
// coins from the server pack table. The client's claimed coins/usd/tokenAmount are
// hints only — a tiny payment can never buy a big pack.
//
// Payer binding: coins go ONLY to the wallet that actually paid — a SIGNER of the tx whose own
// balance of that currency dropped by at least what the treasury gained (SOL: its lamports;
// SPL: the token accounts it owns, from pre/postTokenBalances owner fields). The POSTed `buyer`
// is a claim: anyone watching the chain can POST someone else's fresh signature first (the record
// is first-write-wins), so a claimed buyer that did not pay is never credited. When exactly one
// signer paid, the purchase is re-attributed to that payer (and the claim's referral code is
// dropped) instead of being rejected — so a front-runner gets nothing AND cannot lock the real
// buyer out. Set REATTRIBUTE_TO_PAYER=false to reject such claims outright instead.
//
// Exactly-once: before any coin moves, a one-time marker credited:<sig> is created with a
// create-only write (Blobs "coin-credits"). Only the run that creates it credits; overlapping cron
// runs / the admin path see it and stand back. The balance and pot increments are themselves
// compare-and-swap writes that remember the signature, so a run that dies half-way is resumed
// (after RESUME_AFTER_MS) without double-crediting.
//
// One payment, one product: before crediting, the signature is claimed at sig:<sig> in Blobs
// "miner-requests" (the branded-miner signup's replay registry, also create-only) — a payment already
// used as a miner setup fee can't buy coins, and a credited purchase can't later pay a miner fee.
// Other guards: our own wallets are never a customer; a payment must be claimed within 48h of landing.
//
// Env: SOLANA_RPC (getTransaction) + TREASURY_WALLET (+ POT_WALLET, ROYALTY_WALLET, OPERATOR_WALLET,
// COSIGNER_PUBKEY, TEAM_WALLETS: our own wallets, which can never be a paying customer).
import { getStore } from "@netlify/blobs";
import { addToPot, POT_FRAC } from "./store-pot-core.mjs";
import { casUpdate, readWithEtag, putIfNew, putIfMatch, pushId } from "./store-cas-core.mjs";

export const TREASURY = process.env.TREASURY_WALLET || "5w55F58ia3H71QjBD9bYvNQF2DcNu8K3AfJj9A4WMuWp";
const SOL_MINT = "So11111111111111111111111111111111111111112";
const MINTS = { ORE: "oreoU2P8bN6jkk3jbaiVxYnG1dCXcYxwhwyK9jSybcp", SKR: "SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3", USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" };
const DEC = { SOL: 1e9, ORE: 1e11, SKR: 1e6, USDC: 1e6 };
const PACK_TOL = 0.04;   // absorb price drift between purchase and verification
const ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export const REATTRIBUTE_TO_PAYER = true;
const CLAIM_WINDOW_MS = 48 * 3600e3;   // a payment must be claimed within 48h of landing (clients re-send for 24h)
const RESUME_AFTER_MS = 2 * 60e3;      // a credit claimed by a run that died is finished after this (functions stop at ~30s)
const BAL_APPLIED_MAX = 50;            // recent credited sigs remembered in each balance record
const MINER_SIG_TAG = "coin-purchase";  // value we write at miner-requests sig:<sig> (the signup writes its request id)

// The ONLY coin prices the server honours (mirror of dojo-credits.html PACKS).
const PACKS = [
  { usd: 3, total: 3 }, { usd: 5, total: 5 }, { usd: 10, total: 11 }, { usd: 25, total: 29 }, { usd: 50, total: 60 },
].sort((a, b) => a.usd - b.usd);
// Coins for a verified USD amount: the biggest pack the payment covers (each pack gets the
// same PACK_TOL price-drift allowance, so a $1 pack paid at $0.97 is still 1 coin), and for
// odd amounts between packs 1 coin per $1 with the same allowance — never less than the
// covered pack. Below ~$0.96 → 0 (dust; the caller rejects it).
export function coinsForUsd(usd) {
  if (!(usd > 0)) return 0;
  let best = 0;
  for (const p of PACKS) if (usd + 1e-9 >= p.usd * (1 - PACK_TOL)) best = Math.max(best, p.total);
  return Math.max(best, Math.floor(usd * (1 + PACK_TOL) + 1e-9));
}

// JSON-RPC that THROWS on an RPC/HTTP error (rate limit, outage) — so a transient failure is a
// retry, never mistaken for "this transaction doesn't exist" (which the admin path would reject).
async function rpc(method, params) {
  const r = await fetch(process.env.SOLANA_RPC, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!r.ok) throw new Error(`rpc http ${r.status}`);
  const j = await r.json();
  if (j.error) {
    // Mainnet now serves v1 transactions: a v0-capped getTransaction errors (-32015) on them — ask again allowing v1.
    if (method === "getTransaction" && params?.[1]?.maxSupportedTransactionVersion === 0
        && (j.error.code === -32015 || /transaction version/i.test(j.error.message || ""))) {
      return rpc(method, [params[0], { ...params[1], maxSupportedTransactionVersion: 1 }]);
    }
    const e = new Error(j.error.message || method + " failed"); e.code = j.error.code; throw e;
  }
  return j.result;
}

// the dedicated Dojo Pot wallet tips flow to (kept separate from the coin treasury)
const POT_WALLET = process.env.POT_WALLET || "ED3GMCfoX3XNvavnWADvd6oCsohGg1ukdhv3PaUpvwJe";

// Our own wallets (same list the payout engine refuses to pay): never a paying customer.
function ownWallets() {
  const s = new Set([TREASURY, POT_WALLET, process.env.ROYALTY_WALLET || "ED3GMCfoX3XNvavnWADvd6oCsohGg1ukdhv3PaUpvwJe",
    "HEyazxpV2wxMUvNx53UZUXthRS9Rjsbv7hoHYJNbVedC", process.env.COSIGNER_PUBKEY, process.env.OPERATOR_WALLET,
    ...String(process.env.TEAM_WALLETS || "").split(/[\s,]+/)]);
  return new Set([...s].filter((w) => ADDR_RE.test(w || "")));
}

const keyStr = (k) => (typeof k === "string" ? k : k?.pubkey || String(k));
// every account key in balance-array order (plain-json txs list lookup-table keys in meta.loadedAddresses)
function allKeys(tx) {
  const keys = (tx.transaction.message.accountKeys || []).map(keyStr);
  if (keys.length < (tx.meta?.preBalances || []).length)
    keys.push(...(tx.meta.loadedAddresses?.writable || []), ...(tx.meta.loadedAddresses?.readonly || []));
  return keys;
}
// the tx's signers (lookup-table accounts can never sign)
function signersOf(tx) {
  const msg = tx.transaction.message, ak = msg.accountKeys || [];
  if (ak.length && typeof ak[0] === "object" && "signer" in ak[0]) return ak.filter((k) => k.signer).map((k) => k.pubkey);
  return ak.slice(0, msg.header?.numRequiredSignatures || 0).map(keyStr);
}
const rawOf = (arr, mint, owner) => (arr || []).filter((b) => b.mint === mint && b.owner === owner)
  .reduce((s, b) => s + BigInt(b.uiTokenAmount?.amount || "0"), 0n);

// Read tx `sig` and describe the payment `wallet` received in `currency`:
//   { got (UI units), gainRaw, signers, payers, blockTime }   payers = signers (≠ wallet) whose own
//   balance of that currency dropped by ≥ what `wallet` gained.  null → tx missing / failed.
export async function inspectPayment(sig, currency, wallet = TREASURY) {
  const tx = await rpc("getTransaction", [sig, { maxSupportedTransactionVersion: 0, encoding: "json" }]);
  if (!tx || tx.meta?.err) return null;
  const signers = signersOf(tx);
  let delta;
  if (currency === "SOL") {
    const keys = allKeys(tx);
    delta = (w) => { const i = keys.indexOf(w); return i < 0 ? 0n : BigInt(tx.meta.postBalances[i] || 0) - BigInt(tx.meta.preBalances[i] || 0); };
  } else {
    const mint = MINTS[currency];
    if (!mint) return { got: 0, gainRaw: 0n, signers, payers: [], blockTime: tx.blockTime || null };
    delta = (w) => rawOf(tx.meta.postTokenBalances, mint, w) - rawOf(tx.meta.preTokenBalances, mint, w);
  }
  const gainRaw = delta(wallet);
  const payers = gainRaw > 0n ? signers.filter((s) => s !== wallet && -delta(s) >= gainRaw) : [];
  return { got: Number(gainRaw) / DEC[currency], gainRaw, signers, payers, blockTime: tx.blockTime || null };
}

// how much of `currency` the given wallet (default TREASURY) GAINED in tx `sig` (null → tx missing/failed)
export async function walletReceived(sig, currency, wallet = TREASURY) {
  const p = await inspectPayment(sig, currency, wallet);
  return p ? p.got : null;
}

// live USD price of a currency from Jupiter (CORS-open, no key). null → fail-closed (retry).
// Cached ~60s only: a warm function instance lives across many cron runs, and a price
// frozen at first use would mis-size every later purchase.
const _priceCache = {};
const PRICE_TTL = 60 * 1000;
export async function livePrice(cur) {
  if (cur === "USDC") return 1;
  const hit = _priceCache[cur];
  if (hit && Date.now() - hit.at < PRICE_TTL) return hit.px;
  const mint = cur === "SOL" ? SOL_MINT : MINTS[cur];
  let px = null;
  try { const j = await (await fetch("https://lite-api.jup.ag/price/v3?ids=" + mint)).json(); px = j?.[mint]?.usdPrice ?? null; } catch { px = null; }
  px = Number.isFinite(px) && px > 0 ? px : null;
  if (px != null) _priceCache[cur] = { px, at: Date.now() };   // never cache a failure
  return px;
}

// Strong-consistency JSON read (falls back to the default eventual read only if this
// runtime has no uncached edge URL). A stale read of a purchase or a balance is how a
// record gets credited twice or a coin spent twice, so the ledger reads go through this.
export async function getStrong(store, key) {
  try { return await store.get(key, { type: "json", consistency: "strong" }); }
  catch (e) { if (/uncachedEdgeURL|strong consistency/i.test(String(e?.message || e))) return await store.get(key, { type: "json" }); throw e; }
}

// Apply a claimed credit (marker m): balance + pot, each idempotent by signature, then mark the
// marker done and mirror it onto the purchase record. `mine` = this run just created the marker;
// otherwise a marker still in flight is left to its owner until RESUME_AFTER_MS has passed.
async function finishCredit(store, key, rec, m, mine = false) {
  if (m.state !== "done") {
    if (!mine && Date.now() - (m.at || 0) < RESUME_AFTER_MS) return { result: { sig: m.sig, ok: false, retry: "credit in flight" } };
    if (m.coins > 0) {
      const id = "buy:" + m.sig;
      await casUpdate(getStore("balances"), "bal:" + m.buyer, (b) => {
        const bal = b || { coins: 0 };
        if ((bal.applied || []).includes(id)) return undefined;   // this purchase already landed
        bal.coins = (bal.coins || 0) + m.coins; bal.applied = pushId(bal.applied, id, BAL_APPLIED_MAX); bal.updatedAt = Date.now();
        return bal;
      });
    }
    await addToPot({ usd: m.potUsd, currency: m.currency, native: m.potNative, route: m.route, id: m.route + ":" + m.sig });
    m = { ...m, state: "done", doneAt: Date.now() };
    await getStore("coin-credits").setJSON("credited:" + m.sig, m);
  }
  const next = { ...rec, ...(m.recPatch || {}), verified: true, rejected: false, verifiedAmount: m.got, verifiedUsd: m.usd,
    verifiedAt: m.doneAt || Date.now(), ...(m.route === "tip" ? { toPotUsd: m.potUsd } : { creditedCoins: m.coins }) };
  delete next.rejectReason;
  await store.setJSON(key, next);
  return { verified: true, result: { sig: m.sig, currency: m.currency, got: m.got, usd: +(+m.usd).toFixed(2), ok: true,
    ...(m.route === "tip" ? { tip: true } : { credited: m.coins, claimed: rec.coins }), ...(m.recPatch?.buyerCorrected ? { buyerCorrected: true } : {}) } };
}

async function verifyOne(store, key, rec, etag, { strictReject, reattribute }) {
  const sig = rec.sig;
  const credits = getStore("coin-credits");
  // a credit already claimed for this signature (overlapping run, or one that died) → finish it, never re-decide
  const { value: mark } = await readWithEtag(credits, "credited:" + sig);
  if (mark) return finishCredit(store, key, rec, mark);

  // rejecting is conditional on the record being unchanged since we read it (a concurrent run wins)
  const reject = async (reason, extra = {}) => {
    const wrote = await putIfMatch(store, key, { ...rec, ...extra, rejected: true, rejectReason: reason, rejectedAt: Date.now() }, etag);
    return { rejected: wrote, result: { sig, ok: false, rejected: wrote, reason } };
  };

  const isTip = rec.kind === "tip";
  const pay = await inspectPayment(sig, rec.currency, isTip ? POT_WALLET : TREASURY);
  if (!pay) {   // tx missing/failed: the cron leaves it pending (not yet propagated); the admin path rejects
    if (strictReject) return reject("tx missing/failed");
    return { result: { sig, got: null, ok: false, retry: true } };
  }
  if (!(pay.got > 0)) return reject(`nothing reached the ${isTip ? "pot" : "treasury"} wallet in this tx`);
  if (pay.blockTime && (rec.recordedAt || Date.now()) - pay.blockTime * 1000 > CLAIM_WINDOW_MS)
    return reject("payment landed more than 48h before it was claimed");

  // payer binding — see the header
  const own = ownWallets();
  let buyer = rec.buyer, recPatch = null;
  if (!pay.payers.includes(buyer) || own.has(buyer)) {
    const real = pay.payers.filter((p) => !own.has(p) && ADDR_RE.test(p));
    if (reattribute && real.length === 1) {
      buyer = real[0];
      recPatch = { buyer, claimedBuyer: rec.buyer, buyerCorrected: true, ref: null, ...(rec.ref ? { droppedRef: rec.ref } : {}) };
    } else {
      return reject(pay.signers.includes(rec.buyer) ? "claimed buyer is not the account that paid" : "claimed buyer did not sign the payment",
        { onchainPayers: pay.payers });
    }
  }

  const price = await livePrice(rec.currency);
  if (price == null) return { result: { sig, got: pay.got, ok: false, retry: "no price" } };   // fail-closed
  const usd = pay.got * price;
  let plan;
  if (isTip) plan = { route: "tip", coins: 0, potUsd: usd, potNative: pay.got };   // a tip mints NO coins — 100% feeds the pot
  else {
    const coins = coinsForUsd(usd);
    if (!(coins > 0)) return reject(`dust: $${usd.toFixed(2)} < $1`);
    // POT_FRAC of every verified purchase feeds the pot, tallied from the ACTUAL on-chain amount
    plan = { route: "coinbuy", coins, potUsd: usd * POT_FRAC, potNative: pay.got * POT_FRAC };
  }
  // One payment, one product: the branded-miner setup fee is paid to the same treasury, and its signup
  // claims sig:<sig> in Blobs "miner-requests" with a create-only write. Claim the same key here: if a
  // miner signup holds it, this signature can't also buy coins; if we hold it, the signup is refused.
  if (!(await putIfNew(getStore("miner-requests"), "sig:" + sig, MINER_SIG_TAG))) {
    const holder = await getStore("miner-requests").get("sig:" + sig);
    if (holder !== JSON.stringify(MINER_SIG_TAG)) return reject("payment already used for a branded-miner signup");
  }
  const marker = { sig, buyer, currency: rec.currency, got: pay.got, usd, ...plan, recPatch, state: "claimed", at: Date.now() };
  if (!(await putIfNew(credits, "credited:" + sig, marker))) {
    const { value: other } = await readWithEtag(credits, "credited:" + sig);   // another run claimed it first
    return other ? finishCredit(store, key, rec, other) : { result: { sig, ok: false, retry: "busy" } };
  }
  return finishCredit(store, key, rec, marker, true);
}

// Walk every unverified purchase, verify on-chain, credit server coins from the
// verified USD. Returns a summary. `strictReject` (admin path) rejects a tx that
// can't be read; the cron leaves it pending so a not-yet-propagated tx retries.
export async function verifyPurchases({ strictReject = false, reattribute = REATTRIBUTE_TO_PAYER } = {}) {
  const store = getStore("coin-purchases");
  const { blobs } = await store.list({ prefix: "buy:" });
  let checked = 0, verified = 0, rejected = 0;
  const results = [];
  for (const b of blobs) {
    const { value: rec, etag } = await readWithEtag(store, b.key);
    if (!rec || rec.verified || rec.rejected) continue;
    checked++;
    try {
      const out = await verifyOne(store, b.key, rec, etag, { strictReject, reattribute });
      if (out.verified) verified++;
      if (out.rejected) rejected++;
      results.push(out.result);
    } catch (e) { results.push({ sig: rec.sig, error: String(e.message || e), retry: true }); }
  }
  return { checked, verified, rejected, results };
}
