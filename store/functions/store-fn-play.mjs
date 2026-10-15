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
//   POST {action:"finish", token, playId, pick?, inputLog?}
//        → recompute the outcome server-side (per-game verifier), mint tickets to
//          the wallet (play = 1, verified win = 3, +5 grand slam per round; ×2 for 5+ Degen holders), reveal
//          the seed. The client's claimed result is ignored.
//
// Fail-closed: if a game's outcome verifier isn't available yet, the win is NOT
// trusted — the play still earns its 1 base ticket (the coin was really spent),
// but the win bonus is withheld and flagged. No path mints tickets for free.
//
//   POST {action:"seeker", token}
//        → ONE free coin per Seeker phone: the session wallet must hold a genuine Seeker
//          Genesis Token (checked on-chain). The claim is keyed by the SGT MINT (it can be
//          moved between wallets) and the wallet is marked too (no second SGT, same wallet).
//
// Env: SESSION_SECRET (≥ 32 chars; no fallback — fails closed, see store-session-core.mjs). SOLANA_RPC for the Seeker check.
import { getStore } from "@netlify/blobs";
import { getStrong } from "./store-verify-core.mjs";
import { casUpdate, readWithEtag, putIfNew, putIfMatch, pushId, CasError } from "./store-cas-core.mjs";
import { checkToken, sessionReady, sessionUnavailable } from "./store-session-core.mjs";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { simulate as flipSimulate } from "./dojo-flip-engine.mjs";
import { POOL as FLIP_POOL } from "./flip-pool.mjs";
import { simulate as duelSimulate } from "./dojo-duel-engine.mjs";
import { DUEL_POOL } from "./duel-pool.mjs";

const GAMES = new Set(["duel", "flip", "teto", "cluck", "brawl"]);
// Grand slam (+5, once per draw round): PLAY all five games in the same round, win or lose — it
// rewards using coins across every game. Tickets reset after every draw (store-fn-draw archives
// them), so "same week" = same round.
const SLAM_WIN_GAMES = [];
const SLAM_PLAY_GAMES = ["duel", "flip", "cluck", "brawl", "teto"];
const WIN = 3, PLAY = 1, GRAND_SLAM = 5;
// Holders of 5+ Degen Dojo fighters earn 2× chances on everything they play (0 plays → 0 chances).
const DD_COLLECTION = "2m9DupVeheZ5vfuXZxqV3KSQ7HnVDk2tG6ouH1ZnLwYb";
const HOLDER_MIN = 5, HOLDER_MULT = 2, HOLDER_TTL_MS = 60 * 60 * 1000;
const SEEKER_FREE_COINS = 1;   // free coins for a Seeker owner — once per Seeker device (SGT mint)
const sha256 = (b) => createHash("sha256").update(b).digest("hex");

// ── per-game outcome verifiers ──────────────────────────────────────────────
// Each returns { won:boolean } or { error } (fail-closed) or { unverified:true }.
const BIRDS = 8;
function seedInt(seedHex, tag) { return createHmac("sha256", Buffer.from(seedHex, "hex")).update(tag).digest().readUInt32BE(0); }

