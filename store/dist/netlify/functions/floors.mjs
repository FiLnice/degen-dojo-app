// Netlify Function: /api/floors — collection floor prices for the burn lists (Dojo Sweep + Burn to Mine), so an NFT that
// is worth more listed than burned is never offered as "burn for rent" by default (owner 2026-10-27: a DeGod showed up
// as "+0.0083 SOL").
//
//   POST /api/floors  (application/json, same origin)  { groups: [{ key, sampleMint }, …≤ 40] }
//     →  { floors: { key: floorSol | null }, pending: [key…] }
//     key = the NFT's verified collection address, else (no verified collection) its first verified creator, else its mint;
//     null = floor unknown (not on Magic Eden, no listings, the pair didn't check out, or no answer). `pending` = keys not
//     settled this time (budget or a Magic Eden error) — the page asks for those again; it never breaks the scan.
//
// Trust (security review 2026-10-27): a cached answer is shared by every visitor, so a key's symbol is only looked up (and
// cached) after Helius confirms the sample mint really belongs to that key — verified collection == key, or no verified
// collection and first verified creator == key, or key == the mint itself. A pair that doesn't check out gets null, no
// Magic Eden call and no cache write. A Magic Eden 404 is cached as "no collection" for 1 h only and never replaces a known
// symbol. Only validated base58 / symbol values ever go into a Magic Eden path.
//
// Source: Magic Eden — GET /v2/tokens/{sampleMint} → the collection symbol (works for Metaplex Core ids too), then
// GET /v2/collections/{symbol}/stats → floorPrice (lamports). Cached in Netlify Blobs: symbol per key 24 h, floor per
// symbol 1 h. The Magic Eden key is shared with /api/mebuy and the listings, so a request makes ≤ 10 uncached Magic Eden
// calls and each warm instance ≤ 60 a minute.
// Env: SOLANA_RPC (or HELIUS_RPC) for the membership check; MAGICEDEN_API_KEY (optional).
import { getStore } from "@netlify/blobs";
import { limited } from "./store-ratelimit-core.mjs";

const ME = "https://api-mainnet.magiceden.dev/v2";
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SYMBOL = /^[A-Za-z0-9_.-]{1,80}$/;
const MAX_GROUPS = 40;
const SYMBOL_TTL = 24 * 3600e3, NONE_TTL = 3600e3, FLOOR_TTL = 3600e3;
const BUDGET_MS = 7000;            // stay well inside the function timeout; the rest comes back as `pending`
const CONCURRENCY = 3;             // Magic Eden's rate limit is per key / per IP
const ME_PER_REQUEST = 10;         // uncached Magic Eden calls one request may make
const ME_PER_MINUTE = 60;          // … and one warm instance, so /api/mebuy keeps headroom on the shared key
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });

// Same rule as /api/rpc's originOk: an Origin / Referer must be exactly this site's host (none at all = not a browser page).
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

// per warm instance: Magic Eden calls in the last minute
const meCalls = [];
const meBudgetLeft = (now = Date.now()) => { while (meCalls.length && meCalls[0] <= now - 60e3) meCalls.shift(); return ME_PER_MINUTE - meCalls.length; };

/** One Magic Eden GET. { body } on success, { none: true } on a real 404, null on anything else (not cached). */
async function meGet(path, apiKey) {
  meCalls.push(Date.now());
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 4000);
  try {
    const r = await fetch(ME + path, { headers: { accept: "application/json", ...(apiKey ? { Authorization: "Bearer " + apiKey } : {}) }, signal: ctl.signal });
    if (r.status === 404) return { none: true };
    if (!r.ok) return null;   // 400 / 429 / 5xx: unknown THIS time
    return { body: await r.json() };
  } catch { return null; } finally { clearTimeout(t); }
}

