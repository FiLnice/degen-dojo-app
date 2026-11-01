// Netlify Function: live numbers for the /orewizard and /oreparties pages at /api/wizard (owner 2026-11-01).
//
// Cached answers, so the pages cost next to nothing whatever the traffic (see the free plan note in store-fn-rpc.mjs).
// ?market=1 is the ORE board, treasury, last 8 rounds and ORE price, cached 20 seconds, which an open page polls so the numbers stay live:
// about 6 RPC calls a minute at most, however many people are watching. The default answer is the parties minting on ore.party, 2 minutes.
// That answer also carries the last 100 finished rounds' final boards, read at most every 10 minutes, to show how often a price filter would pass.
// ?party=<slug> looks up any other party when someone pastes its link.
// ?board=1 is every ended and mining party's settings and results, for the leaderboard and the comparisons. Ended parties never
// change, so each is fetched once and kept in Blobs: a refresh only calls ore.party for the ones still mining, every 15 minutes at most.
// Each comes with ORE's average price in SOL while it ran (one GeckoTerminal call), so results can be compared at the price of the time.
// ore.party is outside data: only the fields in cleanParty pass through, and its holder lists never leave this function.
import { limited } from "./store-ratelimit-core.mjs";
import { getStore } from "@netlify/blobs";
import { createHash } from "node:crypto";

const ORE_PROGRAM = "oreV3EG1i9BEgiAJ8b177Z2S2rMarzak4NMv1kULvWv";
const BOARD = "BrcSxdp1nXFzou1YyDnQJcPNBNHgoypZmTsyKBSLLXzi";
const TREASURY = "45db2FSR4mcXdSVVZbKbwojU6uYDpMyhpEi7cC8nHaWG";
const ORE_MINT = "oreoU2P8bN6jkk3jbaiVxYnG1dCXcYxwhwyK9jSybcp", SOL_MINT = "So11111111111111111111111111111111111111112";
const ORE_SOL_POOL = "3Mt1bpU3fnSXyPEm66HKKXyQTpLWrwYziPLqwTqK4ZT7";   // the deepest ORE/SOL pool, for past prices
const PARTIES = "https://ore.party/api/parties";
const SLUG = /^[a-z0-9-]{1,64}$/;
const ROUNDS_BACK = 8, BOARDS_BACK = 100, BOARDS_TTL_MS = 600000, PRICES_TTL_MS = 21600000, PARALLEL = 8, TIMEOUT_MS = 4000, BOARD_BUDGET_MS = 5500, BOARD_CALLS = 70;

// Round address. Self-contained on purpose (no web3 in the function bundle): same base58 + on-curve + PDA rule as store-fn-dd-listings.mjs.
const ALPH = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58decode(s) {
  let n = 0n;
  for (const c of s) n = n * 58n + BigInt(ALPH.indexOf(c));
  const out = [];
  while (n > 0n) { out.unshift(Number(n & 255n)); n >>= 8n; }
  for (const c of s) { if (c === "1") out.unshift(0); else break; }
  return Uint8Array.from(out);
}
function b58encode(bytes) {
  let n = 0n; for (const b of bytes) n = (n << 8n) | BigInt(b);
  let s = ""; while (n > 0n) { s = ALPH[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b === 0) s = "1" + s; else break; }
  return s;
}
const P = (1n << 255n) - 19n;
const D = 37095705934669439343138083508754565189542113879843219016388785533085940283555n;
const SQRT_M1 = 19681161376707505956807079304988542015446066515923890162744021073123829784752n;
const md = (a) => { const r = a % P; return r >= 0n ? r : r + P; };
function pw(b, e) { let r = 1n; b = md(b); while (e > 0n) { if (e & 1n) r = (r * b) % P; b = (b * b) % P; e >>= 1n; } return r; }
function isOnCurve(bytes) {
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
const u64le = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };
function roundAddress(id) {
  const prog = b58decode(ORE_PROGRAM);
  for (let bump = 255; bump >= 0; bump--) {
    const h = createHash("sha256");
    h.update(Buffer.from("round")); h.update(u64le(id)); h.update(Uint8Array.of(bump));
    h.update(prog); h.update(Buffer.from("ProgramDerivedAddress"));
    const d = new Uint8Array(h.digest());
    if (!isOnCurve(d)) return b58encode(d);
  }
  throw new Error("no viable bump");
}
const accountData = (a) => Buffer.from(a.data[0], "base64");

