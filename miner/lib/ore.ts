// ORE v3 grid-mining integration (regolith-labs/ore, program oreV3...).
// Ported from the ORE `api` crate (consts/instruction/sdk/state) and VALIDATED
// byte-for-byte against the live mainnet Board (40B), Round (952B), Config (232B),
// Treasury (48B), Miner (752B) and Automation (160B) accounts.
// Re-checked 2026-10-25 against ore master (protocol config / intermission / treasury-in-Deploy,
// commits 2420277…48c203b) and live mainnet transactions + simulations.
//
// SAFETY: the instruction builders below stake REAL SOL when submitted. Never
// submit one without simulating first (see simulate helpers in the caller).
// Users sign every transaction with their own wallet — this file never holds keys.
import { Buffer } from "buffer";
import { Connection, PublicKey, TransactionInstruction } from "@solana/web3.js";

export const ORE_PROGRAM_ID = new PublicKey("oreV3EG1i9BEgiAJ8b177Z2S2rMarzak4NMv1kULvWv");
export const ORE_ENTROPY_PROGRAM = new PublicKey("3jSkUuYBoJzQPMEzTvkDFXCZUBksPamrVhrnHR9igu2X");
export const ORE_ENTROPY_VAR = new PublicKey("BWCaDY96Xe4WkFq1M7UiCCRcChsJ3p51L5KrGzhxgm2E");
export const ORE_MINT = new PublicKey("oreoU2P8bN6jkk3jbaiVxYnG1dCXcYxwhwyK9jSybcp");
export const ORE_SPLIT_ADDRESS = new PublicKey("SpLiT11111111111111111111111111111111111112");
export const ORE_EXECUTOR = new PublicKey("executor11111111111111111111111111111111112"); // permissionless
// What a round costs, as a share of the SOL staked on all 25 tiles (round.rs calculate_fees + checkpoint.rs):
// a 1% admin fee on every tile, plus a 10% protocol fee on the 24 losing tiles (after the admin fee). Losing
// tiles get the rest of their SOL back; the winning tile keeps 99% and its stakers mine the round's ORE.
// = 0.01 + 0.10 × 0.99 × 24/25 ≈ 0.105 (live Config fee rates: admin 100 bps, protocol 1000 bps).
export const ORE_HOUSE_TAX = 0.105;
export const ORE_DECIMALS = 11;
export const ORE_UNITS_PER_TOKEN = 10n ** 11n; // "grams" per ORE
export const SQUARES = 25;
// Round timing now lives in the on-chain Config (protocol.round_slots / intermission_slots, set by
// UpdateProtocolConfig) — these are FALLBACKS only; readConfig() gives the live values.
export const ROUND_SLOTS = 300; // mining window per round (live Config 2026-10-25)
export const INTERMISSION_SLOTS = 60; // pause after a round before Reset opens the next one
export const SLOT_MS = 350; // FALLBACK mainnet slot time only — the live value is measured at runtime
                            // (Solana cut slots 400→350ms, SIMD-0525, stepping toward 200ms). See useOreGame.
export const CHECKPOINT_FEE_LAMPORTS = 10_000n; // 0.00001 SOL withheld on first deploy
// The per-round fee a permissionless executor bot takes to auto-deploy for you. 7,000 lamports is what
// 204 of the 208 live permissionless automations pay (mainnet, 2026-10-25) — and they are being executed.
export const EXECUTOR_FEE_LAMPORTS = 7_000n;

const SYSTEM_PROGRAM = new PublicKey("11111111111111111111111111111111");
const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

// steel OreInstruction enum values = first byte of instruction data
const IX = { Checkpoint: 2, ClaimSOL: 3, ClaimORE: 4, Deploy: 6 } as const;

// steel prefixes account data with an 8-byte discriminator (byte 0 = OreAccount enum)
const HEADER = 8;

const te = new TextEncoder();
const seed = (s: string) => te.encode(s);

function u64le(n: bigint | number): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(n), true);
  return b;
}
function u32le(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0, true);
  return b;
}

