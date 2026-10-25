// Preacher referral, bound on-chain.
//
// The store adds a tiny SPL Memo instruction — "ddref:<code>" — to the buyer's own purchase transaction
// (coin packs, ORE-miner tips, Degen Dojo NFT buys). The buyer's signature covers it, so the referral is
// part of the payment itself: it can't be added, changed or claimed by anyone else afterwards. The server
// credits a preacher ONLY from this memo, read out of the verified transaction — whatever ref a client
// POSTs alongside the signature is ignored for attribution.
//
// Memos are read from the Memo program's OWN instructions (top level and inner, in execution order) — the
// instruction data is the memo text. Never from the logs: any program can print a line that looks like
// `Program log: Memo (len 11): "ddref:ronin"`, so a log line proves nothing about who wrote it.
// Handles both getTransaction encodings: "json" (programIdIndex + base58 data) and "jsonParsed" (programId +
// the memo text in `parsed`).
export const MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
const MEMO_PROGRAMS = new Set([MEMO_PROGRAM, "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo"]);   // SPL Memo v2 + v1
export const REF_PREFIX = "ddref:";
export const REF_RE = /^[a-z0-9_-]{2,32}$/;

// The referral code carried in a transaction's memo (lowercase), or null if it has none.
// A Dojo Pot tip carries this memo (the store's tip button adds it). Only a plain transfer WITH it counts as a
// tip — so a marketplace royalty or any other deposit into the pot wallet can't be claimed as prize money.
export const TIP_MEMO = "ddtip";

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
// base58 → bytes (null if it isn't base58)
export function b58decode(s) {
  if (typeof s !== "string") return null;
  const out = [];   // little-endian base-256 digits
  for (const c of s) {
    let carry = B58.indexOf(c); if (carry < 0) return null;
    for (let i = 0; i < out.length; i++) { carry += out[i] * 58; out[i] = carry & 0xff; carry >>= 8; }
    while (carry > 0) { out.push(carry & 0xff); carry >>= 8; }
  }
  let zeros = 0; while (zeros < s.length && s[zeros] === "1") zeros++;
  return Uint8Array.from([...new Array(zeros).fill(0), ...out.reverse()]);
}
const utf8 = new TextDecoder();
const keyStr = (k) => (typeof k === "string" ? k : k?.pubkey || "");

export function memosOf(tx) {
  const msg = tx?.transaction?.message; if (!msg) return [];
  const keys = (msg.accountKeys || []).map(keyStr);
  // plain-json txs list lookup-table keys in meta.loadedAddresses (programs are never among them, but keep the order exact)
  if (keys.length < (tx.meta?.preBalances || []).length)
    keys.push(...(tx.meta.loadedAddresses?.writable || []), ...(tx.meta.loadedAddresses?.readonly || []));
  const inner = new Map((tx.meta?.innerInstructions || []).map((x) => [x.index, x.instructions || []]));
  const out = [];
  const take = (ix) => {
    if (!MEMO_PROGRAMS.has(ix?.programId || keys[ix?.programIdIndex])) return;
    let text = null;
    if (typeof ix.parsed === "string") text = ix.parsed;
    else { const b = b58decode(ix.data); if (b) text = utf8.decode(b); }
    if (text) out.push(text);
  };
  (msg.instructions || []).forEach((ix, i) => { take(ix); for (const x of inner.get(i) || []) take(x); });
  return out;
}

export function refFromTx(tx) {
  for (const m of memosOf(tx)) {
    if (!m.startsWith(REF_PREFIX)) continue;
    const code = m.slice(REF_PREFIX.length).toLowerCase();
    if (REF_RE.test(code)) return code;
  }
  return null;
}
