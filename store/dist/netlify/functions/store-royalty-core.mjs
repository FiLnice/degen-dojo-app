// Shared royalty→pot sweep. ALL Degen royalties (13% creator share) land in the creator wallet
// ED3GMC — from the DD store, Magic Eden, Tensor, anywhere — so one watcher on that wallet captures
// EVERY marketplace. Each run: read the wallet's new signatures, and for any tx that touches a known
// marketplace program, credit HALF of what the wallet gained (in every currency) to the weekly pot's
// "royalty" route. Verified against the ACTUAL on-chain gain, idempotent per signature (shared with the
// /api/dd-royalty client report so a sale is never double-counted). The FIRST run only records a baseline
// cursor and credits nothing, so it means "from now on" — never a retroactive dump of past sales.
//
// Durability (nothing is ever silently skipped):
//   • every page of new signatures is read (getSignaturesForAddress paged with `before`, bounded by
//     `until` = the cursor), and the cursor only moves across signatures that were handled: either
//     FINAL (credited / not a marketplace tx / failed tx / given up) or durably queued as retry:<sig>;
//   • a tx the RPC can't return yet, an RPC error, or a missing price → retry:<sig> (re-tried every run,
//     given up after RETRY_MAX_ATTEMPTS or RETRY_MAX_AGE_MS, recorded as gaveUp so it can be audited);
//   • a signature is marked credited only after ALL its currencies were priced and added; each pot add
//     carries the id royalty:<sig>:<cur>, so an overlapping run or a crash-resume can't add it twice.
//
// Sanity: the tx must touch a known marketplace program, must NOT be signed by the royalty wallet itself
// (that is our own trade, e.g. sale proceeds), and only what the wallet actually gained is counted.
//
// Blobs "dd-royalties": <sig> (final record), claim:<sig> (one-time credit marker), retry:<sig> (queue), __cursor__.
import { getStore } from "@netlify/blobs";
import { addToPot } from "./store-pot-core.mjs";
import { livePrice } from "./store-verify-core.mjs";
import { putIfNew, readWithEtag } from "./store-cas-core.mjs";

