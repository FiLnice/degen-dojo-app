// Burn to Mine sizing (owner 2026-10-27): two all-25-tile options, a FUNDED-rounds choice (2 · 5 · 10 · 25 · 50 · 100) and a wallet top-up.
//
// What ORE itself requires (program source, ore program/src automate.rs + deploy.rs, checked 2026-10-27):
//   · Automate takes ANY deposit — no minimum, no multi-round rule — and no minimum per tile.
//   · At a round's first deploy the automation must hold the full stake (tiles × per-tile) + the executor fee, or the
//     program closes it (balance back to the owner); after a round it closes once it can't cover one tile + the fee.
//   · The first Automate opens the Automation account (160 bytes) — and, if missing, the Miner account (752 bytes) plus
//     the one-time 10,000-lamport checkpoint fee — all paid from the wallet (the rent comes back when they close).
// "Funded rounds" (owner): the deposit holds N × (25 × per-tile + the 7,000 executor fee) — N full rounds even if every
// round returns nothing. With reload on, winnings flow back, so it usually keeps going: estimateRounds (lib/ore.ts) gives
// that AVERAGE run — the balance drains by about stake × the house tax + the fee a round — and a losing streak can end it
// sooner. ORE needs only ONE round's stake + fee to deploy; the 2-round minimum is the owner's.
import { estimateRounds, EXECUTOR_FEE_LAMPORTS, CHECKPOINT_FEE_LAMPORTS, SQUARES } from "./ore";
import { dojoFeeOf, depositWithin } from "./dojoFee";

export const BOT_FEE = Number(EXECUTOR_FEE_LAMPORTS); // 7,000 lamports a round
export const TILES = SQUARES; // both options cover all 25 tiles: you're on the winning tile every round
export const MIN_ROUNDS = 2; // owner: at least 2 funded rounds — a short burn gets a top-up to reach it
export const ROUND_CHOICES = [2, 5, 10, 25, 50, 100] as const;
export const DEFAULT_ROUNDS = 2;
export const STRETCH_ROUNDS = 50; // Stretch sizes the per-tile amount up toward this many rounds (on average)
export const STRETCH_MIN_PER_TILE = 40_000; // owner's floor: never below 0.00004 SOL a tile
export const FIXED_PER_TILE = 200_000; // "25 tiles": 0.0002 SOL a tile
export const AUTOMATION_BYTES = 160; // 8-byte discriminator + the Automation struct
export const MINER_BYTES = 752;
export const CHECKPOINT_FEE = Number(CHECKPOINT_FEE_LAMPORTS);
export const TX_ALLOWANCE = 20_000; // per transaction: the 5,000 base fee + room for a priority fee
export const SAFETY = 100_000; // 0.0001 SOL left in the wallet on top

export type Option = "stretch" | "fixed";

/** One full round on all 25 tiles: the stake + the executor's fee. */
export const roundCost = (perTile: number) => perTile * TILES + BOT_FEE;
/** The deposit that funds `rounds` full rounds at `perTile`. */
export const depositForRounds = (perTile: number, rounds: number) => rounds * roundCost(perTile);
/** Full rounds a deposit funds at `perTile`, even if none of them returns anything. */
export const fundedRounds = (deposit: number, perTile: number) => Math.floor(deposit / roundCost(perTile));
/** ≈ rounds on average with reload (it stops when the balance can't load a full round). */
export const avgRounds = (deposit: number, perTile: number) => estimateRounds(deposit, perTile, BOT_FEE, TILES);

/** Stretch: the largest whole-lamport per-tile amount that lasts ≈ STRETCH_ROUNDS on average AND still funds `funded`
 *  full rounds — never below the owner's floor. */
export function stretchPerTile(deposit: number, funded: number): number {
  let p = STRETCH_MIN_PER_TILE;
  while (avgRounds(deposit, p * 2) >= STRETCH_ROUNDS) p *= 2; // bracket, then binary-search the largest p
  let lo = p, hi = p * 2;
  if (avgRounds(deposit, lo) >= STRETCH_ROUNDS) {
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      if (avgRounds(deposit, mid) >= STRETCH_ROUNDS) lo = mid;
      else hi = mid;
    }
    p = lo;
  }
  const cap = Math.floor((deposit / Math.max(1, funded) - BOT_FEE) / TILES); // keep `funded` full rounds in the deposit
  return Math.max(STRETCH_MIN_PER_TILE, Math.min(p, cap));
}

