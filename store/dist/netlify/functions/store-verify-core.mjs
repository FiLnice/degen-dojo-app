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
// Priced when the buyer PAYS (DD-11): the /credits page first asks /api/coinbuy for a QUOTE — the live price, the
// exact token amount for the pack, valid 10 minutes, stored server-side (Blobs "coin-quotes") and bound to the wallet
// and currency. The payment carries a "ddq:<quoteId>" memo the buyer signs, so the quote is read from the CHAIN, not
// from the POST. A payment that names a valid quote (its wallet paid, it landed inside the quote's window, the quote
// not yet used by another payment) is valued at the QUOTE's price. Anything else (no quote, expired, reused, wrong
// wallet) is valued at the LOWER of the price when the record was first POSTed and the price now — and only if it
// was claimed within 15 minutes of landing, so nobody can pay, wait for the token to rise, then claim. Every
// transaction credits at most the biggest pack's coins (60).
//
// Env: SOLANA_RPC (getTransaction) + TREASURY_WALLET (+ POT_WALLET, ROYALTY_WALLET, OPERATOR_WALLET,
// COSIGNER_PUBKEY, TEAM_WALLETS: our own wallets, which can never be a paying customer).
import { randomBytes } from "node:crypto";
import { getStore } from "@netlify/blobs";
import { addToPot, splitGame } from "./store-pot-core.mjs";
import { casUpdate, readWithEtag, putIfNew, putIfMatch, pushId } from "./store-cas-core.mjs";
import { refFromTx, memosOf, TIP_MEMO } from "./store-ref-core.mjs";
import { lockPreacherShare } from "./store-preacher-core.mjs";
import { creditTotals } from "./store-keeper-core.mjs";
// Routes (2026-10-23): "coinbuy" and a referred "minetip" split 22% Pot / 22% Reserve / 12% ops / 44% preacher pool
// (store-pot-core splitGame, preacher share locked here); a "minetip" with no preacher stays 100% Reserve; "tip" (a Dojo
// Pot tip with the ddtip memo) stays 100% Pot. The Reserve and ops
// parts are booked into the Keeper totals (Blobs "keeper"), the same ledger the royalties and repairs use.

