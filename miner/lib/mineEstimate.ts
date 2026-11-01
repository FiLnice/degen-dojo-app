// What a run of SOL is likely to earn, worked out live from the last finished round (owner 2026-10-31). The odds are ORE's own
// (api/src/state/round.rs): 15 of the 25 tiles split the round's 1 uORE, the other 10 give it to one miner, and a Motherlode hits
// 1 round in 500. Checked against 700 real rounds replayed: 1 SOL at 0.01 a round = 0.39 uORE steady, 22% solo.
import { estimateRounds, ROUND_SLOTS, INTERMISSION_SLOTS, SQUARES, ORE_HOUSE_TAX, EXECUTOR_FEE_LAMPORTS } from "@/lib/ore";

export const SPLIT_TILES = 15;
export const SOLO_TILES = 10;
export const MOTHERLODE_ODDS = 1 / 500;
export const NO_MOTHERLODE_LIMIT = 0xffff; // ORE's own default: the most a u16 of whole ORE can say

/** Shorter and Longer never mine with the Motherlode above this many whole ORE (owner). ORE enforces it: a skipped round costs nothing. */
export const PRESET_MAX_MOTHERLODE = 140;

// The Motherlode a mined round can pay, averaged over time: it grows 0.2 uORE a round and hits 1 round in 500, so it averages 100 ORE
// at a hit, and 54 for a run that sits out above 140 (simulated over 30M rounds, 2026-10-31). A quarter of hits land above 140.
// Its size runs like an exponential of mean 100, which gives both figures for any range (meanPool in the store's ORE tools).
function averageMotherlode(min: number, max: number) {
  if (max >= NO_MOTHERLODE_LIMIT) return min + 100;
  const span = max - min, tail = Math.exp(-span / 100);
  return min + 100 - (span * tail) / (1 - tail);
}

// Lamports a tile (owner 2026-10-31: 0.0012 and 0.0004 SOL). The SOL goes at ~10.5% of the stake a round, so 1 SOL lasts ~300 rounds
// (~6.5 h) on Shorter and ~940 rounds (~20 h) on Longer. What a run earns barely changes between them.
export const PRESETS = { shorter: 1_200_000, longer: 400_000 } as const;
export type Preset = keyof typeof PRESETS;

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
}): RunEstimate | null {
  const mined = p.soloTiles + p.splitTiles;
  const rounds = estimateRounds(p.depositLamports, p.perTileLamports, undefined, mined);
  if (rounds <= 0 || p.tiles.length !== SQUARES || p.minMotherlode >= p.maxMotherlode) return null;
  const share = p.tiles.reduce((sum, t) => sum + p.perTileLamports / (Number(t) + p.perTileLamports), 0) / SQUARES;
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