const CREATOR = process.env.ROYALTY_WALLET || "ED3GMCfoX3XNvavnWADvd6oCsohGg1ukdhv3PaUpvwJe";
const ROYALTY_TO_POT = 0.5;
const MINTS = { ORE: "oreoU2P8bN6jkk3jbaiVxYnG1dCXcYxwhwyK9jSybcp", SKR: "SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3", USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" };
// Marketplace programs whose sales pay this wallet a royalty. Conservative allow-list — an inflow that
// doesn't come through one of these (e.g. you funding the wallet) is NEVER counted as royalty.
const MARKETPLACES = new Set([
  "hausS13jsjafwWwGqZTUQRmWyvyxn9EQpqMwV1PBBmk",   // Metaplex / DD AuctionHouse
  "M2mx93ekt1fmXSVkTrUL9xVFHkmME8HTUi5Cyc5aF7K",   // Magic Eden v2
  "mmm3XBJg5gk8XJxEKBvdgptZz6SgK4tXvn36sodowMc",   // Magic Eden MMM (AMM pools)
  "TSWAPaqyCSx2KABk68Shruf4rp7CxcNi8hAsbdwmHbN",   // Tensor (TSwap pools)
  "TCMPhJdwDryooaGtiocG1u3xcYbRpiJzb283XfCZsDp",   // Tensor (TComp — most Tensor listings/bids)
]);
const PAGE = 1000;                         // getSignaturesForAddress max page
const MAX_PAGES = 20;                      // 20k new signatures per run before we stop and resume next run
const RETRY_PER_RUN = 25;                  // queued retries re-tried per run
const RETRY_MAX_ATTEMPTS = 120;            // ≈ 2h of one-minute runs …
const RETRY_MAX_AGE_MS = 3 * 86400e3;      // … or 3 days, whichever comes later, then gaveUp (audit trail)
const CLAIM_RESUME_MS = 2 * 60e3;          // a claim:<sig> left by a caller that died is finished after this

// JSON-RPC that throws on an RPC/HTTP error (→ retry), so "RPC failed" is never read as "no tx".
async function rpc(method, params) {
  const r = await fetch(process.env.SOLANA_RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
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

const keysOf = (tx) => [
  ...(tx.transaction.message.accountKeys || []),
  ...(tx.meta.loadedAddresses?.writable || []),
  ...(tx.meta.loadedAddresses?.readonly || []),
].map((k) => (typeof k === "string" ? k : k.pubkey || k));
// what CREATOR gained in this tx, per currency (SOL native + our SPL mints)
function gains(tx) {
  const keys = keysOf(tx);
  const out = {};
  const i = keys.indexOf(CREATOR);
  if (i >= 0) out.SOL = (tx.meta.postBalances[i] - tx.meta.preBalances[i]) / 1e9;
  const sum = (arr, mint) => arr.filter((b) => b.mint === mint && b.owner === CREATOR).reduce((s, b) => s + Number(b.uiTokenAmount?.uiAmount || 0), 0);
  for (const [cur, mint] of Object.entries(MINTS)) out[cur] = sum(tx.meta.postTokenBalances || [], mint) - sum(tx.meta.preTokenBalances || [], mint);
  return out;
}
const touchesMarket = (tx) => keysOf(tx).some((k) => MARKETPLACES.has(k));
function signersOf(tx) {
  const msg = tx.transaction.message, ak = msg.accountKeys || [];
  if (ak.length && typeof ak[0] === "object" && "signer" in ak[0]) return ak.filter((k) => k.signer).map((k) => k.pubkey);
  return ak.slice(0, msg.header?.numRequiredSignatures || 0).map((k) => (typeof k === "string" ? k : k.pubkey));
}
const isFinal = (rec) => !!(rec && (rec.credited || rec.skip || rec.gaveUp));

// Process ONE signature. → { final: record } (write it; never revisit), { retry: reason }, or
// { refuse: reason } (not ours / outside the caller's window — write nothing).
// `tx` may be passed in when the caller already has it; `notBefore` (ms) refuses older sales.
export async function processRoyaltySig(sig, { tx, notBefore = 0 } = {}) {
  if (tx === undefined) {
    try { tx = await rpc("getTransaction", [sig, { maxSupportedTransactionVersion: 0, encoding: "json" }]); }
    catch (e) { return { retry: "rpc: " + (e.message || e) }; }
  }
  if (!tx) return { retry: "tx not readable yet" };
  const involvesCreator = keysOf(tx).includes(CREATOR)
    || [...(tx.meta?.preTokenBalances || []), ...(tx.meta?.postTokenBalances || [])].some((b) => b.owner === CREATOR);
  if (!involvesCreator) return { refuse: "tx does not involve the royalty wallet" };   // never persisted
  if (notBefore && tx.blockTime && tx.blockTime * 1000 < notBefore) return { refuse: "sale is older than the report window" };   // left to the sweep
  if (tx.meta?.err) return { final: { credited: false, skip: "failed-tx", at: Date.now() } };
  if (!touchesMarket(tx)) return { final: { credited: false, skip: "not-marketplace", at: Date.now() } };
  // the royalty wallet SIGNED → our own trade (e.g. selling an NFT held in ED3GMC = sale proceeds), not a royalty
  if (signersOf(tx).includes(CREATOR)) return { final: { credited: false, skip: "creator-signed", at: Date.now() } };
  const due = Object.entries(gains(tx)).filter(([, amt]) => amt > 0);
  const px = {};
  for (const [c] of due) { px[c] = await livePrice(c); if (px[c] == null) return { retry: "no price for " + c }; }   // all-or-nothing
  const rec = { credited: true, at: Date.now(), routes: {}, potUsd: 0 };
  for (const [c, amt] of due) {
    const potNative = amt * ROYALTY_TO_POT, usd = potNative * px[c];
    rec.routes[c] = { royalty: amt, potNative, usd: +usd.toFixed(4), usdExact: usd }; rec.potUsd += usd;
  }
  rec.potUsd = +rec.potUsd.toFixed(4);
  // One-time claim (create-only write): exactly one caller — a sweep run or /api/dd-royalty — adds this
  // sale to the pot. A claim left by a caller that died is resumed with ITS amounts after CLAIM_RESUME_MS
  // (the pot adds carry royalty:<sig>:<cur> ids, so a resume never double-adds).
  const store = getStore("dd-royalties"), ck = "claim:" + sig;
  let claim = { state: "claimed", at: Date.now(), rec };
  if (!(await putIfNew(store, ck, claim))) {
    const { value: cur } = await readWithEtag(store, ck);
    if (cur?.state === "done") return { final: cur.rec };
    if (cur && Date.now() - (cur.at || 0) < CLAIM_RESUME_MS) return { retry: "credit in flight" };
    claim = cur?.rec ? cur : claim;
  }
  for (const [c, r] of Object.entries(claim.rec.routes))
    await addToPot({ usd: r.usdExact ?? r.usd, currency: c, native: r.potNative, route: "royalty", id: `royalty:${sig}:${c}` });
  await store.setJSON(ck, { ...claim, state: "done", doneAt: Date.now() });
  return { final: claim.rec };
}

// Handle one signature against the store: skip if final, process, persist the outcome (final record,
// or a retry:<sig> queue entry). → "done" | "credited" | "queued"
async function handle(store, sig, opts = {}) {
  const prior = await store.get(sig, { type: "json" });
  if (isFinal(prior)) { await store.delete("retry:" + sig).catch(() => {}); return "done"; }
  const out = await processRoyaltySig(sig, opts);
  if (out.refuse) out.final = { credited: false, skip: out.refuse, at: Date.now() };   // (sweep sigs always involve the wallet)
  if (out.final) {
    await store.setJSON(sig, out.final);
    await store.delete("retry:" + sig).catch(() => {});
    return out.final.credited && out.final.potUsd > 0 ? "credited" : "done";
  }
  const q = (await store.get("retry:" + sig, { type: "json" })) || { sig, attempts: 0, firstSeen: Date.now() };
  q.attempts += 1; q.lastTry = Date.now(); q.lastReason = out.retry;
  if (q.attempts >= RETRY_MAX_ATTEMPTS && Date.now() - q.firstSeen >= RETRY_MAX_AGE_MS) {
    await store.setJSON(sig, { credited: false, gaveUp: true, reason: out.retry, attempts: q.attempts, firstSeen: q.firstSeen, at: Date.now() });
    await store.delete("retry:" + sig).catch(() => {});
    console.log("royalty sweep: GAVE UP on", sig, "—", out.retry);
    return "done";
  }
  await store.setJSON("retry:" + sig, q);
  return "queued";
}

// Every signature newer than `until`, newest first, across all pages.
async function newSignatures(until) {
  const out = []; let before = null;
  for (let p = 0; p < MAX_PAGES; p++) {
    const page = await rpc("getSignaturesForAddress", [CREATOR, { limit: PAGE, ...(until ? { until } : {}), ...(before ? { before } : {}) }]);
    if (!Array.isArray(page)) throw new Error("bad getSignaturesForAddress result");
    out.push(...page);
    if (page.length < PAGE) return { sigs: out, complete: true };
    before = page[page.length - 1].signature;
  }
  return { sigs: out, complete: false };
}

export async function sweepRoyalties() {
  if (!process.env.SOLANA_RPC) return { skipped: "no rpc" };
  const store = getStore("dd-royalties");
  const cur = await store.get("__cursor__", { type: "json" });

  // First ever run → set a baseline and credit nothing (means "from now on").
  if (!cur?.lastSig) {
    const first = await rpc("getSignaturesForAddress", [CREATOR, { limit: 1 }]);
    if (!first?.length) return { checked: 0, credited: 0 };
    await store.setJSON("__cursor__", { lastSig: first[0].signature, since: Date.now() });
    return { baseline: first[0].signature };
  }

  const { sigs, complete } = await newSignatures(cur.lastSig);
  let credited = 0, queued = 0, handled = 0, lastHandled = null;
  const queuedNow = new Set();
  for (const s of sigs.slice().reverse()) {                 // oldest → newest
    try {
      if (!s.err) {
        const r = await handle(store, s.signature);
        if (r === "credited") credited++;
        if (r === "queued") { queued++; queuedNow.add(s.signature); }
      }
      lastHandled = s.signature; handled++;
    } catch (e) { console.log("royalty sweep: stopped at", s.signature, "—", e.message || e); break; }   // cursor stays before it
  }
  // Advance only across handled signatures, and only when the scan reached the old cursor (complete):
  // otherwise there is an unscanned gap between the cursor and the oldest page we read.
  if (complete && lastHandled) await store.setJSON("__cursor__", { ...cur, lastSig: lastHandled, at: Date.now() });

  // Retry queue: least-recently-tried first, bounded per run (skips what was just queued above).
  const { blobs } = await store.list({ prefix: "retry:" });
  const queue = [];
  for (const b of blobs.slice(0, 500)) {
    const sig = b.key.slice(6);
    if (queuedNow.has(sig)) continue;
    const q = await store.get(b.key, { type: "json" });
    queue.push({ sig, lastTry: q?.lastTry || 0 });
  }
  queue.sort((a, b) => a.lastTry - b.lastTry);
  let retried = 0, recovered = 0;
  for (const { sig } of queue.slice(0, RETRY_PER_RUN)) {
    try { const r = await handle(store, sig); retried++; if (r !== "queued") recovered++; if (r === "credited") credited++; }
    catch (e) { console.log("royalty sweep retry error", sig, e.message || e); }
  }
  return { checked: sigs.length, handled, complete, credited, queued, retried, recovered, pending: Math.max(0, blobs.length - recovered) };
}
