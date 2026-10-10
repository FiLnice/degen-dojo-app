/* Dojo Flip — the ONE deterministic engine, shared by the browser (to animate)
 * and the server (to verify the winner). Because both run this exact code from the
 * same committed seed, they can never disagree — which is what lets /api/play mint
 * the win bonus without trusting the client.
 *
 * Flip has no skill: you flip your face-down top card, so the whole game is a pure
 * function of (seed → shuffle, chosen stat, mode). Lock the stat at deal and the
 * outcome is fully reproducible.
 *
 *   import { simulate, makeRng, shuffleIndices, DECK_SIZE } from './dojo-flip-engine.mjs'
 *   simulate(cards, seedHex, 'a', 'casual')  → 'me' | 'ai' | 'draw'
 *
 * `cards` is the POOL in a FIXED order, each { a, d, h, s } (integer stats). The
 * client and server must pass the identical array so the seeded shuffle matches.
 */
export const DECK_SIZE = 21;
const TOTAL = DECK_SIZE * 2;

// mulberry32 seeded from an FNV-1a hash of the hex seed — identical maths client & server
export function makeRng(seedHex) {
  let h = 2166136261 >>> 0;
  const s = String(seedHex);
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  let a = h >>> 0;
  return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}

// Fisher-Yates over [0..n-1] — mirrors the page's `shuf` loop exactly (i from n-1 down to 1)
export function shuffleIndices(n, rng) {
  const a = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) { const j = rng() * (i + 1) | 0; const t = a[i]; a[i] = a[j]; a[j] = t; }
  return a;
}

// Play the whole game out. Returns the winner: 'me', 'ai', or 'draw'.
export function simulate(cards, seedHex, stat, mode) {
  if (!Array.isArray(cards) || cards.length < TOTAL) throw new Error("need at least " + TOTAL + " cards");
  const rng = makeRng(seedHex);
  const order = shuffleIndices(cards.length, rng);
  let me = order.slice(0, DECK_SIZE).map((i) => cards[i]);
  let ai = order.slice(DECK_SIZE, TOTAL).map((i) => cards[i]);
  let pile = [];
  let turn = "me";
  const ld = (c) => ((c[stat] % 10) + 10) % 10;
  let guard = 0; const GUARD = 500000;

  // ── one resolveFlip, mutating the deck + pile in place (faithful to the page) ──
  function resolveFlip(who) {
    const deck = who === "me" ? me : ai;
    const card = deck.shift();
    const top = pile.length ? pile[pile.length - 1] : null;
    let result = "stack";
    if (top && ld(card) === ld(top)) result = "match";
    else if (mode === "comp" && top && card[stat] > top[stat]) result = "capture";
    pile.push(card);
    if (result === "match") { const won = pile.slice(0, -1); pile = [card]; deck.push(...won); }
    else if (result === "capture") { const cap = pile.splice(pile.length - 2, 1)[0]; deck.push(cap); }
  }

  // ── endgame: the player who ran out (loser) holds the pack; winner lays from hand ──
  // Returns a winner string, or a { resume } state to continue normal play (reclaim).
  function endgame(loser, winner) {
    let pack = pile.slice(); pile = [];
    if (pack.length < 1) return winner;
    let t = winner;
    let prev = pack[pack.length - 1];
    let noMatchPulls = 0, steps = 0; const CAP = 500000;
    while (true) {
      if (steps++ > CAP) return "draw";
      const winnerHand = winner === "me" ? me : ai;
      const bothEmpty = winnerHand.length === 0;
      const laid = (t === winner && !bothEmpty);
      let played;
      if (laid) { played = winnerHand.shift(); pack.push(played); }
      else { played = pack.shift(); pack.push(played); }
      if (prev && ld(played) === ld(prev)) {
        if (bothEmpty) return t;               // pure pull-off → the puller wins
        if (t === winner) return winner;        // winner matched from hand → wins outright
        // loser matched → reclaims the pack (minus the hitting card) and play resumes
        const rest = pack.slice(0, -1);
        if (loser === "me") { me = rest; } else { ai = rest; }
        return { resume: true, pile: [played], turn: winner };
      }
      if (bothEmpty) { noMatchPulls++; if (noMatchPulls >= pack.length) return "draw"; }
      else noMatchPulls = 0;
      prev = played;
      t = (t === winner) ? loser : winner;
    }
  }

  while (true) {
    if (guard++ > GUARD) return "draw";
    resolveFlip(turn);
    const deck = turn === "me" ? me : ai;
    if (deck.length === 0) {
      const loser = turn, winner = turn === "me" ? "ai" : "me";
      const r = endgame(loser, winner);
      if (typeof r === "string") return r;
      pile = r.pile; turn = r.turn;            // reclaim → resume normal play
      continue;
    }
    turn = turn === "me" ? "ai" : "me";
  }
}

// expose to the browser too (loaded via a small module shim that stashes this on window)
if (typeof window !== "undefined") window.FlipEngine = { simulate, makeRng, shuffleIndices, DECK_SIZE };
