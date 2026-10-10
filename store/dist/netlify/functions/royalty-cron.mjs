// Scheduled function: every minute, sweep the creator wallet's new marketplace royalties and
// feed 50% into the weekly pot. Captures EVERY marketplace (DD store, Magic Eden, Tensor) because
// all Degen royalties land in the one creator wallet. Idempotent + baseline-on-first-run (see
// store-royalty-core.mjs). The instant path (/api/dd-royalty) still credits DD-store sales the
// moment they confirm; this catches everything else and anything the client missed.
import { sweepRoyalties } from "./store-royalty-core.mjs";

export default async () => {
  if (!process.env.SOLANA_RPC) return;
  try { const r = await sweepRoyalties(); console.log("royalty-cron:", JSON.stringify(r)); }
  catch (e) { console.log("royalty-cron error:", e.message || String(e)); }
};

export const config = { schedule: "* * * * *" };
