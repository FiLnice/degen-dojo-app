// What a run of SOL is likely to earn, worked out live from the last finished round (owner 2026-10-31). The odds are ORE's own
// (api/src/state/round.rs): 15 of the 25 tiles split the round's 1 uORE, the other 10 give it to one miner, and a Motherlode hits
// 1 round in 500. Checked against 700 real rounds replayed: 1 SOL at 0.01 a round = 0.39 uORE steady, 22% solo.
import { estimateRounds, ROUND_SLOTS, INTERMISSION_SLOTS, SQUARES } from "@/lib/ore";

export const SPLIT_ROUND_SHARE = 0.6;
export const SOLO_ROUND_SHARE = 0.4;
export const MOTHERLODE_ODDS = 1 / 500;

/** Shorter and Longer never mine with the Motherlode above this many whole ORE (owner). ORE enforces it: a skipped round costs nothing. */
export const PRESET_MAX_MOTHERLODE = 140;

// The Motherlode a mined round can pay, averaged over time: it grows 0.2 uORE a round and hits 1 round in 500, so it averages 100 ORE
// at a hit, and 54 for a run that sits out above the limit (simulated over 30M rounds, 2026-10-31). A quarter of hits land above 140.
const MOTHERLODE_AVERAGE = 100;
const MOTHERLODE_AVERAGE_LIMITED = 54;

// Lamports a tile (owner 2026-10-31: 0.0012 and 0.0004 SOL). The SOL goes at ~10.5% of the stake a round, so 1 SOL lasts ~300 rounds
// (~6.5 h) on Shorter and ~940 rounds (~20 h) on Longer. What a run earns barely changes between them.
export const PRESETS = { shorter: 1_200_000, longer: 400_000 } as const;
export type Preset = keyof typeof PRESETS;

export type RunEstimate = {
  rounds: number;
  seconds: number; // mining time, leaving out any rounds the Motherlode limit skips
  steady: number; // uORE from split rounds
  soloChance: number; // chance of at least one solo hit over the run
  motherlodeChance: number; // chance a Motherlode hits while this run is mining
  motherlodeCut: number; // this run's share of one: at the limit size on a limited run, else at today's size
  average: number; // uORE over many such runs: split rounds, solos and Motherlodes together
};

/** tiles = SOL staked on each tile of a full round. A hit is shared by stake on the winning tile, and that tile is random, so a
 *  miner on all 25 averages its share across them. */
export function estimateRun(p: { depositLamports: number; perTileLamports: number; tiles: bigint[]; motherlodeOre: number; limited: boolean; slotMs: number }): RunEstimate | null {
  const rounds = estimateRounds(p.depositLamports, p.perTileLamports);
  if (rounds <= 0 || p.tiles.length !== SQUARES) return null;
  const share = p.tiles.reduce((sum, t) => sum + p.perTileLamports / (Number(t) + p.perTileLamports), 0) / SQUARES;
  return {
    rounds,
    seconds: (rounds * (ROUND_SLOTS + INTERMISSION_SLOTS) * p.slotMs) / 1000,
    steady: rounds * SPLIT_ROUND_SHARE * share,
    soloChance: 1 - (1 - SOLO_ROUND_SHARE * share) ** rounds,
    motherlodeChance: 1 - (1 - MOTHERLODE_ODDS) ** rounds,
    motherlodeCut: share * (p.limited ? PRESET_MAX_MOTHERLODE : p.motherlodeOre),
    average: rounds * share * (1 + MOTHERLODE_ODDS * (p.limited ? MOTHERLODE_AVERAGE_LIMITED : MOTHERLODE_AVERAGE)),
  };
}
