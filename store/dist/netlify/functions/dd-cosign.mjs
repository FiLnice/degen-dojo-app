// Netlify Function: /api/dd-cosign — the marketplace COSIGNER for pNFT buys.
//
// pNFT sales on the AuctionHouse need the house AUTHORITY to co-sign execute_sale
// (Metaplex constraint). The authority is a DEDICATED low-privilege key (NOT the update
// authority) held here in COSIGNER_SECRET. The buyer signs first in their wallet, posts
// the tx here; we VALIDATE that the cosigner's signature can only reach our own AuctionHouse
// buy/execute_sale on one of our three houses — no other instruction may reference the cosigner,
// because a signature covers the whole tx and any program handed the account could CPI into the
// AuctionHouse admin calls (authority change, fee withdraw, …). Then we sign and submit.
//
// Deliberately web3.js-free — it parses the transaction wire format and signs with Node's
// built-in ed25519 (crypto), so it bundles reliably as a Netlify function. Only dep: bs58.
//
// Env: COSIGNER_SECRET (base58 or JSON-array 64-byte secret key), SOLANA_RPC (Helius URL).
import { limited } from "./store-ratelimit-core.mjs";
import bs58 from "bs58";
import { createPrivateKey, createPublicKey, sign as edSign, verify as edVerify } from "crypto";
import { minInCurrency, BUY_SLACK, FLOOR_COLLECTION, collectionOf, MIN_SALE_BU } from "./store-min-core.mjs";
import { isLookalike } from "./store-genuine-core.mjs";

const AH = "hausS13jsjafwWwGqZTUQRmWyvyxn9EQpqMwV1PBBmk";
// The store is ORE-only (owner decision), so the co-signer's signature is only ever lent to a buy/execute_sale on the
// ORE house. The SKR / USDC houses still exist on-chain (their fee accounts are empty) but are never co-signed.
const HOUSE_CUR = {   // house → its currency (treasury mint) + fee account, for the exact-schema check, the floor and rent
  "7jAwmzBpVLL9ntSZWRFTvNXZztJJhk84HxGznq1Q3U8Y": { code: "ORE", decimals: 11, mint: "oreoU2P8bN6jkk3jbaiVxYnG1dCXcYxwhwyK9jSybcp", feeAccount: "5cKyg3wmG1P6fyAj7W21KKv58a1Hkmzp3sNyKA2UJBxn",
    minSale: MIN_SALE_BU.ORE },   // 0.001 ORE — no dust-priced sales, whatever the collection
};
const HOUSES = new Set(Object.keys(HOUSE_CUR));
// HOUSE RENT. When the authority co-signs, the AuctionHouse makes the house FEE ACCOUNT pay for every account the sale
// has to create (utils.rs get_fee_payer): the buyer's escrow (bid), the seller's payment ATA, the buyer's NFT ATA, every
// creator ATA (pay_creator_fees, even 0-share creators) and the buyer's pNFT token record (TokenMetadata transfer
// payer). Those accounts then belong to the buyer / seller / creators, so a junk pNFT with fresh wallets could drain the
// fee account and stop every store sale. So every co-signed sale must REFUND that rent in the same transaction: one
// System transfer buyer → fee account, before the buy, of at least what this co-signer computes from chain state.
const TOKEN_ACCOUNT_LEN = 165, TOKEN_RECORD_LEN = 80;
const MAX_REFUND = 50_000_000;            // lamports — far above the worst case (~13M today), refuses a broken client
const FEE_LOW = 20_000_000;               // alert under 0.02 SOL (the account must also hold the bid's trade-state rent transiently)
const RPC_TIMEOUT = 8000;
const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111";
const BUY_DISC = [102, 6, 61, 18, 1, 218, 235, 234];
const EXEC_DISC = [37, 74, 217, 157, 79, 49, 35, 6];
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

