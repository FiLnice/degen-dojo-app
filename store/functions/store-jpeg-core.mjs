// JPEG DOJO — the pure rules of a "bring this JPEG into Degen Dojo" payment (owner idea 2026-11-04, built 2026-11-05).
// The page (/jpeg-dojo/) sends ONE ORE transferChecked to the Treasury + a memo per order:
//     ddjpeg:<design>:<vessel>      design = degen_NNNN | demon_NNNN (a JPEG on the wall), vessel = a Rugged Dojo NFT the payer holds
// The Keeper (store-keeper-core decideTx → decideJpeg, apply → applyJpeg) decides it once:
//   · the design must be on the wall (jpeg-pool.json, baked from scripts/jpeg-dojo.json) and not already taken
//   · the vessel must be a live Rugged Dojo NFT held by the payer in their own wallet (not listed / delegated / frozen)
//   · the ORE must cover the design's price (HOLDER_OFF % less when the payer holds a Degen Dojo card); a free seat (1,080)
// Anything that fails becomes a refund (refund:<sig>, kind "jpeg", paid at the weekly payout like a capped repair).
// What happens next is the owner's: scripts/keeper-apply-jpeg.mjs writes the White card to S3 and puts the vessel on the
// "Back to Degen Dojo" list (Bulkitor, DfaGo3 signs daily). No key here moves anything.
import POOL from "./jpeg-pool.json" with { type: "json" };

export const JPEG_MEMO = "ddjpeg:";
export const RD_COLL = "dgd6We3oS4M5LSVzT6Ep39wwVpjLC336tCpyPZkLAHx";   // RUGGED DOJO
export const DD_COLL = "2m9DupVeheZ5vfuXZxqV3KSQ7HnVDk2tG6ouH1ZnLwYb";   // DEGEN DOJO
export const SEATS = 1080;                                              // 108 worldly desires × 10 (owner's post 2026-11-04)
// Holder discount (owner 2026-11-05): a wallet that already holds a Degen Dojo card (Degen or Demon) pays less.
// The page shows the same number (store-jpeg.html HOLDER_OFF); the Keeper checks the holding when the payment lands.
export const HOLDER_OFF = 25;   // percent
const CENT = 1_000_000_000n;    // 0.01 ORE in raw (11 decimals) — wall prices are whole cents
/** the holder price of a raw ORE price: HOLDER_OFF % off, rounded UP to the cent (0.3 → 0.23, 0.75 → 0.57) */
export const holderPriceRaw = (raw, off = HOLDER_OFF) => { const c = BigInt(raw) / CENT; return ((c * BigInt(100 - off) + 99n) / 100n) * CENT; };
// Repeat collectors (owner 2026-11-05 "if a DEGEN DOJO holder wants to claim another JPEG degen they get a further discount"):
// every JPEG this wallet already brought in adds REPEAT_STEP % to the holder discount, up to MAX_OFF %. Holders only.
export const REPEAT_STEP = 5, MAX_OFF = 40;
export const offFor = (holder, brought = 0) => (holder ? Math.min(MAX_OFF, HOLDER_OFF + REPEAT_STEP * Math.max(0, Math.floor(+brought) || 0)) : 0);
const pctOf = (h) => (h === true ? HOLDER_OFF : Math.max(0, Math.min(MAX_OFF, Math.floor(+h) || 0)));

// Trade-ins (owner 2026-11-05): a buyer can send Rugged Dojo pieces to the Treasury (memo TRADE_MEMO, one or more
// transactions, dojo-gift.js packs them). Each piece = one credit on their wallet = TRADE_CREDIT off a bounty. Every
// JPEG pays at least half its bounty in ORE (less the holder 25%), never under MIN_PAY (that ORE goes to the Reserve). The pieces stay in the Treasury as
// the Dojo's stock. Credits never expire and are never paid out; an order that fails gives its credits back.
export const TRADE_MEMO = "ddtrade:jpeg";
export const TRADE_CREDIT_RAW = 15n * CENT;   // 0.15 ORE a piece
export const MIN_PAY_RAW = 10n * CENT;        // 0.1 ORE, the least any JPEG pays in ORE
export const isTradeMemo = (m) => m === TRADE_MEMO;
// Half cap (owner 2026-11-05 "cap … like 50% and the other half in ORE"): pieces may cover at most HALF of the full bounty
// (whole pieces, rounded down); the holder discount then comes off the ORE that is left. Never below MIN_PAY_RAW.
/** the most credits one JPEG can use: floor(full bounty / 2 / 0.15 ORE) */
export const maxTradeIns = (fullRaw) => Number(BigInt(fullRaw) / (2n * TRADE_CREDIT_RAW));
/** the ORE due on a full bounty after n credits (capped), with the holder price taken on what is left */
// holder: false / true (= HOLDER_OFF) / a percent off (offFor)
export const dueRaw = (fullRaw, n, holder = false) => { const rest = BigInt(fullRaw) - BigInt(Math.min(n, maxTradeIns(fullRaw))) * TRADE_CREDIT_RAW; const off = pctOf(holder); const d = off ? holderPriceRaw(rest, off) : rest; return d < MIN_PAY_RAW ? MIN_PAY_RAW : d; };
// optional :<n> = how many trade-in credits this order uses (see TRADE below)
const MEMO_RE = /^ddjpeg:((?:degen|demon)_\d{4}):([1-9A-HJ-NP-Za-km-z]{32,44})(?::(\d{1,3}))?$/;

