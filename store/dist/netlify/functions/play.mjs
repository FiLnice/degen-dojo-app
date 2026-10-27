// Netlify Function: server-authoritative play lifecycle at /api/play
//
// This is the anti-cheat core. Tickets can ONLY be minted here, and only for a
// play that (a) was paid for with a server-held coin and (b) whose WIN was
// recomputed by us — never taken on the client's word.
//
//   POST {action:"start",  token, game}
//        → auth the wallet, DEBIT 1 coin, commit a secret seed, return a playId
//          and sha256(seed). For chance games the seed stays secret so the player
//          can't see the outcome before they choose.
//   POST {action:"move",   token, playId, round, pick}            (Degen Duel only)
//        → the Duel is played ONE server-locked round at a time: the seed and the future
//          battle stats never leave the server until the duel is over (audit DD-02 — a
//          revealed seed let players try all 40,320 card orders offline). Each round takes
//          exactly one card; the server resolves it and only then reveals the next stat.
//   POST {action:"finish", token, playId, pick?, inputLog?}
//        → recompute the outcome server-side (per-game verifier), mint tickets to
//          the wallet (play = 1, verified win = 3, +5 grand slam per round; ×2 for 5+ Degen holders), reveal
//          the seed. The client's claimed result is ignored.
//          A play belongs to the round it was STARTED in (security review M11 — ticket hoarding): finished in a
//          later round more than 30 min after it started, it earns the play ticket only (no win bonus), and an
//          open play can't be finished at all after 24 h (store-draw-core PLAY_TTL_MS / ROUND_GRACE_MS).
//
// Fail-closed: if a game's outcome verifier isn't available yet, the win is NOT
// trusted — the play still earns its 1 base ticket (the coin was really spent),
// but the win bonus is withheld and flagged. No path mints tickets for free.
//
//   POST {action:"seeker", token}
//        → ONE free coin per Seeker phone: the session wallet must hold a genuine Seeker
//          Genesis Token (checked on-chain). The claim is keyed by the SGT MINT (the SGT is frozen
//          with a permanent delegate, so it is soulbound in practice — keying by mint holds either
//          way) and the wallet is marked too (no second SGT, same wallet).
//
//   POST {action:"free", token}
//        → the FREE WEEKLY COIN (owner 2026-10-27 — the "no purchase necessary" way into the weekly Pot): one coin per
//          weekly round. A Seeker owner gets it per Seeker Genesis Token (one per DEVICE per round, however many wallets —
//          no wallet-age check); anyone else per wallet whose first on-chain transaction is 30+ days old (anti-sybil).
//          One per wallet per round either way. Free coins add NOTHING to the Pot and earn no preacher cut.
//
// Env: SESSION_SECRET (≥ 32 chars; no fallback — fails closed, see store-session-core.mjs). SOLANA_RPC for the Seeker
// and wallet-age checks.
import { limited } from "./store-ratelimit-core.mjs";
import { getStore } from "@netlify/blobs";
import { getStrong } from "./store-verify-core.mjs";
import { casUpdate, readWithEtag, putIfNew, putIfMatch, pushId, CasError } from "./store-cas-core.mjs";
import { checkToken, sessionReady, sessionUnavailable } from "./store-session-core.mjs";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { simulate as flipSimulate } from "./dojo-flip-engine.mjs";
import { POOL as FLIP_POOL } from "./flip-pool.mjs";
import { dealHands, statsFromDigest, playRound, freshState, winnerOf, simulateV2, DUEL_V2, STATS_TAG } from "./dojo-duel-engine.mjs";
import { DUEL_POOL } from "./duel-pool.mjs";
import { ticketRound, ticketKey, mintedInSnapshot, PLAY_TTL_MS, ROUND_GRACE_MS } from "./store-draw-core.mjs";
import { lastDrawTime } from "./store-payout-core.mjs";