/** Which of the pairs really belong together (Helius DAS getAssetBatch on the sample mints). Set of keys that checked out. */
async function verifiedKeys(todo) {
  const ok = new Set(todo.filter((g) => g.key === g.mint).map((g) => g.key));   // a mint as its own key needs no check
  const need = todo.filter((g) => g.key !== g.mint);
  if (!need.length) return ok;
  const pick = (v) => (typeof v === "string" && /^https?:\/\//i.test(v.trim())) ? v.trim() : "";
  const rpc = pick(process.env.SOLANA_RPC) || pick(process.env.HELIUS_RPC);
  if (!rpc) return ok;   // can't check → nothing but mint keys is trusted
  try {
    const ids = [...new Set(need.map((g) => g.mint))];
    const r = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAssetBatch", params: { ids } }) });
    const j = await r.json();
    const byId = new Map(((j && j.result) || []).filter((a) => a && a.id).map((a) => [a.id, a]));
    for (const g of need) {
      const a = byId.get(g.mint);
      if (!a || a.burnt) continue;
      const coll = (a.grouping || []).find((x) => x && x.group_key === "collection" && x.verified !== false);
      const creator = (a.creators || []).find((c) => c && c.verified && c.address);
      if (coll ? coll.group_value === g.key : !!creator && creator.address === g.key) ok.add(g.key);
    }
  } catch { /* RPC down: only mint keys */ }
  return ok;
}

export default async (request) => {
  if (request.method !== "POST") return json({ error: "POST { groups: [{ key, sampleMint }] }" }, 405);
  if (!/^application\/json\b/i.test(request.headers.get("content-type") || "")) return json({ error: "content-type must be application/json" }, 415);
  if (!originOk(request)) return json({ error: "forbidden origin" }, 403);
  const blocked = limited(request, "floors", 12); if (blocked) return blocked;   // 12 / minute / IP (≈ 480 groups)
  let body; try { body = await request.json(); } catch { return json({ error: "bad json" }, 400); }
  const groups = Array.isArray(body && body.groups) ? body.groups : null;
  if (!groups || !groups.length || groups.length > MAX_GROUPS) return json({ error: `groups: 1–${MAX_GROUPS}` }, 400);
  const todo = [], seen = new Set();
  for (const g of groups) {
    if (!g || !B58.test(String(g.key || "")) || !B58.test(String(g.sampleMint || ""))) return json({ error: "bad key / sampleMint" }, 400);
    if (!seen.has(g.key)) { seen.add(g.key); todo.push({ key: g.key, mint: g.sampleMint }); }
  }
  const apiKey = process.env.MAGICEDEN_API_KEY || "";
  let syms = null, prices = null;
  try { syms = getStore("floor-symbols"); prices = getStore("floor-prices"); } catch { /* no Blobs: just no cache */ }
  const read = async (store, k) => { try { return store ? await store.get(k, { type: "json" }) : null; } catch { return null; } };
  const write = async (store, k, v) => { try { if (store) await store.setJSON(k, v); } catch { /* cache is best effort */ } };

  const t0 = Date.now(), floors = {}, pending = [];
  const trusted = await verifiedKeys(todo);
  let meLeft = ME_PER_REQUEST;
  const canCallMe = () => meLeft > 0 && meBudgetLeft() > 0 && Date.now() - t0 <= BUDGET_MS;
  const symbolOf = async (g) => {   // "" = Magic Eden has no collection for it; undefined = not settled this time
    const c = await read(syms, g.key);
    const fresh = c && typeof c.symbol === "string" && Date.now() - c.at < (c.symbol ? SYMBOL_TTL : NONE_TTL);
    if (fresh) return c.symbol;
    if (!canCallMe()) return c && c.symbol ? c.symbol : undefined;   // over budget: a stale symbol still beats nothing
    meLeft--;
    const r = await meGet(`/tokens/${g.mint}`, apiKey);
    if (!r) return c && c.symbol ? c.symbol : undefined;
    const s = r.none ? "" : String((r.body && r.body.collection) || "");
    if (!r.none && !SYMBOL.test(s)) return c && c.symbol ? c.symbol : "";   // odd answer: don't cache it
    if (!s && c && c.symbol) return c.symbol;                               // never replace a known symbol with "none"
    await write(syms, g.key, { symbol: s, at: Date.now() });
    return s;
  };
  const floorOf = async (symbol) => {   // SOL, null = no floor (no listings), undefined = not settled this time
    const c = await read(prices, symbol);
    if (c && Date.now() - c.at < FLOOR_TTL) return c.floor;
    if (!canCallMe()) return undefined;
    meLeft--;
    const r = await meGet(`/collections/${encodeURIComponent(symbol)}/stats`, apiKey);
    if (!r) return undefined;
    const lam = r.none ? 0 : Number(r.body && r.body.floorPrice);
    const floor = lam > 0 ? Math.round(lam) / 1e9 : null;
    await write(prices, symbol, { floor, at: Date.now() });
    return floor;
  };
  const perSymbol = new Map();   // one stats call per symbol per request
  let i = 0;
  const worker = async () => {
    while (i < todo.length) {
      const g = todo[i++];
      floors[g.key] = null;
      if (!trusted.has(g.key)) continue;   // the pair didn't check out: no lookup, no cache
      const symbol = await symbolOf(g);
      if (symbol === undefined) { pending.push(g.key); continue; }
      if (!symbol) continue;
      if (!perSymbol.has(symbol)) perSymbol.set(symbol, floorOf(symbol));
      const f = await perSymbol.get(symbol);
      if (f === undefined) { pending.push(g.key); continue; }
      floors[g.key] = f;
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return json({ floors, pending });
};

export const config = { path: "/api/floors" };