export const TREASURY = process.env.TREASURY_WALLET || "5w55F58ia3H71QjBD9bYvNQF2DcNu8K3AfJj9A4WMuWp";
const SOL_MINT = "So11111111111111111111111111111111111111112";
const MINTS = { ORE: "oreoU2P8bN6jkk3jbaiVxYnG1dCXcYxwhwyK9jSybcp", SKR: "SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3", USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" };
const DEC = { SOL: 1e9, ORE: 1e11, SKR: 1e6, USDC: 1e6 };
const CUR_MINT = { SOL: SOL_MINT, ...MINTS };   // the Keeper ledger is keyed by mint (SOL = the wrapped-SOL mint)
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
export const MAX_COINS = PACKS[PACKS.length - 1].total;   // per-transaction credit cap (DD-11)
// Coins for a verified USD amount: the biggest pack the payment covers (each pack gets the
// same PACK_TOL price-drift allowance, so a $1 pack paid at $0.97 is still 1 coin), and for
// odd amounts between packs 1 coin per $1 with the same allowance — never less than the
// covered pack, never more than the biggest pack. Below ~$0.96 → 0 (dust; the caller rejects it).
export function coinsForUsd(usd) {
  if (!(usd > 0)) return 0;
  let best = 0;
  for (const p of PACKS) if (usd + 1e-9 >= p.usd * (1 - PACK_TOL)) best = Math.max(best, p.total);
  return Math.min(MAX_COINS, Math.max(best, Math.floor(usd * (1 + PACK_TOL) + 1e-9)));
}

// ---------- price quotes (DD-11) ----------
export const QUOTE_MEMO = "ddq:";                 // the payment's memo: "ddq:<quoteId>"
export const QUOTE_ID_RE = /^[0-9a-f]{24}$/;
export const QUOTE_TTL_MS = 10 * 60e3;            // a quote holds its price for 10 minutes
const QUOTE_GRACE_MS = 2 * 60e3;                  // a payment signed just before expiry may land a little after it
const QUOTE_EARLY_MS = 60e3;                      // clock skew: a payment can't predate its own quote by more than this
export const NOQUOTE_WINDOW_MS = 15 * 60e3;       // without a usable quote, a payment must be claimed within 15 min
export const QUOTE_CURRENCIES = new Set(["ORE", "SKR", "SOL"]);
export class QuoteError extends Error { constructor(msg, status = 400) { super(msg); this.status = status; } }
const quotes = () => getStore("coin-quotes");
// raw units → "0.123" (exact decimal string, trailing zeros trimmed)
function uiOf(raw, currency) {
  const d = Math.round(Math.log10(DEC[currency])), p = 10n ** BigInt(d), r = BigInt(raw);
  const frac = (r % p).toString().padStart(d, "0").replace(/0+$/, "");
  return (r / p).toString() + (frac ? "." + frac : "");
}
// A server price quote for one coin pack: the exact token amount at the live price, bound to the wallet + currency,
// valid QUOTE_TTL_MS. Stored create-only at coin-quotes q:<id>; consumed once (used:<id>) by the payment naming it.
export async function createQuote({ wallet, currency, usd }) {
  if (!ADDR_RE.test(String(wallet || ""))) throw new QuoteError("bad wallet");
  if (!QUOTE_CURRENCIES.has(currency)) throw new QuoteError("pay with ORE, SKR or SOL");
  if (wallet === TREASURY || ownWallets().has(wallet)) throw new QuoteError("our own wallets can't buy coins");
  const pack = PACKS.find((p) => p.usd === +usd);
  if (!pack) throw new QuoteError("unknown coin pack");
  const price = await livePrice(currency);
  if (price == null) throw new QuoteError("prices are unavailable right now — try again in a moment", 503);
  const raw = BigInt(Math.ceil((pack.usd / price) * DEC[currency]));   // round UP: the pack is always fully paid
  const at = Date.now();
  const q = { id: randomBytes(12).toString("hex"), wallet, currency, usd: pack.usd, coins: pack.total, price, raw: raw.toString(), at, exp: at + QUOTE_TTL_MS };
  if (!(await putIfNew(quotes(), "q:" + q.id, q))) throw new QuoteError("busy — try again", 503);
  return { quoteId: q.id, memo: QUOTE_MEMO + q.id, wallet, currency, usd: q.usd, coins: q.coins, price, tokenRaw: q.raw,
    tokenAmount: uiOf(raw, currency), exp: q.exp, treasury: TREASURY };
}
// Why this payment can't use quote q (null → it can), judged from the chain: the paying wallet, currency and landing time.
function quoteProblem(q, { buyer, currency, blockTime }) {
  if (q.wallet !== buyer) return "the quote was issued to another wallet";
  if (q.currency !== currency) return "the quote was for another currency";
  const t = blockTime * 1000;
  if (t < q.at - QUOTE_EARLY_MS) return "the payment predates its quote";
  if (t > q.exp + QUOTE_GRACE_MS) return "the quote had expired when the payment landed";
  return null;
}
// Claim quote q for signature sig, once ever. true → this payment holds it (a re-run of the same sig keeps it).
async function consumeQuote(q, sig) {
  if (await putIfNew(quotes(), "used:" + q.id, { sig, at: Date.now() })) return true;
  const { value } = await readWithEtag(quotes(), "used:" + q.id);
  return value?.sig === sig;
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
const POT_WALLET = process.env.POT_WALLET || "5w55F58ia3H71QjBD9bYvNQF2DcNu8K3AfJj9A4WMuWp";   // tips land in the Degen Dojo Reserve

// Our own wallets (same list the payout engine refuses to pay): never a paying customer.
function ownWallets() {
  const s = new Set([TREASURY, POT_WALLET, process.env.ROYALTY_WALLET || "5w55F58ia3H71QjBD9bYvNQF2DcNu8K3AfJj9A4WMuWp",
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
// Programs a plain payment may use (top level and inner): transfers, account creation, compute budget, memos — plus
// Lighthouse, the assertion-only guard program Phantom appends to transactions it sends (it checks state, moves nothing).
const PLAIN_PROGRAMS = new Set(["11111111111111111111111111111111", "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL", "ComputeBudget111111111111111111111111111111",
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr", "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo", "L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95"]);
const ixPrograms = (tx) => {
  const keys = allKeys(tx);
  const ixs = [...(tx.transaction.message.instructions || []), ...(tx.meta?.innerInstructions || []).flatMap((x) => x.instructions || [])];
  return ixs.map((ix) => keys[ix.programIdIndex]);
};
function plainPayment(tx) { return ixPrograms(tx).every((p) => PLAIN_PROGRAMS.has(p)); }
// A mining tip rides in the /mine page's "start auto-mining" tx: the ORE program plus a plain transfer to us.
// Nothing else may run in it (no marketplace / AuctionHouse / swap program), and the ORE program must be there.
export const ORE_PROGRAM = "oreV3EG1i9BEgiAJ8b177Z2S2rMarzak4NMv1kULvWv";
export function minerTipPayment(tx) {
  const progs = ixPrograms(tx);
  return progs.includes(ORE_PROGRAM) && progs.every((p) => p === ORE_PROGRAM || PLAIN_PROGRAMS.has(p));
}

export async function inspectPayment(sig, currency, wallet = TREASURY) {
  const tx = await rpc("getTransaction", [sig, { maxSupportedTransactionVersion: 0, encoding: "json" }]);
  if (!tx || tx.meta?.err) return null;
  const signers = signersOf(tx);
  const memos = memosOf(tx);
  const tip = { plain: plainPayment(tx), tipMemo: memos.includes(TIP_MEMO), minerTip: minerTipPayment(tx),
    minerSignup: memos.some((m) => m.startsWith("ddminer:")) };   // a branded-miner setup fee (store-miner-core) — never a coin buy / tip
  // the price quote this payment names in its own signed memo (DD-11)
  const quoteId = memos.map((m) => (m.startsWith(QUOTE_MEMO) ? m.slice(QUOTE_MEMO.length) : "")).find((id) => QUOTE_ID_RE.test(id)) || null;
  let delta;
  if (currency === "SOL") {
    const keys = allKeys(tx);
    delta = (w) => { const i = keys.indexOf(w); return i < 0 ? 0n : BigInt(tx.meta.postBalances[i] || 0) - BigInt(tx.meta.preBalances[i] || 0); };
  } else {
    const mint = MINTS[currency];
    if (!mint) return { got: 0, gainRaw: 0n, signers, payers: [], blockTime: tx.blockTime || null, memoRef: refFromTx(tx), quoteId, ...tip };
    delta = (w) => rawOf(tx.meta.postTokenBalances, mint, w) - rawOf(tx.meta.preTokenBalances, mint, w);
  }
  const gainRaw = delta(wallet);
  const payers = gainRaw > 0n ? signers.filter((s) => s !== wallet && -delta(s) >= gainRaw) : [];
  return { got: Number(gainRaw) / DEC[currency], gainRaw, signers, payers, blockTime: tx.blockTime || null, memoRef: refFromTx(tx), quoteId, ...tip };
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
    // the Reserve + ops parts of a coin buy / mining tip → the Keeper totals (idempotent by id); the Reserve part is
    // also "unconverted" so the weekly stORE conversion picks it up
    if (m.split) {
      const mint = CUR_MINT[m.currency];
      await creditTotals({ reserve: { [mint]: m.split.reserve }, ops: { [mint]: m.split.ops }, unconverted: { [mint]: m.split.reserve } }, "game:" + m.sig);
    }
    m = { ...m, state: "done", doneAt: Date.now() };
    await getStore("coin-credits").setJSON("credited:" + m.sig, m);
  }
  const next = { ...rec, ...(m.recPatch || {}), verified: true, rejected: false, verifiedAmount: m.got, verifiedUsd: m.usd,
    verifiedAt: m.doneAt || Date.now(), route: m.route, ...(m.split ? { split: m.split } : {}),
    ...(m.route === "coinbuy" ? { creditedCoins: m.coins } : { toPotUsd: m.potUsd }) };
  delete next.rejectReason;
  await store.setJSON(key, next);
  return { verified: true, result: { sig: m.sig, currency: m.currency, got: m.got, usd: +(+m.usd).toFixed(2), ok: true, route: m.route,
    ...(m.route === "coinbuy" ? { credited: m.coins, claimed: rec.coins } : { tip: true }), ...(m.recPatch?.buyerCorrected ? { buyerCorrected: true } : {}) } };
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

  const isTip = rec.kind === "tip" || rec.kind === "minetip";
  let currency = rec.currency, curPatch = null;
  let pay = await inspectPayment(sig, currency, isTip ? POT_WALLET : TREASURY);
  if (!pay) {   // tx missing/failed: the cron leaves it pending (not yet propagated); the admin path rejects
    // …but not forever: a signature that still can't be read after 15 minutes is junk (or failed) — drop it, so
    // junk records can't pile up and stall real purchases behind them.
    if (strictReject || Date.now() - (rec.recordedAt || 0) > 15 * 60_000) return reject("tx missing/failed");
    return { result: { sig, got: null, ok: false, retry: true } };
  }
  // The price quote the payment names in its own memo (never the POSTed one). Its currency is authoritative: a record
  // POSTed first with the wrong currency (a front-runner) can't make the real coin buy look empty.
  let quote = null;
  if (!isTip && pay.quoteId) {
    quote = await getStrong(quotes(), "q:" + pay.quoteId);   // a read error throws → this record is retried, never mis-priced
    if (quote && quote.currency !== currency && QUOTE_CURRENCIES.has(quote.currency)) {
      const again = await inspectPayment(sig, quote.currency, TREASURY);
      if (again) { pay = again; curPatch = { currency: quote.currency, claimedCurrency: currency }; currency = quote.currency; }
    }
  }
  // What the payment is, judged from the transaction itself. Royalties from marketplace sales and other deposits
  // also land in the Treasury — none of them may be claimed as a coin buy or a tip:
  //   coin buy  → a PLAIN transfer (System / Token / ATA / ComputeBudget / Memo only)
  //   Pot tip   → a plain transfer the tipper signed WITH the "ddtip" memo (100% Pot)
  //   mining tip→ the ORE program + plain transfers only (the /mine "start auto-mining" tx)
  let route;
  // a branded-miner setup fee (its ddminer: memo names the signup) can't be filed as a coin buy or tip — that would
  // let someone claim the payment first and block the payer's own miner signup
  if (pay.minerSignup) return reject("this payment is a branded-miner setup fee (ddminer memo), not a coin purchase or tip");
  if (!isTip) {
    if (!pay.plain) return reject("not a coin purchase (a coin pack is a plain transfer — no marketplace or program call)");
    route = "coinbuy";
  } else if (pay.plain && pay.tipMemo) route = "tip";
  else if (pay.minerTip) route = "minetip";
  else return reject("not a Dojo tip (a plain transfer with the ddtip memo, or a tip inside an ORE mining transaction)");
  if (!(pay.got > 0)) return reject(`nothing reached the ${isTip ? "pot" : "treasury"} wallet in this tx`);
  // A payment the Keeper already used (a card repair, a card sent in, a royalty) can't also buy coins or count as a tip.
  const kdec = await getStore("keeper").get("dec:" + sig, { type: "json" }).catch(() => null);
  if (kdec && kdec.kind && kdec.kind !== "skip") return reject(`payment already used by the Dojo Keeper (${kdec.kind})`);
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

  // Referral = the "ddref:<code>" memo the buyer signed into this payment — never the POSTed ref.
  const postedRef = rec.ref ? String(rec.ref).toLowerCase() : null;
  recPatch = { ...(recPatch || {}), ...(curPatch || {}), ref: pay.memoRef || null,
    ...(postedRef && postedRef !== pay.memoRef ? { postedRef } : {}) };

  // Value the payment. A coin buy is priced when it was PAID (DD-11, see the header); tips feed the Pot and mint no
  // coins, so they keep the live price.
  let usd;
  if (route === "coinbuy") {
    if (!pay.blockTime) return { result: { sig, got: pay.got, ok: false, retry: "no block time yet" } };
    let quoteNote = quote ? quoteProblem(quote, { buyer, currency, blockTime: pay.blockTime }) : pay.quoteId ? "unknown quote" : null;
    if (quote && !quoteNote && !(await consumeQuote(quote, sig))) quoteNote = "the quote was already used by another payment";
    if (quote && !quoteNote) {
      usd = pay.got * quote.price;
      recPatch.pricing = { by: "quote", quoteId: quote.id, price: quote.price, quotedRaw: quote.raw, quotedCoins: quote.coins };
    } else {
      const lagMs = (rec.recordedAt || Date.now()) - pay.blockTime * 1000;
      if (lagMs > NOQUOTE_WINDOW_MS)
        return reject(`claimed ${Math.round(lagMs / 60e3)} min after paying without a valid price quote${quoteNote ? ` (${quoteNote})` : ""} — coins are priced when you pay`);
      const now = await livePrice(currency);
      if (now == null) return { result: { sig, got: pay.got, ok: false, retry: "no price" } };   // fail-closed
      // the lower of claim-time and now: waiting never pays (a claim-time price for the wrong currency is ignored)
      const px = rec.postPrice > 0 && !curPatch ? Math.min(rec.postPrice, now) : now;
      usd = pay.got * px;
      recPatch.pricing = { by: "claim", price: px, ...(quoteNote ? { quoteRefused: quoteNote, quoteId: pay.quoteId } : {}) };
    }
  } else {
    const price = await livePrice(currency);
    if (price == null) return { result: { sig, got: pay.got, ok: false, retry: "no price" } };   // fail-closed
    usd = pay.got * price;
  }
  let plan;
  if (route === "tip") plan = { route, coins: 0, potUsd: usd, potNative: pay.got };   // a Pot tip mints NO coins — 100% feeds the pot
  else {
    const coins = route === "coinbuy" ? coinsForUsd(usd) : 0;
    if (route === "coinbuy" && !(coins > 0)) return reject(`dust: $${usd.toFixed(2)} < $1`);
    // lock the preacher's share NOW (their fighters at this moment); an RPC failure throws → the cron retries later
    const lock = await lockPreacherShare({ ref: pay.memoRef, buyer });
    // a mining tip with NO preacher stays 100% in the Reserve — no Pot, no ops share (owner 2026-10-23)
    const sp = route === "minetip" && !(lock.pct > 0) ? { pot: 0n, ops: 0n, preacher: 0n, reserve: BigInt(pay.gainRaw) } : splitGame(pay.gainRaw, lock.pct);
    const split = { v: 3, currency, dec: Math.round(Math.log10(DEC[currency])), gainRaw: String(pay.gainRaw),
      pot: String(sp.pot), reserve: String(sp.reserve), ops: String(sp.ops), preacher: String(sp.preacher),
      preacherPct: lock.pct, ref: lock.code, preacherWallet: lock.wallet || null, ...(lock.tier ? { tier: lock.tier } : {}), ...(lock.why ? { why: lock.why } : {}) };
    const frac = Number(sp.pot) / Number(pay.gainRaw);   // = 0.22 up to rounding dust
    plan = { route, coins, potUsd: usd * frac, potNative: Number(sp.pot) / DEC[currency], split };
  }
  // One payment, one product: the branded-miner setup fee is paid to the same treasury, and its signup
  // claims sig:<sig> in Blobs "miner-requests" with a create-only write. Claim the same key here: if a
  // miner signup holds it, this signature can't also buy coins; if we hold it, the signup is refused.
  if (!(await putIfNew(getStore("miner-requests"), "sig:" + sig, MINER_SIG_TAG))) {
    const holder = await getStore("miner-requests").get("sig:" + sig);
    if (holder !== JSON.stringify(MINER_SIG_TAG)) return reject("payment already used for a branded-miner signup");
  }
  const marker = { sig, buyer, currency, got: pay.got, usd, ...plan, recPatch, state: "claimed", at: Date.now() };
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