/* ---------- PDAs (seeds validated against on-chain BOARD/CONFIG/TREASURY) ---------- */
export const boardPda = () => PublicKey.findProgramAddressSync([seed("board")], ORE_PROGRAM_ID)[0];
export const configPda = () => PublicKey.findProgramAddressSync([seed("config")], ORE_PROGRAM_ID)[0];
export const treasuryPda = () => PublicKey.findProgramAddressSync([seed("treasury")], ORE_PROGRAM_ID)[0];
export const minerPda = (auth: PublicKey) =>
  PublicKey.findProgramAddressSync([seed("miner"), auth.toBytes()], ORE_PROGRAM_ID)[0];
export const automationPda = (auth: PublicKey) =>
  PublicKey.findProgramAddressSync([seed("automation"), auth.toBytes()], ORE_PROGRAM_ID)[0];
export const roundPda = (id: bigint | number) =>
  PublicKey.findProgramAddressSync([seed("round"), u64le(id)], ORE_PROGRAM_ID)[0];

export function ataFor(owner: PublicKey, mint: PublicKey = ORE_MINT): PublicKey {
  return PublicKey.findProgramAddressSync(
    [owner.toBytes(), TOKEN_PROGRAM.toBytes(), mint.toBytes()],
    ATA_PROGRAM,
  )[0];
}

/* ---------- Account decoders ---------- */
export type OreBoard = {
  roundId: bigint;
  startSlot: bigint;
  endSlot: bigint;
  productionCostEma: bigint;
};

export function decodeBoard(data: Uint8Array): OreBoard {
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    roundId: v.getBigUint64(HEADER, true),
    startSlot: v.getBigUint64(HEADER + 8, true),
    endSlot: v.getBigUint64(HEADER + 16, true),
    productionCostEma: v.getBigUint64(HEADER + 24, true),
  };
}

export type OreRound = {
  id: bigint;
  deployed: bigint[]; // lamports staked on each of the 25 squares
  miners: number[]; // unique miners on each square
  motherlode: bigint;
  expiresAt: bigint;
  winningSquare: number | null; // resolved only once entropy is revealed (round over)
};

export function decodeRound(data: Uint8Array): OreRound {
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let o = HEADER;
  const id = v.getBigUint64(o, true);
  o += 8;
  const arr = (): bigint[] => {
    const a: bigint[] = [];
    for (let i = 0; i < SQUARES; i++) {
      a.push(v.getBigUint64(o, true));
      o += 8;
    }
    return a;
  };
  const deployed = arr();
  o += SQUARES * 8; // skip `mass`
  const miners = arr().map(Number);
  const slotHash = data.subarray(o, o + 32);
  o += 32;
  const expiresAt = v.getBigUint64(o, true);
  o += 8;
  const motherlode = v.getBigUint64(o, true);

  let winningSquare: number | null = null;
  const allZero = slotHash.every((b) => b === 0);
  const allMax = slotHash.every((b) => b === 255);
  if (!allZero && !allMax) {
    const sv = new DataView(slotHash.buffer, slotHash.byteOffset, 32);
    const rng =
      sv.getBigUint64(0, true) ^
      sv.getBigUint64(8, true) ^
      sv.getBigUint64(16, true) ^
      sv.getBigUint64(24, true);
    winningSquare = Number(rng % BigInt(SQUARES));
  }
  return { id, deployed, miners, motherlode, expiresAt, winningSquare };
}

/** The live round timing + fee rates (Config account, 232 bytes: admin {authority, fee_collector, fee_rate} then
 *  protocol {authority, fee_collector, fee_rate, intermission_slots, round_slots, entropy var, entropy program}). */
export type OreConfig = { adminFeeBps: bigint; protocolFeeBps: bigint; intermissionSlots: bigint; roundSlots: bigint };
export function decodeConfig(data: Uint8Array): OreConfig {
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    adminFeeBps: v.getBigUint64(HEADER + 64, true),
    protocolFeeBps: v.getBigUint64(HEADER + 136, true),
    intermissionSlots: v.getBigUint64(HEADER + 144, true),
    roundSlots: v.getBigUint64(HEADER + 152, true),
  };
}
export async function readConfig(conn: Connection): Promise<OreConfig | null> {
  const acc = await conn.getAccountInfo(configPda());
  return acc && acc.data.length >= HEADER + 160 ? decodeConfig(acc.data) : null;
}

