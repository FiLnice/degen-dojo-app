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
import bs58 from "bs58";
import { createPrivateKey, sign as edSign } from "crypto";

const AH = "hausS13jsjafwWwGqZTUQRmWyvyxn9EQpqMwV1PBBmk";
// Our three houses (ORE / SKR / USDC). The cosigner is their authority, so its signature is only ever
// lent to a buy/execute_sale on one of THESE houses.
const HOUSES = new Set([
  "7jAwmzBpVLL9ntSZWRFTvNXZztJJhk84HxGznq1Q3U8Y",   // ORE
  "EfeSbHoNsXxKFRjMmNpFPNnUDYE2QmkQ5ugxvtQzCE6C",   // SKR
  "GnbcBGfDLe3S2QaKwSPGwiJ6SoU8qzdkYAPdzTLfn1Ft",   // USDC
]);
const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111";
const BUY_DISC = [102, 6, 61, 18, 1, 218, 235, 234];
const EXEC_DISC = [37, 74, 217, 157, 79, 49, 35, 6];
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

const readCU16 = (b, o) => { let v = 0, s = 0, i = o; for (;;) { const x = b[i++]; v |= (x & 0x7f) << s; if ((x & 0x80) === 0) break; s += 7; } return [v, i]; };
const encCU16 = (n) => { const out = []; for (;;) { let b = n & 0x7f; n >>= 7; if (n) out.push(b | 0x80); else { out.push(b); break; } } return Buffer.from(out); };
const b58 = (bytes) => bs58.encode(bytes);

async function getAccount(rpc, pubkeyB58) {
  const r = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAccountInfo", params: [pubkeyB58, { encoding: "base64" }] }) });
  const j = await r.json();
  return j.result && j.result.value;
}

export default async (request) => {
  if (request.method !== "POST") return new Response("POST only", { status: 405 });
  const secret = process.env.COSIGNER_SECRET, rpc = process.env.SOLANA_RPC;
  if (!secret) return json({ error: "COSIGNER_SECRET is not set" }, 500);
  if (!rpc) return json({ error: "SOLANA_RPC is not set" }, 500);
  let body; try { body = await request.json(); } catch { return new Response("bad json", { status: 400 }); }
  if (!body || !body.tx) return json({ error: "missing tx" }, 400);

  // cosigner key: 64-byte secret = seed(32) + pubkey(32)
  let sk;
  try { sk = secret.trim().startsWith("[") ? Uint8Array.from(JSON.parse(secret)) : bs58.decode(secret.trim()); } catch { return json({ error: "COSIGNER_SECRET is not valid" }, 500); }
  if (sk.length !== 64) return json({ error: "COSIGNER_SECRET must be a 64-byte secret key" }, 500);
  const seed = Buffer.from(sk.slice(0, 32)), cosignerB58 = b58(Buffer.from(sk.slice(32, 64)));

  let tx; try { tx = Buffer.from(body.tx, "base64"); } catch { return json({ error: "bad base64" }, 400); }
  try {
    // ── tx wire: [compactU16 numSigs][numSigs × 64 sig][message] ──
    let o = 0, numSigs; [numSigs, o] = readCU16(tx, o);
    const sigs = []; for (let i = 0; i < numSigs; i++) { sigs.push(Buffer.from(tx.slice(o, o + 64))); o += 64; }
    const message = tx.slice(o);   // the exact bytes each signer signs — never modified below

    // ── parse v0 message (for validation + signer index only) ──
    let m = 0;
    if ((message[m] & 0x80) === 0) return json({ error: "legacy transactions not supported" }, 400);
    m += 1;
    const numReqSig = message[m], roSigned = message[m + 1]; m += 3;   // header: reqSig, roSigned, roUnsigned
    let numStatic; [numStatic, m] = readCU16(message, m);
    const staticKeys = []; for (let i = 0; i < numStatic; i++) { staticKeys.push(message.slice(m, m + 32)); m += 32; }
    m += 32;                                            // recent blockhash
    let numIx; [numIx, m] = readCU16(message, m);
    const ixs = [];
    for (let i = 0; i < numIx; i++) {
      const programIdIndex = message[m]; m += 1;
      let nAcc; [nAcc, m] = readCU16(message, m); const accIdx = [...message.slice(m, m + nAcc)]; m += nAcc;
      let dLen; [dLen, m] = readCU16(message, m); const data = message.slice(m, m + dLen); m += dLen;
      ixs.push({ programIdIndex, accIdx, data });
    }
    let numAlt; [numAlt, m] = readCU16(message, m);
    const altLookups = [];
    for (let i = 0; i < numAlt; i++) {
      const accountKey = message.slice(m, m + 32); m += 32;
      let nW; [nW, m] = readCU16(message, m); const wIdx = message.slice(m, m + nW); m += nW;
      let nR; [nR, m] = readCU16(message, m); const rIdx = message.slice(m, m + nR); m += nR;
      altLookups.push({ accountKey, wIdx, rIdx });
    }

    // resolve the full account list (static + ALT writable + ALT readonly) to read program ids
    const altAddrs = [];
    for (const l of altLookups) {
      const acc = await getAccount(rpc, b58(l.accountKey));
      if (!acc) return json({ error: "lookup table not found on-chain" }, 400);
      const d = Buffer.from(acc.data[0], "base64"), list = [];
      for (let p = 56; p + 32 <= d.length; p += 32) list.push(d.slice(p, p + 32));   // LookupTableMeta is 56 bytes
      altAddrs.push(list);
    }
    const wAlt = [], rAlt = [];
    altLookups.forEach((l, li) => { for (const idx of l.wIdx) wAlt.push(altAddrs[li][idx]); });
    altLookups.forEach((l, li) => { for (const idx of l.rIdx) rAlt.push(altAddrs[li][idx]); });
    const accounts = [...staticKeys, ...wAlt, ...rAlt];

    // GATE (security invariant): the cosigner is the AUTHORITY of our three houses, so its signature must
    // only ever reach an AuctionHouse buy/execute_sale on one of those houses.
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
    const sr = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "sendTransaction", params: [out.toString("base64"), { encoding: "base64", skipPreflight: true, maxRetries: 5 }] }) });
    const sj = await sr.json();
    if (sj.error) return json({ error: "submit failed: " + JSON.stringify(sj.error).slice(0, 300) }, 400);
    return json({ signature: sj.result });
  } catch (e) {
    return json({ error: "cosign failed: " + (e.message || String(e)).slice(0, 300) }, 400);
  }
};

export const config = { path: "/api/dd-cosign" };
