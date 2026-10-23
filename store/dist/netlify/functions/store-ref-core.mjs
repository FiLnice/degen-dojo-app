// Preacher referral, bound on-chain.
//
// The store adds a tiny SPL Memo instruction — "ddref:<code>" — to the buyer's own purchase transaction
// (coin packs, ORE-miner tips, Degen Dojo NFT buys). The buyer's signature covers it, so the referral is
// part of the payment itself: it can't be added, changed or claimed by anyone else afterwards. The server
// credits a preacher ONLY from this memo, read out of the verified transaction — whatever ref a client
// POSTs alongside the signature is ignored for attribution.
//
// The Memo program logs each memo as:   Program log: Memo (len 11): "ddref:ronin"
export const MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
export const REF_PREFIX = "ddref:";
export const REF_RE = /^[a-z0-9_-]{2,32}$/;

// The referral code carried in a transaction's memo (lowercase), or null if it has none.
// A Dojo Pot tip carries this memo (the store's tip button adds it). Only a plain transfer WITH it counts as a
// tip — so a marketplace royalty or any other deposit into the pot wallet can't be claimed as prize money.
export const TIP_MEMO = "ddtip";
export function memosOf(tx) {
  const out = [];
  for (const line of tx?.meta?.logMessages || []) { const m = /Memo \(len \d+\): "(.*)"$/.exec(line); if (m) out.push(m[1]); }
  return out;
}

export function refFromTx(tx) {
  for (const line of tx?.meta?.logMessages || []) {
    const m = /Memo \(len \d+\): "(.*)"$/.exec(line);
    if (!m || !m[1].startsWith(REF_PREFIX)) continue;
    const code = m[1].slice(REF_PREFIX.length).toLowerCase();
    if (REF_RE.test(code)) return code;
  }
  return null;
}
