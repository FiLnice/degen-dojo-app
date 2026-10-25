// Netlify Function: /api/dd-listings — the DD ORE/SKR/USDC AuctionHouse listing index.
//   POST { mint, seller, currency, price, priceBaseUnits, tradeState, tokenAccount? } → record a listing.
//        Nothing the client sends is trusted. The server re-derives the seller trade-state PDA from
//        (seller, house-for-currency, token account, treasury mint, mint, price, size=1) exactly as
//        dojo-ah.js / the AuctionHouse program do, and requires that the claimed tradeState IS that PDA,
//        that it exists on-chain owned by the AuctionHouse program, and that the seller's token account
//        still holds the mint. Name + image come from DAS (getAsset), never from the client, and are
//        length-capped and stripped of control/markup characters. A client `name` field is ignored.
//   GET  → the live listings. Every stored record is re-checked on each GET: the PDA is re-derived
//          from the stored fields (drops any forged/legacy record), the trade state must still exist
//          and be AuctionHouse-owned (a sold/cancelled listing's trade state is closed), and the seller
//          must still hold the NFT. Anything that fails is pruned and never served. Feed caps: one listing
//          per NFT (the newest), at most SELLER_CAP NFTs per seller (see capListings / admitListing).
// Storage: Netlify Blobs ("dd-listings", keyed by tradeState). Env: SOLANA_RPC (DAS-capable).
// Self-contained on purpose (base58 + PDA derivation + ed25519 on-curve check inline): the store's
// function bundle ships no @solana/web3.js. The PDA code is regression-tested against web3.js.
import { limited } from "./store-ratelimit-core.mjs";
import { getStore } from "@netlify/blobs";
import { createHash } from "node:crypto";
import { minInCurrency, LIST_SLACK, BUY_SLACK, FLOOR_COLLECTION, collectionOf, MIN_SALE_BU } from "./store-min-core.mjs";
import { dojoOf, isLookalike } from "./store-genuine-core.mjs";

