// Netlify Function: same-origin Solana RPC proxy for the store.
//
// The store page is public, so it can never carry a keyed RPC URL. It calls
// /api/rpc instead, and this forwards to the real endpoint with the key held in
// a Netlify environment variable (Site configuration → Environment variables →
// SOLANA_RPC, e.g. your Helius URL).
//
// Only the read-only methods checkout actually needs are allowed, so the proxy
// can't be turned into a general-purpose free RPC by anyone who finds the URL.
// sendTransaction relays a transaction the USER already signed in their wallet (one-approval buys sign
// swap + buy together, then send them in order). It can't move anyone's funds without their signature;
// it's limited to one small tx per request so the proxy isn't a bulk relay on our key.
import { limited } from "./store-ratelimit-core.mjs";
const ALLOWED = new Set([
  "getLatestBlockhash",
  "simulateTransaction",
  "getSignatureStatuses",
  "getAccountInfo",
  "getMultipleAccounts",
  "getTokenAccountsByOwner",   // list a wallet's NFTs for the "List a Degen" page
  "getBalance",
  // universal resolve: find a listing by mint, and read its DAS metadata.
  "getProgramAccounts",   // guarded below to the Magic Eden program only
  "getAsset",             // DAS — name, image, traits
  "getAssetBatch",        // DAS batch — names + images for a wallet's NFTs / the listings grid
  "getAssetsByGroup",     // DAS — a collection's NFTs, for the branded-miner preview (/create); guarded below
  "searchAssets",         // DAS — ONE wallet's Metaplex Core NFTs for Dojo Sweep / Burn to Mine; guarded below
  "getMinimumBalanceForRentExemption",   // what a burned Core NFT's 1-byte tombstone keeps (Sweep pricing)
  // The ORE miner (/mine) reads the round clock and confirms deploys/claims
  // through this same proxy — both read-only.
  "getSlot",
  "getTransaction",
  "getRecentPerformanceSamples",   // the miner measures live ms-per-slot for its round countdown
  "getTokenAccountBalance",        // the miner's ORE balance (ORE tips)
  "sendTransaction",      // pre-signed by the user's wallet — see sendOk below
]);

// getProgramAccounts is the one heavy call here, so it's pinned to Magic Eden's
// M2 program. That's all the resolver needs (find a listing's trade state by
// mint); it stops the endpoint being used to scan arbitrary programs on our key.
const M2_PROGRAM = "M2mx93ekt1fmXSVkTrUL9xVFHkmME8HTUi5Cyc5aF7K";
// Solana's public RPC: a fallback for plain methods when Helius is rate-limiting (no DAS / no gPA there).
const PUBLIC_RPC = "https://api.mainnet-beta.solana.com";
const PUBLIC_OK = new Set(["getMinimumBalanceForRentExemption", "getLatestBlockhash", "getSignatureStatuses", "getAccountInfo", "getMultipleAccounts", "getBalance", "simulateTransaction", "getSlot", "getTransaction", "getTokenAccountsByOwner", "getRecentPerformanceSamples", "getTokenAccountBalance", "sendTransaction"]);
// ── abuse limits (every call in a request must pass) ──
export const MAX_BODY_BYTES = 64 * 1024;   // largest real call is ~5 KB (100-key getMultipleAccounts)
export const MAX_BATCH = 10;
export const DAS_LIMIT = 250, DAS_PAGES = 8;   // searchAssets: ≤ 2,000 Core NFTs a wallet, ≤ 250 per (multi-MB-free) answer
const DAS_METHODS = new Set(["getAsset", "getAssetBatch", "searchAssets"]);               // the store/miner never batch; 10 leaves headroom
const B58_KEY = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const isKey = (v) => typeof v === "string" && B58_KEY.test(v);
const isSig = (v) => typeof v === "string" && /^[1-9A-HJ-NP-Za-km-z]{64,96}$/.test(v);
const keyList = (v, max) => Array.isArray(v) && v.length >= 1 && v.length <= max && v.every(isKey);
// one signed tx (base64, ≤ the 1232-byte packet limit) per request, never inside a batch
const sendOk = (c, n) => c?.method !== "sendTransaction" ||
  (n === 1 && typeof c.params?.[0] === "string" && c.params[0].length <= 1700 && (c.params?.[1]?.encoding ?? "base58") === "base64");