const GAMES = new Set(["duel", "flip", "teto", "cluck", "brawl"]);
// Grand slam (+5, once per draw round): PLAY all five games in the same round, win or lose — it
// rewards using coins across every game. Tickets reset after every draw (store-fn-draw archives
// them), so "same week" = same round.
const SLAM_WIN_GAMES = [];
const SLAM_PLAY_GAMES = ["duel", "flip", "cluck", "brawl", "teto"];
const WIN = 3, PLAY = 1, GRAND_SLAM = 5;
// Degen Duel is skill: a sensible player takes the Dojo ~70% of the time (security review INFO-3), so a 3-chance win made
// it pay ~2.4 chances per coin against ~2.0 for Flip and 1.25 for Cluck/Brawl. A Duel win is worth 2 (owner
// 2026-10-25: "the same as other games") → ~1.7 per coin for a strong player.
const WIN_BY_GAME = { duel: 2 };
// Holders of 5+ Degen Dojo fighters earn 2× chances on everything they play (0 plays → 0 chances).
// A wallet's count is re-checked every 10 min, and each Degen backs ONE wallet's 2× for an hour — the same five
// NFTs passed from wallet to wallet can't make every wallet a holder (security review LOW-2).
const DD_COLLECTION = "2m9DupVeheZ5vfuXZxqV3KSQ7HnVDk2tG6ouH1ZnLwYb";
const HOLDER_MIN = 5, HOLDER_MULT = 2, HOLDER_TTL_MS = 10 * 60 * 1000, ASSET_CLAIM_MS = 60 * 60 * 1000;
const SEEKER_FREE_COINS = 1;   // free coins for a Seeker owner — once per Seeker device (SGT mint)
const sha256 = (b) => createHash("sha256").update(b).digest("hex");
// Degen Duel v2: the 8 battle stats = SHA-256(seed + STATS_TAG) (same as the engine's roundStats)
const duelStats = (seedHex) => statsFromDigest(createHash("sha256").update(String(seedHex) + STATS_TAG).digest());
const DUEL_ROUNDS = 8, DUEL_TTL_MS = 30 * 60 * 1000;   // an unfinished duel can't be played on after 30 min

// ── per-game outcome verifiers ──────────────────────────────────────────────
// Each returns { won:boolean } or { error } (fail-closed) or { unverified:true }.
const BIRDS = 8;
function seedInt(seedHex, tag) { return createHmac("sha256", Buffer.from(seedHex, "hex")).update(tag).digest().readUInt32BE(0); }

const VERIFIERS = {
  // Cluck-Fu — pure chance. Winning rooster = HMAC(seed,'cluck') % 8, fixed the
  // moment the seed was committed (before the player picked). Player wins iff they
  // backed that rooster. Fully recomputable from the revealed seed.
  cluck(play, sub) {
    const pick = sub.pick;   // a real number only (null / "" / [7] / true are refused, not coerced)
    if (typeof pick !== "number" || !Number.isInteger(pick) || pick < 0 || pick >= BIRDS) return { error: "bad pick" };
    const winner = seedInt(play.seed, "cluck:" + play.playId) % BIRDS;
    return { won: pick === winner, winner, birds: BIRDS };
  },
  // Dojo Flip — no skill (you flip a face-down card), so the whole game is a pure
  // function of (committed seed → shuffle, chosen stat, mode). We replay the SAME
  // shared engine the client animated and check who actually won. Fully verifiable.
  flip(play) {
    const stat = play.stat, mode = play.mode === "comp" ? "comp" : "casual";   // locked at start
    if (!["a", "d", "h", "s"].includes(stat)) return { error: "bad stat" };
    let winner; try { winner = flipSimulate(FLIP_POOL, play.seed, stat, mode); } catch { return { error: "sim failed" }; }
    return { won: winner === "me", winner };   // 'me' is the human; 'ai'/'draw' → no win bonus
  },
  // Degen Duel — best-of-8 card game, played round by round through action "move" (v2). The
  // cards were locked one round at a time on the server, so the winner is a replay of the
  // STORED moves from the secret seed — nothing the client sends at finish is used.
  // A duel started before v2 (its seed was revealed at start → its order could be optimised
  // offline, audit DD-02) earns only the participation entry.
  duel(play) {
    if (play.duel?.v !== DUEL_V2) return { unverified: true };
    const d = play.duel;
    if (d.round !== DUEL_ROUNDS || !Array.isArray(d.moves) || d.moves.length !== DUEL_ROUNDS) return { error: "play all 8 rounds first" };
    let winner;
    try { winner = simulateV2(DUEL_POOL, play.seed, duelStats(play.seed), d.moves.map((m) => m.yi)); } catch { return { error: "illegal duel" }; }
    if (winner !== winnerOf(d.state)) return { error: "duel replay mismatch" };   // stored rounds must agree with a full replay
    return { won: winner === "me", winner };   // 'me' is the human; 'dojo'/'draw' → no win bonus
  },
  // Cock Brawl — pure chance, 8-rooster ring royale. Surviving rooster =
  // HMAC(seed,'brawl:'+playId) % 8, fixed at commit (before the player backs a bird).
  // Player wins iff they backed the last bird standing. Fully recomputable from the seed.
  brawl(play, sub) {
    const pick = sub.pick;
    if (typeof pick !== "number" || !Number.isInteger(pick) || pick < 0 || pick >= BIRDS) return { error: "bad pick" };
    const winner = seedInt(play.seed, "brawl:" + play.playId) % BIRDS;
    return { won: pick === winner, winner };
  },
  // Teto — real-time skill; flat entries by design (see the ticket model). Fail-closed
  // here means a Teto win earns the same 1 entry as a play, which is intended.
  teto() { return { unverified: true }; },
};

