// Shared provably-fair draw engine — the ONE place a weekly round is committed and drawn.
// Imported by /api/draw (store-fn-draw.mjs, admin buttons) and the weekly payout cron
// (store-fn-payout-cron.mjs), by /api/play (which round a new ticket goes to), and by the payout
// fraud checks (re-verify a draw).
//
//   commitRound()  → secret seed stored, sha256(seed) published, the round frozen (entries first, below)
//   drawRound()    → entries snapshotted + published, THEN a future target slot set; its blockhash mixed with the
//                    seed picks the winners (ticket-weighted, no repeats), seed revealed, pot snapshotted + reset,
//                    tickets archived
//   verifyDraw(n)  → recompute round n from its revealed seed + blockhash + archived tickets
//
// CRASH-SAFE (audit DD-07, 2026-10-23). A draw is a resumable state machine in a PRIVATE record
// draws/drawing:<n> (the seed stays secret until the end; public:<n> says "committed" until the very last step):
//   1 frozen    new tickets go to round n+1 from here on (ticketRound())
//   2 settled   SETTLE_MS later no play that saw round n open can still be writing into it
//   3 snapshot  the exact ticket ledger → draws/snap:<n> (create-only) → archived to tickets-archive
//   4 entries   [wallet, tickets] published (entries:<n>; + the target slot, for a freezeFirst round)
//   5 block     the first finalized block at/after the target slot (getBlocks)
//   6 pot       the pot is snapshotted to pot/round:<n> and reset ONCE (marker resetFor:<n> on the pot record)
//   7 result    winners computed only from the stored inputs (seed, blockhash, snapshot, pot, SOL price)
//   8 drawn     public:<n> committed → drawn (compare-and-swap, published LAST), then best-effort cleanup
// Every step is idempotent and stored before the next one runs, so a crash anywhere is finished by the next
// drawRound() call (the weekly cron calls it while public:<n> still says "committed"), and two concurrent calls
// converge on the same stored values. Commits are create-only too (seed:<n>, public:<n>; "latest" is repaired).
//
// ENTRIES FIRST (security review 2026-10-23, INFO-1/INFO-2). A round committed from now on ("freezeFirst") is
// frozen AT the commit: the seed's hash is published and new tickets go to the next round right away, but no
// target slot is chosen yet. After the settle, the ticket snapshot is taken and PUBLISHED (its hash on public:<n>,
// the [wallet, tickets] list on entries:<n>), and only then is the target slot set — so the blockhash that picks
// the winners comes into existence after the entries are fixed and public, and anyone can re-run the pick
// (/api/draw?action=entries&round=n, and the check on /draw). A round committed by the older code (target slot
// set at commit) is still drawn the old way.
//
// Blobs: "draws" (latest, public:<n>, seed:<n>, drawing:<n>, snap:<n>, entries:<n>, legacy-closed), "tickets"
// (r<n>:player:<wallet>, written ONLY by /api/play; the old unprefixed player:<wallet> ledger is drawn once, in
// the first draw after this change), "tickets-archive" (r<n>:player:<wallet>), "pot" (current, round:<n>).
// Env: SOLANA_RPC.
import { getStore } from "@netlify/blobs";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { getPot } from "./store-pot-core.mjs";
import { casUpdate, readWithEtag, putIfNew, putIfMatch, CasError } from "./store-cas-core.mjs";

export const SOL_MINT = "So11111111111111111111111111111111111111112";
export const SLOTS_AHEAD = 300;   // finalized + 300 ≈ 1–2 min ahead of the chain tip (slots run ~0.2–0.4 s; round 1 measured 56 s)
// Every week 5 winners (owner 2026-10-27), whatever the pot — paid in tiers 40 / 25 / 15 / 10 / 10% by pick order
// (store-payout-core PRIZE_TIERS). With fewer entrants the unfilled ranks' shares roll into next week's Pot.
export const WINNERS = 5;
export function winnerCount() { return WINNERS; }

const ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

// an error the HTTP wrapper turns into a status code (409 = wrong state)
export class DrawError extends Error { constructor(msg, status = 409) { super(msg); this.status = status; } }

