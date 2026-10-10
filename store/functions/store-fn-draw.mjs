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
// Env: ADMIN_KEY (gates commit/draw), SOLANA_RPC (a Solana RPC URL).
// Tickets come from the "tickets" Blobs store (see store-fn-ticket.mjs).
import { getStore } from "@netlify/blobs";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { getPot, archiveAndResetPot, POT_FRAC } from "./store-pot-core.mjs";

const SOL_MINT = "So11111111111111111111111111111111111111112";
async function solUsd() { try { const j = await (await fetch("https://lite-api.jup.ag/price/v3?ids=" + SOL_MINT)).json(); const p = j?.[SOL_MINT]?.usdPrice; return p > 0 ? p : null; } catch { return null; } }

const SLOTS_AHEAD = 300;   // ~2 min of slots between commit and the target blockhash
// Winner count scales with the pot: a fat pot (> BIG_POT_SOL) splits among more
// winners to feel winnable; a small pot stays one big grab-attention prize.
const BIG_POT_SOL = 10;
const WINNERS_BIG = 5, WINNERS_SMALL = 1;
function winnerCount(potSol) { return potSol > BIG_POT_SOL ? WINNERS_BIG : WINNERS_SMALL; }

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

async function rpc(method, params) {
  const r = await fetch(process.env.SOLANA_RPC, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || method + " failed");
  return j.result;
}

// the blockhash of the first finalized block at or after `slot` (skipped slots have none)
async function blockhashAtOrAfter(slot) {
  for (let s = slot; s < slot + 150; s++) {
    try {
      const b = await rpc("getBlock", [s, { transactionDetails: "none", rewards: false, maxSupportedTransactionVersion: 0 }]);
      if (b?.blockhash) return { slot: s, blockhash: b.blockhash };
    } catch { /* skipped slot → try the next */ }
  }
  throw new Error("no finalized block found near the target slot yet — try again shortly");
}

// deterministic weighted pick of up to n distinct winners from
// [{wallet, name, tickets}]. Entries must be sorted canonically by the caller so
// the pick reproduces regardless of blob-list order. Carries the WALLET through so
// the (user-run) payout can pay winners directly.
function pickWinners(seedHex, blockhash, entriesIn, n) {
  let entries = entriesIn.filter((e) => e.tickets > 0).map((e) => ({ ...e }));
  const winners = [];
  let counter = 0;
  while (winners.length < n && entries.length) {
    const total = entries.reduce((s, e) => s + e.tickets, 0);
    // a fresh 8-byte draw per winner, from HMAC(seed, blockhash|counter)
    const digest = createHmac("sha256", Buffer.from(seedHex, "hex")).update(blockhash + ":" + counter++).digest();
    const roll = Number(digest.readBigUInt64BE(0) % BigInt(total));
    let acc = 0, hit = 0;
    for (let i = 0; i < entries.length; i++) { acc += entries[i].tickets; if (roll < acc) { hit = i; break; } }
    winners.push({ wallet: entries[hit].wallet, name: entries[hit].name, tickets: entries[hit].tickets });
    entries.splice(hit, 1);   // no repeat winners
  }
  return winners;
}

export default async (request) => {
  const url = new URL(request.url);
  const action = url.searchParams.get("action") || "status";
  const store = getStore("draws");
  const admin = () => (url.searchParams.get("key") || "") === (process.env.ADMIN_KEY || "\0");
  const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });

  const latestRound = Number((await store.get("latest")) || 0);

  if (action === "status") {
    const pub = latestRound ? await store.get("public:" + latestRound, { type: "json" }) : null;
    // the LIVE pot (accumulated from verified purchases + tips) — real, not a manual number.
    // Shape matches what the /pot ledger page renders: potSol, potPct, routes{route:{sol,skr,ore}}.
    const pot = await getPot();
    const sp = await solUsd();
    return json({
      round: latestRound, draw: pub,
      potSol: sp ? +(pot.usd / sp).toFixed(4) : null, potUsd: +pot.usd.toFixed(2),
      potPct: Math.round(POT_FRAC * 100), routes: pot.routes, solPrice: sp,
    });
  }

  if (!admin()) return json({ error: "forbidden" }, 403);

  if (action === "commit") {
    const open = latestRound ? await store.get("public:" + latestRound, { type: "json" }) : null;
    if (open && open.status === "committed") return json({ error: "a round is already open — draw it first" }, 409);
    const round = latestRound + 1;
    const seed = randomBytes(32).toString("hex");
    const targetSlot = (await rpc("getSlot", [{ commitment: "finalized" }])) + SLOTS_AHEAD;
    await store.setJSON("seed:" + round, { seed });                       // secret until the draw
    const pub = { round, status: "committed", commitHash: sha256(Buffer.from(seed, "hex")), targetSlot, committedAt: Date.now() };
    await store.setJSON("public:" + round, pub);
    await store.set("latest", String(round));
    return json({ ok: true, ...pub });                                    // commitHash is public proof
  }

  if (action === "draw") {
    const pub = latestRound ? await store.get("public:" + latestRound, { type: "json" }) : null;
    if (!pub || pub.status !== "committed") return json({ error: "no open round to draw — commit one first" }, 409);
    const { seed } = (await store.get("seed:" + latestRound, { type: "json" })) || {};
    if (!seed) return json({ error: "seed missing" }, 500);
    const { slot, blockhash } = await blockhashAtOrAfter(pub.targetSlot);

    // read the ticket ledger — one blob per wallet. Aggregate by WALLET (unique;
    // display names aren't), then sort canonically by wallet so the weighted pick
    // reproduces independently of the blob-list order.
    const tstore = getStore("tickets");
    const { blobs } = await tstore.list();
    const byWallet = new Map(); let totalTickets = 0;
    for (const b of blobs) {
      const v = await tstore.get(b.key, { type: "json" }); if (!v || !(v.tickets > 0)) continue;
      const w = v.wallet || v.name; if (!w) continue;
      const e = byWallet.get(w) || { wallet: v.wallet || null, name: v.name || v.wallet, tickets: 0 };
      e.tickets += v.tickets || 0; byWallet.set(w, e); totalTickets += v.tickets || 0;
    }
    const entries = [...byWallet.values()].sort((a, b) => (String(a.wallet) < String(b.wallet) ? -1 : String(a.wallet) > String(b.wallet) ? 1 : 0));

    // Prize = the REAL accumulated pot (verified purchases + tips), converted to SOL.
    // ?potSol= still overrides for a manual top-up/special draw; else use the ledger.
    const pot = await getPot();
    const sp = await solUsd();
    const potFromLedger = sp && pot.usd > 0 ? +(pot.usd / sp).toFixed(4) : 0;
    const potSol = Number(url.searchParams.get("potSol")) || potFromLedger;
    const nWinners = Number(url.searchParams.get("winners")) || winnerCount(potSol);
    const winners = pickWinners(seed, blockhash, entries, nWinners);
    const result = { ...pub, status: "drawn", seed, blockSlot: slot, blockhash, potSol, potUsd: +pot.usd.toFixed(2), potBreakdown: pot.byRoute, nWinners, totalTickets, entrants: entries.length, winners, drawnAt: Date.now() };
    await store.setJSON("public:" + latestRound, result);
    // snapshot + reset the pot so next week accumulates fresh (unless a manual override was used)
    if (!url.searchParams.get("potSol")) await archiveAndResetPot(latestRound);
    return json({ ok: true, ...result });
  }

  return json({ error: "unknown action" }, 400);
};

export const config = { path: "/api/draw" };