// What the player learns after Duel round `round` (0-based) is resolved: that round's cards and
// result, the score so far, and — unless the duel is over — the NEXT round's battle stat only.
function duelMoveReply(rec, round) {
  const m = rec.duel.moves[round], done = rec.duel.moves.slice(0, round + 1);
  const sY = done.filter((x) => x.r === "w").length, sD = done.filter((x) => x.r === "l").length;
  const complete = round + 1 >= DUEL_ROUNDS;
  return { round: round + 1, k: m.k, yi: m.yi, di: m.di, r: m.r, sY, sD, complete,
    ...(complete ? { winner: sY > sD ? "me" : sY < sD ? "dojo" : "draw" } : { nextStat: duelStats(rec.seed)[round + 1] }) };
}

// ── server coin ledger (credited only by verified on-chain purchases + the one Seeker coin) ──
// Every balance / play / ticket mutation is a compare-and-swap (store-cas-core.mjs): two
// concurrent starts can't spend one coin twice, two concurrent finishes can't award twice.
async function getCoins(bstore, wallet) { const b = await getStrong(bstore, "bal:" + wallet); return b?.coins || 0; }
class NoCoins extends Error { constructor(coins) { super("no coins"); this.coins = coins; } }
const PLAY_IDS_MAX = 500;   // recent finished playIds kept on the ticket record (idempotent ticket mint)

// ── Seeker Genesis Token (SGT) check ────────────────────────────────────────
// A genuine SGT is a Token-2022 mint, supply 1, minted by the Seeker mint authority, whose
// metadata pointer AND token-group membership both point at the Seeker group account.
// (GT2zu… = mint/metadata-pointer authority, GT22s… = the group / metadata account.)
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const SGT_MINT_AUTHORITY = "GT2zuHVaZQYZSyQMgJPLzvkmyztfyXg2NJunqFp4p3A4";
const SGT_GROUP = "GT22s89nU4iWFkNXj1Bw6uYhJJWDRPpShHt4Bk8f99Te";

async function solanaRpc(method, params) {
  const url = process.env.SOLANA_RPC;
  if (!url) throw new Error("SOLANA_RPC not set");
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  if (!res.ok) throw new Error("rpc http " + res.status);
  const j = await res.json();
  if (j.error) throw new Error(j.error.message || method + " failed");
  return j.result;
}

// How many Degen Dojo fighters back this wallet's 2×? Cached 10 min per wallet (Blobs "holders", w:<wallet>).
// Each counted NFT is claimed for this wallet for ASSET_CLAIM_MS (a:<asset id>, conditional write): an NFT another
// wallet counted within the hour doesn't count here. Look-alikes never count (DAS lists verified collections only).
// Any lookup failure → treated as not a holder for this play (never blocks the game).
const CLAIM_CHECKS_MAX = 50;   // stop after this many claim lookups (a whale's first five are almost always free)
async function ddHolderMult(wallet) {
  const cache = getStore("holders");
  try {
    const c = await cache.get("w:" + wallet, { type: "json" });
    if (c && Date.now() - c.at < HOLDER_TTL_MS) return c.count >= HOLDER_MIN ? HOLDER_MULT : 1;
  } catch {}
  try {
    const ids = [];
    for (let page = 1; page <= 5; page++) {
      const res = await solanaRpc("getAssetsByOwner", { ownerAddress: wallet, page, limit: 1000 });
      const items = res?.items || [];
      for (const a of items) if (a?.id && !a.burnt && (a.grouping || []).some((g) => g.group_key === "collection" && g.group_value === DD_COLLECTION)) ids.push(a.id);
      if (items.length < 1000) break;
    }
    let count = 0;
    const now = Date.now();
    for (const id of ids.slice(0, CLAIM_CHECKS_MAX)) {
      if (count >= HOLDER_MIN) break;
      if (await claimAsset(cache, id, wallet, now)) count++;
    }
    try { await cache.setJSON("w:" + wallet, { count, at: now }); } catch {}
    return count >= HOLDER_MIN ? HOLDER_MULT : 1;
  } catch { return 1; }
}
// true if `id` may back `wallet` now: unclaimed, expired, or already ours → (re)claimed for us. A lost race = not ours.
async function claimAsset(cache, id, wallet, now) {
  const key = "a:" + id;
  const { value, etag } = await readWithEtag(cache, key);
  if (value && value.wallet !== wallet && now - (value.at || 0) < ASSET_CLAIM_MS) return false;
  const next = { wallet, at: now };
  return etag ? await putIfMatch(cache, key, next, etag) : await putIfNew(cache, key, next);
}

