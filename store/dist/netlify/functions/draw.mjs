// Netlify Function: provably-fair weekly pot draw at /api/draw
//
// The whole point: nobody — not even us — can pick or predict the winner. It's a
// classic commit-reveal bound to a FUTURE Solana blockhash:
//
//   1. COMMIT (before the week's blockhash exists): we generate a secret 32-byte
//      seed, publish sha256(seed) (the commitment) and a target future slot. The
//      seed stays secret; the blockhash at that slot doesn't exist yet, so we
//      can't have chosen it.
//   2. DRAW (after that slot finalizes): we fetch the blockhash of the target
//      slot — a value no one controlled — mix it with the seed, and pick winners
//      weighted by raffle tickets. Then we REVEAL the seed.
//   3. VERIFY (anyone, forever): check sha256(seed) == the published commitment,
//      check the blockhash really is that slot's on-chain, and re-run the exact
//      pick. Same inputs → same winners. Fairness is checkable, not trusted.
//
//   GET  ?action=status            → latest round (public: commitment, seed if
//                                     drawn, blockhash, winners, tickets total)
//   GET  ?action=commit&key=KEY    → open a new round (admin)
//   GET  ?action=draw&key=KEY      → run the draw for the open round (admin)
//
// The commit/draw logic lives in store-draw-core.mjs, shared with the weekly payout cron
// (store-fn-payout-cron.mjs), which commits + draws automatically each week.
//
// Env: ADMIN_KEY (gates commit/draw), SOLANA_RPC (a Solana RPC URL).
// Tickets come from the "tickets" Blobs store, written ONLY by /api/play (store-fn-play.mjs).
import { getPot, POT_FRAC } from "./store-pot-core.mjs";
import { commitRound, drawRound, latestRound, getPublic, solUsd, DrawError } from "./store-draw-core.mjs";
import { adminKeyOk } from "./store-session-core.mjs";

export default async (request) => {
  const url = new URL(request.url);
  const action = url.searchParams.get("action") || "status";
  const admin = () => adminKeyOk(url.searchParams.get("key"), "ADMIN_KEY");   // unset ADMIN_KEY never matches (no "\0" sentinel)
  const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });

  if (action === "status") {
    const round = await latestRound();
    const pub = await getPublic(round);
    // the LIVE pot (accumulated from verified purchases + tips) — real, not a manual number.
    // Shape matches what the /pot ledger page renders: potSol, potPct, routes{route:{sol,skr,ore}}.
    const pot = await getPot();
    const sp = await solUsd();
    return json({
      round, draw: pub,
      potSol: sp ? +(pot.usd / sp).toFixed(4) : null, potUsd: +pot.usd.toFixed(2),
      potPct: Math.round(POT_FRAC * 100), routes: pot.routes, solPrice: sp,
    });
  }

  if (!admin()) return json({ error: "forbidden" }, 403);

  try {
    if (action === "commit") return json({ ok: true, ...(await commitRound()) });   // commitHash is public proof
    if (action === "draw") {
      const result = await drawRound({ potSolOverride: Number(url.searchParams.get("potSol")) || 0, winnersOverride: Number(url.searchParams.get("winners")) || 0 });
      return json({ ok: true, ...result });
    }
  } catch (e) {
    if (e instanceof DrawError) return json({ error: e.message }, e.status);
    return json({ error: String(e.message || e) }, 500);
  }

  return json({ error: "unknown action" }, 400);
};

export const config = { path: "/api/draw" };
