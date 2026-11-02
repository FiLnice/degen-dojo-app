// What a run of SOL is likely to earn, worked out live from the last finished round (owner 2026-10-31). The odds are ORE's own
// (api/src/state/round.rs): 15 of the 25 tiles split the round's 1 uORE, the other 10 give it to one miner, and a Motherlode hits
// 1 round in 500. Checked against 700 real rounds replayed: 1 SOL at 0.01 a round = 0.39 uORE steady, 22% solo.
import { estimateRounds, ROUND_SLOTS, INTERMISSION_SLOTS, SQUARES, ORE_HOUSE_TAX, EXECUTOR_FEE_LAMPORTS } from "@/lib/ore";

export const SPLIT_TILES = 15;
export const SOLO_TILES = 10;
export const MOTHERLODE_ODDS = 1 / 500;
export const NO_MOTHERLODE_LIMIT = 0xffff; // ORE's own default: the most a u16 of whole ORE can say

/** The Steady strategy never mines with the Motherlode above this many whole ORE (owner). ORE enforces it: a skipped round costs nothing. */
export const PRESET_MAX_MOTHERLODE = 140;

// The Motherlode a mined round can pay, averaged over time: it grows 0.2 uORE a round and hits 1 round in 500, so it averages 100 ORE
// at a hit, and 54 for a run that sits out above 140 (simulated over 30M rounds, 2026-10-31). A quarter of hits land above 140.
// Its size runs like an exponential of mean 100, which gives both figures for any range (meanPool in the store's ORE tools).
function averageMotherlode(min: number, max: number) {
  if (max >= NO_MOTHERLODE_LIMIT) return min + 100;
  const span = max - min, tail = Math.exp(-span / 100);
  return min + 100 - (span * tail) / (1 - tail);
}

// How busy the board is by Motherlode size (35,655 rounds, Sep–Oct 2026; the same table as the ORE Wizard's store-ore-tools.js):
// share = the fraction of rounds in that range, f = the average board there against the overall average. Miners pile in while the
// Motherlode is big, so a run that only mines a low range meets a quieter board than the one on screen (owner 2026-11-02).
const ML_BANDS = [
  { lo: 0, hi: 50, share: 0.385, f: 0.92 }, { lo: 50, hi: 100, share: 0.232, f: 0.978 }, { lo: 100, hi: 150, share: 0.121, f: 1.025 },
  { lo: 150, hi: 200, share: 0.082, f: 1.1 }, { lo: 200, hi: 250, share: 0.061, f: 1.235 }, { lo: 250, hi: 300, share: 0.045, f: 1.353 },
  { lo: 300, hi: 350, share: 0.032, f: 1.484 }, { lo: 350, hi: 400, share: 0.022, f: 1.555 }, { lo: 400, hi: 500, share: 0.019, f: 1.487 },
];
const bandOf = (ml: number) => ML_BANDS.find((b) => ml < b.hi) ?? ML_BANDS[ML_BANDS.length - 1];

/** The board a run meets over its Motherlode range, as weights and multipliers on the board seen now (at `motherlodeNow`). */
function boardBands(motherlodeNow: number, min: number, max: number) {
  const fNow = bandOf(motherlodeNow).f;
  const out: { w: number; scale: number }[] = [];
  ML_BANDS.forEach((b, i) => {
    const top = i === ML_BANDS.length - 1 ? Math.max(b.hi, max >= NO_MOTHERLODE_LIMIT ? b.hi : max) : b.hi;
    const lo = Math.max(b.lo, min), hi = Math.min(top, max);
    if (hi > lo) out.push({ w: b.share * Math.min(1, (hi - lo) / (top - b.lo)), scale: b.f / fNow });
  });
  return out.length ? out : [{ w: 1, scale: 1 }];
}

// Lamports a tile (owner 2026-10-31: 0.0012 and 0.0004 SOL). The SOL goes at ~10.5% of the stake a round, so 1 SOL lasts ~300 rounds
// (~6.5 h) on Shorter and ~940 rounds (~20 h) on Longer on all 25 tiles. What a run earns barely changes between them.
export const PRESETS = { shorter: 1_200_000, longer: 400_000 } as const;
export type Preset = keyof typeof PRESETS;