// ── DD-15 hardening: the ONLY transaction this co-signer accepts is the store's pNFT buy (dojo-ah.js buildBuyIxs) ──
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", SYSTEM = "11111111111111111111111111111111";
const RENT = "SysvarRent111111111111111111111111111111111", ATA_PROG = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const META = "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s", AUTH_RULES = "auth9SigNpDKz4sJJ1DfCTuZrZNSAgh9sFD3rboVmgg";
const SYSVAR_IX = "Sysvar1nstructions1111111111111111111111111";
const AH_SIGNER = "HS2eL9WJbh7pA4i4veK3YDwhGLRjY3uKryvG1NbHRprj";   // PDA ["auction_house","signer"] of the AuctionHouse program
const ALT_PROGRAM = "AddressLookupTab1e1111111111111111111111111";
const MEMO_V2 = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr", MEMO_V1 = "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo";
const LIGHTHOUSE = "L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95";   // assertion-only guards Phantom appends when it signs
// Programs a buy may contain, and how many of each: AuctionHouse exactly [buy, execute_sale]; ComputeBudget only
// its own settings (each kind once, no accounts); at most 2 short text memos (the "ddref:" referral); Lighthouse
// guards. Anything else is refused — this signature is only ever lent to a recognised buy.
const CB_DATA_LEN = { 0: 9, 1: 5, 2: 5, 3: 9, 4: 5 };   // RequestUnits(old), RequestHeapFrame, SetComputeUnitLimit, SetComputeUnitPrice, SetLoadedAccountsDataSizeLimit
const MAX_MEMOS = 2, MAX_MEMO_BYTES = 128, MAX_LIGHTHOUSE = 12, MAX_LIGHTHOUSE_DATA = 512;
const BUY_DATA_LEN = 26, EXEC_DATA_LEN = 27, BUY_ACCOUNTS = 14, EXEC_FIXED = 21, PNFT_TAIL = 7, MAX_CREATORS = 5;
const MAX_TX_BYTES = 1232, MAX_TX_B64 = 1700, MAX_ALTS = 2, MAX_ACCOUNTS = 128;

// Strict compact-u16 (Solana shortvec): ≤ 3 bytes, canonical (no superfluous continuation), never past the end.
class Refuse extends Error {}
const readCU16 = (b, o) => {
  let v = 0;
  for (let k = 0; k < 3; k++) {
    if (o + k >= b.length) throw new Refuse("truncated transaction");
    const x = b[o + k];
    v |= (x & 0x7f) << (7 * k);
    if ((x & 0x80) === 0) {
      if (k > 0 && x === 0) throw new Refuse("non-canonical length encoding");
      if (v > 0xffff) throw new Refuse("bad length");
      return [v, o + k + 1];
    }
  }
  throw new Refuse("bad length encoding");
};
const take = (b, o, n) => { if (n < 0 || o + n > b.length) throw new Refuse("truncated transaction"); return b.slice(o, o + n); };
const encCU16 = (n) => { const out = []; for (;;) { let b = n & 0x7f; n >>= 7; if (n) out.push(b | 0x80); else { out.push(b); break; } } return Buffer.from(out); };
const b58 = (bytes) => bs58.encode(bytes);

async function rpcCall(rpc, method, params) {
  const r = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(RPC_TIMEOUT) });
  const j = await r.json();   // a 429 / HTML error page is not JSON → throws
  if (j.error) throw new Error(method + ": " + (j.error.message || "rpc error"));
  return j.result;
}
async function getAccount(rpc, pubkeyB58) {
  const res = await rpcCall(rpc, "getAccountInfo", [pubkeyB58, { encoding: "base64" }]);
  return res && res.value;
}

// The NFT's DAS record, tried twice; null when DAS is unavailable (the caller then reads the Metadata account itself).
async function assetOf(rpc, mint) {
  for (let i = 0; i < 2; i++) {
    try { const a = await rpcCall(rpc, "getAsset", { id: mint }); if (a && a.id) return a; } catch {}
    if (!i) await new Promise((ok) => setTimeout(ok, 400));
  }
  return null;
}
// Fallback when DAS is down: the same facts from the on-chain Metadata account — name, uri, creators and the VERIFIED
// collection (what DAS `grouping` reports). Shaped like a DAS asset so the floor + look-alike rules read it unchanged.
// The account is the execute_sale's metadata slot; AuctionHouse itself checks it is this mint's metadata, so a fake
// one only makes the transaction fail on-chain. null when it can't be read either → the caller refuses.
export function assetFromMetadata(mint, b) {
  let o = 1 + 32 + 32;
  const str = () => { const n = b.readUInt32LE(o); o += 4; const s = b.subarray(o, o + n).toString("utf8").replace(/\0+$/, ""); o += n; return s; };
  const name = str(); str(); const uri = str();
  o += 2;   // seller fee bps
  const creators = [];
  if (b[o++]) { const n = b.readUInt32LE(o); o += 4; for (let k = 0; k < n; k++) { creators.push({ address: bs58.encode(b.subarray(o, o + 32)), verified: !!b[o + 32], share: b[o + 33] }); o += 34; } }
  o += 2;                                // primary sale happened, is mutable
  if (b[o++]) o += 1;                    // edition nonce
  if (b[o++]) o += 1;                    // token standard
  let grouping = [];
  if (b[o++]) { const verified = !!b[o]; const key = bs58.encode(b.subarray(o + 1, o + 33)); if (verified) grouping = [{ group_key: "collection", group_value: key }]; }
  return { id: mint, content: { metadata: { name: name.trim() }, json_uri: uri.trim(), links: {}, files: [] }, creators, grouping, _fromMetadata: true };
}
async function metadataAsset(rpc, mint, metadataKey) {
  try {
    const acc = await getAccount(rpc, metadataKey);
    if (!acc || acc.owner !== META) return null;
    return assetFromMetadata(mint, Buffer.from(acc.data[0], "base64"));
  } catch { return null; }
}

