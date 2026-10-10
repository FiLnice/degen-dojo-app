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
//          the wallet (play = 1, verified win = 3, +3 one-time grand slam), reveal
//          the seed. The client's claimed result is ignored.
//
// Fail-closed: if a game's outcome verifier isn't available yet, the win is NOT
// trusted — the play still earns its 1 base ticket (the coin was really spent),
// but the win bonus is withheld and flagged. No path mints tickets for free.
//
// Env: SESSION_SECRET (or ADMIN_KEY) — must match store-fn-auth.
import { getStore } from "@netlify/blobs";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { simulate as flipSimulate } from "./dojo-flip-engine.mjs";
import { POOL as FLIP_POOL } from "./flip-pool.mjs";
import { simulate as duelSimulate } from "./dojo-duel-engine.mjs";
import { DUEL_POOL } from "./duel-pool.mjs";

const GAMES = new Set(["duel", "flip", "teto", "cluck", "brawl"]);
// Grand-slam counts only the games whose WIN we can verify. Teto is flat-entries
// (its win isn't server-checkable), so a verified win in each of these three earns
// the one-time bonus — otherwise the slam would be unreachable.
const SLAM_GAMES = ["duel", "flip", "cluck"];
const WIN = 3, PLAY = 1, GRAND_SLAM = 3;
const SECRET = () => process.env.SESSION_SECRET || process.env.ADMIN_KEY || "\0dev-secret";
const sha256 = (b) => createHash("sha256").update(b).digest("hex");

// verify the HMAC session token from /api/auth → wallet, or null
function checkToken(token) {
  if (!token || typeof token !== "string") return null;
  const i = token.lastIndexOf("."); if (i < 0) return null;
  const body = token.slice(0, i), mac = token.slice(i + 1);
  const [wallet, expStr] = body.split(".");
  if (!wallet || !expStr) return null;
  const good = createHmac("sha256", SECRET()).update(body).digest("hex");
  if (mac.length !== good.length) return null;
  // constant-ish compare
  let diff = 0; for (let k = 0; k < good.length; k++) diff |= mac.charCodeAt(k) ^ good.charCodeAt(k);
  if (diff !== 0) return null;
  if (Date.now() > Number(expStr)) return null;
  return wallet;
}

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

// ── server coin ledger (credited only by verified on-chain purchases) ──
async function getCoins(bstore, wallet) { const b = await bstore.get("bal:" + wallet, { type: "json" }); return b?.coins || 0; }

const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "content-type" };

export default async (request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (request.method !== "POST") return new Response("POST only", { status: 405, headers: CORS });
  let r; try { r = await request.json(); } catch { return new Response("bad json", { status: 400, headers: CORS }); }
  const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS } });

  const wallet = checkToken(r.token);
  if (!wallet) return json({ error: "sign in first" }, 401);
  if (!GAMES.has(r.game || (r.action === "finish" ? "x" : ""))) { if (r.action === "start") return json({ error: "bad game" }, 400); }

  const balances = getStore("balances");
  const plays = getStore("plays");

  if (r.action === "me") {
    const coins = await getCoins(balances, wallet);
    const t = await getStore("tickets").get("player:" + wallet, { type: "json" });
    return json({ ok: true, wallet, coins, tickets: t?.tickets || 0, wins: t?.wins || 0, plays: t?.plays || 0, grandSlam: !!t?.grandSlam });
  }

  if (r.action === "start") {
    const coins = await getCoins(balances, wallet);
    if (coins < 1) return json({ error: "no coins — buy some to play", coins }, 402);
    // Flip locks its stat/mode NOW, before the seed exists, so the player can't
    // pick a winning stat after seeing the deck. Stored on the play, not re-trusted.
    const choice = {};
    if (r.game === "flip") {
      if (!["a", "d", "h", "s"].includes(r.stat)) return json({ error: "pick a stat first" }, 400);
      choice.stat = r.stat; choice.mode = r.mode === "comp" ? "comp" : "casual";
    }
    // debit first (a failed play still costs the coin, like an arcade token)
    await balances.setJSON("bal:" + wallet, { coins: coins - 1, updatedAt: Date.now() });
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
    const rec = await plays.get("play:" + (r.playId || ""), { type: "json" });
    if (!rec) return json({ error: "unknown play" }, 404);
    if (rec.wallet !== wallet) return json({ error: "not your play" }, 403);
    if (rec.status !== "open") return json({ error: "already finished", already: true }, 409);

    const verify = VERIFIERS[rec.game];
    const res = verify ? verify(rec, r) : { error: "no verifier" };
    if (res.error) return json({ error: res.error }, 400);

    // mint tickets: always 1 for the paid play; +2 (→3 total) only for a verified win
    const won = res.won === true;
    let awarded = won ? WIN : PLAY;
    const tstore = getStore("tickets");
    const key = "player:" + wallet;
    const cur = (await tstore.get(key, { type: "json" })) || { name: rec.displayName || wallet, wallet, tickets: 0, plays: 0, wins: 0, games: {}, grandSlam: false };
    cur.tickets += awarded; cur.plays += 1; if (won) cur.wins += 1;
    cur.games[rec.game] = cur.games[rec.game] || { plays: 0, wins: 0 };
    cur.games[rec.game].plays += 1; if (won) cur.games[rec.game].wins += 1;
    let grandSlam = false;
    if (won && !cur.grandSlam && SLAM_GAMES.every((k) => cur.games[k] && cur.games[k].wins > 0)) {
      cur.grandSlam = true; grandSlam = true; awarded += GRAND_SLAM; cur.tickets += GRAND_SLAM;
    }
    cur.updatedAt = Date.now();
    await tstore.setJSON(key, cur);

    rec.status = "done"; rec.won = won; rec.awarded = awarded; rec.unverified = !!res.unverified; rec.finishedAt = Date.now();
    await plays.setJSON("play:" + rec.playId, rec);

    return json({ ok: true, won, awarded, grandSlam, tickets: cur.tickets, seed: rec.seed, winUnverified: !!res.unverified, ...(res.winner != null ? { winner: res.winner } : {}) });
  }

  return json({ error: "unknown action" }, 400);
};

export const config = { path: "/api/play" };