async function rpc(method, params) {
  const url = [process.env.SOLANA_RPC, process.env.HELIUS_RPC].find((u) => /^https:\/\//.test(u || ""));
  if (!url) throw new Error("no RPC configured");
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(TIMEOUT_MS) });
  const j = await r.json();
  if (j.error) throw new Error(`rpc ${method}: ${j.error.message || "error"}`);
  return j.result;
}

async function orePriceInSol() {
  const r = await fetch(`https://lite-api.jup.ag/price/v3?ids=${ORE_MINT},${SOL_MINT}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  const j = await r.json(), o = j[ORE_MINT]?.usdPrice, s = j[SOL_MINT]?.usdPrice;
  return o && s ? o / s : null;
}

// Board: round id @8, production cost EMA @32 (lamports per ORE). Treasury: Motherlode @8 (11 decimals). Round: tiles u64[25] @16.
let lastPot = { round: null, value: null };   // finished rounds never change, so a warm instance reads them once a round
async function market() {
  const [board, treasury] = (await rpc("getMultipleAccounts", [[BOARD, TREASURY], { encoding: "base64" }])).value.map(accountData);
  const roundId = board.readBigUInt64LE(8);
  if (lastPot.round !== roundId) {
    const ids = Array.from({ length: ROUNDS_BACK }, (_, i) => roundId - BigInt(i + 1));
    const rounds = (await rpc("getMultipleAccounts", [ids.map(roundAddress), { encoding: "base64" }])).value;
    const pots = rounds.filter(Boolean).map((a) => {
      const d = accountData(a); let sum = 0;
      for (let i = 0; i < 25; i++) sum += Number(d.readBigUInt64LE(16 + 8 * i));
      return sum / 25 / 1e9;
    }).filter((p) => p > 0).sort((a, b) => a - b);
    lastPot = {
      round: roundId,
      value: pots.length ? pots[Math.floor(pots.length / 2)] : null,   // median, so one odd round doesn't skew it
      seconds: await roundSeconds(ids, rounds).catch(() => lastPot.seconds),
    };
  }
  return {
    roundId: roundId.toString(),
    motherlode: Number(treasury.readBigUInt64LE(8)) / 1e11,
    prodCost: Number(board.readBigUInt64LE(32)) / 1e9,
    tilePot: lastPot.value,
    roundSec: lastPot.seconds,
    orePrice: await orePriceInSol().catch(() => null),
  };
}
// What a round really takes, gaps included: the slots between finished rounds (Round.expires_at @648 is end slot + a fixed term) × today's slot time.
async function roundSeconds(ids, rounds) {
  const known = ids.map((id, i) => rounds[i] && { id, slot: accountData(rounds[i]).readBigUInt64LE(648) }).filter(Boolean);
  if (known.length < 2) return null;
  const newest = known[0], oldest = known[known.length - 1];
  const slots = Number(newest.slot - oldest.slot) / Number(newest.id - oldest.id);
  const samples = await rpc("getRecentPerformanceSamples", [3]);
  const perSlot = samples.reduce((t, s) => t + s.samplePeriodSecs, 0) / samples.reduce((t, s) => t + s.numSlots, 0);
  return slots * perSlot;
}

// The final board of each recent round in SOL. Only the tile totals are read (u64[25] @16), so one call stays small.
let lastBoards = { at: 0, value: null };
async function recentBoards() {
  if (Date.now() - lastBoards.at < BOARDS_TTL_MS) return lastBoards.value;
  const [board] = (await rpc("getMultipleAccounts", [[BOARD], { encoding: "base64" }])).value.map(accountData);
  const roundId = board.readBigUInt64LE(8), ids = Array.from({ length: BOARDS_BACK }, (_, i) => roundId - BigInt(i + 1));
  const rounds = (await rpc("getMultipleAccounts", [ids.map(roundAddress), { encoding: "base64", dataSlice: { offset: 16, length: 200 } }])).value;
  const value = rounds.filter(Boolean).map((a) => {
    const d = accountData(a); let sum = 0;
    for (let i = 0; i < 25; i++) sum += Number(d.readBigUInt64LE(8 * i));
    return +(sum / 1e9).toFixed(3);
  }).filter((b) => b > 0);
  lastBoards = { at: Date.now(), value };
  return value;
}

// ORE's price in SOL for each past day, from the middle of its daily candle. Kept in Blobs, so a GeckoTerminal hiccup costs nothing.
let lastPrices = { at: 0, value: null };
async function pastPrices(store) {
  if (Date.now() - lastPrices.at < PRICES_TTL_MS) return lastPrices.value;
  try {
    const r = await fetch(`https://api.geckoterminal.com/api/v2/networks/solana/pools/${ORE_SOL_POOL}/ohlcv/day?aggregate=1&limit=365&currency=token`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    const candles = (await r.json())?.data?.attributes?.ohlcv_list;
    if (!Array.isArray(candles) || !candles.length) throw new Error("no candles");
    const value = Object.fromEntries(candles.map((c) => [new Date(c[0] * 1000).toISOString().slice(0, 10), (c[1] + c[4]) / 2]));
    await store.setJSON("prices", value).catch(() => {});
    lastPrices = { at: Date.now(), value };
    return value;
  } catch { return lastPrices.value || (await store.get("prices", { type: "json" }).catch(() => null)); }
}
// A party's run ends at its last round. It mined nearly every round its Motherlode range allowed (Motherlode sizes fall off exponentially
// around 100 ORE), so that sets when it started, never before the party existed.
function runPrice(q, days, roundNow, roundSec) {
  if (!days || !q.last || !roundNow) return null;
  const allowed = Math.exp(-q.minML / 100) - (q.maxML ? Math.exp(-q.maxML / 100) : 0);
  const end = Date.now() - (roundNow - q.last) * roundSec * 1000;
  const start = Math.max(Date.parse(q.created) || 0, end - (q.rounds / Math.max(allowed, 0.05)) * roundSec * 1000);
  let sum = 0, n = 0;
  for (let t = start; t <= end; t += 21600000) { const p = days[new Date(t).toISOString().slice(0, 10)]; if (p) { sum += p; n++; } }
  return n ? +(sum / n).toFixed(4) : null;
}

