// Shared provably-fair draw engine — the ONE place a weekly round is committed and drawn.
// Imported by /api/draw (store-fn-draw.mjs, admin buttons) and the weekly payout cron
// (store-fn-payout-cron.mjs), and by the payout fraud checks (re-verify a draw).
//
//   commitRound()  → secret seed stored, sha256(seed) + a future target slot published
//   drawRound()    → blockhash at/after the target slot mixed with the seed picks the winners
//                    (ticket-weighted, no repeats), seed revealed, pot snapshotted + reset,
//                    tickets archived + cleared
//   verifyDraw(n)  → recompute round n from its revealed seed + blockhash + archived tickets
//
// Blobs: "draws" (latest, public:<n>, seed:<n>), "tickets" (player:<wallet>, written ONLY by
// /api/play), "tickets-archive" (r<n>:player:<wallet>), "pot" (via store-pot-core.mjs).
// Env: SOLANA_RPC.
import { getStore } from "@netlify/blobs";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { getPot, archiveAndResetPot } from "./store-pot-core.mjs";

export const SOL_MINT = "So11111111111111111111111111111111111111112";
export const SLOTS_AHEAD = 300;   // ~2 min of slots between commit and the target blockhash
// Winner count scales with the pot: a fat pot (> BIG_POT_SOL) splits among more winners to
// feel winnable; a small pot stays one big grab-attention prize.
export const BIG_POT_SOL = 10;
export const WINNERS_BIG = 5, WINNERS_SMALL = 1;
export function winnerCount(potSol) { return potSol > BIG_POT_SOL ? WINNERS_BIG : WINNERS_SMALL; }

const ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

// an error the HTTP wrapper turns into a status code (409 = wrong state)
export class DrawError extends Error { constructor(msg, status = 409) { super(msg); this.status = status; } }

export async function solUsd() {
  try { const j = await (await fetch("https://lite-api.jup.ag/price/v3?ids=" + SOL_MINT)).json(); const p = j?.[SOL_MINT]?.usdPrice; return p > 0 ? p : null; } catch { return null; }
}

