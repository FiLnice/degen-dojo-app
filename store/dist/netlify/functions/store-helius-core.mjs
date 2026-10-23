// Shared Treasury history reader — Helius's enhanced (batch) address history.
//
// The Treasury (5w55) auto-mines ORE: the ORE executor's deploys list it as the authority, so it shows up in ~1,250
// transactions a day and almost none of them change its balances. Reading each one with getTransaction can never keep
// up (and burns RPC credits). Helius's enhanced history returns 100 transactions per request WITH each one's balance
// changes, so a caller keeps only the few that touch the wallet and reads those in full.
//
// Used by store-keeper-core.mjs (scanTreasury: the Dojo Keeper's reader) and store-fn-reserve.mjs (/api/reserve).
//
//   heliusKey()                         → the api-key in SOLANA_RPC when it is a Helius URL, else "" (callers fall back
//                                         to getSignaturesForAddress + getTransaction)
//   enhancedPage(address, key, before)  → up to 100 parsed txs, newest first (429 → backs off and retries; other errors throw)
//   walkHistory(state, address, key, { since, budgetOk, maxPages, onTx })
//       calls onTx(e, tMs) for every tx newer than the last walk (state.newest[address]) down to `since` (ms). Whatever
//       doesn't fit in the budget (budgetOk() false, or maxPages requests) is kept in state.gaps[address] — from where it
//       stopped back to where it should end — and later calls keep filling it. A re-walked page can repeat a tx, so onTx
//       must be idempotent. `state` ({ newest: {}, gaps: {} }) is updated in place; the caller persists it.
export const HELIUS_PAGE = 100;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const heliusKey = () => {
  try { const u = new URL(process.env.SOLANA_RPC); return /helius/i.test(u.hostname) ? u.searchParams.get("api-key") || "" : ""; } catch { return ""; }
};

export async function enhancedPage(address, key, before) {
  for (let tries = 0; tries < 4; tries++) {
    const r = await fetch(`https://api.helius.xyz/v0/addresses/${address}/transactions?api-key=${encodeURIComponent(key)}&limit=${HELIUS_PAGE}${before ? "&before=" + before : ""}`);
    if (r.status === 429) { await sleep(500 * (tries + 1)); continue; }
    if (!r.ok) throw new Error("helius history " + r.status);
    return await r.json();
  }
  throw new Error("helius history rate-limited");
}

export async function walkHistory(state, address, key, { since = 0, budgetOk = () => true, maxPages = Infinity, onTx }) {
  state.newest ||= {}; state.gaps ||= {};
  const gaps = (state.gaps[address] ||= []);
  let pages = 0;
  const more = () => budgetOk() && pages < maxPages;
  // walk older from `from` until the signature `until` (or `since`); → null when finished, else where it stopped.
  // A page already in hand (the top page) is always walked — it costs no request.
  const walk = async (from, until, firstPage) => {
    let before = from, lastT = Date.now(), page = firstPage;
    while (page || more()) {
      if (!page) { page = await enhancedPage(address, key, before); pages++; }
      if (!Array.isArray(page) || !page.length) return null;
      for (const e of page) {
        const t = (e.timestamp || 0) * 1000;
        if (e.signature === until || t < since) return null;
        await onTx(e, t);
        before = e.signature; lastT = t;
      }
      if (page.length < HELIUS_PAGE) return null;
      page = null;
    }
    return { before, t: lastT };
  };
  // the top: new txs since the last call (usually this one request)
  const prevNewest = state.newest[address] || null;
  const top = await enhancedPage(address, key, null).catch(() => null);
  pages++;
  let topPage = null;
  if (Array.isArray(top) && top.length && top[0].signature !== prevNewest) {
    state.newest[address] = top[0].signature;
    gaps.unshift({ before: null, t: Date.now(), until: prevNewest });   // from the very top down to the previous newest
    topPage = top;
  }
  // fill gaps newest-first while the budget lasts; a gap that doesn't finish keeps where it stopped
  for (let i = 0; i < gaps.length; ) {
    const g = gaps[i];
    const first = g.before === null && i === 0 ? topPage : null;
    if (!first && !more()) break;
    const left = await walk(g.before, g.until, first);
    if (left) { gaps[i] = { ...g, before: left.before, t: left.t }; i++; } else gaps.splice(i, 1);
  }
}