export type Sizing = {
  option: Option;
  perTile: number; // lamports a tile
  deposit: number; // into the automation
  dojoFee: number; // 1% of the deposit, to the Reserve, same transaction
  totalIn: number; // deposit + fee = what the burn returns + the top-up
  topUp: number; // from the wallet's own SOL (0 when the burn covers it)
  funded: number; // full rounds the deposit holds even if every round returns nothing
  rounds: number; // ≈ rounds on average with reload
  botFeePct: number; // the executor's 7,000 a round over those average rounds, as % of the deposit
  minIn: number; // the least SOL in that starts this option (MIN_ROUNDS funded rounds, with the 1% fee)
};

/** Size an option for `back` lamports coming back from the burns and a funded-rounds target (2 / 5 / 10, never under 2).
 *  The deposit is that target's need at the option's base per-tile amount (the wallet tops up the difference), or
 *  everything that came back when that's more — Stretch then sizes the per-tile amount up toward 50 average rounds. */
export function sizeOption(option: Option, back: number, rounds: number): Sizing {
  const target = Math.max(MIN_ROUNDS, Math.floor(rounds) || MIN_ROUNDS);
  const base = option === "stretch" ? STRETCH_MIN_PER_TILE : FIXED_PER_TILE;
  const need = depositForRounds(base, target);
  const needIn = need + dojoFeeOf(need);
  const deposit = back >= needIn ? depositWithin(back) : need;
  const perTile = option === "stretch" ? stretchPerTile(deposit, target) : FIXED_PER_TILE;
  const dojoFee = dojoFeeOf(deposit);
  const r = avgRounds(deposit, perTile);
  const start = depositForRounds(base, MIN_ROUNDS);
  return {
    option,
    perTile,
    deposit,
    dojoFee,
    totalIn: deposit + dojoFee,
    topUp: Math.max(0, deposit + dojoFee - Math.max(0, back)),
    funded: fundedRounds(deposit, perTile),
    rounds: r,
    botFeePct: deposit > 0 ? (r * BOT_FEE * 100) / deposit : 0,
    minIn: start + dojoFeeOf(start),
  };
}

/** One-time SOL the first Automate takes from the wallet (rent comes back when the accounts close). */
export function oneTimeLamports(p: { hasAutomation: boolean; hasMiner: boolean; rentAutomation: number; rentMiner: number }): number {
  return (p.hasAutomation ? 0 : p.rentAutomation) + (p.hasMiner ? 0 : p.rentMiner + CHECKPOINT_FEE);
}
/** Before burning: what the wallet must already hold (besides what the burns return) for burn + mine to go through. */
export function walletNeedBefore(s: Sizing, oneTime: number, burnTxs: number): number {
  return s.topUp + oneTime + TX_ALLOWANCE * (burnTxs + 1) + SAFETY;
}
/** After burning: what the wallet must hold for the mining transaction itself. */
export function walletNeedAfter(s: Sizing, oneTime: number): number {
  return s.totalIn + oneTime + TX_ALLOWANCE;
}
/** What step 2 does once the burns are sent (security review 2026-10-27):
 *  · "failed"    — not every burn confirmed: stop, nothing is mined (and nothing is pulled from the wallet);
 *  · "short"     — the wallet can't cover the mining transaction now: stop with how much is missing;
 *  · "reconfirm" — the top-up grew (or the deposit moved) beyond a small tolerance: show the new numbers, second click;
 *  · "go"        — mine with `s2`.
 *  "back" is capped at what the review measured, so SOL arriving from elsewhere between the two reads isn't spent. */
export type Step2 =
  | { kind: "failed"; done: number; sent: number }
  | { kind: "short"; back: number; missing: number; s2: Sizing }
  | { kind: "reconfirm"; back: number; s2: Sizing }
  | { kind: "go"; back: number; s2: Sizing };
export function step2Plan(p: { pre: number; post: number; reviewGain: number; sent: number; done: number; option: Option; rounds: number; planned: Sizing; oneTime: number }): Step2 {
  if (p.sent < 1 || p.done !== p.sent) return { kind: "failed", done: p.done, sent: p.sent };
  const back = Math.max(0, Math.min(p.post - p.pre, p.reviewGain));
  const s2 = sizeOption(p.option, back, p.rounds);
  const need = walletNeedAfter(s2, p.oneTime);
  if (p.post < need) return { kind: "short", back, missing: need - p.post, s2 };
  const tol = Math.max(5_000, Math.floor(p.planned.totalIn * 0.02));
  if (s2.topUp > p.planned.topUp + tol || Math.abs(s2.deposit - p.planned.deposit) > tol) return { kind: "reconfirm", back, s2 };
  return { kind: "go", back, s2 };
}

/** Rent fallback if the live read fails — the older, higher rate, so it never under-asks. */
export const rentFallback = (bytes: number) => (128 + bytes) * 6960;
