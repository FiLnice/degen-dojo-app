/* Degen Duel — the ONE deterministic engine, shared by the browser (to deal &
 * animate) and the server (to verify the winner). Both run this from the same
 * committed seed, so they agree.
 *
 * Duel is a best-of-8 card game: from a seeded shuffle you and the Dojo each get 8
 * fighters (both hands visible); each round a seeded battle-stat is chosen; YOU pick
 * which of your cards to play, the Dojo always plays its best card for that stat;
 * higher value wins the round. The only player input is the ORDER you play your 8
 * cards — a permutation of [0..7] — so the outcome is a pure function of (seed, picks).
 *
 *   import { simulate, makeRng } from './dojo-duel-engine.mjs'
 *   simulate(pool, seedHex, [2,0,3,1,7,4,6,5])  → 'me' | 'dojo' | 'draw'
 *
 * `pool` is [atk,def,hp,dmg] per fighter in the FIXED buildPool order (see
 * duel-pool.mjs). `picks[r]` = index (0..7) of the hand card you played in round r.
 */
const ROUNDS = 8, HAND = 8, STATS = 4;   // 8 rounds, 8 cards each side, 4 battle stats

export function makeRng(seedHex) {
  let h = 2166136261 >>> 0;
  const s = String(seedHex);
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  let a = h >>> 0;
  return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}

// Reproduce the page's draw order EXACTLY: pickHands() shuffles the whole pool then
// takes 16 (8 each); then one battle-stat is drawn per round. Same rng → same game.
export function deal(pool, rng) {
  const n = pool.length;
  const idx = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) { const j = rng() * (i + 1) | 0; const t = idx[i]; idx[i] = idx[j]; idx[j] = t; }  // Fisher-Yates == page's pickHands
  const hand = idx.slice(0, 16);
  const you = hand.slice(0, 8).map((i) => pool[i]);
  const dojo = hand.slice(8, 16).map((i) => pool[i]);
  const stats = [];
  for (let r = 0; r < ROUNDS; r++) stats.push(rng() * STATS | 0);   // Math.floor(rng()*4)
  return { you, dojo, stats };
}

// Play it out. picks = a permutation of [0..3]: which hand card you played each round.
export function simulate(pool, seedHex, picks) {
  const { you, dojo, stats } = deal(pool, makeRng(seedHex));
  const usedY = [false, false, false, false], usedD = [false, false, false, false];
  let sY = 0, sD = 0;
  for (let r = 0; r < ROUNDS; r++) {
    const k = stats[r];
    const yi = picks[r];
    if (yi < 0 || yi >= HAND || usedY[yi]) throw new Error("illegal pick");
    // the Dojo plays its BEST unused card for this stat (first max on ties — matches reduce)
    let di = -1;
    for (let i = 0; i < HAND; i++) { if (!usedD[i] && (di < 0 || dojo[i][k] > dojo[di][k])) di = i; }
    const yv = you[yi][k], dv = dojo[di][k];
    if (yv > dv) sY++; else if (yv < dv) sD++;   // tie → no point to either (matches the page)
    usedY[yi] = true; usedD[di] = true;
  }
  return sY > sD ? "me" : sY < sD ? "dojo" : "draw";
}

/* ── v2: SERVER-LOCKED ROUNDS (security audit DD-02) ─────────────────────────────────────────
 * v1 revealed the seed at start, and the seed fixed all 8 battle stats — so a player could try
 * all 40,320 card orders offline and submit a guaranteed win. In v2 the seed stays on the server
 * until the duel is over:
 *   • the HANDS still come from makeRng(seed) (both hands are shown to the player anyway — and
 *     that 32-bit rng state reveals nothing about the stats below);
 *   • the 8 battle stats come from SHA-256(seed + ":duel-stats") — unknowable without the seed;
 *   • the player sees round r's stat, submits ONE card, the server resolves it and only then
 *     reveals round r+1's stat. After round 8 the seed is revealed; anyone can check
 *     sha256(seed) == the commitment published at start and replay the whole duel.
 */
export const DUEL_V2 = 2;
export const STATS_TAG = ":duel-stats";

// pool indices of both hands (same shuffle as deal())
export function dealHands(pool, seedHex) {
  const rng = makeRng(seedHex), n = pool.length;
  const idx = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) { const j = rng() * (i + 1) | 0; const t = idx[i]; idx[i] = idx[j]; idx[j] = t; }
  return { you: idx.slice(0, HAND), dojo: idx.slice(HAND, HAND * 2) };
}

// the 8 battle stats from the SHA-256 digest of (seedHex + STATS_TAG): one byte per round, % 4
// (256 is a multiple of 4, so every stat is equally likely)
export function statsFromDigest(digest) {
  const b = digest instanceof Uint8Array ? digest : new Uint8Array(digest);
  return Array.from({ length: ROUNDS }, (_, r) => b[r] % STATS);
}
export async function roundStats(seedHex) {   // browser + Node 18+ (Web Crypto)
  const d = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(seedHex) + STATS_TAG));
  return statsFromDigest(new Uint8Array(d));
}

// One round. state = { round, usedY:[8], usedD:[8], sY, sD }; hands hold pool indices; pick = hand slot 0..7.
// The Dojo plays its BEST unused card for the stat (first max on ties), exactly as in v1.
export function playRound(pool, hands, stats, state, pick) {
  const r = state.round;
  if (r < 0 || r >= ROUNDS) throw new Error("duel is over");
  if (!Number.isInteger(pick) || pick < 0 || pick >= HAND || state.usedY[pick]) throw new Error("illegal pick");
  const k = stats[r];
  let di = -1;
  for (let i = 0; i < HAND; i++) { if (!state.usedD[i] && (di < 0 || pool[hands.dojo[i]][k] > pool[hands.dojo[di]][k])) di = i; }
  const yv = pool[hands.you[pick]][k], dv = pool[hands.dojo[di]][k];
  const res = yv > dv ? "w" : yv < dv ? "l" : "t";
  const usedY = state.usedY.slice(), usedD = state.usedD.slice();
  usedY[pick] = true; usedD[di] = true;
  return { k, yi: pick, di, r: res,
    state: { round: r + 1, usedY, usedD, sY: state.sY + (res === "w" ? 1 : 0), sD: state.sD + (res === "l" ? 1 : 0) } };
}
export const freshState = () => ({ round: 0, usedY: Array(HAND).fill(false), usedD: Array(HAND).fill(false), sY: 0, sD: 0 });
export const winnerOf = (st) => (st.sY > st.sD ? "me" : st.sY < st.sD ? "dojo" : "draw");

// Replay a whole v2 duel (verification): picks = the 8 hand slots played, in order.
export function simulateV2(pool, seedHex, stats, picks) {
  const hands = dealHands(pool, seedHex);
  let st = freshState();
  for (let r = 0; r < ROUNDS; r++) st = playRound(pool, hands, stats, st, picks[r]).state;
  return winnerOf(st);
}

if (typeof window !== "undefined") window.DuelEngine = { simulate, makeRng, deal, dealHands, roundStats, statsFromDigest, playRound, freshState, winnerOf, simulateV2, DUEL_V2 };