// ORE spot (the Pot is shown and paid in ORE — whatever comes in is swapped to ORE at payout)
export async function oreUsd() {
  const ORE = "oreoU2P8bN6jkk3jbaiVxYnG1dCXcYxwhwyK9jSybcp";
  try { const j = await (await fetch("https://lite-api.jup.ag/price/v3?ids=" + ORE)).json(); const p = j?.[ORE]?.usdPrice; return p > 0 ? p : null; } catch { return null; }
}
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

// The blockhash of the first finalized block at or after `slot`. The slot comes from getBlocks — the
// authoritative list of slots that HAVE a finalized block — never from a getBlock error: a node missing a
// block in its long-term storage (-32009) answers like a skipped slot and used to push the draw onto the
// next slot (security review LOW-4). Any RPC failure is a retryable DrawError; nothing is ever skipped on an error.
export const BLOCK = { transactionDetails: "none", rewards: false, maxSupportedTransactionVersion: 0 };
export async function firstBlockSlot(from, to) {
  let slots;
  try { slots = await rpc("getBlocks", [from, to, { commitment: "finalized" }]); }
  catch (e) { throw new DrawError(`couldn't list the blocks from slot ${from} (${e.message || e}) — try again shortly`); }
  if (!Array.isArray(slots)) throw new DrawError(`couldn't list the blocks from slot ${from} — try again shortly`);
  const s = slots.map(Number).filter((x) => x >= from).sort((a, b) => a - b)[0];
  return s ?? null;
}
export async function blockhashAtOrAfter(slot) {
  const s = await firstBlockSlot(slot, slot + 150);
  if (s == null) throw new DrawError("no finalized block found near the target slot yet — try again shortly");
  let b;
  try { b = await rpc("getBlock", [s, BLOCK]); }
  catch (e) { throw new DrawError(`couldn't read the block at slot ${s} (${e.message || e}) — try again shortly`); }
  if (!b?.blockhash) throw new DrawError(`the block at slot ${s} came back without a hash — try again shortly`);
  return { slot: s, blockhash: b.blockhash };
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
// /api/play writes them count: key "player:<wallet>" (or "legacy:player:<wallet>" — the pre-DD-07
// unprefixed ledger, drawn once) with a valid base58 wallet field.
export function entriesFromRecords(records) {
  const byWallet = new Map(); let totalTickets = 0;
  for (const { key, value: v } of records) {
    const tk = +v?.tickets;   // numeric even if a record ever held a string (a "5" would concatenate)
    if (!v || !(tk > 0) || !Number.isFinite(tk)) continue;
    const k = String(key || "").startsWith("legacy:") ? String(key).slice(7) : key;
    if (!ADDR_RE.test(v.wallet || "") || k !== "player:" + v.wallet) continue;
    const e = byWallet.get(v.wallet) || { wallet: v.wallet, name: v.name || v.wallet, tickets: 0 };
    e.tickets += tk; byWallet.set(v.wallet, e); totalTickets += tk;
  }
  const entries = [...byWallet.values()].sort((a, b) => (a.wallet < b.wallet ? -1 : a.wallet > b.wallet ? 1 : 0));
  return { entries, totalTickets };
}
export const entriesHash = (entries) => sha256(JSON.stringify(entries.map((e) => [e.wallet, e.tickets])));

// Strong reads (a step must see what the previous step — maybe another invocation — just wrote).
const strong = async (store, key) => (await readWithEtag(store, key)).value;

// The latest committed round. A commit that crashed after writing public:<n+1> but before moving "latest"
// is repaired here, so a half-finished commit can never be forgotten or re-used.
export async function latestRound() {
  const store = getStore("draws");
  let n = Number((await strong(store, "latest")) || 0);
  const start = n;
  while (await strong(store, "public:" + (n + 1))) n++;
  if (n > start) await casUpdate(store, "latest", (cur) => (Number(cur || 0) >= n ? undefined : n));
  return n;
}
export async function getPublic(round) { return round ? await strong(getStore("draws"), "public:" + round) : null; }
// The published [wallet, tickets] list of a round (written when its entries froze), or null.
export async function publicEntries(round) { return round ? await strong(getStore("draws"), "entries:" + round) : null; }

// Tickets: the per-round ledger key /api/play mints into, and the round a ticket earned NOW belongs to — the
// open round, unless its draw has started (frozen) → the next one. (Before any round exists: round 1.)
export const ticketKey = (round, wallet) => `r${round}:player:${wallet}`;
export async function ticketRound() {
  const n = await latestRound();
  const pub = await getPublic(n);
  if (pub?.status === "committed" && !(await strong(getStore("draws"), "drawing:" + n))) return n;
  return n + 1;
}
export const SETTLE_MS = 30e3;   // > a play function's longest run: after it, nothing can still write into a frozen round

// Plays (store-fn-play.mjs; security review M11 — ticket hoarding). A play remembers the round it was started in.
// Finished in a LATER round more than ROUND_GRACE_MS after it started, it earns only the play ticket (no win
// bonus), so a banked win can't be timed into the fattest pot; an open play can't be finished at all after
// PLAY_TTL_MS. sweepPlays() deletes expired / long-finished play records.
export const PLAY_TTL_MS = 24 * 3600e3, ROUND_GRACE_MS = 30 * 60e3, PLAY_KEEP_MS = 8 * 24 * 3600e3;

// Open a new round: secret seed + public commitment. Throws DrawError(409) when a round is already open (or
// still being drawn). Create-only writes: two concurrent commits publish ONE round, and a commit that crashed
// half-way is completed (its seed was never revealed). The round is frozen right here (entries first, see the
// header): public:<n> first, then drawing:<n> — a commit that dies between the two is frozen by the first draw call.
export async function commitRound() {
  const store = getStore("draws");
  const latest = await latestRound();
  const open = await getPublic(latest);
  if (open && open.status !== "drawn") throw new DrawError("a round is already open — draw it first");
  const round = latest + 1;
  await putIfNew(store, "seed:" + round, { seed: randomBytes(32).toString("hex") });   // secret until the draw
  const { seed } = (await strong(store, "seed:" + round)) || {};
  if (!seed) throw new DrawError("seed missing", 500);
  // no target slot yet: it is chosen only after the entries are frozen and published (drawRound)
  const pub = { round, status: "committed", freezeFirst: true, commitHash: sha256(Buffer.from(seed, "hex")), targetSlot: null, committedAt: Date.now() };
  let out = pub;
  if (!(await putIfNew(store, "public:" + round, pub))) {
    const cur = await getPublic(round);
    if (cur?.status !== "committed") throw new DrawError(`round ${round} already exists`, 409);
    out = cur;   // a concurrent commit won — same round
  }
  if (out.freezeFirst) await putIfNew(store, "drawing:" + round, { round, phase: "frozen", frozenAt: Date.now() });   // tickets → round+1 from now
  await casUpdate(store, "latest", (cur) => (Number(cur || 0) >= round ? undefined : round));
  return out;
}

// Merge `fields` into drawing:<round> unless they are already there (first writer wins).
async function setOnce(store, round, fields) {
  const { value } = await casUpdate(store, "drawing:" + round, (cur) => {
    if (!cur) throw new DrawError("draw state missing", 500);
    const add = Object.fromEntries(Object.entries(fields).filter(([k]) => cur[k] === undefined));
    return Object.keys(add).length ? { ...cur, ...add } : undefined;
  });
  return value;
}

// Snapshot the pot to round:<round> and reset it — exactly ONCE per round. The pot record carries
// resetFor:<round> after the reset, so a re-run returns the archived snapshot instead of resetting again.
// Until the reset lands the snapshot is re-taken, so it always equals what the reset clears (a
// contribution arriving mid-way is in this round's snapshot or in next week's pot, never lost).
async function archivePotOnce(round) {
  const store = getStore("pot");
  const routeNames = Object.keys((await getPot()).routes || {});
  const zeroRoutes = (r = {}) => Object.fromEntries([...new Set([...routeNames, ...Object.keys(r)])].map((k) => [k, { sol: 0, skr: 0, ore: 0 }]));
  for (let i = 0; i < 10; i++) {
    const { value, etag } = await readWithEtag(store, "current");
    if (value && value.resetFor === round) {
      const snap = await strong(store, "round:" + round);
      if (snap) return snap;
      throw new DrawError(`the pot was reset for round ${round} but its snapshot is missing`, 500);
    }
    const { applied, resetFor, ...raw } = value || {};
    const routes = { ...zeroRoutes(raw.routes), ...(raw.routes || {}) };
    const snap = { usd: 0, since: null, updatedAt: null, ...raw, routes, round, closedAt: Date.now() };
    await store.setJSON("round:" + round, snap);   // archive FIRST
    const fresh = { usd: 0, routes: zeroRoutes(raw.routes), since: null, updatedAt: null, ...(applied ? { applied } : {}), resetFor: round };
    if (etag ? await putIfMatch(store, "current", fresh, etag) : await putIfNew(store, "current", fresh)) return snap;
  }
  throw new CasError("pot busy — retry the draw");
}

// Draw the open round. potSolOverride / winnersOverride keep the old admin query params
// (?potSol= manual top-up draw — then the pot ledger is NOT archived/reset); the first call's values are
// stored with the freeze and win. A round with NO winners (no tickets) does not reset the pot: it rolls over.
// A freezeFirst round (committed by this code) was frozen at its commit: the first call after the settle takes
// the snapshot, publishes the entries, picks the target slot and answers 409 "waiting for the target slot"; a
// call once that slot is final (the cron's next tick, or the admin a minute later) draws it. An older round
// (target slot set at commit) is frozen by the first call, which answers 409 "settling". Any crash is resumed
// the same way.
export async function drawRound({ potSolOverride = 0, winnersOverride = 0, now = Date.now() } = {}) {
  const store = getStore("draws");
  const round = await latestRound();
  let pub = await getPublic(round);
  if (!pub || pub.status !== "committed") throw new DrawError("no open round to draw — commit one first");
  const { seed } = (await strong(store, "seed:" + round)) || {};
  if (!seed) throw new DrawError("seed missing", 500);

  // 1) freeze — from now on /api/play mints into round+1. A freezeFirst round is normally frozen by its commit
  //    already; an older round only once its committed target slot is final.
  if (!(await strong(store, "drawing:" + round)) && !pub.freezeFirst) {
    const slot = await rpc("getSlot", [{ commitment: "finalized" }]);
    if (slot < pub.targetSlot) throw new DrawError(`the target slot ${pub.targetSlot} isn't final yet (now ${slot}) — try again shortly`);
  }
  await putIfNew(store, "drawing:" + round, { round, phase: "frozen", frozenAt: now });
  // the first call's admin overrides are kept (later calls can't change them)
  let st = await setOnce(store, round, { potSolOverride: Number(potSolOverride) || 0, winnersOverride: Number(winnersOverride) || 0 });
  // 2) settle
  const wait = st.frozenAt + SETTLE_MS - now;
  if (wait > 0) throw new DrawError(`round ${round} is frozen — tickets are settling; draw again in ${Math.ceil(wait / 1000)} s`, 409);

  // 3) the exact ticket snapshot (create-only) → archived to tickets-archive. Each record keeps its play ids
  //    (here, not in the archive) so a finish retried after this round is drawn can tell its play was minted.
  let snap = await strong(store, "snap:" + round);
  if (!snap) {
    const tstore = getStore("tickets");
    const legacy = !(await strong(store, "legacy-closed"));
    // one record per player:<wallet> — this round's ledger, plus (first draw only) the old unprefixed ledger,
    // summed per wallet; `src` = the live keys it came from.
    const byKey = new Map();
    const add = (key, src, v) => {
      const cur = byKey.get(key);
      if (!cur) { byKey.set(key, { key, src: [src], value: { ...v, playIds: [...(v.playIds || [])] } }); return; }
      cur.src.push(src);
      for (const f of ["tickets", "plays", "wins"]) cur.value[f] = (+cur.value[f] || 0) + (+v[f] || 0);
      cur.value.playIds = [...new Set([...cur.value.playIds, ...(v.playIds || [])])];
    };
    for (const b of (await tstore.list({ prefix: `r${round}:` })).blobs) {
      const v = await strong(tstore, b.key); if (v) add(b.key.slice(`r${round}:`.length), b.key, v);
    }
    if (legacy) for (const b of (await tstore.list({ prefix: "player:" })).blobs) {
      const v = await strong(tstore, b.key); if (v) add(b.key, b.key, v);
    }
    const records = [...byKey.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    const e = entriesFromRecords(records);
    await putIfNew(store, "snap:" + round, { round, takenAt: Date.now(), legacy, records, entriesHash: entriesHash(e.entries), totalTickets: e.totalTickets });
    snap = await strong(store, "snap:" + round);
  }
  if (snap.legacy) await putIfNew(store, "legacy-closed", { round, at: Date.now() });   // the old ledger is drawn ONCE
  if (!st.archived) {
    const archive = getStore("tickets-archive");
    for (const r of snap.records) { const { playIds, ...v } = r.value; await archive.setJSON(`r${round}:${r.key}`, v); }   // r<n>:player:<wallet>, as before
    st = await setOnce(store, round, { archived: Date.now(), phase: "snapshot" });
  }
  const { entries, totalTickets } = entriesFromRecords(snap.records);
  const rollover = !entries.length;

  // 4) publish the entries — the [wallet, tickets] list the pick runs on (what entriesHash commits to) — and, for a
  //    freezeFirst round, only NOW choose the target slot: its blockhash doesn't exist until after the entries are public.
  await putIfNew(store, "entries:" + round, { round, entriesHash: entriesHash(entries), totalTickets, entries: entries.map((e) => [e.wallet, e.tickets]) });
  if (pub.freezeFirst && !pub.targetSlot) {
    const fin = await rpc("getSlot", [{ commitment: "finalized" }]);
    await casUpdate(store, "public:" + round, (cur) => (cur && cur.status === "committed" && !cur.targetSlot
      ? { ...cur, targetSlot: fin + SLOTS_AHEAD, entriesSlot: fin, entriesAt: Date.now(), entriesHash: entriesHash(entries), totalTickets, entrants: entries.length } : undefined));
    pub = await getPublic(round);
    if (pub?.status !== "committed") throw new DrawError(`round ${round} was drawn meanwhile — reload`, 409);
  }

  // 5) the blockhash at/after the committed target slot (stored once)
  if (!st.blockhash) {
    if (pub.freezeFirst) {
      const fin = await rpc("getSlot", [{ commitment: "finalized" }]);
      if (fin < pub.targetSlot) throw new DrawError(`round ${round}: entries frozen (${totalTickets} tickets, ${entries.length} players) — waiting for target slot ${pub.targetSlot} (now ${fin}); draw again in about a minute`, 409);
    }
    const b = await blockhashAtOrAfter(pub.targetSlot); st = await setOnce(store, round, { blockSlot: b.slot, blockhash: b.blockhash });
  }

  // 6) the pot: snapshot + reset once (or just read it, when it carries over)
  if (!st.pot) {
    const reset = !st.potSolOverride && !rollover;
    const p = reset ? await archivePotOnce(round) : await getPot();
    const solPrice = await solUsd();
    if (!solPrice && !st.potSolOverride) throw new DrawError("no SOL price right now — draw again shortly", 503);
    st = await setOnce(store, round, { pot: { usd: +p.usd || 0, routes: p.routes || {} }, potReset: reset, solPrice: solPrice || 0, phase: "pot" });
  }

  // 7) the result — from the stored inputs only, so every re-run picks the same winners
  if (!st.result) {
    const potFromLedger = st.solPrice > 0 && st.pot.usd > 0 ? +(st.pot.usd / st.solPrice).toFixed(4) : 0;
    const potSol = st.potSolOverride || potFromLedger;
    const nWinners = Math.min(WINNERS, st.winnersOverride || WINNERS);   // the old ?winners= override can only lower it (5 tiers)
    const winners = pickWinners(seed, st.blockhash, entries, nWinners);
    st = await setOnce(store, round, { phase: "result", result: { ...pub, status: "drawn", seed, blockSlot: st.blockSlot, blockhash: st.blockhash, potSol,
      potUsd: +st.pot.usd.toFixed(2), potBreakdown: st.pot.routes, nWinners, totalTickets, entrants: entries.length, entriesHash: entriesHash(entries),
      winners, drawnAt: Date.now(), ...(rollover ? { potRolledOver: true } : {}), ...(st.potSolOverride ? { manualPot: true } : {}) } });
  }

  // 8) publish LAST — committed → drawn, exactly once
  await casUpdate(store, "public:" + round, (cur) => (cur && cur.status === "committed" ? st.result : undefined));
  const result = await getPublic(round);
  // 9) cleanup (best effort — nothing reads a drawn round's live tickets or the drawn legacy ledger again)
  try {
    const tstore = getStore("tickets");
    for (const b of (await tstore.list({ prefix: `r${round}:` })).blobs) await tstore.delete(b.key);
    for (const r of snap.records) for (const k of r.src || []) if (k.startsWith("player:")) await tstore.delete(k);   // the drawn old ledger
    await setOnce(store, round, { cleanedAt: Date.now() });
  } catch { /* leftovers are harmless */ }
  try { await sweepPlays({ round, budgetMs: 5000 }); } catch { /* best effort */ }
  return result;
}

// Was `playId` minted into `round`, which has since been frozen? true / false from that round's ticket snapshot,
// null while it has none yet (its live ledger is then still the whole truth). A snapshot taken before play ids were
// kept answers true: when in doubt a play is never minted twice.
export async function mintedInSnapshot(round, wallet, playId) {
  const snap = await strong(getStore("draws"), "snap:" + round);
  if (!snap) return null;
  const rec = (snap.records || []).find((r) => r.key === "player:" + wallet);
  if (!rec) return false;
  return Array.isArray(rec.value?.playIds) ? rec.value.playIds.includes(playId) : true;
}

// Delete play records nobody can use any more: open plays past PLAY_TTL_MS (+1 h margin) and plays finished (or stuck
// "finishing") more than PLAY_KEEP_MS ago. Play ids are random hex, so the store is walked one "play:<hex digit>"
// shard at a time, starting at a different shard each round, until the time budget runs out.
export async function sweepPlays({ round = 0, budgetMs = 5000, now = Date.now() } = {}) {
  const plays = getStore("plays"), t0 = Date.now(), HEX = "0123456789abcdef";
  let checked = 0, deleted = 0;
  for (let i = 0; i < 16 && Date.now() - t0 < budgetMs; i++) {
    const h = HEX[(Number(round) * 5 + i) % 16];
    for (const b of (await plays.list({ prefix: "play:" + h })).blobs) {
      if (Date.now() - t0 >= budgetMs) break;
      const p = await plays.get(b.key, { type: "json" }).catch(() => null); checked++;
      if (!p) continue;
      const open = p.status === "open" && now - (p.createdAt || 0) > PLAY_TTL_MS + 3600e3;
      const old = p.status !== "open" && now - (p.finishedAt || p.finishingAt || p.createdAt || 0) > PLAY_KEEP_MS;
      if (open || old) { await plays.delete(b.key); deleted++; }
    }
  }
  return { checked, deleted };
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
  // entries first: the ticket list was frozen and published before the target slot was even chosen
  if (pub.freezeFirst && !(pub.entriesSlot < pub.targetSlot)) problems.push("the entries were published after the target slot was set");
  // the blockhash really is that slot's, and it is the FIRST block at/after the target (getBlocks lists every slot with a block)
  try {
    const b = await rpc("getBlock", [pub.blockSlot, BLOCK]);
    if (!b?.blockhash) unchecked.push("on-chain blockhash (block not returned)");
    else if (b.blockhash !== pub.blockhash) problems.push(`blockhash ${pub.blockhash} is not slot ${pub.blockSlot}'s on-chain hash`);
  } catch (e) { unchecked.push("on-chain blockhash (" + (e.message || e) + ")"); }
  try {
    const first = await firstBlockSlot(pub.targetSlot, pub.blockSlot);
    if (first == null) unchecked.push("first block after the target slot (no block listed)");
    else if (first !== pub.blockSlot) problems.push(`slot ${first} had a block — the draw should have used it, not slot ${pub.blockSlot}`);
  } catch (e) { unchecked.push("first block after the target slot (" + (e.message || e) + ")"); }
  const { entries, totalTickets } = await archivedEntries(round);
  if (pub.entriesHash && entriesHash(entries) !== pub.entriesHash) problems.push("archived tickets differ from the snapshot that was drawn");
  const published = await strong(getStore("draws"), "entries:" + round);
  if (published && pub.entriesHash && entriesHash((published.entries || []).map(([wallet, tickets]) => ({ wallet, tickets }))) !== pub.entriesHash)
    problems.push("the published entries list differs from the snapshot that was drawn");
  if (totalTickets !== pub.totalTickets) problems.push(`archived tickets total ${totalTickets} ≠ drawn total ${pub.totalTickets}`);
  const again = pickWinners(pub.seed, pub.blockhash, entries, pub.nWinners || (pub.winners || []).length);
  const a = again.map((w) => w.wallet).join(","), b = (pub.winners || []).map((w) => w.wallet).join(",");
  if (a !== b) problems.push("recomputed winners differ from the published winners");
  return { ok: !problems.length, problems, unchecked, entries, totalTickets };
}
