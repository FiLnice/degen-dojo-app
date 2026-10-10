// Netlify Function: raffle-ticket ledger at /api/ticket
//
// POST {player, game, won}
//   → award weekly raffle tickets (3 for a win, 1 for a play, +3 grand-slam) to `player`, in the
//     "tickets" Blobs store the provably-fair draw reads. Aggregated per player.
//
// IMPORTANT — anti-cheat: this endpoint records ticket CLAIMS, which are only as
// trustworthy as their source. The tamper-proof design ties every ticket to a
// VERIFIED coin spend: a play costs a coin, coins come from on-chain-verified
// purchases (store-fn-coinbuy + the verify step), so a player can't mint tickets
// without paying. For provably-fair games (Cluck-Fu) the win itself is derived
// from a future blockhash, so "won" can be re-checked. Wire that server-side
// gating before real prizes ride on it; until then treat totals as indicative.
//
// GET ?key=ADMIN_KEY → dump the ticket ledger (for the draw / audit).
import { getStore } from "@netlify/blobs";

const NAME_RE = /^[\w .\-]{1,24}$/;
const GAME = new Set(["duel", "flip", "teto", "cluck"]);
const WIN = 3, PLAY = 1, GRAND_SLAM = 3;   // win = 3 chances, play = 1; win all 4 games once = +3
const ALL_GAMES = ["duel", "flip", "teto", "cluck"];

export default async (request) => {
  const store = getStore("tickets");
  const url = new URL(request.url);

  if (request.method === "GET") {
    if ((url.searchParams.get("key") || "") !== (process.env.ADMIN_KEY || "\0")) return new Response("forbidden", { status: 403 });
    const { blobs } = await store.list();
    const out = [];
    for (const b of blobs) { const v = await store.get(b.key, { type: "json" }); if (v) out.push(v); }
    return new Response(JSON.stringify(out), { headers: { "content-type": "application/json", "cache-control": "no-store" } });
  }

  if (request.method !== "POST") return new Response("POST only", { status: 405 });
  let r; try { r = await request.json(); } catch { return new Response("bad json", { status: 400 }); }
  if (!NAME_RE.test(r.player || "") || !GAME.has(r.game)) return new Response(JSON.stringify({ error: "bad record" }), { status: 400 });

  let awarded = r.won ? WIN : PLAY;
  const key = "player:" + r.player;
  const cur = (await store.get(key, { type: "json" })) || { name: r.player, tickets: 0, plays: 0, wins: 0, games: {}, grandSlam: false };
  cur.tickets += awarded;
  cur.plays += 1;
  if (r.won) cur.wins += 1;
  cur.games[r.game] = cur.games[r.game] || { plays: 0, wins: 0 };
  cur.games[r.game].plays += 1;
  if (r.won) cur.games[r.game].wins += 1;
  // one-time grand-slam bonus: a win in every one of the four games
  if (!cur.grandSlam && ALL_GAMES.every((k) => cur.games[k] && cur.games[k].wins > 0)) {
    cur.grandSlam = true; awarded += GRAND_SLAM; cur.tickets += GRAND_SLAM;
  }
  cur.updatedAt = Date.now();
  await store.setJSON(key, cur);
  return new Response(JSON.stringify({ ok: true, awarded, tickets: cur.tickets, grandSlam: cur.grandSlam }), { headers: { "content-type": "application/json" } });
};

export const config = { path: "/api/ticket" };