export async function rpc(method, params) {
  const r = await fetch(process.env.SOLANA_RPC, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = await r.json();
  if (j.error) { const e = new Error(j.error.message || method + " failed"); e.code = j.error.code; throw e; }
  return j.result;
}

// the blockhash of the first finalized block at or after `slot` (skipped slots have none)
export async function blockhashAtOrAfter(slot) {
  for (let s = slot; s < slot + 150; s++) {
    try {
      const b = await rpc("getBlock", [s, { transactionDetails: "none", rewards: false, maxSupportedTransactionVersion: 0 }]);
      if (b?.blockhash) return { slot: s, blockhash: b.blockhash };
    } catch { /* skipped slot → try the next */ }
  }
  throw new DrawError("no finalized block found near the target slot yet — try again shortly");
}

// deterministic weighted pick of up to n distinct winners from [{wallet, name, tickets}].
// Entries must be sorted canonically (by wallet) so the pick reproduces regardless of
// blob-list order. Carries the WALLET through so the payout can pay winners directly.
export function pickWinners(seedHex, blockhash, entriesIn, n) {
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

// Aggregate ticket records [{key, value}] → canonical entries. Only records shaped like
// /api/play writes them count: key "player:<wallet>" with a valid base58 wallet field.
export function entriesFromRecords(records) {
  const byWallet = new Map(); let totalTickets = 0;
  for (const { key, value: v } of records) {
    if (!v || !(v.tickets > 0)) continue;
    if (!ADDR_RE.test(v.wallet || "") || key !== "player:" + v.wallet) continue;
    const e = byWallet.get(v.wallet) || { wallet: v.wallet, name: v.name || v.wallet, tickets: 0 };
    e.tickets += v.tickets || 0; byWallet.set(v.wallet, e); totalTickets += v.tickets || 0;
  }
  const entries = [...byWallet.values()].sort((a, b) => (a.wallet < b.wallet ? -1 : a.wallet > b.wallet ? 1 : 0));
  return { entries, totalTickets };
}
export const entriesHash = (entries) => sha256(JSON.stringify(entries.map((e) => [e.wallet, e.tickets])));

export async function latestRound() { return Number((await getStore("draws").get("latest")) || 0); }
export async function getPublic(round) { return round ? await getStore("draws").get("public:" + round, { type: "json" }) : null; }

// Open a new round: secret seed + public commitment to a FUTURE slot. Throws DrawError(409)
// when a round is already open.
export async function commitRound() {
  const store = getStore("draws");
  const latest = await latestRound();
  const open = await getPublic(latest);
  if (open && open.status === "committed") throw new DrawError("a round is already open — draw it first");
  const round = latest + 1;
  const seed = randomBytes(32).toString("hex");
  const targetSlot = (await rpc("getSlot", [{ commitment: "finalized" }])) + SLOTS_AHEAD;
  await store.setJSON("seed:" + round, { seed });                       // secret until the draw
  const pub = { round, status: "committed", commitHash: sha256(Buffer.from(seed, "hex")), targetSlot, committedAt: Date.now() };
  await store.setJSON("public:" + round, pub);
  await store.set("latest", String(round));
  return pub;
}

// Draw the open round. potSolOverride / winnersOverride keep the old admin query params
// (?potSol= manual top-up draw — then the pot ledger is NOT archived/reset).
// A round with NO winners (no tickets) does not reset the pot: it rolls over to next week.
export async function drawRound({ potSolOverride = 0, winnersOverride = 0 } = {}) {
  const store = getStore("draws");
  const round = await latestRound();
  const pub = await getPublic(round);
  if (!pub || pub.status !== "committed") throw new DrawError("no open round to draw — commit one first");
  const { seed } = (await store.get("seed:" + round, { type: "json" })) || {};
  if (!seed) throw new DrawError("seed missing", 500);
  const { slot, blockhash } = await blockhashAtOrAfter(pub.targetSlot);

  // read the ticket ledger ONCE — the exact snapshot that is drawn is the one archived, so the
  // draw can be re-verified later from tickets-archive even if someone played mid-draw.
  const tstore = getStore("tickets");
  const { blobs } = await tstore.list();
  const records = [];
  for (const b of blobs) records.push({ key: b.key, value: await tstore.get(b.key, { type: "json" }) });
  const { entries, totalTickets } = entriesFromRecords(records);

  // Prize = the REAL accumulated pot (verified purchases + tips + royalties), shown in SOL.
  const pot = await getPot();
  const sp = await solUsd();
  const potFromLedger = sp && pot.usd > 0 ? +(pot.usd / sp).toFixed(4) : 0;
  const potSol = Number(potSolOverride) || potFromLedger;
  const nWinners = Number(winnersOverride) || winnerCount(potSol);
  const winners = pickWinners(seed, blockhash, entries, nWinners);
  const rollover = !winners.length;
  const result = { ...pub, status: "drawn", seed, blockSlot: slot, blockhash, potSol, potUsd: +pot.usd.toFixed(2), potBreakdown: pot.routes,
    nWinners, totalTickets, entrants: entries.length, entriesHash: entriesHash(entries), winners, drawnAt: Date.now(),
    ...(rollover ? { potRolledOver: true } : {}), ...(potSolOverride ? { manualPot: true } : {}) };
  await store.setJSON("public:" + round, result);
  // snapshot + reset the pot so next week accumulates fresh (unless a manual override was used,
  // or nobody won — then the pot simply carries over).
  if (!potSolOverride && !rollover) await archiveAndResetPot(round);
  // Chances are per round ("weekly"): archive the drawn ticket snapshot into "tickets-archive"
  // (r<round>:<key>) and clear it, so the next round — and its grand slam — starts from zero.
  const archive = getStore("tickets-archive");
  for (const { key, value } of records) {
    if (value) await archive.setJSON(`r${round}:${key}`, value);
    await tstore.delete(key);
  }
  return result;
}

// Archived entries of a drawn round (what the pick ran on).
export async function archivedEntries(round) {
  const archive = getStore("tickets-archive");
  const prefix = `r${round}:`;
  const { blobs } = await archive.list({ prefix });
  const records = [];
  for (const b of blobs) records.push({ key: b.key.slice(prefix.length), value: await archive.get(b.key, { type: "json" }) });
  return entriesFromRecords(records);
}

// Independently re-check a drawn round: commitment, on-chain blockhash, and the pick itself.
// Returns { ok, problems:[…], unchecked:[…], entries, totalTickets }.
export async function verifyDraw(round) {
  const problems = [], unchecked = [];
  const pub = await getPublic(round);
  if (!pub || pub.status !== "drawn") return { ok: false, problems: ["round " + round + " is not drawn"], unchecked, entries: [], totalTickets: 0 };
  if (sha256(Buffer.from(pub.seed || "", "hex")) !== pub.commitHash) problems.push("revealed seed does not match the published commitment");
  if (!(pub.blockSlot >= pub.targetSlot)) problems.push("draw block slot is before the committed target slot");
  // the blockhash really is that slot's (and every slot between target and it was skipped)
  try {
    const b = await rpc("getBlock", [pub.blockSlot, { transactionDetails: "none", rewards: false, maxSupportedTransactionVersion: 0 }]);
    if (!b?.blockhash) unchecked.push("on-chain blockhash (block not returned)");
    else if (b.blockhash !== pub.blockhash) problems.push(`blockhash ${pub.blockhash} is not slot ${pub.blockSlot}'s on-chain hash`);
    const gap = pub.blockSlot - pub.targetSlot;
    if (gap > 0 && gap <= 8) {
      for (let s = pub.targetSlot; s < pub.blockSlot; s++) {
        let hb = null; try { hb = await rpc("getBlock", [s, { transactionDetails: "none", rewards: false, maxSupportedTransactionVersion: 0 }]); } catch {}
        if (hb?.blockhash) { problems.push(`slot ${s} had a block — the draw should have used it, not slot ${pub.blockSlot}`); break; }
      }
    } else if (gap > 8) unchecked.push(`skipped-slot gap of ${gap} (too long to scan)`);
  } catch (e) { unchecked.push("on-chain blockhash (" + (e.message || e) + ")"); }
  const { entries, totalTickets } = await archivedEntries(round);
  if (pub.entriesHash && entriesHash(entries) !== pub.entriesHash) problems.push("archived tickets differ from the snapshot that was drawn");
  if (totalTickets !== pub.totalTickets) problems.push(`archived tickets total ${totalTickets} ≠ drawn total ${pub.totalTickets}`);
  const again = pickWinners(pub.seed, pub.blockhash, entries, pub.nWinners || (pub.winners || []).length);
  const a = again.map((w) => w.wallet).join(","), b = (pub.winners || []).map((w) => w.wallet).join(",");
  if (a !== b) problems.push("recomputed winners differ from the published winners");
  return { ok: !problems.length, problems, unchecked, entries, totalTickets };
}