export async function readBoard(conn: Connection): Promise<OreBoard | null> {
  const acc = await conn.getAccountInfo(boardPda());
  return acc ? decodeBoard(acc.data) : null;
}
export async function readRound(conn: Connection, id: bigint): Promise<OreRound | null> {
  const acc = await conn.getAccountInfo(roundPda(id));
  return acc ? decodeRound(acc.data) : null;
}

// Miner account = 752 bytes: 8 header + fields; rewards_factor is a 16-byte Numeric (steel: I80F48, LE i128).
export type OreMiner = {
  authority: PublicKey;
  autoReturn: boolean; // SOL winnings go straight back to the wallet at checkpoint (no claim needed)
  checkpointId: bigint;
  roundId: bigint; // last round this miner deployed in
  deployed: bigint[]; // lamports this miner staked per square (current round)
  rewardsSol: bigint; // claimable SOL (lamports)
  refinedOre: bigint; // rORE — no claim fee (grams)
  unrefinedOre: bigint; // uORE — 10% fee on claim (grams)
  claimableOre: bigint; // what you actually receive: rORE + 0.9 × uORE (grams)
  lifetimeDeployedSol: bigint;
  lifetimeRewardsSol: bigint;
  lifetimeRewardsOre: bigint;
  rewardsFactor: bigint; // raw I80F48 bits — refining rewards accrue as Treasury.factor − this (see withPendingRefined)
};

const i128le = (v: DataView, o: number) => (v.getBigInt64(o + 8, true) << 64n) | v.getBigUint64(o, true);
// What a full claim pays: refined + unrefined minus ORE's refining fee — 10% of the unrefined part, at least 1 gram
// (miner.rs claim_ore: fee = max(1, unrefined / 10)).
const claimable = (refined: bigint, unrefined: bigint) => refined + (unrefined > 0n ? unrefined - (unrefined / 10n > 1n ? unrefined / 10n : 1n) : 0n);

export function decodeMiner(data: Uint8Array): OreMiner {
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const authority = new PublicKey(data.subarray(8, 40));
  const autoReturn = v.getBigUint64(40, true) > 0n;
  const checkpointId = v.getBigUint64(48, true);
  const deployed: bigint[] = [];
  for (let i = 0; i < SQUARES; i++) deployed.push(v.getBigUint64(64 + i * 8, true));
  const roundId = v.getBigUint64(664, true);
  const rewardsFactor = i128le(v, 672); // rewards_factor (Numeric) occupies 672..688
  const rewardsSol = v.getBigUint64(688, true);
  const refinedOre = v.getBigUint64(696, true);
  const unrefinedOre = v.getBigUint64(704, true);
  const lifetimeRewardsOre = v.getBigUint64(728, true);
  const lifetimeDeployedSol = v.getBigUint64(736, true);
  const lifetimeRewardsSol = v.getBigUint64(744, true);
  return {
    authority,
    autoReturn,
    checkpointId,
    roundId,
    deployed,
    rewardsSol,
    refinedOre,
    unrefinedOre,
    claimableOre: claimable(refinedOre, unrefinedOre),
    lifetimeDeployedSol,
    lifetimeRewardsSol,
    lifetimeRewardsOre,
    rewardsFactor,
  };
}

/** Treasury.miner_rewards_factor (raw I80F48 bits) — Treasury = 8 header + motherlode u64 + factor @ 16..32. */
export function treasuryRewardsFactor(data: Uint8Array): bigint | null {
  if (data.length < 32) return null;
  return i128le(new DataView(data.buffer, data.byteOffset, data.byteLength), 16);
}

/**
 * The miner account only folds in refining rewards (other miners' 10% claim fees, shared pro rata on unrefined
 * ORE) when it's touched — miner.rs update_rewards runs at claim/checkpoint. Add what has accrued since, so the
 * vault shows what a claim would actually pay: refined += floor((treasury.factor − miner.factor) × unrefined).
 */