const num = (v) => (v == null || v === "" || !Number.isFinite(+v) ? null : +v);
function cleanParty(m, row) {
  const s = m.strategy || {}, pro = s.pro || {}, a = m.assets || {}, log = m.miningLog || {};
  const status = String(m.status || "").slice(0, 20), sol = num(a.sol) || 0;
  return {
    name: String(m.name || row?.name || m.slug).slice(0, 60), slug: m.slug, status,
    supply: num(row?.supply), minted: num(row?.minted), price: num(row?.mintPriceSol), closes: typeof row?.mintClosesAt === "string" ? row.mintClosesAt.slice(0, 40) : null,
    sol, pro: s.mode === "pro", solo: num(s.soloTiles) || 0, split: num(s.splitTiles) || 0, perTile: num(s.solPerTile) || 0,
    minML: num(s.minMotherlodeOre) || 0, maxML: num(s.maxMotherlodeOre), secs: num(pro.secondsLeft),
    bps: pro.solPerTileMode === "share" ? num(pro.tileShareBps) || 0 : 0, disc: num(pro.minDiscountPct), countML: !!pro.countMotherlode,
    rounds: num(log.totalRounds) || 0, last: num(log.rows?.[0]?.roundId), solos: num(log.soloWins) || 0, mls: num(log.motherlodeWins) || 0, oreWon: num(log.oreWon) || 0,
    spent: status === "minting" ? 0 : Math.max(0, (num(s.rounds) || 0) * (num(s.solPerRound) || 0) - sol),   // the vault it started with, less what's left
    created: typeof row?.createdAt === "string" ? row.createdAt.slice(0, 10) : "",
  };
}
async function getParty(row) {
  const r = await fetch(`${PARTIES}/${row.slug}/mining?limit=1`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!r.ok) throw new Error(`party ${r.status}`);
  const m = await r.json();
  return cleanParty({ ...m, slug: row.slug }, row);
}
const listParties = async () => {
  const j = await (await fetch(PARTIES, { signal: AbortSignal.timeout(TIMEOUT_MS) })).json();
  if (!Array.isArray(j.parties)) throw new Error("ore.party: no list");
  return j.parties.filter((x) => SLUG.test(x.slug || ""));
};
async function getParties(rows, until = Infinity) {
  const queue = [...rows], out = [];
  const work = async () => {
    for (let row = queue.shift(); row && Date.now() < until; row = queue.shift()) {
      try { out.push(await getParty(row)); }
      catch (e) { if (e.message === "party 429") queue.length = 0; /* any other failure: one bad party shouldn't cost the rest */ }
    }
  };
  await Promise.all(Array.from({ length: PARALLEL }, work));
  return out;
}
const mintingParties = async () => getParties((await listParties()).filter((x) => x.status === "minting"));