// The five ready strategies (owner 2026-11-02, replacing plain Shorter/Longer, which are now the pace of any of them). Named by what
// a miner is after, not by past results: across 67 ORE Parties the spread was about 90% luck (see the ORE Wizard notes).
// max = NO_MOTHERLODE_LIMIT means no upper limit.
export const STRATEGIES = {
  steady: { label: "Steady", solo: SOLO_TILES, split: SPLIT_TILES, min: 0, max: PRESET_MAX_MOTHERLODE, blurb: `All 25 tiles. Pauses while the Motherlode is above ${PRESET_MAX_MOTHERLODE} uORE.` },
  split: { label: "Split only", solo: 0, split: SPLIT_TILES, min: 0, max: 90, blurb: "The 15 split tiles: smaller, steadier wins, cheaper rounds, no solos. Pauses above 90 uORE." },
  solo: { label: "Solo hunter", solo: SOLO_TILES, split: 0, min: 0, max: 90, blurb: "The 10 solo tiles: rarer wins of a whole uORE. Pauses above 90 uORE." },
  motherlode: { label: "Motherlode", solo: SOLO_TILES, split: SPLIT_TILES, min: 100, max: NO_MOTHERLODE_LIMIT, blurb: "All 25 tiles, only once the Motherlode is 100 uORE or more. Long waits between runs." },
  nonstop: { label: "Nonstop", solo: SOLO_TILES, split: SPLIT_TILES, min: 0, max: NO_MOTHERLODE_LIMIT, blurb: "All 25 tiles, every round, whatever the Motherlode." },
} as const;
export type Strategy = keyof typeof STRATEGIES;

export type RunEstimate = {
  rounds: number;
  seconds: number; // mining time, leaving out any rounds the Motherlode limit skips
  secondsWithWaits: number; // the same run counting those skipped rounds
  stakePerRound: number; // lamports on the board each round
  costPerRound: number; // lamports a round really uses: ORE's fees on the stake + the bot's fee
  steady: number; // uORE from split rounds
  soloChance: number; // chance of at least one solo hit over the run
  motherlodeChance: number; // chance a Motherlode hits while this run is mining
  motherlodeCut: number; // this run's share of one: at the limit size on a limited run, else at today's size
  average: number; // uORE over many such runs: split rounds, solos and Motherlodes together
};

/** tiles = SOL staked on each tile of a full round. A hit is shared by stake on the winning tile, and that tile is random, so a
 *  miner averages its share across all 25. soloTiles and splitTiles are how many of each it mines a round, of ORE's 10 and 15. */
export function estimateRun(p: {
  depositLamports: number;
  perTileLamports: number;
  tiles: bigint[];
  motherlodeOre: number;
  soloTiles: number;
  splitTiles: number;
  minMotherlode: number;
  maxMotherlode: number;
  slotMs: number;
  /** true: price the board as it usually is over the Motherlode range (strategies, or a range that excludes now); false: as it is now */
  typicalBoard: boolean;
}): RunEstimate | null {
  const mined = p.soloTiles + p.splitTiles;
  const rounds = estimateRounds(p.depositLamports, p.perTileLamports, undefined, mined);
  if (rounds <= 0 || p.tiles.length !== SQUARES || p.minMotherlode >= p.maxMotherlode) return null;
  const a = p.perTileLamports;
  const bands = p.typicalBoard ? boardBands(p.motherlodeOre, p.minMotherlode, p.maxMotherlode) : [{ w: 1, scale: 1 }];
  const weight = bands.reduce((s, b) => s + b.w, 0);
  const share = bands.reduce((s, b) => s + b.w * p.tiles.reduce((sum, t) => sum + a / (Number(t) * b.scale + a), 0), 0) / weight / SQUARES;
  const seconds = (rounds * (ROUND_SLOTS + INTERMISSION_SLOTS) * p.slotMs) / 1000;
  const limited = p.maxMotherlode < NO_MOTHERLODE_LIMIT;
  const roundsInRange = Math.exp(-p.minMotherlode / 100) - (limited ? Math.exp(-p.maxMotherlode / 100) : 0);
  const stakePerRound = p.perTileLamports * mined;
  return {
    rounds,
    seconds,
    secondsWithWaits: seconds / roundsInRange,
    stakePerRound,
    costPerRound: stakePerRound * ORE_HOUSE_TAX + Number(EXECUTOR_FEE_LAMPORTS),
    steady: rounds * (p.splitTiles / SQUARES) * share,
    soloChance: 1 - (1 - (p.soloTiles / SQUARES) * share) ** rounds,
    motherlodeChance: 1 - (1 - (mined / SQUARES) * MOTHERLODE_ODDS) ** rounds,
    motherlodeCut: share * (limited ? p.maxMotherlode : Math.max(p.minMotherlode, p.motherlodeOre)),
    average: rounds * share * (mined / SQUARES) * (1 + MOTHERLODE_ODDS * averageMotherlode(p.minMotherlode, p.maxMotherlode)),
  };
}
