// Shared Dojo Pot ledger — the ONE place the weekly prize pot is accumulated, so the
// "% into the pot" shown to buyers becomes TRUE and on-chain-verifiable instead of a
// manual number. Every VERIFIED contribution (a share of each coin purchase, 100% of a
// tip, the Cluck-Fu sweep, …) is tallied here in USD + per-route, per-currency — the exact
// shape the /pot ledger page renders.
//
// Imported by store-verify-core.mjs (adds each verified purchase's pot share) and
// store-fn-draw.mjs (reads the live pot for the prize, archives+resets it on a draw).
import { getStore } from "@netlify/blobs";

export const POT_FRAC = 0.25;             // 25% of every coin purchase feeds the pot
const KEY = "current";
const ROUTES = ["coinbuy", "royalty", "tip", "cluck", "game", "shelves", "other"];
const curKey = (c) => ({ SOL: "sol", ORE: "ore", SKR: "skr" }[c] || null);

function zero() {
  const o = { usd: 0, routes: {}, since: null, updatedAt: null };
  for (const r of ROUTES) o.routes[r] = { sol: 0, skr: 0, ore: 0 };
  return o;
}

export async function getPot() {
  const p = await getStore("pot").get(KEY, { type: "json" });
  if (!p) return zero();
  const z = zero();
  const routes = { ...z.routes };
  for (const r of ROUTES) routes[r] = { ...z.routes[r], ...((p.routes || {})[r] || {}) };
  return { ...z, ...p, routes };
}

// Add a verified contribution. `usd` is authoritative for the prize; `currency`+`native`
// fill the transparent per-route breakdown. Idempotency is the CALLER's job (a signature is
// only ever verified once), so this is a plain accumulate.
export async function addToPot({ usd = 0, currency = null, native = 0, route = "other" }) {
  if (!(usd > 0)) return;
  const store = getStore("pot");
  const p = await getPot();
  p.usd += usd;
  const rt = p.routes[ROUTES.includes(route) ? route : "other"];
  const k = curKey(currency);
  if (k && rt[k] != null) rt[k] += native || 0;
  p.since = p.since || Date.now();
  p.updatedAt = Date.now();
  await store.setJSON(KEY, p);
  return p;
}

// Run on a draw: snapshot the pot to the round's archive and reset to zero so next week
// accumulates fresh. Returns the snapshot that was paid out.
export async function archiveAndResetPot(round) {
  const store = getStore("pot");
  const snap = await getPot();
  await store.setJSON("round:" + round, { ...snap, round, closedAt: Date.now() });
  await store.setJSON(KEY, zero());
  return snap;
}