// getProgramAccounts is pinned to M2 AND must be a narrow lookup: at least one memcmp filter whose bytes are
// a full base58 pubkey (the resolver matches the listing's mint at offset 112). A filter-less or dataSize-only
// scan would dump the whole M2 program (hundreds of thousands of accounts) on our key.
// Dojo Sweep (/sweep) — two more narrow lookups, each exactly [account-type discriminator @0, ONE wallet/vault key]:
//   GemFarm FARM program: the wallet's own Farmer accounts (identity @40)
//   GemBank BANK program: one vault's GemDepositReceipts (vault @8) — which NFTs it holds
// Any other filter, offset or count is refused, so neither can be widened into a scan of the program.
const GEMFARM = "farmL4xeBFVXJqtfxCzU9b28QACM7E2W2ctT6epAjvE", GEMBANK = "bankHHdqMuaaST4qQk6mkzxGeKPHWmqdgor6Gs8r88m";
const FARMER_DISC = "jXX2LSteZVk", GDR_DISC = "cugAXF7JS7L";   // base58 of sha256("account:Farmer" / "account:GemDepositReceipt")[0..8]
const memcmpIs = (x, offset, ok) => !!x && Object.keys(x).length === 1 && !!x.memcmp && x.memcmp.offset === offset &&
  (x.memcmp.encoding ?? "base58") === "base58" && ok(x.memcmp.bytes);
const sliceOk = (s) => s == null || (Number.isInteger(s.offset) && Number.isInteger(s.length) && s.offset >= 0 && s.length >= 0 && s.length <= 256 && Object.keys(s).length === 2);
const narrowGpa = (c, prog, disc, offset) => {
  const o = c?.params?.[1] || {}, f = o.filters;
  return c?.params?.[0] === prog && Array.isArray(f) && f.length === 2 && memcmpIs(f[0], 0, (b) => b === disc) && memcmpIs(f[1], offset, isKey) &&
    sliceOk(o.dataSlice) && Object.keys(o).every((k) => ["filters", "encoding", "dataSlice", "commitment"].includes(k));
};
const gpaOk = (c) => {
  if (c?.method !== "getProgramAccounts") return true;
  if (c?.params?.[0] === GEMFARM) return narrowGpa(c, GEMFARM, FARMER_DISC, 40);
  if (c?.params?.[0] === GEMBANK) return narrowGpa(c, GEMBANK, GDR_DISC, 8);
  if (c?.params?.[0] !== M2_PROGRAM) return false;
  const f = c?.params?.[1]?.filters;
  if (!Array.isArray(f) || f.length < 1 || f.length > 4) return false;
  // pinned to the MINT (offset 112): a memcmp on a shared key (e.g. the auction house at offset 8) would match
  // every Magic Eden listing and turn this into a full scan on our key.
  return f.some((x) => x && x.memcmp && x.memcmp.offset === 112 &&
    (x.memcmp.encoding ?? "base58") === "base58" && isKey(x.memcmp.bytes));
};
// getAssetsByGroup: collection lookups only, one page of at most 1000, first few pages — enough to
// sample a collection's art for the /create preview without letting the proxy crawl everything.
const groupOk = (c) => {
  if (c?.method !== "getAssetsByGroup") return true;
  const p = c?.params || {};
  // page-number paging only: cursor/before/after would walk past the 3-page cap
  if (p.cursor != null || p.before != null || p.after != null) return false;
  return p.groupKey === "collection" && typeof p.groupValue === "string" && (p.limit ?? 1000) <= 1000 && (p.page ?? 1) <= 3;
};
// DAS takes object params ({ids}) or a one-element array ([{ids}]) — accept both, cap the size.
const dasArg = (c) => (Array.isArray(c?.params) ? c.params[0] : c?.params) || {};
// per-method parameter caps
const PARAM_OK = {
  getMultipleAccounts: (p) => keyList(p?.[0], 100),
  getSignatureStatuses: (p) => Array.isArray(p?.[0]) && p[0].length >= 1 && p[0].length <= 256 && p[0].every(isSig),
  getTransaction: (p) => isSig(p?.[0]),
  getAccountInfo: (p) => isKey(p?.[0]),
  getBalance: (p) => isKey(p?.[0]),
  getTokenAccountBalance: (p) => isKey(p?.[0]),
  getRecentPerformanceSamples: (p) => p == null || (Array.isArray(p) && (p.length === 0 || (Number.isInteger(p[0]) && p[0] >= 1 && p[0] <= 10))),
  getTokenAccountsByOwner: (p) => isKey(p?.[0]) && !!p?.[1] && (isKey(p[1].mint) || isKey(p[1].programId)),
  simulateTransaction: (p) => typeof p?.[0] === "string" && p[0].length <= 2000 &&
    (p?.[1]?.accounts == null || keyList(p[1].accounts.addresses, 64)),
  getAsset: (p) => isKey(dasArg({ params: p })?.id ?? (Array.isArray(p) ? p[0] : undefined)),
  getAssetBatch: (p) => keyList(dasArg({ params: p }).ids, 100),
  // Core NFTs of ONE owner only: interface pinned, page-number paging (≤ 8 pages of ≤ 250 — keeps each answer small), no other filters/cursors
  searchAssets: (p) => { const a = dasArg({ params: p });
    return Object.keys(a).every((k) => ["ownerAddress", "interface", "burnt", "page", "limit"].includes(k)) && isKey(a.ownerAddress) &&
      a.interface === "MplCoreAsset" && (a.burnt == null || a.burnt === false) && Number.isInteger(a.page ?? 1) && (a.page ?? 1) >= 1 && (a.page ?? 1) <= DAS_PAGES &&
      Number.isInteger(a.limit ?? DAS_LIMIT) && (a.limit ?? DAS_LIMIT) >= 1 && (a.limit ?? DAS_LIMIT) <= DAS_LIMIT; },
  getMinimumBalanceForRentExemption: (p) => Array.isArray(p) && p.length >= 1 && p.length <= 2 && Number.isInteger(p[0]) && p[0] >= 0 && p[0] <= 10240 &&
    (p.length === 1 || (!!p[1] && typeof p[1] === "object" && Object.keys(p[1]).every((k) => k === "commitment"))),
};
const paramsOk = (c) => !PARAM_OK[c.method] || PARAM_OK[c.method](c.params);
export const callOk = (c, n) => !!c && typeof c === "object" && !Array.isArray(c) && ALLOWED.has(c.method) &&
  paramsOk(c) && gpaOk(c) && groupOk(c) && sendOk(c, n);