// ore.party answers 429 after about 120 calls in a burst, so a run stops at BOARD_CALLS, mining parties first. Filling Blobs takes
// a few runs: each hands back what it has, stays cached for a minute, and the next carries on from what Blobs kept.
async function boardParties() {
  const until = Date.now() + BOARD_BUDGET_MS;
  const rows = (await listParties()).filter((x) => x.status !== "minting" && x.status !== "dissolved" && !x.private);
  const store = getStore("wizard-parties");
  const ended = (await store.get("ended-v2", { type: "json" }).catch(() => null)) || {};
  const todo = rows.filter((x) => !(x.status === "complete" && ended[x.slug])).sort((a, b) => (a.status === "complete") - (b.status === "complete"));
  const fresh = await getParties(todo.slice(0, BOARD_CALLS), until);
  const newlyEnded = fresh.filter((p) => p.status === "complete");
  if (newlyEnded.length) {
    for (const p of newlyEnded) ended[p.slug] = p;
    await store.setJSON("ended-v2", ended).catch(() => {});
  }
  const bySlug = new Map(fresh.map((p) => [p.slug, p]));
  const parties = rows.map((x) => bySlug.get(x.slug) || (x.status === "complete" ? ended[x.slug] : null)).filter(Boolean);
  const [days, live] = await Promise.all([pastPrices(store), market().catch(() => null)]);
  for (const p of parties) p.px = runPrice(p, days, Number(live?.roundId), live?.roundSec || 77);
  return { parties, whole: parties.length === rows.length };
}
let lastParties = null, lastBoard = null;   // a warm instance rides out an ore.party hiccup on the last good lists

export default async (request) => {
  const blocked = limited(request, "wizard", 60); if (blocked) return blocked;   // 60 / minute / IP (DD-04)
  const q = new URL(request.url).searchParams, slug = q.get("party");
  if (q.has("market")) {
    const live = await market().catch(() => null);
    return json({ market: live }, live ? 20 : 5, 10);
  }
  if (q.has("board")) {
    try {
      const b = await boardParties();
      if (b.parties.length) lastBoard = b.parties;
      return json({ parties: b.parties }, b.whole ? 900 : 60, 3600);
    } catch { return json({ parties: lastBoard }, 20); }
  }
  if (slug !== null) {
    if (!SLUG.test(slug)) return json({ party: null }, 300);
    try {
      const row = (await listParties()).find((x) => x.slug === slug);
      return json({ party: row ? await getParty(row) : null }, 120);
    } catch { return json({ party: null, failed: true }, 20); }
  }
  try {
    const [parties, boards] = await Promise.all([mintingParties(), recentBoards().catch(() => lastBoards.value)]);
    lastParties = parties;
    return json({ parties, boards }, 120);
  } catch { return json({ parties: lastParties, boards: lastBoards.value }, 20); }
};

function json(o, sMaxAge, stale = 300) {
  return new Response(JSON.stringify(o), { headers: {
    "content-type": "application/json",
    "cache-control": `public, max-age=0, s-maxage=${sMaxAge}, stale-while-revalidate=${stale}`,
    "netlify-cdn-cache-control": `public, s-maxage=${sMaxAge}, stale-while-revalidate=${stale}`,
    "netlify-vary": "query",   // ?board=1 and ?party= are separate answers
  } });
}

export const config = { path: "/api/wizard" };