// is this parsed mint account a genuine SGT?
export function isSeekerGenesisMint(acct) {
  if (!acct || acct.owner !== TOKEN_2022) return false;
  const info = acct.data?.parsed?.info;
  if (!info || info.mintAuthority !== SGT_MINT_AUTHORITY || String(info.supply) !== "1") return false;
  const ext = Array.isArray(info.extensions) ? info.extensions : [];
  const ptr = ext.find((e) => e && e.extension === "metadataPointer");
  const mem = ext.find((e) => e && e.extension === "tokenGroupMember");
  return !!(ptr && ptr.state && ptr.state.authority === SGT_MINT_AUTHORITY && ptr.state.metadataAddress === SGT_GROUP &&
            mem && mem.state && mem.state.group === SGT_GROUP);
}

// every genuine SGT mint `wallet` currently holds. Throws on any RPC failure (→ 503, never
// "not a Seeker"). `rpc` is injectable for tests.
export async function findSeekerGenesisMints(wallet, rpc = solanaRpc) {
  const r = await rpc("getTokenAccountsByOwner", [wallet, { programId: TOKEN_2022 }, { encoding: "jsonParsed", commitment: "confirmed" }]);
  if (!r || !Array.isArray(r.value)) throw new Error("bad token-account response");
  const mints = [...new Set(r.value.map((a) => a?.account?.data?.parsed?.info)
    .filter((i) => i && i.mint && i.tokenAmount && i.tokenAmount.amount !== "0").map((i) => i.mint))];
  const out = [];
  for (let k = 0; k < mints.length; k += 100) {
    const batch = mints.slice(k, k + 100);
    const m = await rpc("getMultipleAccounts", [batch, { encoding: "jsonParsed", commitment: "confirmed" }]);
    if (!m || !Array.isArray(m.value)) throw new Error("bad mint response");
    m.value.forEach((acct, i) => { if (isSeekerGenesisMint(acct)) out.push(batch[i]); });
  }
  return out;
}

// ── free weekly coin ─────────────────────────────────────────────────────────
const FREE_COINS = 1;
const FREE_AGE_MS = 30 * 24 * 3600e3;   // a wallet's first transaction must be at least this old
const AGE_PAGES = 5;                    // getSignaturesForAddress pages of 1,000 (newest first) we read at most
const AGE_RECHECK_MS = 3600e3;          // a "too new" verdict with no known first transaction is re-checked after an hour
const nextDrawAt = (now = Date.now()) => lastDrawTime(now) + 7 * 24 * 3600e3;

// Is `wallet` old enough for the free weekly coin? Signatures come newest first, so the first one older than 30 days
// settles it. Reading AGE_PAGES full pages that are ALL newer than 30 days means 5,000+ transactions in a month: faking
// that costs a farm wallet ≥ 0.025 SOL in fees — far more than one free coin is worth — and it is what an active ORE
// auto-miner looks like, so such a busy wallet counts as eligible. A wallet with no transactions is not eligible.
// Throws on RPC failure (→ 503, never a wrong "too new"). `rpc` / `now` are injectable for tests.
export async function walletAgeVerdict(wallet, rpc = solanaRpc, now = Date.now()) {
  let before = null, oldest = null;
  for (let page = 0; page < AGE_PAGES; page++) {
    const sigs = await rpc("getSignaturesForAddress", [wallet, { limit: 1000, ...(before ? { before } : {}) }]);
    if (!Array.isArray(sigs)) throw new Error("bad signatures response");
    for (const x of sigs) if (x && x.blockTime && x.blockTime * 1000 <= now - FREE_AGE_MS) return { eligible: true };
    if (!sigs.length) break;
    const last = sigs[sigs.length - 1];
    if (last.blockTime) oldest = last.blockTime * 1000;
    if (sigs.length < 1000) break;   // that was the wallet's first transaction
    before = last.signature;
    if (page === AGE_PAGES - 1) return { eligible: true, busy: true };
  }
  return oldest ? { eligible: false, firstAt: oldest, eligibleAt: oldest + FREE_AGE_MS } : { eligible: false, firstAt: null, eligibleAt: null };
}
// The verdict, cached per wallet in Blobs "free-claims" (age:<wallet>): "eligible" never expires (a wallet only gets
// older); "too new" is reused until the day it becomes eligible (or an hour, for a wallet with no transactions yet).
async function cachedAgeVerdict(fstore, wallet, now = Date.now()) {
  const key = "age:" + wallet;
  try {
    const c = await fstore.get(key, { type: "json" });
    if (c?.eligible) return c;
    if (c && !c.eligible && (c.eligibleAt ? now < c.eligibleAt : now - (c.at || 0) < AGE_RECHECK_MS)) return c;
  } catch {}
  const v = await walletAgeVerdict(wallet, solanaRpc, now);
  try { await fstore.setJSON(key, { ...v, at: now }); } catch {}
  return v;
}

const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "content-type" };