// Same-origin only: the Origin (or, failing that, Referer) must be a URL whose host is EXACTLY this
// site's host — "https://store.degendojo.xyz.evil.com" or "https://evil.com/?store.degendojo.xyz" no
// longer pass the old substring test, and an opaque "null" origin is refused. A request with NEITHER
// header (curl, a server, some privacy proxies) is allowed: it can't come from another site's page in a
// browser (browsers always send Origin on a cross-origin POST), and a non-browser client could forge the
// header anyway — the method/param caps above are what bound that traffic.
export function originOk(request) {
  const src = request.headers.get("origin") || request.headers.get("referer") || "";
  if (!src) return true;
  let h;
  try { h = new URL(src).host.toLowerCase(); } catch { return false; }
  if (!h) return false;
  const own = new Set();
  const hh = (request.headers.get("host") || "").trim().toLowerCase();
  if (hh) own.add(hh);
  try { own.add(new URL(request.url).host.toLowerCase()); } catch {}
  return own.has(h);
}

// Upstream circuit breaker (per warm instance): when Helius keeps answering 429 even after a retry, stop
// sending it more for a few seconds — plain calls go straight to Solana's public RPC, DAS calls get a fast
// "busy" instead of piling more retries onto a saturated quota.
const BREAKER_MS = 10_000;
let breakerUntil = 0;

