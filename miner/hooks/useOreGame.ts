"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Connection } from "@solana/web3.js";
import { useWallet } from "@/lib/wallet-bridge";
import {
  boardPda,
  treasuryPda,
  minerPda,
  automationPda,
  roundPda,
  decodeBoard,
  decodeRound,
  decodeMiner,
  decodeAutomation,
  SLOT_MS,
  type OreBoard,
  type OreRound,
  type OreMiner,
  type OreAutomation,
} from "@/lib/ore";

const RPC_PROXY_PATH = "/api/rpc"; // server-side Helius proxy — key stays on the server

export type OreGameState = {
  /** Mainnet connection the miner reads from and submits through. */
  connection: Connection;
  board: OreBoard | null;
  round: OreRound | null; // current (in-progress) round
  lastWinner: number | null; // winning square of the previous, resolved round
  miner: OreMiner | null; // the connected wallet's miner account
  automation: OreAutomation | null; // the connected wallet's auto-mining account
  motherlode: bigint | null; // accumulated Motherlode jackpot (ORE grams)
  balance: number | null; // connected wallet SOL balance (lamports)
  secondsLeft: number; // approx seconds until the current round ends
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
};

/**
 * Reads the live ORE grid state (mainnet) through the server-side RPC proxy
 * (/api/rpc → Helius), so visitors need no RPC of their own. Reads are free;
 * transactions are still signed by the user's own wallet.
 */
