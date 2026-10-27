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
//                                     drawn, blockhash, winners, tickets total); &round=N → that round
//   GET  ?action=entries&round=N   → the [wallet, tickets] list round N is drawn from (published when the
//                                     round's entries freeze, BEFORE its target slot is chosen) — with the
//                                     revealed seed + blockhash anyone can re-run the pick
//   GET  ?action=commit  (Bearer ADMIN_KEY) → open a new round (admin)
//   GET  ?action=draw    (Bearer ADMIN_KEY) → run the draw for the open round (admin)
//
// The commit/draw logic lives in store-draw-core.mjs, shared with the weekly payout cron
// (store-fn-payout-cron.mjs), which commits + draws automatically each week. A draw is crash-safe and
// resumable (DD-07): the first ?action=draw freezes the round and answers 409 "settling"; calling it
// again ~30 s later (or the cron's next tick) finishes it. A crashed draw is finished the same way.
//
// Env: ADMIN_KEY (gates commit/draw), SOLANA_RPC (a Solana RPC URL).
// Tickets come from the "tickets" Blobs store, written ONLY by /api/play (store-fn-play.mjs).
import { limited } from "./store-ratelimit-core.mjs";
import { getPot, POT_PCT_MAX, POT_PCT_MIN } from "./store-pot-core.mjs";
import { commitRound, drawRound, latestRound, getPublic, publicEntries, solUsd, oreUsd, DrawError } from "./store-draw-core.mjs";
import { adminRequestOk } from "./store-session-core.mjs";

export default async (request) => {
  const blocked = limited(request, "draw", 30); if (blocked) return blocked;   // 30 / minute / IP (DD-04)
  const url = new URL(request.url);
  const action = url.searchParams.get("action") || "status";
  const admin = () => adminRequestOk(request, "ADMIN_KEY");   // unset ADMIN_KEY never matches (no "\0" sentinel)
  const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });

  // a past round's public record / its published entries (round numbers only; nothing private is reachable)
  const asked = url.searchParams.get("round");
  const askedRound = asked == null ? null : /^\d{1,6}$/.test(asked) ? Number(asked) : NaN;
  if (Number.isNaN(askedRound)) return json({ error: "bad round" }, 400);
  if (action === "entries") {
    const round = askedRound || (await latestRound());
    const e = round ? await publicEntries(round) : null;
    return e ? json(e) : json({ error: "no published entries for round " + round }, 404);
  }

  if (action === "status") {
    const latest = await latestRound();
    const round = askedRound && askedRound <= latest ? askedRound : latest;
    const pub = await getPublic(round);
    // the LIVE pot (accumulated from verified purchases + tips) — real, not a manual number.
    // Shape matches what the /pot ledger page renders: potSol, potPct, routes{route:{sol,skr,ore}}.
    const pot = await getPot();
    const [sp, op] = await Promise.all([solUsd(), oreUsd()]);
    return json({
      round, latestRound: latest, draw: pub,
      potSol: sp ? +(pot.usd / sp).toFixed(4) : null, potOre: op ? +(pot.usd / op).toFixed(4) : null, potUsd: +pot.usd.toFixed(2),
      potPct: POT_PCT_MAX, potPctMin: POT_PCT_MIN, routes: pot.routes, solPrice: sp, orePrice: op,
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