export function withPendingRefined(m: OreMiner, treasuryFactor: bigint | null): OreMiner {
  if (treasuryFactor == null || treasuryFactor <= m.rewardsFactor || m.unrefinedOre === 0n) return m;
  const pending = ((treasuryFactor - m.rewardsFactor) * m.unrefinedOre) >> 48n;
  const refinedOre = m.refinedOre + pending;
  return { ...m, refinedOre, claimableOre: claimable(refinedOre, m.unrefinedOre) };
}

export async function readMiner(conn: Connection, authority: PublicKey): Promise<OreMiner | null> {
  const acc = await conn.getAccountInfo(minerPda(authority));
  return acc && acc.data.length > 8 ? decodeMiner(acc.data) : null;
}

/**
 * Whether this miner must Checkpoint a prior round before it can Deploy into
 * `currentRoundId`. The program requires checkpoint_id == round_id when the
 * current round has advanced past the miner's last deployed round.
 */
export function minerNeedsCheckpoint(miner: OreMiner | null, currentRoundId: bigint): boolean {
  if (!miner) return false;
  return miner.roundId !== currentRoundId && miner.checkpointId !== miner.roundId;
}

// Automation account = 160 bytes: 8 header + fields (see api/src/state/automation.rs).
export type OreAutomation = {
  amount: bigint; // SOL per tile per round (lamports)
  balance: bigint; // SOL left in the automation (lamports)
  fee: bigint; // executor fee per round (lamports)
  reload: boolean; // auto-reload winnings back into balance
  active: boolean; // has a funded balance
};

export function decodeAutomation(data: Uint8Array): OreAutomation {
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const amount = v.getBigUint64(8, true);
  // authority @ 16..48
  const balance = v.getBigUint64(48, true);
  // executor @ 56..88
  const fee = v.getBigUint64(88, true);
  // strategy @ 96, mask @ 104
  const reload = v.getBigUint64(112, true) > 0n;
  return { amount, balance, fee, reload, active: balance > 0n };
}

export async function readAutomation(
  conn: Connection,
  authority: PublicKey,
): Promise<OreAutomation | null> {
  const acc = await conn.getAccountInfo(automationPda(authority));
  return acc && acc.data.length > 8 ? decodeAutomation(acc.data) : null;
}

/** The accumulated Motherlode jackpot (ORE grams) — Treasury.motherlode @ offset 8. */
export async function readMotherlode(conn: Connection): Promise<bigint | null> {
  const acc = await conn.getAccountInfo(treasuryPda());
  if (!acc || acc.data.length < 16) return null;
  const d = acc.data;
  return new DataView(d.buffer, d.byteOffset, d.byteLength).getBigUint64(8, true);
}

/**
 * Estimated rounds an auto-mining balance lasts. Each round the executor needs the FULL stake (25 tiles) plus its fee
 * in the balance (deploy.rs closes the automation otherwise); with reload on, the SOL the round returns flows back in
 * at checkpoint, so the balance really drains by the house tax + the executor fee per round. Approximate.
 */
export function estimateRounds(
  balanceLamports: bigint | number,
  perTileLamports: bigint | number,
  executorFeeLamports: bigint | number = EXECUTOR_FEE_LAMPORTS,
): number {
  const balance = Number(balanceLamports), stake = Number(perTileLamports) * SQUARES, fee = Number(executorFeeLamports);
  if (!(stake > 0) || balance < stake + fee) return 0;
  return 1 + Math.floor((balance - stake - fee) / (stake * ORE_HOUSE_TAX + fee));
}

/* ---------- Instruction builders (account order from api/src/sdk.rs + idl.json) ---------- */
type Meta = { pubkey: PublicKey; isSigner: boolean; isWritable: boolean };
const meta = (pubkey: PublicKey, isSigner: boolean, isWritable: boolean): Meta => ({
  pubkey,
  isSigner,
  isWritable,
});
const ix = (keys: Meta[], data: Uint8Array) =>
  new TransactionInstruction({ programId: ORE_PROGRAM_ID, keys, data: Buffer.from(data) });