// ── constants (must match dojo-ah.js) ──────────────────────────────────────────────────────────
export const AH_PROGRAM = "hausS13jsjafwWwGqZTUQRmWyvyxn9EQpqMwV1PBBmk";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
export const HOUSES = {
  ORE:  { house: "7jAwmzBpVLL9ntSZWRFTvNXZztJJhk84HxGznq1Q3U8Y", mint: "oreoU2P8bN6jkk3jbaiVxYnG1dCXcYxwhwyK9jSybcp", decimals: 11 },
  SKR:  { house: "EfeSbHoNsXxKFRjMmNpFPNnUDYE2QmkQ5ugxvtQzCE6C", mint: "SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3", decimals: 6 },
  USDC: { house: "GnbcBGfDLe3S2QaKwSPGwiJ6SoU8qzdkYAPdzTLfn1Ft", mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", decimals: 6 },
};
// The store is ORE-only (owner decision): new listings and the served feed are ORE. SKR / USDC stay in HOUSES only so
// old records still re-derive (recordConsistent) instead of being mistaken for forgeries.
export const ACTIVE = new Set(["ORE"]);
const SIZE = 1n;                         // dojo-ah.js always lists size 1
const U64_MAX = (1n << 64n) - 1n;
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const NAME_MAX = 64, IMAGE_MAX = 512;

const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store", "access-control-allow-origin": "*" } });
const store = () => getStore({ name: "dd-listings", consistency: "strong" });
async function rpc(method, params) {
  const r = await fetch(process.env.SOLANA_RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error("rpc " + method + ": " + (j.error.message || "error"));
  return j.result;
}

// ── base58 ─────────────────────────────────────────────────────────────────────────────────────
const ALPH = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function b58decode(s) {
  let n = 0n;
  for (const c of s) { const i = ALPH.indexOf(c); if (i < 0) throw new Error("bad base58"); n = n * 58n + BigInt(i); }
  const out = [];
  while (n > 0n) { out.unshift(Number(n & 255n)); n >>= 8n; }
  for (const c of s) { if (c === "1") out.unshift(0); else break; }
  return Uint8Array.from(out);
}
export function b58encode(bytes) {
  let n = 0n; for (const b of bytes) n = (n << 8n) | BigInt(b);
  let s = ""; while (n > 0n) { s = ALPH[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b === 0) s = "1" + s; else break; }
  return s;
}
export function pk(s) {
  if (typeof s !== "string" || !B58.test(s)) throw new Error("bad pubkey");
  const b = b58decode(s); if (b.length !== 32) throw new Error("bad pubkey length");
  return b;
}

// ── ed25519 on-curve check (same rule as web3.js / noble: decompressible point) ─────────────────
const P = (1n << 255n) - 19n;
const D = 37095705934669439343138083508754565189542113879843219016388785533085940283555n;
const SQRT_M1 = 19681161376707505956807079304988542015446066515923890162744021073123829784752n;
const md = (a) => { const r = a % P; return r >= 0n ? r : r + P; };
function pw(b, e) { let r = 1n; b = md(b); while (e > 0n) { if (e & 1n) r = (r * b) % P; b = (b * b) % P; e >>= 1n; } return r; }
export function isOnCurve(bytes) {
  const last = bytes[31];
  let y = 0n; for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(i === 31 ? last & 0x7f : bytes[i]);
  if (y >= P) return false;
  const y2 = (y * y) % P, u = md(y2 - 1n), v = md(D * y2 + 1n);
  const v3 = (v * v % P) * v % P, v7 = (v3 * v3 % P) * v % P;
  let x = (u * v3 % P) * pw(u * v7 % P, (P - 5n) / 8n) % P;
  const vx2 = (v * x % P) * x % P;
  const root1 = vx2 === u, root2 = vx2 === md(-u);
  if (!root1 && !root2) return false;
  if (root2) x = (x * SQRT_M1) % P;
  if (x === 0n && (last & 0x80)) return false;
  return true;
}
function createPda(seeds, program) {
  const h = createHash("sha256");
  for (const s of seeds) h.update(s);
  h.update(program); h.update(Buffer.from("ProgramDerivedAddress"));
  const d = new Uint8Array(h.digest());
  return isOnCurve(d) ? null : d;
}
export function findPda(seeds, programB58) {
  const prog = pk(programB58);
  for (let bump = 255; bump >= 0; bump--) { const a = createPda([...seeds, Uint8Array.of(bump)], prog); if (a) return [b58encode(a), bump]; }
  throw new Error("no viable bump");
}
const utf8 = (s) => Buffer.from(s, "utf8");
const u64le = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
export const ataOf = (owner, mint) => findPda([pk(owner), pk(TOKEN_PROGRAM), pk(mint)], ATA_PROGRAM)[0];
export const tradeStateOf = (seller, house, tokenAccount, treasuryMint, mint, priceBU, size = SIZE) =>
  findPda([utf8("auction_house"), pk(seller), pk(house), pk(tokenAccount), pk(treasuryMint), pk(mint), u64le(priceBU), u64le(size)], AH_PROGRAM)[0];

// ── price: exactly dojo-ah.js priceToBaseUnits, plus the canonical inverse ───────────────────────
export function priceToBaseUnits(price, decimals) {
  const s = String(price);
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error("bad price");
  const [whole, f = ""] = s.split(".");
  const frac = f.slice(0, decimals).padEnd(decimals, "0");
  return BigInt(whole) * (10n ** BigInt(decimals)) + BigInt(frac || "0");
}
function formatUnits(bu, decimals) {
  const s = bu.toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals), frac = s.slice(s.length - decimals).replace(/0+$/, "");
  return frac ? whole + "." + frac : whole;
}

// ── sanitising DAS-derived display fields ─────────────────────────────────────────────────────
// Control chars, bidi overrides, zero-widths, line/paragraph separators, and markup/quote characters
// are removed outright (names are display-only). Clients ALSO escape — this is defence in depth for
// any cached old page that still used innerHTML.
export function cleanName(s) {
  const t = String(s ?? "").normalize("NFC")
    .replace(/[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2069\ufeff]/g, "")
    .replace(/[<>"'`\\]/g, "")
    .replace(/\s+/g, " ").trim();
  return Array.from(t).slice(0, NAME_MAX).join("");
}
export function cleanImage(u) {
  if (typeof u !== "string" || !u || u.length > IMAGE_MAX) return "";
  let url; try { url = new URL(u.trim()); } catch { return ""; }
  if (url.protocol !== "https:" || url.username || url.password) return "";
  const href = url.href;
  return href.length <= IMAGE_MAX && !/["'<>\\`\s]/.test(href) ? href : "";
}
const dasName = (a) => cleanName(a && a.content && a.content.metadata && a.content.metadata.name);
const dasImage = (a) => { const c = (a && a.content) || {}; const f = (c.files && c.files[0]) || {}; return cleanImage((c.links && c.links.image) || "") || cleanImage(f.cdn_uri || "") || cleanImage(f.uri || ""); };

// The only fields ever served, in the original response shape (+ image, tokenAccount).
function publicView(r) {
  return { mint: r.mint, seller: r.seller, currency: r.currency, price: r.price, priceBaseUnits: r.priceBaseUnits,
    tradeState: r.tradeState, tokenAccount: r.tokenAccount, name: cleanName(r.name), image: cleanImage(r.image || ""), listedAt: r.listedAt,
    dojo: r.dojo || null };   // "Degen Dojo" | "Demon Dojo" | "TETO" for our verified collections, else null
}

// Pure structural re-check of a stored record (no RPC): the PDA must re-derive from its own fields.
export function recordConsistent(r) {
  try {
    const h = HOUSES[r.currency]; if (!h) return false;
    for (const k of ["mint", "seller", "tradeState", "tokenAccount"]) pk(r[k]);
    const bu = BigInt(r.priceBaseUnits); if (bu <= 0n || bu > U64_MAX) return false;
    if (priceToBaseUnits(String(r.price), h.decimals) !== bu) return false;
    return tradeStateOf(r.seller, h.house, r.tokenAccount, h.mint, r.mint, bu) === r.tradeState;
  } catch { return false; }
}

// Live check of a token account (jsonParsed) — seller still holds the mint.
function holds(acc, seller, mint) {
  const p = acc && acc.owner === TOKEN_PROGRAM && acc.data && acc.data.parsed;
  const info = p && p.type === "account" && p.info;
  if (!info || info.mint !== mint || info.owner !== seller) return false;
  try { return BigInt(info.tokenAmount && info.tokenAmount.amount) >= SIZE; } catch { return false; }
}
const tradeStateLive = (acc) => !!(acc && acc.owner === AH_PROGRAM && acc.lamports > 0 && Array.isArray(acc.data) && Buffer.from(acc.data[0] || "", "base64").length >= 1);

export class ListingError extends Error { constructor(msg, status = 400) { super(msg); this.status = status; } }

/** Validate a client listing claim against chain state. Returns the record to store, or throws ListingError. */
export async function verifyListing(d, rpcFn = rpc, minFn = minInCurrency) {
  const { mint, seller, currency, tradeState } = d || {};
  const h = HOUSES[currency];
  if (!h) throw new ListingError("bad currency");
  if (!ACTIVE.has(currency)) throw new ListingError("the marketplace is ORE-only — list in ORE");
  try { pk(mint); pk(seller); pk(tradeState); } catch { throw new ListingError("bad fields"); }
  // price → base units, then the canonical human price every client re-derives the same PDA from.
  let bu;
  try {
    const fromPrice = d.price != null ? priceToBaseUnits(String(d.price), h.decimals) : null;
    const claimed = d.priceBaseUnits != null && d.priceBaseUnits !== "" ? (/^\d{1,20}$/.test(String(d.priceBaseUnits)) ? BigInt(String(d.priceBaseUnits)) : null) : fromPrice;
    if (claimed == null || (fromPrice != null && fromPrice !== claimed)) throw 0;
    bu = claimed;
  } catch { throw new ListingError("bad price"); }
  if (bu <= 0n || bu > U64_MAX) throw new ListingError("bad price");
  if (MIN_SALE_BU[currency] && bu < MIN_SALE_BU[currency]) throw new ListingError(`the lowest price on this market is ${formatUnits(MIN_SALE_BU[currency], h.decimals)} ${currency}`);
  const price = Number(formatUnits(bu, h.decimals));
  if (!(price > 0) || priceToBaseUnitsSafe(price, h.decimals) !== bu) throw new ListingError("price not representable");

  // token account: ONLY the seller's ATA. execute_sale asserts the seller's token account is their ATA
  // (assert_is_ata), so a listing from any other token account could never be bought — a dead row in the feed.
  const tokenAccount = ataOf(seller, mint);
  if (d.tokenAccount != null && d.tokenAccount !== "") { try { pk(d.tokenAccount); } catch { throw new ListingError("bad tokenAccount"); }
    if (d.tokenAccount !== tokenAccount) throw new ListingError("this NFT isn't in your main (associated) token account, so it could never be bought — move it to your wallet's main account and list again"); }
  if (tradeStateOf(seller, h.house, tokenAccount, h.mint, mint, bu) !== tradeState) throw new ListingError("trade state does not match this seller/house/mint/price");

  const res = await rpcFn("getMultipleAccounts", [[tradeState, tokenAccount], { encoding: "jsonParsed", commitment: "confirmed" }]);
  const [tsAcc, taAcc] = (res && res.value) || [];
  if (!tsAcc) throw new ListingError("trade state not found on-chain — listing not confirmed yet", 409);
  if (!tradeStateLive(tsAcc)) throw new ListingError("trade state is not an AuctionHouse account");
  if (!holds(taAcc, seller, mint)) throw new ListingError("seller does not hold this NFT");

  // FAIL CLOSED: without the DAS record we can't tell a Degen (floor) or a look-alike (refused) from anything else, so
  // a DAS error is "try again", never "record it as some other collection" (that record would be served forever).
  let asset = null;
  for (let i = 0; i < 2 && !asset; i++) { try { const a = await rpcFn("getAsset", { id: mint }); if (a && a.id) asset = a; } catch {} }
  if (!asset) throw new ListingError("couldn't confirm this NFT right now — try again in a minute", 409);
  const name = dasName(asset), image = dasImage(asset), collection = collectionOf(asset), dojo = dojoOf(asset);
  // A look-alike (copies our name, collection name, creator wallets or art without being ours) is never listed here.
  if (isLookalike(asset)) throw new ListingError("this NFT copies Degen Dojo but isn't one of ours — it can't be listed here");
  // The Degen Dojo floor: 1.5 SOL in this currency at today's price (Degens only). No price at all → try again.
  if (collection === FLOOR_COLLECTION) {
    const min = await minFn(currency);
    if (!min) throw new ListingError("the price feed is unavailable, so the Degen Dojo minimum can't be checked — try again in a minute", 503);
    if (price < min * LIST_SLACK) throw new ListingError(`below the Degen Dojo minimum (${min.toFixed(3)} ${currency} ≈ 1.5 SOL)`);
  }
  return { v: 2, mint, seller, currency, price, priceBaseUnits: bu.toString(), tradeState, tokenAccount, name, image, collection, collChecked: true, dojo,
    listedAt: (res && res.context && res.context.slot) || null };
}
function priceToBaseUnitsSafe(p, dec) { try { return priceToBaseUnits(String(p), dec); } catch { return -1n; } }

// ── FEED CAPS (anti-spam) ──────────────────────────────────────────────────────────────────────
// Every listing already needs a real on-chain trade state (rent) and the NFT in the seller's wallet, but one wallet
// could still flood the feed by re-listing the same NFT at many prices, or by listing a pile of cheap NFTs. So:
//   · the feed shows ONE listing per NFT — the newest (highest listedAt slot) of its live listings; a POST that
//     re-lists an NFT also drops the seller's older stored records for it (their trade states may still be open
//     on-chain, but the seller's latest price is the one shown);
//   · a seller shows at most SELLER_CAP NFTs — their newest; a POST that would add a NEW NFT beyond SELLER_CAP
//     stored ones is refused (429). Re-listing an NFT they already list is always allowed.
export const SELLER_CAP = 100;
const newer = (a, b) => (a.listedAt || 0) - (b.listedAt || 0) || (a.tradeState < b.tradeState ? -1 : a.tradeState > b.tradeState ? 1 : 0);
export function capListings(recs, { perSeller = SELLER_CAP } = {}) {
  const byMint = new Map();
  for (const r of recs) { const p = byMint.get(r.mint); if (!p || newer(r, p) > 0) byMint.set(r.mint, r); }
  const bySeller = new Map();
  for (const r of byMint.values()) { if (!bySeller.has(r.seller)) bySeller.set(r.seller, []); bySeller.get(r.seller).push(r); }
  const out = [];
  for (const list of bySeller.values()) out.push(...list.sort((a, b) => newer(b, a)).slice(0, perSeller));
  return out;
}
/** POST gate: may `rec` be stored next to these stored records? → { ok, replace: [tradeState…] } (older records of
 *  the same seller + NFT, to delete) or { ok:false } when it would be the seller's (SELLER_CAP+1)th NFT. */
export function admitListing(rec, stored, { perSeller = SELLER_CAP } = {}) {
  const mine = stored.filter((r) => r && r.seller === rec.seller && r.tradeState !== rec.tradeState);
  const replace = mine.filter((r) => r.mint === rec.mint).map((r) => r.tradeState);
  if (replace.length) return { ok: true, replace };
  return new Set(mine.map((r) => r.mint)).size >= perSeller ? { ok: false, replace: [] } : { ok: true, replace: [] };
}

/** Filter stored records down to the ones still live on-chain. Returns { live, dead }. */
export async function liveListings(recs, rpcFn = rpc) {
  const live = [], dead = [];
  const ok = [];
  for (const r0 of recs) {
    const r = r0 && !r0.tokenAccount && r0.seller && r0.mint ? (() => { try { return { ...r0, tokenAccount: ataOf(r0.seller, r0.mint) }; } catch { return r0; } })() : r0;
    if (r && recordConsistent(r)) ok.push(r); else dead.push(r0);
  }
  for (let i = 0; i < ok.length; i += 50) {
    const chunk = ok.slice(i, i + 50);
    const keys = chunk.flatMap((r) => [r.tradeState, r.tokenAccount]);
    const res = await rpcFn("getMultipleAccounts", [keys, { encoding: "jsonParsed", commitment: "confirmed" }]);
    const vals = res && res.value;
    if (!Array.isArray(vals) || vals.length !== keys.length) throw new Error("rpc returned no account data");
    chunk.forEach((r, k) => {
      if (tradeStateLive(vals[2 * k]) && holds(vals[2 * k + 1], r.seller, r.mint)) live.push(r); else dead.push(r);
    });
  }
  // Legacy (pre-v2) records carried a client-supplied name: replace it with DAS (once), or blank it.
  const legacy = live.filter((r) => r.v !== 2);
  if (legacy.length) {
    let assets = [];
    try { assets = (await rpcFn("getAssetBatch", { ids: legacy.map((r) => r.mint) })) || []; } catch {}
    const byId = new Map(assets.filter((a) => a && a.id).map((a) => [a.id, a]));
    for (const r of legacy) { const a = byId.get(r.mint); r.name = a ? dasName(a) : ""; r.image = a ? dasImage(a) : ""; if (a) { r.v = 2; r._dirty = true; } }
  }
  return { live, dead };
}

export default async (request) => {
  const blocked = limited(request, "dd-listings", 60); if (blocked) return blocked;   // 60 / minute / IP (DD-04)
  if (request.method === "POST") {
    let d; try { d = await request.json(); } catch { return json({ error: "bad json" }, 400); }
    let rec;
    try { rec = await verifyListing(d); }
    catch (e) { return json({ error: e instanceof ListingError ? e.message : "could not verify the listing right now" }, e instanceof ListingError ? e.status : 502); }
    const s = store();
    const stored = [];
    for (const b of (await s.list()).blobs) { const r = await s.get(b.key, { type: "json" }); if (r) stored.push(r); }
    const gate = admitListing(rec, stored);
    if (!gate.ok) return json({ error: `you already have ${SELLER_CAP} NFTs listed here — delist one first` }, 429);
    await s.setJSON(rec.tradeState, rec);
    for (const ts of gate.replace) s.delete(ts).catch(() => {});   // the seller's older price for this NFT
    return json({ ok: true, listing: publicView(rec) });
  }

  // GET → verify every stored listing against chain, drop the dead ones.
  const s = store();
  const { blobs } = await s.list();
  const recs = [];
  for (const b of blobs) { const r = await s.get(b.key, { type: "json" }); if (r) recs.push(r); }
  if (!recs.length) return json({ listings: [] });
  let out;
  try { out = await liveListings(recs); }
  catch { return json({ listings: [], error: "chain unavailable" }, 502); }   // fail closed: never serve unverified
  for (const r of out.dead) if (r && r.tradeState) s.delete(r.tradeState).catch(() => {});   // sold/cancelled/forged → prune
  for (const r of out.live) if (r._dirty) { delete r._dirty; s.setJSON(r.tradeState, r).catch(() => {}); }
  // Hide Degen Dojo listings now under the floor (the currency fell against SOL): the co-signer won't sign them,
  // so a buyer would only hit a refusal. Kept in the store — they come back if the price recovers.
  // records whose collection was never confirmed by DAS (made before the collection was stored, or stored as "" by the
  // old fail-open POST during a DAS error): look it up once; until it's known the listing is NOT served (it could be a
  // below-floor Degen or a look-alike).
  const unknown = out.live.filter((r) => r.collection === undefined || (r.collection === "" && !r.collChecked));
  const unresolved = new Set();
  if (unknown.length) {
    let assets = []; try { assets = (await rpc("getAssetBatch", { ids: unknown.map((r) => r.mint) })) || []; } catch {}
    const byId = new Map(assets.filter((a) => a && a.id).map((a) => [a.id, a]));
    for (const r of unknown) { const a = byId.get(r.mint); if (!a) { unresolved.add(r.tradeState); continue; }
      r.collection = collectionOf(a); r.collChecked = true; r.dojo = dojoOf(a); r.lookalike = isLookalike(a); s.setJSON(r.tradeState, r).catch(() => {}); }   // remember it
  }
  // only ORE listings from the seller's ATA are buyable (execute_sale asserts the ATA); the rest stay stored, not served
  out.live = capListings(out.live.filter((r) => !r.lookalike && !unresolved.has(r.tradeState) && ACTIVE.has(r.currency) && r.tokenAccount === ataOf(r.seller, r.mint)));
  const mins = {}; for (const c of new Set(out.live.map((r) => r.currency))) mins[c] = await minInCurrency(c);
  // a Degen is served only while its price is above the floor (with the buy slack) — and not at all while there is no price
  const buyable = out.live.filter((r) => r.collection !== FLOOR_COLLECTION || (mins[r.currency] && r.price >= mins[r.currency] * BUY_SLACK));
  const listings = buyable.map(publicView).sort((a, b) => a.price - b.price);
  return json({ listings });
};

export const config = { path: "/api/dd-listings" };