export default async (request) => {
  const blocked = limited(request, "play", 60); if (blocked) return blocked;   // 60 / minute / IP (DD-04)
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (request.method !== "POST") return new Response("POST only", { status: 405, headers: CORS });
  let r; try { r = await request.json(); } catch { return new Response("bad json", { status: 400, headers: CORS }); }
  const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS } });

  // POST {action:"peek", wallet} → { ok, coins }: the coin balance of a CONNECTED wallet, read-only and without a
  // signature (owner 2026-10-27 — "it should show them directly since i was connected"). Coins only — no tickets,
  // plays or wins; starting/finishing a play, claims and everything else still need the signed session below.
  // Accepted trade-off: a wallet's coin count is readable by its address (like its on-chain balances).
  if (r.action === "peek") {
    const slow = limited(request, "play-peek", 30); if (slow) return slow;   // 30 / minute / IP on top of the 60 above
    const w = String(r.wallet || "");
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(w)) return json({ error: "bad wallet" }, 400);
    return json({ ok: true, coins: await getCoins(getStore("balances"), w) });
  }

  if (!sessionReady()) return sessionUnavailable(CORS);
  const wallet = checkToken(r.token);
  if (!wallet) return json({ error: "sign in first" }, 401);
  if (!GAMES.has(r.game || (r.action === "finish" ? "x" : ""))) { if (r.action === "start") return json({ error: "bad game" }, 400); }

  const balances = getStore("balances");
  const plays = getStore("plays");

  if (r.action === "me") {
    const coins = await getCoins(balances, wallet);
    const t = await getStrong(getStore("tickets"), ticketKey(await ticketRound(), wallet));   // this round's chances
    const round = await ticketRound();
    const freeClaimed = !!(await getStrong(getStore("free-claims"), `r${round}:w:${wallet}`));
    return json({ ok: true, wallet, coins, tickets: t?.tickets || 0, wins: t?.wins || 0, plays: t?.plays || 0, grandSlam: !!t?.grandSlam,
      free: { claimed: freeClaimed, nextAt: nextDrawAt() } });
  }

  try {
  if (r.action === "start") {
    // Flip locks its stat/mode NOW, before the seed exists, so the player can't
    // pick a winning stat after seeing the deck. Stored on the play, not re-trusted.
    const choice = {};
    if (r.game === "flip") {
      if (!["a", "d", "h", "s"].includes(r.stat)) return json({ error: "pick a stat first" }, 400);
      choice.stat = r.stat; choice.mode = r.mode === "comp" ? "comp" : "casual";
    }
    // Duel: the page deals from its baked pool by INDEX — refuse (before any coin is spent) a page
    // whose pool doesn't match ours, or an old page that still expects the seed up front.
    if (r.game === "duel" && Number(r.poolLen) !== DUEL_POOL.length)
      return json({ error: "This page is out of date — refresh to play.", stale: true }, 409);
    // debit first (a failed play still costs the coin, like an arcade token) — atomically: the
    // write only lands if the balance is unchanged since we read it, else re-read and re-check.
    let coins;
    try {
      const { value } = await casUpdate(balances, "bal:" + wallet, (b) => {
        if (!b || !(b.coins >= 1)) throw new NoCoins(b?.coins || 0);
        return { ...b, coins: b.coins - 1, updatedAt: Date.now() };
      });
      coins = value.coins + 1;   // balance before this debit (the reply below reports coins - 1)
    } catch (e) { if (e instanceof NoCoins) return json({ error: "no coins — buy some to play", coins: e.coins }, 402); throw e; }
    const playId = randomBytes(12).toString("hex");
    const seed = randomBytes(32).toString("hex");
    // Flip is interactive and its only choice is already locked → the client needs the deck, so
    // we reveal its seed. The Duel keeps its seed SECRET: the player gets both hands (pool
    // indices) and round 1's battle stat only; later stats come one round at a time ("move").
    // Cluck / Brawl hide the seed until the pick lands.
    const revealSeed = r.game === "flip";
    // the round this play belongs to (the one being filled now) — a finish in a later round can't carry its win there
    const round = await ticketRound();
    const rec = { playId, wallet, game: r.game, seed, commitHash: sha256(Buffer.from(seed, "hex")), status: "open", createdAt: Date.now(), round, ...choice };
    let duelView = null;
    if (r.game === "duel") {
      const hands = dealHands(DUEL_POOL, seed);
      rec.duel = { v: DUEL_V2, hands, round: 0, state: freshState(), moves: [] };
      duelView = { v: DUEL_V2, poolLen: DUEL_POOL.length, you: hands.you, dojo: hands.dojo, round: 0, stat: duelStats(seed)[0], rounds: DUEL_ROUNDS, expiresAt: rec.createdAt + DUEL_TTL_MS };
    }
    await plays.setJSON("play:" + playId, rec);
    return json({ ok: true, playId, commitHash: rec.commitHash, coins: coins - 1, ...(revealSeed ? { seed } : {}), ...(duelView ? { duel: duelView } : {}) });
  }

  // Degen Duel v2 — ONE server-locked round. Each round accepts exactly one card, in order; the
  // reply carries that round's result and only then the NEXT round's battle stat.
  if (r.action === "move") {
    const pkey = "play:" + String(r.playId || "");
    const { value: rec, etag } = await readWithEtag(plays, pkey);   // strong read + etag for the conditional write
    if (!rec) return json({ error: "unknown play" }, 404);
    if (rec.wallet !== wallet) return json({ error: "not your play" }, 403);
    if (rec.game !== "duel" || rec.duel?.v !== DUEL_V2) return json({ error: "not a round-by-round duel" }, 400);
    const d = rec.duel, round = r.round, pick = r.pick;
    if (typeof round !== "number" || typeof pick !== "number" || !Number.isInteger(round) || !Number.isInteger(pick)) return json({ error: "bad move" }, 400);
    // an exact retry of the last played round (its reply got lost) gets the same answer back;
    // a different card for an already-played round is refused — every round's choice is final
    if (round === d.round - 1 && d.moves[round]?.yi === pick) return json({ ok: true, replay: true, ...duelMoveReply(rec, round) });
    if (rec.status !== "open") return json({ error: "this duel is already settled" }, 409);
    if (round !== d.round) return json({ error: round < d.round ? "that round is already played" : `out of order — round ${d.round + 1} is next`, round: d.round }, 409);
    if (Date.now() - rec.createdAt > DUEL_TTL_MS) return json({ error: "this duel expired — start a new one" }, 410);
    let mv;
    try { mv = playRound(DUEL_POOL, d.hands, duelStats(rec.seed), d.state, pick); }
    catch (e) { return json({ error: e.message || "illegal pick" }, 400); }
    const next = { ...rec, duel: { ...d, round: d.round + 1, state: mv.state, moves: [...d.moves, { k: mv.k, yi: mv.yi, di: mv.di, r: mv.r }] } };
    // only one request can move this round: a concurrent move changed the etag → refused
    if (!(await putIfMatch(plays, pkey, next, etag))) return json({ error: "that round is already played", round: d.round + 1 }, 409);
    return json({ ok: true, ...duelMoveReply(next, round) });
  }

  if (r.action === "finish") {
    const pkey = "play:" + String(r.playId || "");
    let { value: rec, etag } = await readWithEtag(plays, pkey);   // strong: a just-started play must be visible
    if (!rec) return json({ error: "unknown play" }, 404);
    if (rec.wallet !== wallet) return json({ error: "not your play" }, 403);
    if (rec.status === "done") return json({ error: "already finished", already: true }, 409);
    // an open play can't be banked forever (security review M11): after PLAY_TTL_MS it is void (the coin was spent)
    if (rec.status === "open" && Date.now() - (rec.createdAt || 0) > PLAY_TTL_MS)
      return json({ error: "this play expired — plays must be finished within 24 hours", expired: true }, 410);

    // 1) LOCK the outcome: open → finishing, a conditional write only one request can win. The
    //    outcome is stored on the play, so a retry/resume can never re-roll it with new input.
    if (rec.status === "open") {
      const verify = VERIFIERS[rec.game];
      const res = verify ? verify(rec, r) : { error: "no verifier" };
      if (res.error) return json({ error: res.error }, 400);
      const won = res.won === true;
      const mult = await ddHolderMult(wallet);
      // finished in a later round than it was started in (or, for a play from before rounds were stored, simply
      // old) and past the grace → "late": the play ticket only. A banked win can't be timed into another week's pot.
      const lateRound = rec.round == null || rec.round !== (await ticketRound());
      const late = lateRound && Date.now() - (rec.createdAt || 0) > ROUND_GRACE_MS;
      const locked = { ...rec, status: "finishing", won, mult, unverified: !!res.unverified, finishingAt: Date.now(),
        ...(late ? { late: true } : {}), ...(res.winner != null ? { winner: res.winner } : {}) };
      if (await putIfMatch(plays, pkey, locked, etag)) rec = locked;
      else {
        ({ value: rec } = await readWithEtag(plays, pkey));   // lost the race → follow the winner's outcome
        if (!rec || rec.status === "done") return json({ error: "already finished", already: true }, 409);
        if (rec.status !== "finishing") return json({ error: "busy — retry" }, 503);
      }
    }
    if (rec.status !== "finishing") return json({ error: "bad play state" }, 409);

    // 2) mint tickets exactly once per playId: 1 for the paid play; 3 for a verified win (a Duel win 2); ×2 for
    //    5+ Degen holders; +5 grand slam once per round. Idempotent, so a concurrent or resumed
    //    finish of the same play adds nothing.
    //    Tickets go into the round being filled NOW (store-draw-core ticketRound — the next one once a draw has
    //    started, audit DD-07). The play remembers that round (mintRound) so a retried finish lands in the same
    //    ledger; if it never landed there and that round has since been frozen for its draw, it moves on.
    //    A "late" play (see the lock) counts as a played game only: 1 ticket (× holder), no win, no grand slam.
    const { won, mult, late } = rec;
    const winCounts = won && !late;
    const base = (winCounts ? (WIN_BY_GAME[rec.game] ?? WIN) : PLAY) * mult;
    const tstore = getStore("tickets");
    const has = async (key) => ((await getStrong(tstore, key))?.playIds || []).includes(rec.playId);
    const tr = await ticketRound();
    let mintRound = rec.mintRound;
    if (mintRound == null && (await has("player:" + wallet))) mintRound = "legacy";   // minted before per-round ledgers
    let alreadyMinted = false;
    if (mintRound != null && mintRound !== "legacy" && mintRound !== tr && !(await has(ticketKey(mintRound, wallet)))) {
      // the round this play was aimed at has been frozen and its live ledger doesn't show the play: ask that round's
      // ticket snapshot (security review LOW-1 — after the draw the live ledger is gone, so "missing" used to read as
      // "never minted" and the play was minted again into the next round)
      // (no snapshot yet → its live ledger is still the truth: the play never landed there)
      if ((await mintedInSnapshot(mintRound, wallet, rec.playId)) === true) alreadyMinted = true;
      else mintRound = null;   // it never landed there → re-aim at the round open now
    }
    if (alreadyMinted) {
      const done = { ...rec, mintRound, status: "done", awarded: rec.awarded ?? base, finishedAt: rec.finishedAt || Date.now() };
      await plays.setJSON(pkey, done);
      return json({ ok: true, won, awarded: done.awarded, grandSlam: false, holder2x: mult > 1, seed: rec.seed, alreadyMinted: true, ...(late ? { late: true } : {}),
        winUnverified: !!rec.unverified, ...(rec.winner != null ? { winner: rec.winner } : {}) });
    }
    if (mintRound == null) {
      const seen = rec.mintRound ?? null;
      const { value: p } = await casUpdate(plays, pkey, (cur) => (cur && cur.status === "finishing" && (cur.mintRound ?? null) === seen ? { ...cur, mintRound: tr } : undefined));
      mintRound = p?.mintRound ?? tr;   // a concurrent finisher may have aimed it already — follow it
    }
    const tkey = mintRound === "legacy" ? "player:" + wallet : ticketKey(mintRound, wallet);
    const { value: cur } = await casUpdate(tstore, tkey, (t) => {
      const c = t || { name: rec.displayName || wallet, wallet, tickets: 0, plays: 0, wins: 0, games: {}, grandSlam: false };
      if ((c.playIds || []).includes(rec.playId)) return undefined;   // already minted for this play
      c.games ||= {};
      c.tickets += base; c.plays += 1; if (winCounts) c.wins += 1;
      c.games[rec.game] = c.games[rec.game] || { plays: 0, wins: 0 };
      c.games[rec.game].plays += 1; if (winCounts) c.games[rec.game].wins += 1;
      if (late) c.latePlays = (c.latePlays || 0) + 1;
      if (!late && !c.grandSlam && SLAM_WIN_GAMES.every((k) => c.games[k] && c.games[k].wins > 0)
          && SLAM_PLAY_GAMES.every((k) => c.games[k] && c.games[k].plays > 0)) {
        c.grandSlam = true; c.slamPlayId = rec.playId; c.tickets += GRAND_SLAM * mult;
      }
      c.playIds = pushId(c.playIds, rec.playId, PLAY_IDS_MAX);
      c.holder = mult > 1;
      c.updatedAt = Date.now();
      return c;
    });
    const grandSlam = cur.slamPlayId === rec.playId;
    const awarded = base + (grandSlam ? GRAND_SLAM * mult : 0);

    // 3) close the play (same content from any concurrent finisher)
    const done = { ...rec, mintRound, status: "done", awarded, finishedAt: rec.finishedAt || Date.now() };
    await plays.setJSON(pkey, done);

    return json({ ok: true, won, awarded, grandSlam, holder2x: mult > 1, tickets: cur.tickets, seed: rec.seed, winUnverified: !!rec.unverified,
      ...(late ? { late: true, note: "finished in a later round than it was started in — counted as a play (1 chance), not a win" } : {}),
      ...(rec.winner != null ? { winner: rec.winner } : {}) });
  }

  if (r.action === "free") {
    // wallet comes ONLY from the verified session token above. One free coin per weekly round (the round tickets mint
    // into): per Seeker Genesis Token for Seeker owners (no age check), else per wallet 30+ days old. Create-only
    // markers make every claim single-use; nothing here touches the Pot ledger or any preacher.
    if (!process.env.SOLANA_RPC) return json({ error: "The free-coin check is offline right now — try again later" }, 503);
    const fstore = getStore("free-claims");
    const round = await ticketRound(), now = Date.now(), nextAt = nextDrawAt(now);
    const wkey = `r${round}:w:${wallet}`;
    if (await getStrong(fstore, wkey)) return json({ ok: false, already: true, round, nextAt, error: "You already took this week's free coin." }, 409);
    // 1) a Seeker: its SGT, once per round (a Seeker on another wallet this round can't claim it again)
    let mints = null, sgt = null, via = null;
    try { mints = await findSeekerGenesisMints(wallet); } catch { mints = null; }   // RPC trouble → try the age path
    for (const m of (mints || []).slice().sort()) {
      if (await putIfNew(fstore, `r${round}:sgt:${m}`, { wallet, ts: now })) { sgt = m; via = "seeker"; break; }
    }
    // 2) otherwise the wallet's age
    if (!via) {
      let v;
      try { v = await cachedAgeVerdict(fstore, wallet, now); }
      catch { return json({ error: "Couldn't reach Solana to check your wallet — try again in a moment." }, 503); }
      if (!v.eligible) {
        if (mints && mints.length) return json({ ok: false, already: true, round, nextAt, error: "This Seeker already took this week's free coin on another wallet." }, 409);
        return json({ ok: false, tooNew: true, eligibleAt: v.eligibleAt || null,
          error: v.eligibleAt ? "Your wallet must be 30+ days old for the free weekly coin." : "Your wallet needs some on-chain history (30+ days) for the free weekly coin." }, 403);
      }
      via = "age";
    }
    // 3) one per wallet per round — losing a race releases the SGT we took
    if (!(await putIfNew(fstore, wkey, { via, sgt, ts: now }))) {
      if (sgt) await fstore.delete(`r${round}:sgt:${sgt}`);
      return json({ ok: false, already: true, round, nextAt, error: "You already took this week's free coin." }, 409);
    }
    // 4) credit (idempotent per round) — balance only: no Pot share, no preacher cut, no tickets
    const id = "free:" + round;
    const { value: bal } = await casUpdate(balances, "bal:" + wallet, (b) => {
      const v = b || { coins: 0 };
      if ((v.applied || []).includes(id)) return undefined;
      return { ...v, coins: (v.coins || 0) + FREE_COINS, applied: pushId(v.applied, id, 50), updatedAt: Date.now() };
    });
    return json({ ok: true, claimed: FREE_COINS, coins: bal.coins, via, round, nextAt });
  }

  if (r.action === "seeker") {
    // wallet comes ONLY from the verified session token above — never from the request body
    if (!process.env.SOLANA_RPC) return json({ error: "Seeker check is offline right now — try again later" }, 503);
    const claims = getStore("seeker-claims");
    if (await getStrong(claims, "claim:" + wallet)) return json({ ok: false, already: true, error: "This wallet already claimed its free Seeker coin." }, 409);
    let mints;
    try { mints = await findSeekerGenesisMints(wallet); }
    catch { return json({ error: "Couldn't reach Solana to check your Seeker — try again in a moment." }, 503); }
    if (!mints.length) return json({ ok: false, noSeeker: true, error: "No Seeker Genesis Token found in this wallet." }, 404);
    // Claim an SGT with a create-only write: exactly one request can ever create sgt:<mint>.
    const rec = { wallet, ts: Date.now(), coins: SEEKER_FREE_COINS };
    let mint = null;
    for (const m of mints.sort()) { if (await putIfNew(claims, "sgt:" + m, { ...rec, mint: m })) { mint = m; break; } }
    if (!mint) return json({ ok: false, already: true, error: "This Seeker already claimed its free coin." }, 409);
    // one claim per wallet too (a wallet holding two SGTs racing itself): lose → release our SGT
    if (!(await putIfNew(claims, "claim:" + wallet, { ...rec, mint }))) {
      await claims.delete("sgt:" + mint);
      return json({ ok: false, already: true, error: "This wallet already claimed its free Seeker coin." }, 409);
    }
    const id = "seeker:" + mint;
    const { value: bal } = await casUpdate(balances, "bal:" + wallet, (b) => {
      const v = b || { coins: 0 };
      if ((v.applied || []).includes(id)) return undefined;
      return { ...v, coins: (v.coins || 0) + SEEKER_FREE_COINS, applied: pushId(v.applied, id, 50), updatedAt: Date.now() };
    });
    return json({ ok: true, claimed: SEEKER_FREE_COINS, coins: bal.coins, mint });
  }
  } catch (e) {
    if (e instanceof CasError) return json({ error: e.status === 503 ? "busy — please retry" : e.message }, e.status);
    throw e;
  }

  return json({ error: "unknown action" }, 400);
};

export const config = { path: "/api/play" };
