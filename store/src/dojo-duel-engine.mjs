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

if (typeof window !== "undefined") window.DuelEngine = { simulate, makeRng, deal };