// Rent a co-signed sale makes the house fee account pay, from live chain state: every account it must create that
// doesn't exist yet (full rent-exempt minimum, from the Rent sysvar). Also returns the fee account's balance.
export async function houseRent(rpcFn, { feeAccount, escrow, sellerPayAta, buyerNftAta, creatorAtas, destTokenRecord }) {
  const keys = [RENT, feeAccount, escrow, sellerPayAta, buyerNftAta, destTokenRecord, ...creatorAtas];
  const res = await rpcFn("getMultipleAccounts", [keys, { encoding: "base64", commitment: "confirmed" }]);
  const v = res && res.value;
  if (!Array.isArray(v) || v.length !== keys.length || !v[0]) throw new Error("chain unavailable");
  const rs = Buffer.from(v[0].data[0], "base64");
  if (rs.length < 16) throw new Error("bad rent sysvar");
  const perByteYear = rs.readBigUInt64LE(0), threshold = rs.readDoubleLE(8);
  const rentOf = (len) => Math.ceil(Number((128n + BigInt(len)) * perByteYear) * threshold);
  const empty = (a) => !a || !a.data || Buffer.from(a.data[0] || "", "base64").length === 0;
  let owed = 0;
  [[2, TOKEN_ACCOUNT_LEN], [3, TOKEN_ACCOUNT_LEN], [4, TOKEN_ACCOUNT_LEN], [5, TOKEN_RECORD_LEN]].forEach(([i, len]) => { if (empty(v[i])) owed += rentOf(len); });
  for (let i = 6; i < keys.length; i++) if (empty(v[i])) owed += rentOf(TOKEN_ACCOUNT_LEN);
  return { owed, feeLamports: v[1] ? v[1].lamports : 0 };
}

const SPKI_ED25519 = Buffer.from("302a300506032b6570032100", "hex");
const verifySig = (pubkey32, message, sig) => { try { return edVerify(null, message, createPublicKey({ key: Buffer.concat([SPKI_ED25519, pubkey32]), format: "der", type: "spki" }), sig); } catch { return false; } };

