// Shared coin-purchase verification — the ONE place a purchase turns into coins.
// Imported by BOTH /api/verify (admin-triggered) and verify-cron (every minute) so
// the crediting rule can never drift between the two paths.
//
// Rule: re-read the purchase's signature on-chain, confirm the TREASURY actually
// received the tokens, value that REAL amount in USD at the live price, and mint
// coins from the server pack table. The client's claimed coins/usd/tokenAmount are
// hints only — a tiny payment can never buy a big pack.
//
// What a payment IS comes from the transaction, never from the POST (security review 2026-10-23, H2): a plain transfer
// with the "ddtip" memo is a Pot tip, the ORE program + plain transfers is a mining tip, any other plain transfer to
// the Treasury is a coin buy; the currency is whichever of ORE / SKR / SOL the receiving wallet actually gained (the
// quote's, when the payment's ddq memo names one). The POSTed kind / currency / buyer are hints, so whoever POSTs a
// signature first — with any kind or currency — changes nothing about how it is judged.
//
// Payer binding: coins go ONLY to the wallet that actually paid — a SIGNER of the tx whose own
// balance of that currency dropped by at least what the treasury gained (SOL: its lamports;
// SPL: the token accounts it owns, from pre/postTokenBalances owner fields). The POSTed `buyer`
// is a claim: anyone watching the chain can POST someone else's fresh signature first (the record
// is first-write-wins), so a claimed buyer that did not pay is never credited. When exactly one
// signer paid, the purchase is re-attributed to that payer (and the claim's referral code is
// dropped) instead of being rejected — so a front-runner gets nothing AND cannot lock the real
// buyer out. Set REATTRIBUTE_TO_PAYER=false to reject such claims outright instead.
// Rejections that hinge on something a POSTer or the RPC controls are NOT final (`requeue` on the record): a claimed
// buyer that isn't the payer ("buyer" — the on-chain payer's own later POST re-queues it) and a transaction the RPC
// couldn't read for 15 minutes ("unreadable" — a later POST of it, once readable, re-queues it). The admin can re-queue
// or delete any rejected record (/api/verify). Everything else is a fact of the chain and final.
//
// Exactly-once: before any coin moves, a one-time marker credited:<sig> is created with a
// create-only write (Blobs "coin-credits"). Only the run that creates it credits; overlapping cron
// runs / the admin path see it and stand back. The balance and pot increments are themselves
// compare-and-swap writes that remember the signature, so a run that dies half-way is resumed
// (after RESUME_AFTER_MS) without double-crediting.
//
// Only pending work is read (review M10): /api/coinbuy writes pending:<sig> next to buy:<sig>; verifyPurchases walks
// pending:* and drops each key once its record is verified or rejected — a settled record is never read again. At most
// VERIFY_BUDGET_MS per run, starting at a random point, so a long queue can't starve the keys that sort last. Junk
// (a tx that isn't a payment to us) is indexed at rej:<sig> and purged after PURGE_AFTER_MS with old quotes (purgeJunk).
//
// One payment, one product: before crediting, the signature is claimed at sig:<sig> in Blobs
// "miner-requests" (the branded-miner signup's replay registry, also create-only) — a payment already
// used as a miner setup fee can't buy coins, and a credited purchase can't later pay a miner fee.
// Other guards: our own wallets are never a customer; a payment must be claimed within 48h of landing; a marketplace
// transaction (it lists a marketplace program) and a card repair (a "ddfix:" memo) are never a coin buy or tip — the
// Dojo Keeper books those; an ORE payment without a "ddq:" quote memo isn't a coin buy (the repair QR pays that way).
//
// Priced when the buyer PAYS (DD-11): the /credits page first asks /api/coinbuy for a QUOTE — the live price, the
// exact token amount for the pack, valid 5 minutes, stored server-side (Blobs "coin-quotes") and bound to the wallet
// and currency. The payment carries a "ddq:<quoteId>" memo the buyer signs, so the quote is read from the CHAIN, not
// from the POST. A payment that names a valid quote (its wallet paid, it landed inside the quote's window, the quote
// not yet used by another payment, and no NEWER quote was issued to that wallet + currency before it landed — one live
// quote at a time, so nobody can collect quotes and pay with the best one) is valued at the QUOTE's price. Anything
// else (no quote, expired, reused, superseded, wrong wallet) is valued at the LOWER of the price when the record was
// first POSTed and the price now — and only if it was claimed within 15 minutes of landing, so nobody can pay, wait for
// the token to rise, then claim. Every transaction credits at most the biggest pack's coins (60).
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
import { MARKETPLACES } from "./store-royalty-core.mjs";
// Routes (2026-10-23): "coinbuy" and a referred "minetip" split 22% Pot / 22% Reserve / 12% ops / 44% preacher pool
// (store-pot-core splitGame, preacher share locked here); a "minetip" with no preacher stays 100% Reserve; "tip" (a Dojo
// Pot tip with the ddtip memo) stays 100% Pot. The Reserve and ops
// parts are booked into the Keeper totals (Blobs "keeper"), the same ledger the royalties and repairs use.