/** Deploy: stake `amountLamports` on the selected squares of `roundId`. Ten ORE accounts (the Treasury joined at
 *  index 7 — deploy.rs splits accounts at 10, and checks motherlode conditions on it) then the two entropy accounts. */
export function deployIx(p: {
  signer: PublicKey;
  authority?: PublicKey;
  amountLamports: bigint;
  roundId: bigint;
  squares: boolean[]; // length 25
}): TransactionInstruction {
  const authority = p.authority ?? p.signer;
  let mask = 0;
  for (let i = 0; i < SQUARES; i++) if (p.squares[i]) mask |= 1 << i;

  const data = new Uint8Array(1 + 8 + 4);
  data[0] = IX.Deploy;
  data.set(u64le(p.amountLamports), 1);
  data.set(u32le(mask), 9);

  return ix(
    [
      meta(p.signer, true, true),
      meta(authority, false, true),
      meta(automationPda(authority), false, true),
      meta(boardPda(), false, true),
      meta(configPda(), false, true),
      meta(minerPda(authority), false, true),
      meta(roundPda(p.roundId), false, true),
      meta(treasuryPda(), false, true),
      meta(SYSTEM_PROGRAM, false, false),
      meta(ORE_PROGRAM_ID, false, false),
      meta(ORE_ENTROPY_VAR, false, true),
      meta(ORE_ENTROPY_PROGRAM, false, false),
    ],
    data,
  );
}

/** Checkpoint: settle a prior round's rewards into the miner account. */
export function checkpointIx(p: {
  signer: PublicKey;
  authority?: PublicKey;
  roundId: bigint;
}): TransactionInstruction {
  const authority = p.authority ?? p.signer;
  return ix(
    [
      meta(p.signer, true, true),
      meta(authority, false, true),
      meta(automationPda(authority), false, true),
      meta(boardPda(), false, true),
      meta(minerPda(authority), false, true),
      meta(roundPda(p.roundId), false, true),
      meta(treasuryPda(), false, true),
      meta(SYSTEM_PROGRAM, false, false),
    ],
    new Uint8Array([IX.Checkpoint]),
  );
}

/** ClaimSOL: withdraw settled SOL winnings from the miner account. */
export function claimSolIx(signer: PublicKey): TransactionInstruction {
  return ix(
    [
      meta(signer, true, true),
      meta(boardPda(), false, true),
      meta(minerPda(signer), false, true),
      meta(SYSTEM_PROGRAM, false, false),
      meta(ORE_PROGRAM_ID, false, false),
    ],
    new Uint8Array([IX.ClaimSOL]),
  );
}

/** ClaimORE: transfer settled ORE winnings to the signer's ATA (the program creates the ATA if missing). `bps` = share
 *  to claim, 10000 = all (ClaimORE { bps } — the program also defaults to 100% when the arg is absent). */
export function claimOreIx(signer: PublicKey, bps: bigint = 10_000n): TransactionInstruction {
  const treasury = treasuryPda();
  return ix(
    [
      meta(signer, true, true),
      meta(boardPda(), false, true),
      meta(minerPda(signer), false, true),
      meta(ORE_MINT, false, true),
      meta(ataFor(signer), false, true),
      meta(treasury, false, true),
      meta(ataFor(treasury), false, true),
      meta(SYSTEM_PROGRAM, false, false),
      meta(TOKEN_PROGRAM, false, false),
      meta(ATA_PROGRAM, false, false),
      meta(ORE_PROGRAM_ID, false, false),
    ],
    Uint8Array.from([IX.ClaimORE, ...u64le(bps)]),
  );
}

/** Create the signer's ORE associated-token account if missing (idempotent). */
export function createAtaIdempotentIx(
  payer: PublicKey,
  owner: PublicKey,
  mint: PublicKey = ORE_MINT,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: ATA_PROGRAM,
    keys: [
      meta(payer, true, true),
      meta(ataFor(owner, mint), false, true),
      meta(owner, false, false),
      meta(mint, false, false),
      meta(SYSTEM_PROGRAM, false, false),
      meta(TOKEN_PROGRAM, false, false),
    ],
    data: Buffer.from([1]), // CreateIdempotent
  });
}