export default async (request) => {
  const blocked = limited(request, "dd-cosign", 20); if (blocked) return blocked;   // 20 / minute / IP (DD-04)
  // GET ?status=1 — the house fee account balance (public on-chain anyway), for the payouts desk's low-balance alert.
  if (request.method === "GET" && new URL(request.url).searchParams.has("status")) {
    const rpc = process.env.SOLANA_RPC; if (!rpc) return json({ error: "SOLANA_RPC is not set" }, 500);
    const houses = {};
    for (const [house, c] of Object.entries(HOUSE_CUR)) {
      let lamports = null; try { const a = await getAccount(rpc, c.feeAccount); lamports = a ? a.lamports : 0; } catch {}
      houses[c.code] = { house, feeAccount: c.feeAccount, lamports, sol: lamports == null ? null : lamports / 1e9, low: lamports != null && lamports < FEE_LOW, lowBelowSol: FEE_LOW / 1e9 };
    }
    return json({ houses });
  }
  if (request.method !== "POST") return new Response("POST only", { status: 405 });
  const secret = process.env.COSIGNER_SECRET, rpc = process.env.SOLANA_RPC;
  if (!secret) return json({ error: "COSIGNER_SECRET is not set" }, 500);
  if (!rpc) return json({ error: "SOLANA_RPC is not set" }, 500);
  let body; try { const raw = await request.text(); if (raw.length > 4096) return json({ error: "refused: request too large" }, 413); body = JSON.parse(raw); } catch { return new Response("bad json", { status: 400 }); }
  if (!body || !body.tx) return json({ error: "missing tx" }, 400);

  // cosigner key: 64-byte secret = seed(32) + pubkey(32)
  let sk;
  try { sk = secret.trim().startsWith("[") ? Uint8Array.from(JSON.parse(secret)) : bs58.decode(secret.trim()); } catch { return json({ error: "COSIGNER_SECRET is not valid" }, 500); }
  if (sk.length !== 64) return json({ error: "COSIGNER_SECRET must be a 64-byte secret key" }, 500);
  const seed = Buffer.from(sk.slice(0, 32)), cosignerB58 = b58(Buffer.from(sk.slice(32, 64)));

  // size + encoding before anything else: canonical base64 of at most one Solana packet
  const tx64 = typeof body.tx === "string" ? body.tx : "";
  if (!tx64 || tx64.length > MAX_TX_B64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(tx64)) return json({ error: "refused: bad transaction encoding" }, 400);
  const tx = Buffer.from(tx64, "base64");
  if (tx.toString("base64") !== tx64 || tx.length > MAX_TX_BYTES) return json({ error: "refused: bad transaction encoding" }, 400);
  try {
    // ── tx wire: [compactU16 numSigs][numSigs × 64 sig][message] ──
    let o = 0, numSigs; [numSigs, o] = readCU16(tx, o);
    const sigs = []; for (let i = 0; i < numSigs; i++) { sigs.push(Buffer.from(take(tx, o, 64))); o += 64; }
    const message = tx.slice(o);   // the exact bytes each signer signs — never modified below

    // ── parse the v0 message strictly (every byte accounted for) ──
    let m = 0;
    if (message.length < 4) return json({ error: "refused: truncated transaction" }, 400);
    if ((message[m] & 0x80) === 0) return json({ error: "legacy transactions not supported" }, 400);
    if (message[m] !== 0x80) return json({ error: "refused: only v0 transactions are supported" }, 400);
    m += 1;
    const numReqSig = message[m], roSigned = message[m + 1], roUnsigned = message[m + 2]; m += 3;   // header
    // exactly two signers — the buyer (fee payer, writable) and this co-signer (read-only) — and one signature slot each
    if (numReqSig !== 2 || roSigned !== 1 || numSigs !== numReqSig) return json({ error: "refused: a buy is signed by exactly the buyer and the co-signer" }, 400);
    let numStatic; [numStatic, m] = readCU16(message, m);
    if (numStatic < 3 || numStatic > MAX_ACCOUNTS || roUnsigned > numStatic - numReqSig) return json({ error: "refused: bad account header" }, 400);
    const staticKeys = []; for (let i = 0; i < numStatic; i++) { staticKeys.push(take(message, m, 32)); m += 32; }
    // The buyer (fee payer, slot 0) signs first in their wallet. Check that signature before anything else — no RPC
    // call, no co-signature and no relay for a transaction its buyer never signed.
    if (!verifySig(Buffer.from(staticKeys[0]), message, sigs[0])) return json({ error: "refused: the buyer's signature is missing or invalid" }, 400);
    take(message, m, 32); m += 32;                      // recent blockhash
    let numIx; [numIx, m] = readCU16(message, m);
    if (numIx < 2 || numIx > 24) return json({ error: "refused: unexpected number of instructions" }, 400);
    const ixs = [];
    for (let i = 0; i < numIx; i++) {
      const programIdIndex = take(message, m, 1)[0]; m += 1;
      let nAcc; [nAcc, m] = readCU16(message, m); const accIdx = [...take(message, m, nAcc)]; m += nAcc;
      let dLen; [dLen, m] = readCU16(message, m); const data = take(message, m, dLen); m += dLen;
      ixs.push({ programIdIndex, accIdx, data });
    }
    let numAlt; [numAlt, m] = readCU16(message, m);
    if (numAlt > MAX_ALTS) return json({ error: "refused: too many lookup tables" }, 400);
    const altLookups = [];
    for (let i = 0; i < numAlt; i++) {
      const accountKey = take(message, m, 32); m += 32;
      let nW; [nW, m] = readCU16(message, m); const wIdx = take(message, m, nW); m += nW;
      let nR; [nR, m] = readCU16(message, m); const rIdx = take(message, m, nR); m += nR;
      if (!nW && !nR) return json({ error: "refused: empty lookup table entry" }, 400);
      altLookups.push({ accountKey, wIdx, rIdx });
    }
    if (m !== message.length) return json({ error: "refused: trailing bytes after the transaction" }, 400);

    // resolve the full account list (static + ALT writable + ALT readonly) to read program ids
    const altAddrs = [];
    for (const l of altLookups) {
      const acc = await getAccount(rpc, b58(l.accountKey));
      if (!acc) return json({ error: "lookup table not found on-chain" }, 400);
      if (acc.owner !== ALT_PROGRAM) return json({ error: "refused: not an address lookup table" }, 400);
      const d = Buffer.from(acc.data[0], "base64"), list = [];
      for (let p = 56; p + 32 <= d.length; p += 32) list.push(d.slice(p, p + 32));   // LookupTableMeta is 56 bytes
      altAddrs.push(list);
    }
    const wAlt = [], rAlt = [];
    for (const [li, l] of altLookups.entries()) for (const idx of l.wIdx) { if (!altAddrs[li][idx]) return json({ error: "refused: lookup index out of range" }, 400); wAlt.push(altAddrs[li][idx]); }
    for (const [li, l] of altLookups.entries()) for (const idx of l.rIdx) { if (!altAddrs[li][idx]) return json({ error: "refused: lookup index out of range" }, 400); rAlt.push(altAddrs[li][idx]); }
    const accounts = [...staticKeys, ...wAlt, ...rAlt];
    if (accounts.length > MAX_ACCOUNTS) return json({ error: "refused: too many accounts" }, 400);
    if (new Set(accounts.map((k) => b58(k))).size !== accounts.length) return json({ error: "refused: an account is listed twice" }, 400);

    // ── exact shape: only the programs a store buy uses, AuctionHouse exactly [buy, execute_sale] in that order ──
    const progOf = (ix) => (ix.programIdIndex < numStatic ? b58(accounts[ix.programIdIndex]) : null);   // programs are never loaded from a lookup table
    const keyOf = (ix, n) => b58(accounts[ix.accIdx[n]]);
    const cbSeen = new Set(); let memos = 0, guards = 0; const ahIxs = [], sysIxs = [];
    for (const ix of ixs) {
      if (ix.accIdx.some((k) => k >= accounts.length)) return json({ error: "refused: instruction references an unknown account" }, 400);
      const prog = progOf(ix);
      if (prog === AH) { ahIxs.push(ix); continue; }
      // the house-rent refund: exactly a System transfer (no other System instruction), checked against the sale below
      if (prog === SYSTEM) {
        if (sysIxs.length || ix.accIdx.length !== 2 || ix.data.length !== 12 || Buffer.from(ix.data).readUInt32LE(0) !== 2)
          return json({ error: "refused: unexpected System instruction" }, 400);
        sysIxs.push(ix); continue;
      }
      if (prog === COMPUTE_BUDGET) {
        const kind = ix.data[0];
        if (ix.accIdx.length || CB_DATA_LEN[kind] !== ix.data.length || cbSeen.has(kind)) return json({ error: "refused: unexpected compute-budget instruction" }, 400);
        cbSeen.add(kind); continue;
      }
      if (prog === MEMO_V2 || prog === MEMO_V1) {
        let text = null; try { text = new TextDecoder("utf-8", { fatal: true }).decode(ix.data); } catch {}
        if (++memos > MAX_MEMOS || !text || ix.data.length > MAX_MEMO_BYTES || /[\u0000-\u001f\u007f]/.test(text)) return json({ error: "refused: unexpected memo" }, 400);
        continue;
      }
      if (prog === LIGHTHOUSE) {
        if (++guards > MAX_LIGHTHOUSE || ix.data.length > MAX_LIGHTHOUSE_DATA) return json({ error: "refused: unexpected guard instruction" }, 400);
        continue;
      }
      return json({ error: "refused: unexpected program " + (prog || "from a lookup table") + " in this transaction" }, 400);
    }
    const isDisc = (ix, d) => ix.data.length >= 8 && d.every((b, i) => ix.data[i] === b);
    if (ahIxs.length !== 2 || !isDisc(ahIxs[0], BUY_DISC) || !isDisc(ahIxs[1], EXEC_DISC))
      return json({ error: "refused: a store buy is exactly one AuctionHouse buy followed by its execute_sale" }, 400);
    const [bx, ex] = ahIxs;
    // buy: exact data + account count; execute_sale: 21 fixed + [creator wallet, creator ATA] × 1..5 + the 7 pNFT accounts
    const creators = (ex.accIdx.length - EXEC_FIXED - PNFT_TAIL) / 2;
    if (bx.data.length !== BUY_DATA_LEN || bx.accIdx.length !== BUY_ACCOUNTS || ex.data.length !== EXEC_DATA_LEN
      || !Number.isInteger(creators) || creators < 1 || creators > MAX_CREATORS)
      return json({ error: "refused: AuctionHouse instruction is not the store's buy layout" }, 400);
    const house = keyOf(bx, 8), cur = HOUSE_CUR[house], payer = b58(staticKeys[0]), t = EXEC_FIXED + 2 * creators;
    const bPrice = Buffer.from(bx.data).readBigUInt64LE(10), bSize = Buffer.from(bx.data).readBigUInt64LE(18);
    const ePrice = Buffer.from(ex.data).readBigUInt64LE(11), eSize = Buffer.from(ex.data).readBigUInt64LE(19);
    const schemaOk = !!cur
      && keyOf(ex, 10) === house                                          // the same Degen Dojo house, at its exact position
      && keyOf(bx, 0) === payer && keyOf(bx, 2) === payer && keyOf(ex, 0) === payer   // the fee payer is the buyer
      && keyOf(bx, 3) === cur.mint && keyOf(ex, 5) === cur.mint            // that house's currency
      && keyOf(bx, 7) === cosignerB58 && keyOf(ex, 9) === cosignerB58      // authority = this co-signer
      && keyOf(bx, 4) === keyOf(ex, 2) && keyOf(bx, 5) === keyOf(ex, 4) && keyOf(bx, 6) === keyOf(ex, 6) && keyOf(bx, 9) === keyOf(ex, 11)   // same token account, metadata, escrow, fee account
      && keyOf(bx, 10) === keyOf(ex, 13)                                   // the buy's trade state is the one the sale completes
      && keyOf(bx, 11) === TOKEN && keyOf(bx, 12) === SYSTEM && keyOf(bx, 13) === RENT
      && keyOf(ex, 16) === TOKEN && keyOf(ex, 17) === SYSTEM && keyOf(ex, 18) === ATA_PROG && keyOf(ex, 19) === AH_SIGNER && keyOf(ex, 20) === RENT
      && keyOf(ex, t) === META && keyOf(ex, t + 4) === AUTH_RULES && keyOf(ex, t + 6) === SYSVAR_IX
      && keyOf(bx, 9) === cur.feeAccount
      && bPrice === ePrice && bPrice > 0n && bSize === 1n && eSize === 1n;
    if (!schemaOk) return json({ error: "refused: AuctionHouse accounts are not the store's buy layout" }, 400);
    if (bPrice < cur.minSale) return json({ error: `refused: the lowest price the store co-signs is ${Number(cur.minSale) / 10 ** cur.decimals} ${cur.code}` }, 400);

    // GATE (security invariant): the cosigner is the AUTHORITY of our houses, so its signature must only ever
    // reach an AuctionHouse buy/execute_sale on the one it co-signs for (HOUSES = the ORE house).
    //  · A signature covers the whole transaction, and any instruction that lists the cosigner account can
    //    use that signer privilege — including another program that CPIs into the AuctionHouse's admin
    //    calls (update_auction_house, withdraw_from_fee, …). So EVERY instruction that references the
    //    cosigner (as program, or in its accounts) must be AH buy/execute_sale on one of OUR houses.
    //  · Any AuctionHouse instruction at all must be buy/execute_sale on one of our houses.
    //  · Other programs (ComputeBudget, Phantom's Lighthouse guards injected when the wallet signs first) are
    //    allowed only because they never receive the cosigner account, so they can't use its signature.
    const isAH = (ix) => b58(accounts[ix.programIdIndex]) === AH;
    const isBuyOrExec = (ix) => { const d = [...ix.data.slice(0, 8)];
      return d.length === 8 && (BUY_DISC.every((b, i) => d[i] === b) || EXEC_DISC.every((b, i) => d[i] === b)); };
    const onOurHouse = (ix) => ix.accIdx.some((k) => accounts[k] && HOUSES.has(b58(accounts[k])));
    const touchesCosigner = (ix) => b58(accounts[ix.programIdIndex] || Buffer.alloc(32)) === cosignerB58
      || ix.accIdx.some((k) => accounts[k] && b58(accounts[k]) === cosignerB58);
    for (const ix of ixs) {
      if (ix.accIdx.some((k) => k >= accounts.length) || ix.programIdIndex >= accounts.length)
        return json({ error: "refused: instruction references an unknown account" }, 400);
      if (isAH(ix) && !(isBuyOrExec(ix) && onOurHouse(ix)))
        return json({ error: "refused: AuctionHouse call is not a buy/execute_sale on a Degen Dojo house" }, 400);
      if (touchesCosigner(ix) && !(isAH(ix) && isBuyOrExec(ix) && onOurHouse(ix)))
        return json({ error: "refused: the cosigner may only be used by a Degen Dojo AuctionHouse buy/execute_sale" }, 400);
    }
    if (!ixs.some((ix) => isAH(ix) && isBuyOrExec(ix) && onOurHouse(ix) && touchesCosigner(ix)))
      return json({ error: "refused: no Degen Dojo AuctionHouse sale needs this cosigner" }, 400);

    // SALES ONLY: when the authority signs a `buy`, the house fee account pays the bid's rent — a bid alone could be
    // cancelled by the bidder for the refund, draining the account every pNFT sale needs. So the co-signature is
    // only lent to a transaction that completes the sale: every buy must be matched by an execute_sale on the same
    // buyer trade state (buy accounts[10] / execute_sale accounts[13]).
    const isBuy = (ix) => isAH(ix) && BUY_DISC.every((b, i) => ix.data[i] === b);
    const isExec = (ix) => isAH(ix) && EXEC_DISC.every((b, i) => ix.data[i] === b);
    const keyAt = (ix, n) => (ix.accIdx.length > n && accounts[ix.accIdx[n]] ? b58(accounts[ix.accIdx[n]]) : null);
    const saleStates = new Set(ixs.filter(isExec).map((ix) => keyAt(ix, 13)).filter(Boolean));
    if (!saleStates.size) return json({ error: "refused: the co-signer only completes sales (no execute_sale)" }, 400);
    if (ixs.filter(isBuy).some((ix) => !saleStates.has(keyAt(ix, 10))))
      return json({ error: "refused: a bid without its matching sale" }, 400);

    // HOUSE RENT REFUND (see HOUSE RENT above): the buyer's System transfer to this house's fee account, placed before
    // the buy, must cover every account the sale makes the house create. Nothing else may use the System program.
    let rent;
    try {
      rent = await houseRent((method, params) => rpcCall(rpc, method, params), {
        feeAccount: cur.feeAccount, escrow: keyOf(bx, 6), sellerPayAta: keyOf(ex, 7), buyerNftAta: keyOf(ex, 8),
        destTokenRecord: keyOf(ex, t + 3), creatorAtas: Array.from({ length: creators }, (_, i) => keyOf(ex, EXEC_FIXED + 2 * i + 1)) });
    } catch { return json({ error: "refused: couldn't read the chain right now — please try again in a minute" }, 503); }
    const refund = sysIxs[0];
    const refundLamports = refund ? Buffer.from(refund.data).readBigUInt64LE(4) : 0n;
    if (refund && !(keyOf(refund, 0) === payer && keyOf(refund, 1) === cur.feeAccount && ixs.indexOf(refund) < ixs.indexOf(bx)))
      return json({ error: "refused: the rent refund must go from the buyer to the house fee account, before the buy" }, 400);
    if (refundLamports > BigInt(MAX_REFUND)) return json({ error: "refused: rent refund larger than any sale needs" }, 400);
    if (refundLamports < BigInt(rent.owed))
      return json({ error: `refused: this sale opens accounts worth ${rent.owed} lamports of rent; the transaction refunds ${refundLamports} — rebuild the buy and try again`, rentOwed: rent.owed }, 400);
    if (rent.feeLamports < FEE_LOW) console.warn(`[dd-cosign] LOW house fee account ${cur.feeAccount}: ${rent.feeLamports / 1e9} SOL (top up above ${FEE_LOW / 1e9} SOL)`);

    // FLOOR: never co-sign a Degen Dojo sale priced under the minimum (1.5 SOL in the house's currency), so a
    // listing made around the List page can't be sold under the floor. Checked on execute_sale — the step this
    // co-signer actually signs (a bid can be placed without it). Other collections have no minimum. 15% slack keeps
    // honest listings buyable when the currency drifts against SOL. FAIL CLOSED: when DAS is down the NFT is read from
    // its Metadata account instead; when neither can be read, or the price feed has no price for a Degen, refuse
    // ("try again") rather than skip the floor / look-alike checks.
    for (const ix of ixs) {
      if (!(isAH(ix) && EXEC_DISC.every((b, i) => ix.data[i] === b)) || ix.data.length < 27) continue;
      const cur = ix.accIdx.map((k) => HOUSE_CUR[b58(accounts[k])]).find(Boolean);
      const mintKey = accounts[ix.accIdx[3]];   // execute_sale accounts: buyer, seller, token_account, token_mint(3), …
      if (!cur || !mintKey) continue;           // (AuctionHouse checks the mint against the token account + trade states)
      const priceBU = Buffer.from(ix.data).readBigUInt64LE(11);   // execute_sale: disc(8) 3 bumps buyer_price(u64) token_size(u64)
      const asset = (await assetOf(rpc, b58(mintKey))) || (await metadataAsset(rpc, b58(mintKey), keyOf(ix, 4)));
      if (!asset) return json({ error: "refused: couldn't check this NFT right now — please try again in a minute" }, 503);
      if (isLookalike(asset)) return json({ error: "refused: this NFT copies Degen Dojo but isn't one of ours" }, 400);
      if (collectionOf(asset) !== FLOOR_COLLECTION) continue;
      const min = await minInCurrency(cur.code);
      if (!min) return json({ error: "refused: the price feed is unavailable, so the Degen Dojo minimum can't be checked — please try again in a minute" }, 503);
      if (Number(priceBU) / 10 ** cur.decimals < min * BUY_SLACK)
        return json({ error: `refused: price is under the Degen Dojo minimum (${min.toFixed(3)} ${cur.code} ≈ 1.5 SOL)` }, 400);
    }

    // find the cosigner's signature slot
    let signerIndex = -1;
    for (let i = 0; i < numReqSig; i++) if (b58(staticKeys[i]) === cosignerB58) { signerIndex = i; break; }
    if (signerIndex < 0) return json({ error: "cosigner is not a required signer of this tx" }, 400);
    if (signerIndex === 0) return json({ error: "refused: the cosigner can't be the fee payer" }, 400);
    // the cosigner key must appear exactly once in the account list (no duplicate entries to confuse the checks)
    if (accounts.filter((k) => b58(k) === cosignerB58).length !== 1) return json({ error: "refused: cosigner listed more than once" }, 400);
    // HARDENING: the cosigner must be a READ-ONLY signer. Writable signers occupy indices
    // [0, numReqSig - roSigned); a read-only signer can never be debited or have its data changed,
    // so this closes the theoretical "make the cosigner a writable account + drain it" path even
    // though the cosigner holds no funds.
    if (signerIndex < numReqSig - roSigned) return json({ error: "refused: cosigner must be a read-only signer" }, 400);

    // ed25519-sign the raw message with Node crypto (no web3 needed)
    const pkcs8 = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]);
    const signature = edSign(null, message, createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" }));
    sigs[signerIndex] = signature;

    // Both parties have signed (buyer via Phantom, then us). Submit it.
    const out = Buffer.concat([encCU16(numSigs), ...sigs, message]);
    // skipPreflight: the client already simulated the buy; a preflight here just re-checks the blockhash on
    // a possibly-lagging node and throws BlockhashNotFound. Send straight to the leader.
    const sr = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "sendTransaction", params: [out.toString("base64"), { encoding: "base64", skipPreflight: true, maxRetries: 5 }] }), signal: AbortSignal.timeout(RPC_TIMEOUT) });
    const sj = await sr.json();
    if (sj.error) return json({ error: "submit failed: " + JSON.stringify(sj.error).slice(0, 300) }, 400);
    return json({ signature: sj.result });
  } catch (e) {
    if (e instanceof Refuse) return json({ error: "refused: " + e.message }, 400);
    return json({ error: "cosign failed: " + (e.message || String(e)).slice(0, 300) }, 400);
  }
};

export const config = { path: "/api/dd-cosign" };