export const TREASURY = process.env.TREASURY_WALLET || "5w55F58ia3H71QjBD9bYvNQF2DcNu8K3AfJj9A4WMuWp";
const SOL_MINT = "So11111111111111111111111111111111111111112";
const MINTS = { ORE: "oreoU2P8bN6jkk3jbaiVxYnG1dCXcYxwhwyK9jSybcp", SKR: "SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3", USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" };
const DEC = { SOL: 1e9, ORE: 1e11, SKR: 1e6, USDC: 1e6 };
const CUR_MINT = { SOL: SOL_MINT, ...MINTS };   // the Keeper ledger is keyed by mint (SOL = the wrapped-SOL mint)
const PAY_CURRENCIES = ["ORE", "SKR", "SOL"];  // what a coin pack / tip can be paid in (order = tie-break)
// absorbs rounding and price drift (no-quote path) — a quoted payment pays the exact amount, so 1% is plenty;
// it was 4%, which let a buyer pay 96% of a quote and still get the full pack (review L1)
const PACK_TOL = 0.01;
const ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export const REATTRIBUTE_TO_PAYER = true;
const CLAIM_WINDOW_MS = 48 * 3600e3;   // a payment must be claimed within 48h of landing (clients re-send for 24h)
const RESUME_AFTER_MS = 2 * 60e3;      // a credit claimed by a run that died is finished after this (functions stop at ~30s)
const BAL_APPLIED_MAX = 50;            // recent credited sigs remembered in each balance record
const MINER_SIG_TAG = "coin-purchase";  // value we write at miner-requests sig:<sig> (the signup writes its request id)
const UNREADABLE_MS = 15 * 60_000;     // a signature the RPC still can't read after this is rejected (re-queueable)
const VERIFY_BUDGET_MS = 20_000;       // per run: scheduled functions stop at 30 s
export const PURGE_AFTER_MS = 3 * 86400e3;   // rejected junk + old quotes are deleted after 3 days (> the 48h claim window)
export const PENDING = "pending:";     // coin-purchases pending:<sig> — the cron's work list
const REJ = "rej:";                    // coin-purchases rej:<sig> — rejected junk, purged after PURGE_AFTER_MS
const PENDING_INDEX_V = "meta:pending-v1";

// The ONLY coin prices the server honours (mirror of dojo-credits.html PACKS).
const PACKS = [
  { usd: 3, total: 3 }, { usd: 5, total: 5 }, { usd: 10, total: 11 }, { usd: 25, total: 29 }, { usd: 50, total: 60 },
].sort((a, b) => a.usd - b.usd);
export const MAX_COINS = PACKS[PACKS.length - 1].total;   // per-transaction credit cap (DD-11)
// Coins for a verified USD amount: the biggest pack the payment covers (each pack gets the
// same PACK_TOL price-drift allowance, so a $10 pack paid at $9.95 is still 11 coins), and for
// odd amounts between packs 1 coin per $1 with the same allowance — never less than the
// covered pack, never more than the biggest pack. Below ~$0.99 → 0 (dust; the caller rejects it).
export function coinsForUsd(usd) {
  if (!(usd > 0)) return 0;
  let best = 0;
  for (const p of PACKS) if (usd + 1e-9 >= p.usd * (1 - PACK_TOL)) best = Math.max(best, p.total);
  return Math.min(MAX_COINS, Math.max(best, Math.floor(usd * (1 + PACK_TOL) + 1e-9)));
}

// ---------- price quotes (DD-11) ----------
export const QUOTE_MEMO = "ddq:";                 // the payment's memo: "ddq:<quoteId>"
export const QUOTE_ID_RE = /^[0-9a-f]{24}$/;
export const QUOTE_TTL_MS = 5 * 60e3;             // a quote holds its price for 5 minutes (owner 2026-10-25, was 10)
const QUOTE_GRACE_MS = 60e3;                      // a payment signed just before expiry may land a little after it
const QUOTE_EARLY_MS = 60e3;                      // clock skew: a payment can't predate its own quote by more than this
const QUOTE_NEWER_SKEW_MS = 5_000;                // a newer quote requested while this payment was landing doesn't count
const QUOTES_PER_HOUR = 20;                       // per wallet (a quote is a stored record — no unbounded writes)
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
// Every quote is also logged at qlog:<wallet> (the last day's): a newer quote for the same currency retires the older
// ones (see quoteProblem), and a wallet gets at most QUOTES_PER_HOUR.
export async function createQuote({ wallet, currency, usd }) {
  if (!ADDR_RE.test(String(wallet || ""))) throw new QuoteError("bad wallet");
  if (!QUOTE_CURRENCIES.has(currency)) throw new QuoteError("pay with ORE, SKR or SOL");
  if (wallet === TREASURY || ownWallets().has(wallet)) throw new QuoteError("our own wallets can't buy coins");
  const pack = PACKS.find((p) => p.usd === +usd);
  if (!pack) throw new QuoteError("unknown coin pack");
  const price = await livePrice(currency);
  if (price == null) throw new QuoteError("prices are unavailable right now — try again in a moment", 503);
  const raw = BigInt(Math.ceil((pack.usd / price) * DEC[currency]));   // round UP: the pack is always fully paid
  const at = Date.now(), id = randomBytes(12).toString("hex");
  await casUpdate(quotes(), "qlog:" + wallet, (log) => {
    const day = (Array.isArray(log) ? log : []).filter((e) => at - e.at < 86400e3);
    if (day.filter((e) => at - e.at < 3600e3).length >= QUOTES_PER_HOUR) throw new QuoteError("too many price quotes for this wallet — try again later", 429);
    return [...day, { id, cur: currency, at }].slice(-60);
  });
  const q = { id, wallet, currency, usd: pack.usd, coins: pack.total, price, raw: raw.toString(), at, exp: at + QUOTE_TTL_MS };
  if (!(await putIfNew(quotes(), "q:" + q.id, q))) throw new QuoteError("busy — try again", 503);
  return { quoteId: q.id, memo: QUOTE_MEMO + q.id, wallet, currency, usd: q.usd, coins: q.coins, price, tokenRaw: q.raw,
    tokenAmount: uiOf(raw, currency), exp: q.exp, treasury: TREASURY };
}
// Why this payment can't use quote q (null → it can), judged from the chain: the paying wallet, currency and landing time.
async function quoteProblem(q, { buyer, currency, blockTime }) {
  if (q.wallet !== buyer) return "the quote was issued to another wallet";
  if (q.currency !== currency) return "the quote was for another currency";
  const t = blockTime * 1000;
  if (t < q.at - QUOTE_EARLY_MS) return "the payment predates its quote";
  if (t > q.exp + QUOTE_GRACE_MS) return "the quote had expired when the payment landed";
  // one live quote per wallet + currency: a quote issued after this one and before the payment landed retires it
  const log = (await getStrong(quotes(), "qlog:" + q.wallet)) || [];
  if (log.some((e) => e.id !== q.id && e.cur === q.currency && e.at > q.at && e.at < t - QUOTE_NEWER_SKEW_MS))
    return "a newer quote was issued before this payment landed (only the latest quote holds its price)";
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
// a json-encoded transaction (null → the node can't read it, yet or ever); commitment defaults to finalized
const readTx = (sig, commitment) => rpc("getTransaction", [sig, { maxSupportedTransactionVersion: 0, encoding: "json", ...(commitment ? { commitment } : {}) }]);

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

// What the transaction itself says (memos, programs) — the same facts the Dojo Keeper reads.
function txFacts(tx) {
  const memos = memosOf(tx);
  return { memos, signers: signersOf(tx), blockTime: tx.blockTime || null, memoRef: refFromTx(tx),
    plain: plainPayment(tx), tipMemo: memos.includes(TIP_MEMO), minerTip: minerTipPayment(tx),
    minerSignup: memos.some((m) => m.startsWith("ddminer:")),   // a branded-miner setup fee (store-miner-core) — never a coin buy / tip
    repair: memos.some((m) => m.startsWith("ddfix:")),          // a card repair (the Dojo Keeper's) — never a coin buy / tip
    market: allKeys(tx).some((k) => MARKETPLACES.has(k)),       // lists a marketplace program (used or not) — the Keeper's royalty
    // the price quote this payment names in its own signed memo (DD-11)
    quoteId: memos.map((m) => (m.startsWith(QUOTE_MEMO) ? m.slice(QUOTE_MEMO.length) : "")).find((id) => QUOTE_ID_RE.test(id)) || null };
}
// What `wallet` gained in `currency` in tx, and which signers paid it:
//   { got (UI units), gainRaw, payers }   payers = signers (≠ wallet) whose own balance of that currency dropped by ≥ the gain
function paymentIn(tx, currency, wallet, signers = signersOf(tx)) {
  let delta;
  if (currency === "SOL") {
    const keys = allKeys(tx);
    delta = (w) => { const i = keys.indexOf(w); return i < 0 ? 0n : BigInt(tx.meta.postBalances[i] || 0) - BigInt(tx.meta.preBalances[i] || 0); };
  } else {
    const mint = MINTS[currency];
    if (!mint) return { got: 0, gainRaw: 0n, payers: [] };
    delta = (w) => rawOf(tx.meta.postTokenBalances, mint, w) - rawOf(tx.meta.preTokenBalances, mint, w);
  }
  const gainRaw = delta(wallet);
  const payers = gainRaw > 0n ? signers.filter((s) => s !== wallet && -delta(s) >= gainRaw) : [];
  return { got: Number(gainRaw) / DEC[currency], gainRaw, payers };
}
// What kind of payment the transaction is: { route } or { reject } (a fact of the chain, final)
export function classifyPayment(tx) {
  const f = txFacts(tx);
  if (f.minerSignup) return { f, reject: "this payment is a branded-miner setup fee (ddminer memo), not a coin purchase or tip" };
  if (f.market) return { f, reject: "a marketplace transaction is not a coin purchase or a Dojo tip" };
  if (f.repair) return { f, reject: "a card repair payment (ddfix memo) is not a coin purchase or a Dojo tip — the Dojo Keeper handles it" };
  if (f.plain && f.tipMemo) return { f, route: "tip" };
  if (f.minerTip) return { f, route: "minetip" };
  if (f.plain) return { f, route: "coinbuy" };
  return { f, reject: "not a coin purchase or a Dojo tip (a coin pack or Pot tip is a plain transfer, a mining tip rides in an ORE mining transaction)" };
}
const walletFor = (route) => (route === "coinbuy" ? TREASURY : POT_WALLET);
const gainedIn = (tx, route) => PAY_CURRENCIES.filter((c) => paymentIn(tx, c, walletFor(route)).gainRaw > 0n);

// Read tx `sig` and describe the payment `wallet` received in `currency` (null → tx missing / failed):
//   { got, gainRaw, signers, payers, blockTime, memoRef, quoteId, plain, tipMemo, minerTip, minerSignup, repair, market }
export async function inspectPayment(sig, currency, wallet = TREASURY) {
  const tx = await readTx(sig);
  if (!tx || tx.meta?.err) return null;
  const f = txFacts(tx);
  return { ...paymentIn(tx, currency, wallet, f.signers), signers: f.signers, blockTime: f.blockTime, memoRef: f.memoRef, quoteId: f.quoteId,
    plain: f.plain, tipMemo: f.tipMemo, minerTip: f.minerTip, minerSignup: f.minerSignup, repair: f.repair, market: f.market };
}

// how much of `currency` the given wallet (default TREASURY) GAINED in tx `sig` (null → tx missing/failed)
export async function walletReceived(sig, currency, wallet = TREASURY) {
  const p = await inspectPayment(sig, currency, wallet);
  return p ? p.got : null;
}

// The /api/coinbuy POST filter (review M10): when the node can already read the signature, it must be a coin buy or tip
// paying us — anything else (someone's unrelated swap, a royalty, our own transaction) is refused before it is stored.
// A signature the node can't read yet is accepted: the cron re-reads it (and rejects it after 15 minutes).
// → { ok: true, readable } | { ok: false, error }
export async function postCheck(sig) {
  let tx;
  try { tx = await readTx(sig, "confirmed"); } catch { return { ok: true, readable: false }; }   // RPC hiccup: the cron decides
  if (!tx) return { ok: true, readable: false };
  if (tx.meta?.err) return { ok: false, error: "that transaction failed" };
  const signers = signersOf(tx);
  if (signers.includes(TREASURY) || signers.includes(POT_WALLET)) return { ok: false, error: "that is one of our own transactions" };
  const c = classifyPayment(tx);
  if (c.reject) return { ok: false, error: c.reject };
  const gained = gainedIn(tx, c.route);
  if (!gained.length) return { ok: false, error: "this transaction paid nothing to the Dojo" };
  // a memo-less ORE transfer is never a coin buy (verifyOne) — and it may be a card repair (the repair QR pays that
  // way), so no coin record is created for it at all: the Dojo Keeper decides it alone (review M2)
  if (c.route === "coinbuy" && !c.f.quoteId && gained.length === 1 && gained[0] === "ORE")
    return { ok: false, error: "an ORE payment without a price-quote memo isn't a coin purchase (card repairs are paid that way) — buy coins on the Coins page" };
  return { ok: true, readable: true };
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
  delete next.rejectReason; delete next.requeue;
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

  // rejecting is conditional on the record being unchanged since we read it (a concurrent run wins).
  // { junk } → not a payment to us at all (indexed for the purge); { requeue } → not final (see the header)
  const reject = async (reason, { junk = false, ...extra } = {}) => {
    const wrote = await putIfMatch(store, key, { ...rec, ...extra, rejected: true, rejectReason: reason, rejectedAt: Date.now() }, etag);
    if (wrote && junk) await store.setJSON(REJ + sig, { at: Date.now(), reason });
    return { rejected: wrote, result: { sig, ok: false, rejected: wrote, reason } };
  };

  const tx = await readTx(sig);
  if (!tx) {   // not readable: the cron leaves it pending (not yet propagated); the admin path rejects
    // …but not forever: a signature that still can't be read after 15 minutes is rejected — re-queueable, since an RPC
    // node that answers null under load must not cost a buyer their coins (a later POST of it re-queues it)
    if (strictReject || Date.now() - (rec.recordedAt || 0) > UNREADABLE_MS) return reject("transaction not readable on-chain", { requeue: "unreadable", junk: true });   // purged after 3 days unless re-queued
    return { result: { sig, got: null, ok: false, retry: true } };
  }
  if (tx.meta?.err) return reject("the transaction failed on-chain", { junk: true });

  // What the payment is, judged from the transaction itself (never the POSTed kind). Royalties from marketplace sales,
  // card repairs and other deposits also land in the Treasury — none of them may be claimed as a coin buy or a tip:
  //   coin buy  → a PLAIN transfer (System / Token / ATA / ComputeBudget / Memo only)
  //   Pot tip   → a plain transfer the tipper signed WITH the "ddtip" memo (100% Pot)
  //   mining tip→ the ORE program + plain transfers only (the /mine "start auto-mining" tx)
  const c = classifyPayment(tx);
  if (c.reject) return reject(c.reject, { junk: true });
  const route = c.route, f = c.f;
  // A payment the Keeper already used (a card repair, a card sent in, a royalty) can't also buy coins or count as a tip.
  const kdec = await getStrong(getStore("keeper"), "dec:" + sig).catch(() => null);
  if (kdec && kdec.kind && kdec.kind !== "skip" && kdec.kind !== "retry") return reject(`payment already used by the Dojo Keeper (${kdec.kind})`);
  // …and its currency: what the receiving wallet actually gained (the quote's when the memo names one; the POSTed
  // currency only breaks a tie between two currencies the wallet gained in one tx)
  const gained = gainedIn(tx, route);
  if (!gained.length) return reject(`nothing reached the ${route === "coinbuy" ? "treasury" : "pot"} wallet in this tx`, { junk: true });
  // The price quote the payment names in its own memo (never the POSTed one).
  const quote = route === "coinbuy" && f.quoteId ? await getStrong(quotes(), "q:" + f.quoteId) : null;   // a read error throws → retried
  const currency = quote && gained.includes(quote.currency) ? quote.currency : gained.includes(rec.currency) ? rec.currency : gained[0];
  // The repair QR pays plain ORE with no memo, and every coin pack from /credits carries its ddq quote memo — so an ORE
  // transfer without one is not a coin buy (the Keeper decides it).
  if (route === "coinbuy" && currency === "ORE" && !f.quoteId)
    return reject("an ORE payment without a price-quote memo isn't a coin purchase (card repairs are paid that way) — buy coins on the Coins page");
  const pay = { ...paymentIn(tx, currency, walletFor(route), f.signers), ...f };
  const kind = route === "coinbuy" ? "buy" : "tip";
  const curPatch = { ...(currency !== rec.currency ? { currency, claimedCurrency: rec.currency } : {}), ...(kind !== rec.kind ? { kind, claimedKind: rec.kind } : {}) };
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
      // not final: the claimed buyer is a POSTed field — a later POST naming one of the on-chain payers re-queues it
      return reject(pay.signers.includes(rec.buyer) ? "claimed buyer is not the account that paid" : "claimed buyer did not sign the payment",
        { onchainPayers: pay.payers, requeue: "buyer" });
    }
  }

  // Referral = the "ddref:<code>" memo the buyer signed into this payment — never the POSTed ref.
  const postedRef = rec.ref ? String(rec.ref).toLowerCase() : null;
  recPatch = { ...(recPatch || {}), ...curPatch, ref: pay.memoRef || null,
    ...(postedRef && postedRef !== pay.memoRef ? { postedRef } : {}) };

  // Value the payment. A coin buy is priced when it was PAID (DD-11, see the header); tips feed the Pot and mint no
  // coins, so they keep the live price.
  let usd;
  if (route === "coinbuy") {
    if (!pay.blockTime) return { result: { sig, got: pay.got, ok: false, retry: "no block time yet" } };
    let quoteNote = quote ? await quoteProblem(quote, { buyer, currency, blockTime: pay.blockTime }) : pay.quoteId ? "unknown quote" : null;
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
      const px = rec.postPrice > 0 && !curPatch.currency ? Math.min(rec.postPrice, now) : now;
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

// ---------- the pending index (review M10) ----------
// Queue a purchase record for verification (/api/coinbuy on a new or re-queued record; the admin's re-queue).
export async function queuePending(store, sig) { await store.setJSON(PENDING + sig, { at: Date.now() }); }
// One time after this change ships: records POSTed before it have no pending:<sig> key yet — queue the open ones.
async function backfillPending(store) {
  if (await store.get(PENDING_INDEX_V)) return;
  const { blobs } = await store.list({ prefix: "buy:" });
  let n = 0;
  for (const b of blobs) {
    const r = await store.get(b.key, { type: "json" }).catch(() => null);
    if (r?.sig && !r.verified && !r.rejected) { await queuePending(store, r.sig); n++; }
  }
  await store.setJSON(PENDING_INDEX_V, { at: Date.now(), queued: n });
}

// Verify every PENDING purchase on-chain, credit server coins from the verified USD. Returns a summary.
// `strictReject` (admin path) rejects a tx that can't be read; the cron leaves it pending so a not-yet-propagated
// tx retries. Settled records (verified / rejected) leave the pending list and are never read again.
export async function verifyPurchases({ strictReject = false, reattribute = REATTRIBUTE_TO_PAYER, budgetMs = VERIFY_BUDGET_MS } = {}) {
  const store = getStore("coin-purchases");
  await backfillPending(store);
  const { blobs } = await store.list({ prefix: PENDING });
  const keys = blobs.map((b) => b.key), deadline = Date.now() + budgetMs;
  const start = keys.length ? Math.floor(Math.random() * keys.length) : 0;   // a long queue can't starve its last keys
  let checked = 0, verified = 0, rejected = 0, left = 0;
  const results = [];
  for (let i = 0; i < keys.length; i++) {
    if (Date.now() > deadline) { left = keys.length - i; break; }
    const pkey = keys[(start + i) % keys.length], key = "buy:" + pkey.slice(PENDING.length);
    const { value: rec, etag } = await readWithEtag(store, key);
    if (!rec || rec.verified || rec.rejected) { await store.delete(pkey); continue; }   // settled elsewhere (or deleted)
    checked++;
    try {
      const out = await verifyOne(store, key, rec, etag, { strictReject, reattribute });
      if (out.verified) verified++;
      if (out.rejected) rejected++;
      if (out.verified || out.rejected) await store.delete(pkey);
      results.push(out.result);
    } catch (e) { results.push({ sig: rec.sig, error: String(e.message || e), retry: true }); }
  }
  return { checked, verified, rejected, ...(left ? { left } : {}), results };
}

// ---------- re-queue / delete (admin, and the payer's own POST for a non-final rejection) ----------
// Can this POST re-open a rejected record? Only the non-final rejections (see the header): a "buyer" one when the new
// POST names one of the on-chain payers; an "unreadable" one when the node can now read the transaction.
export function requeueAllowed(prev, post, { readable = false } = {}) {
  if (!prev?.rejected || prev.verified) return false;
  if ((prev.requeued || 0) >= 5) return false;
  if (prev.requeue === "buyer") return Array.isArray(prev.onchainPayers) && prev.onchainPayers.includes(post.buyer) && post.buyer !== prev.buyer;
  if (prev.requeue === "unreadable") return readable;
  return false;
}
// The record a re-queue writes: the new POST's hints, the EARLIEST claim time (the 15-min / 48h windows count from the
// first claim — never later), the old rejection kept for the record.
export function requeuedRecord(prev, post) {
  const next = { ...post, recordedAt: Math.min(prev.recordedAt || post.recordedAt, post.recordedAt), requeued: (prev.requeued || 0) + 1,
    prevReject: prev.rejectReason, verified: false };
  if (prev.postPrice > 0 && prev.currency === post.currency) next.postPrice = next.postPrice > 0 ? Math.min(prev.postPrice, next.postPrice) : prev.postPrice;
  return next;
}
// Admin: put a rejected record back in the queue (any rejection — the admin has looked at it).
export async function adminRequeue(sig) {
  const store = getStore("coin-purchases"), key = "buy:" + sig;
  const { value: rec, etag } = await readWithEtag(store, key);
  if (!rec) return { ok: false, error: "no such record" };
  if (rec.verified) return { ok: false, error: "already verified" };
  if (!rec.rejected) { await queuePending(store, sig); return { ok: true, already: "pending" }; }
  const next = { ...rec, rejected: false, requeued: (rec.requeued || 0) + 1, prevReject: rec.rejectReason, requeuedBy: "admin", requeuedAt: Date.now() };
  delete next.rejectReason; delete next.rejectedAt; delete next.requeue;
  if (!(await putIfMatch(store, key, next, etag))) return { ok: false, error: "the record changed meanwhile — try again" };
  await store.delete(REJ + sig);
  await queuePending(store, sig);
  return { ok: true };
}
// Admin: delete a record that never credited anything (a credited one is history — never deleted).
export async function adminDelete(sig) {
  const store = getStore("coin-purchases");
  const rec = await getStrong(store, "buy:" + sig);
  if (!rec) return { ok: false, error: "no such record" };
  if (rec.verified || (await getStrong(getStore("coin-credits"), "credited:" + sig))) return { ok: false, error: "credited — kept as history" };
  for (const k of ["buy:", PENDING, REJ]) await store.delete(k + sig);
  return { ok: true };
}

// ---------- purge (hourly, from the verify cron) ----------
// Rejected junk older than PURGE_AFTER_MS, and quotes (with their used: marker) that expired that long ago.
// A purged junk signature POSTed again is refused at the door (postCheck) or rejected again by one getTransaction.
export async function purgeJunk({ now = Date.now(), budgetMs = 8000 } = {}) {
  const deadline = Date.now() + budgetMs, store = getStore("coin-purchases"), qs = quotes();
  let junk = 0, quotesGone = 0;
  for (const b of (await store.list({ prefix: REJ })).blobs) {
    if (Date.now() > deadline) break;
    const v = await store.get(b.key, { type: "json" }).catch(() => null);
    if (v && now - (v.at || 0) < PURGE_AFTER_MS) continue;
    const sig = b.key.slice(REJ.length), rec = await store.get("buy:" + sig, { type: "json" }).catch(() => null);
    if (rec && (rec.verified || !rec.rejected)) { await store.delete(b.key); continue; }   // re-queued / credited since: keep
    await store.delete("buy:" + sig); await store.delete(PENDING + sig); await store.delete(b.key); junk++;
  }
  for (const b of (await qs.list({ prefix: "q:" })).blobs) {
    if (Date.now() > deadline) break;
    const q = await qs.get(b.key, { type: "json" }).catch(() => null);
    if (q && now - (q.exp || q.at || 0) < PURGE_AFTER_MS) continue;
    await qs.delete(b.key); await qs.delete("used:" + b.key.slice(2)); quotesGone++;
  }
  return { junk, quotes: quotesGone };
}