export function useOreGame(pollMs = 12000): OreGameState {
  const { publicKey } = useWallet();

  const connection = useMemo(() => {
    const origin = typeof window !== "undefined" ? window.location.origin : "http://localhost:3000";
    const proxy = `${origin}${RPC_PROXY_PATH}`;
    // Resilient reads: the /api/rpc proxy can hiccup (cold start / shared-key 429 / timeout →
    // "Failed to fetch"). Retry it a few times, then fall back to a CORS-open PUBLIC RPC so the
    // grid always loads. Reads only — deploy/claim are still signed + sent by the user's wallet.
    const PUBLIC_RPC = "https://api.mainnet-beta.solana.com";
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const resilientFetch: typeof fetch = async (input, init) => {
      for (let i = 0; i < 3; i++) {
        try {
          const res = await fetch(input, init);
          // JSON-RPC errors come back as HTTP 200 (error in the body), so 2xx is a real answer.
          // Any non-2xx (429/500/502/403/timeout) or a thrown network error → retry, then fall back.
          if (res.ok) return res;
        } catch {
          /* network blip — retry */
        }
        await sleep(250 * (i + 1));
      }
      return fetch(PUBLIC_RPC, init); // last resort so a flaky proxy never blanks the page
    };
    return new Connection(proxy, { commitment: "confirmed", fetch: resilientFetch });
  }, []);

  const [board, setBoard] = useState<OreBoard | null>(null);
  const [round, setRound] = useState<OreRound | null>(null);
  const [lastWinner, setLastWinner] = useState<number | null>(null);
  const [miner, setMiner] = useState<OreMiner | null>(null);
  const [automation, setAutomation] = useState<OreAutomation | null>(null);
  const [motherlode, setMotherlode] = useState<bigint | null>(null);
  const [balance, setBalance] = useState<number | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const endAtRef = useRef(0);
  const failStreakRef = useRef(0); // consecutive read failures — used to ignore transient RPC blips
  // Live ms-per-slot, MEASURED from the chain so the countdown never drifts as Solana keeps
  // cutting slot time (400→350→…→200ms). Falls back to SLOT_MS until the first sample lands.
  const slotMsRef = useRef(SLOT_MS);

  const refresh = useCallback(async () => {
    try {
      // Wave 1 — board + treasury (motherlode) in ONE getMultipleAccounts, plus the slot clock.
      // Batching keeps the request count (and 429s) down on a shared RPC key.
      const [core, slot] = await Promise.all([
        connection.getMultipleAccountsInfo([boardPda(), treasuryPda()], "confirmed"),
        connection.getSlot(),
      ]);
      const boardAcc = core[0];
      if (!boardAcc) {
        setError("ORE board not found on this RPC");
        return;
      }
      const b = decodeBoard(boardAcc.data);
      const treasuryAcc = core[1];
      const ml =
        treasuryAcc && treasuryAcc.data.length >= 16
          ? new DataView(treasuryAcc.data.buffer, treasuryAcc.data.byteOffset, treasuryAcc.data.byteLength).getBigUint64(8, true)
          : null;
      setBoard(b);
      setMotherlode(ml);
      // end_slot briefly reads as u64::MAX during round transitions — clamp so the
      // countdown can't blow up. A round is ~150 slots; out of range = "resolving".
      const slotsLeft = Number(b.endSlot) - slot;
      endAtRef.current =
        slotsLeft > 0 && slotsLeft < 1000 ? Date.now() + slotsLeft * slotMsRef.current : Date.now();

      // Wave 2 — current round, previous round, and (if connected) miner + automation, all in
      // ONE getMultipleAccounts; balance alongside.
      const keys = [roundPda(b.roundId), roundPda(b.roundId - 1n)];
      if (publicKey) keys.push(minerPda(publicKey), automationPda(publicKey));
      const [accs, bal] = await Promise.all([
        connection.getMultipleAccountsInfo(keys, "confirmed"),
        publicKey ? connection.getBalance(publicKey) : Promise.resolve(null),
      ]);
      const roundAcc = accs[0], prevAcc = accs[1];
      setRound(roundAcc ? decodeRound(roundAcc.data) : null);
      setLastWinner(prevAcc ? decodeRound(prevAcc.data).winningSquare : null);
      if (publicKey) {
        const minerAcc = accs[2], autoAcc = accs[3];
        setMiner(minerAcc && minerAcc.data.length > 8 ? decodeMiner(minerAcc.data) : null);
        setAutomation(autoAcc && autoAcc.data.length > 8 ? decodeAutomation(autoAcc.data) : null);
      } else {
        setMiner(null);
        setAutomation(null);
      }
      setBalance(bal);
      setError(null);
      failStreakRef.current = 0;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      failStreakRef.current += 1;
      // A rate-limited (429) read is display-only noise — the executor bot does the actual
      // mining, and the poll catches up next tick. NEVER surface it (it was looping a scary
      // red banner). Only a NON-429 fault that persists (bad RPC / decode error) gets a banner.
      // Rate-limit AND transient network faults ("Failed to fetch") are retried + public-RPC
      // backed now, so they're just noise — never banner them. Only a persistent real fault
      // (bad decode, board genuinely missing) surfaces.
      const transient = /\b429\b|\b403\b|Access forbidden|forbidden|Too Many Requests|rate.?limit|Failed to fetch|fetch failed|NetworkError|load failed/i.test(msg);
      if (!transient && failStreakRef.current >= 2) setError(msg);
    } finally {
      setLoading(false);
    }
  }, [connection, publicKey]);

  // Measure the REAL mainnet ms-per-slot from recent performance samples, so the round
  // countdown tracks Solana's slot-time cuts (400→350→…→200ms) instead of a hardcoded guess.
  const measureSlotMs = useCallback(async () => {
    try {
      const samples = await connection.getRecentPerformanceSamples(3);
      const s = samples.find((x) => x.numSlots > 0 && x.samplePeriodSecs > 0);
      if (!s) return;
      const ms = (s.samplePeriodSecs * 1000) / s.numSlots;
      if (ms >= 150 && ms <= 650) slotMsRef.current = ms; // ignore nonsense samples
    } catch {
      /* keep the current/fallback SLOT_MS */
    }
  }, [connection]);

  // Measure once on mount, then re-measure every 2 min (cheap; well under the RPC budget).
  useEffect(() => {
    measureSlotMs();
    const id = setInterval(measureSlotMs, 120000);
    return () => clearInterval(id);
  }, [measureSlotMs]);

  // Poll on-chain state.
  useEffect(() => {
    refresh();
    const id = setInterval(refresh, pollMs);
    return () => clearInterval(id);
  }, [refresh, pollMs]);

  // Smooth 1s countdown, resynced by each poll.
  useEffect(() => {
    const id = setInterval(() => {
      setSecondsLeft(Math.max(0, Math.min(3600, Math.round((endAtRef.current - Date.now()) / 1000))));
    }, 1000);
    return () => clearInterval(id);
  }, []);

  return {
    connection,
    board,
    round,
    lastWinner,
    miner,
    automation,
    motherlode,
    balance,
    secondsLeft,
    loading,
    error,
    refresh,
  };
}