const VERIFIERS = {
  // Cluck-Fu — pure chance. Winning rooster = HMAC(seed,'cluck') % 8, fixed the
  // moment the seed was committed (before the player picked). Player wins iff they
  // backed that rooster. Fully recomputable from the revealed seed.
  cluck(play, sub) {
    const pick = Number(sub.pick);
    if (!Number.isInteger(pick) || pick < 0 || pick >= BIRDS) return { error: "bad pick" };
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
  // Degen Duel — best-of-4 card game. The only input is the ORDER you played your 4
  // cards (a permutation of 0..3); everything else is seeded. We replay the shared
  // engine with those picks and check who actually won. Fully verifiable.
  duel(play, sub) {
    const picks = sub.picks;
    if (!Array.isArray(picks) || picks.length !== 8) return { error: "bad picks" };
    const seen = new Set();
    for (const p of picks) { if (!Number.isInteger(p) || p < 0 || p > 7 || seen.has(p)) return { error: "bad picks" }; seen.add(p); }
    let winner; try { winner = duelSimulate(DUEL_POOL, play.seed, picks); } catch { return { error: "illegal picks" }; }
    return { won: winner === "me", winner };   // 'me' is the human; 'dojo'/'draw' → no win bonus
  },
  // Cock Brawl — pure chance, 8-rooster ring royale. Surviving rooster =
  // HMAC(seed,'brawl:'+playId) % 8, fixed at commit (before the player backs a bird).
  // Player wins iff they backed the last bird standing. Fully recomputable from the seed.
  brawl(play, sub) {
    const pick = Number(sub.pick);
    if (!Number.isInteger(pick) || pick < 0 || pick >= BIRDS) return { error: "bad pick" };
    const winner = seedInt(play.seed, "brawl:" + play.playId) % BIRDS;
    return { won: pick === winner, winner };
  },
  // Teto — real-time skill; flat entries by design (see the ticket model). Fail-closed
  // here means a Teto win earns the same 1 entry as a play, which is intended.
  teto() { return { unverified: true }; },
};

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

// How many Degen Dojo fighters does this wallet hold? Cached 1h per wallet (Blobs "holders").
// Any lookup failure → treated as not a holder for this play (never blocks the game).
async function ddHolderMult(wallet) {
  const cache = getStore("holders");
  try {
    const c = await cache.get("w:" + wallet, { type: "json" });
    if (c && Date.now() - c.at < HOLDER_TTL_MS) return c.count >= HOLDER_MIN ? HOLDER_MULT : 1;
  } catch {}
  try {
    let count = 0;
    for (let page = 1; page <= 5; page++) {
      const res = await solanaRpc("getAssetsByOwner", { ownerAddress: wallet, page, limit: 1000 });
      const items = res?.items || [];
      for (const a of items) if ((a.grouping || []).some((g) => g.group_key === "collection" && g.group_value === DD_COLLECTION) && !a.burnt) count++;
      if (items.length < 1000 || count >= HOLDER_MIN) break;
    }
    try { await cache.setJSON("w:" + wallet, { count, at: Date.now() }); } catch {}
    return count >= HOLDER_MIN ? HOLDER_MULT : 1;
  } catch { return 1; }
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

const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "content-type" };

export default async (request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (request.method !== "POST") return new Response("POST only", { status: 405, headers: CORS });
  let r; try { r = await request.json(); } catch { return new Response("bad json", { status: 400, headers: CORS }); }
  const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS } });

  if (!sessionReady()) return sessionUnavailable(CORS);
  const wallet = checkToken(r.token);
  if (!wallet) return json({ error: "sign in first" }, 401);
  if (!GAMES.has(r.game || (r.action === "finish" ? "x" : ""))) { if (r.action === "start") return json({ error: "bad game" }, 400); }

  const balances = getStore("balances");
  const plays = getStore("plays");

  if (r.action === "me") {
    const coins = await getCoins(balances, wallet);
    const t = await getStrong(getStore("tickets"), "player:" + wallet);
    return json({ ok: true, wallet, coins, tickets: t?.tickets || 0, wins: t?.wins || 0, plays: t?.plays || 0, grandSlam: !!t?.grandSlam });
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
    // Flip & Duel are interactive → the client needs the deck/hands up front, so we
    // reveal the seed. (Flip's choice is already locked; Duel's only input is the
    // card order, sent at finish.) Cluck hides the seed until the pick lands.
    const revealSeed = r.game === "flip" || r.game === "duel";
    const rec = { playId, wallet, game: r.game, seed, commitHash: sha256(Buffer.from(seed, "hex")), status: "open", createdAt: Date.now(), ...choice };
    await plays.setJSON("play:" + playId, rec);
    return json({ ok: true, playId, commitHash: rec.commitHash, coins: coins - 1, ...(revealSeed ? { seed } : {}) });
  }

  if (r.action === "finish") {
    const pkey = "play:" + String(r.playId || "");
    let { value: rec, etag } = await readWithEtag(plays, pkey);   // strong: a just-started play must be visible
    if (!rec) return json({ error: "unknown play" }, 404);
    if (rec.wallet !== wallet) return json({ error: "not your play" }, 403);
    if (rec.status === "done") return json({ error: "already finished", already: true }, 409);

    // 1) LOCK the outcome: open → finishing, a conditional write only one request can win. The
    //    outcome is stored on the play, so a retry/resume can never re-roll it with new input.
    if (rec.status === "open") {
      const verify = VERIFIERS[rec.game];
      const res = verify ? verify(rec, r) : { error: "no verifier" };
      if (res.error) return json({ error: res.error }, 400);
      const won = res.won === true;
      const mult = await ddHolderMult(wallet);
      const locked = { ...rec, status: "finishing", won, mult, unverified: !!res.unverified, finishingAt: Date.now(),
        ...(res.winner != null ? { winner: res.winner } : {}) };
      if (await putIfMatch(plays, pkey, locked, etag)) rec = locked;
      else {
        ({ value: rec } = await readWithEtag(plays, pkey));   // lost the race → follow the winner's outcome
        if (!rec || rec.status === "done") return json({ error: "already finished", already: true }, 409);
        if (rec.status !== "finishing") return json({ error: "busy — retry" }, 503);
      }
    }
    if (rec.status !== "finishing") return json({ error: "bad play state" }, 409);

    // 2) mint tickets exactly once per playId: 1 for the paid play; 3 for a verified win; ×2 for
    //    5+ Degen holders; +5 grand slam once per round. Idempotent, so a concurrent or resumed
    //    finish of the same play adds nothing.
    const { won, mult } = rec;
    const base = (won ? WIN : PLAY) * mult;
    const tstore = getStore("tickets");
    const { value: cur } = await casUpdate(tstore, "player:" + wallet, (t) => {
      const c = t || { name: rec.displayName || wallet, wallet, tickets: 0, plays: 0, wins: 0, games: {}, grandSlam: false };
      if ((c.playIds || []).includes(rec.playId)) return undefined;   // already minted for this play
      c.games ||= {};
      c.tickets += base; c.plays += 1; if (won) c.wins += 1;
      c.games[rec.game] = c.games[rec.game] || { plays: 0, wins: 0 };
      c.games[rec.game].plays += 1; if (won) c.games[rec.game].wins += 1;
      if (!c.grandSlam && SLAM_WIN_GAMES.every((k) => c.games[k] && c.games[k].wins > 0)
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
    const done = { ...rec, status: "done", awarded, finishedAt: rec.finishedAt || Date.now() };
    await plays.setJSON(pkey, done);

    return json({ ok: true, won, awarded, grandSlam, holder2x: mult > 1, tickets: cur.tickets, seed: rec.seed, winUnverified: !!rec.unverified, ...(rec.winner != null ? { winner: rec.winner } : {}) });
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