/** Send ORE from the signer's ATA to `to`'s ATA (SPL TransferChecked). */
export function oreTransferIx(from: PublicKey, to: PublicKey, amount: bigint): TransactionInstruction {
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM,
    keys: [
      meta(ataFor(from), false, true),
      meta(ORE_MINT, false, false),
      meta(ataFor(to), false, true),
      meta(from, true, false),
    ],
    data: Buffer.from([12, ...u64le(amount), ORE_DECIMALS]), // TransferChecked
  });
}

// AutomateV2 data (what the official SDK sends) = [0] + amount(8) + deposit(8) + fee(8) + mask(8) + strategy(1) + reload(8)
// + conditions(24) = 66B. The conditions are left at the program's defaults — no production-cost cap, motherlode 0..65535 ORE,
// no solo/split preference — so it behaves exactly like the old 42-byte Automate (which the program still accepts).
function automateData(p: {
  amount: bigint;
  deposit: bigint;
  fee: bigint;
  mask: number;
  reload: boolean;
}): Uint8Array {
  const d = new Uint8Array(66);
  d[0] = 0; // Automate discriminator
  d.set(u64le(p.amount), 1);
  d.set(u64le(p.deposit), 9);
  d.set(u64le(p.fee), 17);
  d.set(u64le(BigInt(p.mask >>> 0)), 25);
  d[33] = 1; // strategy = Preferred (use provided mask)
  d.set(u64le(p.reload ? 1 : 0), 34);
  d.set(u64le(0xffff_ffff_ffff_ffffn), 42); // conditions.max_production_cost = u64::MAX
  // min_motherlode u16 = 0 @ 50
  d.set([0xff, 0xff], 52); // max_motherlode u16 = u16::MAX
  // split_tiles, solo_tiles u16 = 0 @ 54/56, _buffer u64 = 0 @ 58
  return d;
}

/**
 * Start (or update) auto-mining: deposit a balance; a permissionless executor
 * deploys `amountLamports` on the masked tiles every round, taking `feeLamports`,
 * until the balance runs low.
 */
export function automateIx(p: {
  signer: PublicKey;
  amountLamports: bigint;
  depositLamports: bigint;
  feeLamports: bigint;
  squares: boolean[];
  reload: boolean;
}): TransactionInstruction {
  let mask = 0;
  for (let i = 0; i < SQUARES; i++) if (p.squares[i]) mask |= 1 << i;
  return ix(
    [
      meta(p.signer, true, true),
      meta(automationPda(p.signer), false, true),
      meta(ORE_EXECUTOR, false, true),
      meta(minerPda(p.signer), false, true),
      meta(SYSTEM_PROGRAM, false, false),
    ],
    automateData({ amount: p.amountLamports, deposit: p.depositLamports, fee: p.feeLamports, mask, reload: p.reload }),
  );
}

/** Stop auto-mining: executor = zero address closes the automation and refunds the balance. */
export function stopAutomationIx(signer: PublicKey): TransactionInstruction {
  return ix(
    [
      meta(signer, true, true),
      meta(automationPda(signer), false, true),
      meta(PublicKey.default, false, true), // Pubkey::default() → close + refund balance
      meta(minerPda(signer), false, true),
      meta(SYSTEM_PROGRAM, false, false),
    ],
    automateData({ amount: 0n, deposit: 0n, fee: 0n, mask: 0, reload: false }),
  );
}

// Preacher referral, bound on-chain: a tiny SPL Memo "ddref:<code>" inside the buyer's own transaction, so
// it's covered by their signature (the store credits preachers only from this memo — store-ref-core.mjs).
export const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
export function refMemoIx(code: string): TransactionInstruction {
  return new TransactionInstruction({ programId: MEMO_PROGRAM_ID, keys: [], data: Buffer.from("ddref:" + code, "utf8") });
}