export const isJpegMemo = (m) => typeof m === "string" && m.startsWith(JPEG_MEMO);
/** → [{ design, vessel }] in memo order (unreadable ddjpeg memos are returned in .bad) */
export function parseJpegMemos(memos) {
  const out = [], bad = [];
  for (const m of memos || []) { if (!isJpegMemo(m)) continue; const x = MEMO_RE.exec(m); if (x) out.push({ design: x[1], vessel: x[2], trade: x[3] ? +x[3] : 0 }); else bad.push(m); }
  out.bad = bad;
  return out;
}
/** the design's price in raw ORE (BigInt, 11 decimals), or null when it is not on the wall */
export const jpegPriceRaw = (design) => (Object.prototype.hasOwnProperty.call(POOL, design) ? BigInt(POOL[design]) : null);
export const onWall = (design) => jpegPriceRaw(design) != null;
export const wallSize = () => Object.keys(POOL).length;

/** Why this NFT can't carry a JPEG for `payer` (null = it can). `a` = a DAS asset. */
export function vesselProblem(a, payer) {
  if (!a) return "that NFT wasn't found";
  if (a.burnt) return "that NFT is burned";
  const g = (a.grouping || []).find((x) => x.group_key === "collection" && x.verified !== false);
  if (!g || g.group_value !== RD_COLL) return "only a Rugged Dojo NFT can carry a JPEG into Degen Dojo";
  if (a.ownership?.owner !== payer) return "the paying wallet doesn't hold that Rugged Dojo NFT in its own wallet (listed or staked pieces can't carry a JPEG)";
  // a programmable NFT (every Rugged Dojo piece) is ALWAYS "frozen" at the token level — that is how pNFTs work; listed or
  // staked shows as a delegate. Only a plain NFT that is frozen is really locked.
  if (a.ownership?.delegated || (a.ownership?.frozen && a.interface !== "ProgrammableNFT")) return "that Rugged Dojo NFT is listed or locked — unlist it first";
  return null;
}

/**
 * Decide a ddjpeg payment (pure apart from the injected readers).
 *   ore: raw ORE (BigInt) that reached the Treasury · memos: the tx's memos · assetOf(mint) → DAS asset (fresh) or null
 *   holder: true when the payer holds a Degen Dojo card right now (→ holder prices)
 *   credits: the payer's unused trade-in credits right now (applyJpeg takes them atomically)
 * → { kind: "jpeg", holder, orders: [{ design, vessel, price, full }], refused: [{ design, vessel, reason, raw }], refundRaw, leftover }
 * Prices are taken in memo order. If any order is refused, the ORE not used by the accepted ones is refunded; if all
 * went through, ORE beyond their prices is a tip to the Reserve. No order accepted = the whole payment is refunded.
 */
export async function decideJpegOrders({ ore, memos, payer, assetOf, holder = false, credits = 0, off = null }) {
  const pct = off != null ? pctOf(off) : pctOf(holder);   // the holder (+ repeat) discount for this payer
  const asked = parseJpegMemos(memos), orders = [], refused = [];
  const seenD = new Set(), seenV = new Set();
  let left = BigInt(ore), cr = Math.max(0, Math.floor(credits) || 0);
  for (const { design, vessel, trade: asks = 0 } of asked) {
    const full = jpegPriceRaw(design);
    const trade = full == null ? 0 : Math.min(asks, maxTradeIns(full)), price = full == null ? null : dueRaw(full, trade, pct);
    const no = (reason) => refused.push({ design, vessel, reason, raw: "0" });
    if (price == null) { no("that JPEG isn't on the wall (taken, or not a JPEG DOJO fighter)"); continue; }
    if (seenD.has(design)) { no("the same JPEG twice in one payment"); continue; }
    if (seenV.has(vessel)) { no("the same Rugged Dojo NFT twice in one payment"); continue; }
    const why = vesselProblem(await assetOf(vessel), payer);
    if (why) { no(why); continue; }
    if (trade > cr) { no("not enough trade-in credit on this wallet (send the Rugged Dojo pieces first)"); continue; }
    if (left < price) { no(holder ? "the payment didn't cover this JPEG" : "the payment didn't cover this JPEG (the holder price needs a Degen Dojo card in the paying wallet)"); continue; }
    left -= price; cr -= trade; seenD.add(design); seenV.add(vessel);
    orders.push({ design, vessel, price: price.toString(), ...(pct || trade ? { full: full.toString() } : {}), ...(trade ? { trade } : {}) });
  }
  // what's left after the accepted orders: refunded when anything asked for was refused (it was meant for that),
  // a tip to the Reserve when every order went through (like a repair's leftover)
  const refusedAny = refused.length > 0 || (asked.bad || []).length > 0 || !asked.length;
  return { kind: "jpeg", holder: !!holder, ...(pct ? { off: pct } : {}), orders, refused, refundRaw: refusedAny ? left.toString() : "0", leftover: refusedAny ? "0" : left.toString(), bad: asked.bad };
}