export default async (request) => {
  if (request.method !== "POST") return new Response("POST only", { status: 405 });
  const blocked = limited(request, "rpc", 480); if (blocked) return blocked;   // 480 calls / minute / IP (pages batch their reads; a household shares one IP)

  // Accept either name: the store historically used SOLANA_RPC, the standalone miner uses
  // HELIUS_RPC. Reading both means whichever the Netlify site has set just works (this was the
  // cause of the /mine "403 Access forbidden" fallback — the site only had HELIUS_RPC). Only take
  // a value that actually looks like an https URL, so a mistyped/garbage var is ignored, not forwarded.
  const pick = (v) => (typeof v === "string" && /^https?:\/\//i.test(v.trim())) ? v.trim() : "";
  const upstream = pick(process.env.SOLANA_RPC) || pick(process.env.HELIUS_RPC);
  if (!upstream) return new Response(JSON.stringify({ error: { message: "no valid RPC URL configured — set SOLANA_RPC or HELIUS_RPC to your Helius https URL" } }), { status: 500 });

  // Only serve requests from the store's own pages (exact host match — see originOk). This is spoofable
  // by a non-browser client, but it stops other websites from quietly spending the Helius quota (or
  // relaying transactions) through a visitor's browser.
  if (!originOk(request)) {
    return new Response(JSON.stringify({ error: { message: "forbidden origin" } }), { status: 403 });
  }

  // Body cap: refuse on the declared length first, then on what actually arrived.
  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > MAX_BODY_BYTES) return new Response(JSON.stringify({ error: { message: "request too large" } }), { status: 413 });
  let raw;
  try { raw = await request.text(); } catch { return new Response("bad body", { status: 400 }); }
  if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) return new Response(JSON.stringify({ error: { message: "request too large" } }), { status: 413 });
  let body;
  try { body = JSON.parse(raw); } catch { return new Response("bad json", { status: 400 }); }

  const calls = Array.isArray(body) ? body : [body];
  if (calls.length < 1 || calls.length > MAX_BATCH) {
    return new Response(JSON.stringify({ error: { message: `batch must hold 1–${MAX_BATCH} calls` } }), { status: 413 });
  }
  if (!calls.every((c) => callOk(c, calls.length))) {
    return new Response(JSON.stringify({ error: { message: "method or params not allowed" } }), { status: 403 });
  }
  // DAS answers are the heavy ones (an NFT page of JSON each): their own, smaller per-IP budget on top of the 480/min
  if (calls.some((c) => DAS_METHODS.has(c.method))) { const das = limited(request, "rpc-das", 90); if (das) return das; }

  // The upstream (Helius) rate-limits bursts with a 429. Retry ONCE with a short backoff so a busy second
  // doesn't fail a page load, a mining read or a purchase step (more retries just multiply quota use).
  let res, text;
  const plain = calls.every((c) => PUBLIC_OK.has(c?.method));
  const jsonHeaders = { "content-type": "application/json", "cache-control": "no-store" };
  if (Date.now() < breakerUntil) {   // Helius saturated a moment ago
    if (plain) {
      try { const p = await fetch(PUBLIC_RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); return new Response(await p.text(), { status: p.status, headers: jsonHeaders }); }
      catch (_) { /* fall through to the busy reply */ }
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: calls[0]?.id ?? 1, error: { code: -32005, message: "Solana RPC busy — try again in a few seconds." } }), { status: 503, headers: { ...jsonHeaders, "retry-after": "10" } });
  }
  for (let attempt = 0; ; attempt++) {
    try {
      res = await fetch(upstream, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (e) {
      // A dropped upstream connection used to crash the function (an HTML 500 the page could not
      // parse, which stalled checkouts). Retry, then fall back to the public RPC for plain calls.
      if (attempt < 2) { await new Promise((r) => setTimeout(r, 250 * (attempt + 1))); continue; }
      if (plain) {
        try {
          const p = await fetch(PUBLIC_RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
          return new Response(await p.text(), { status: p.status, headers: jsonHeaders });
        } catch (_) { /* fall through to a JSON error */ }
      }
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: calls[0]?.id ?? 1, error: { code: -32000, message: "Solana RPC unavailable — try again in a moment." } }), { status: 502, headers: jsonHeaders });
    }
    if (res.status === 429 && attempt < 1) { await new Promise((r) => setTimeout(r, 300)); continue; }
    if (res.status === 429) breakerUntil = Date.now() + BREAKER_MS;   // still 429 after the retry → open the breaker
    // Helius still busy: plain (non-DAS) calls can be served by Solana's public RPC instead.
    if (res.status === 429 && plain) {
      const p = await fetch(PUBLIC_RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (p.ok) { res = p; }
    }
    text = await res.text();
    break;
  }
  return new Response(text, {
    status: res.status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
};

// No Netlify platform rate-limit rule here any more (2026-10-26): tripping it repeatedly got the owner's own home IP
// blocked at Netlify's edge (connections dropped to BOTH sites for ~15 min). The per-IP limiter inside the function
// (limited(), 480/min) still guards the Helius key and answers with a normal 429 JSON the pages back off from.
export const config = { path: "/api/rpc" };
