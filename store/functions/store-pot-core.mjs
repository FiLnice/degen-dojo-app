// Shared Dojo Pot ledger — the ONE place the weekly prize pot is accumulated, so the
// "% into the pot" shown to buyers becomes TRUE and on-chain-verifiable instead of a
// manual number. Every VERIFIED contribution (a share of each coin purchase, 100% of a
// tip, the Cluck-Fu sweep, …) is tallied here in USD + per-route, per-currency — the exact
// shape the /pot ledger page renders.
//
// Imported by store-verify-core.mjs (adds each verified purchase's pot share) and
// store-fn-draw.mjs (reads the live pot for the prize, archives+resets it on a draw).
import { getStore } from "@netlify/blobs";
import { casUpdate, readWithEtag, putIfMatch, putIfNew, pushId, CasError } from "./store-cas-core.mjs";

export const POT_FRAC = 0.65;             // 65% of every coin purchase feeds the pot (20–30% preachers, rest Degen Dojo)
const KEY = "current";
// Recent contribution ids kept INSIDE the pot blob, so "add" and "already added?" are one atomic
// write: a cron run that overlaps another, or resumes after a crash, can never add the same
// signature twice. Carried across the weekly reset. Long-term idempotency is the callers' own
// per-signature records; this window only has to cover minutes.
const APPLIED_MAX = 1000;
const ROUTES = ["coinbuy", "royalty", "tip", "cluck", "game", "shelves", "other"];
const curKey = (c) => ({ SOL: "sol", ORE: "ore", SKR: "skr" }[c] || null);

function zero() {
  const o = { usd: 0, routes: {}, since: null, updatedAt: null };
  for (const r of ROUTES) o.routes[r] = { sol: 0, skr: 0, ore: 0 };
  return o;
}

function normalize(p) {
  if (!p) return zero();
  const z = zero();
  const routes = { ...z.routes };
  for (const r of ROUTES) routes[r] = { ...z.routes[r], ...((p.routes || {})[r] || {}) };
  return { ...z, ...p, routes };
}
export async function getPot() {
  const { applied, ...p } = normalize(await getStore("pot").get(KEY, { type: "json" }));
  return p;
}

// Add a verified contribution. `usd` is authoritative for the prize; `currency`+`native`
// fill the transparent per-route breakdown. Atomic (compare-and-swap, so concurrent adds are
// never lost) and, when `id` is given (e.g. "coinbuy:<sig>"), idempotent: a repeat id is a no-op.
export async function addToPot({ usd = 0, currency = null, native = 0, route = "other", id = null }) {
  if (!(usd > 0)) return;
  const { value } = await casUpdate(getStore("pot"), KEY, (cur) => {
    const p = normalize(cur);
    if (id && (p.applied || []).includes(id)) return undefined;   // already counted
    p.usd += usd;
    const rt = p.routes[ROUTES.includes(route) ? route : "other"];
    const k = curKey(currency);
    if (k && rt[k] != null) rt[k] += native || 0;
    p.since = p.since || Date.now();
    p.updatedAt = Date.now();
    if (id) p.applied = pushId(p.applied, id, APPLIED_MAX);
    return p;
  });
  const { applied, ...out } = normalize(value);
  return out;
}

// Run on a draw: snapshot the pot to the round's archive and reset to zero so next week
// accumulates fresh. Returns the snapshot that was paid out. The reset is conditional on the pot
// not having changed since the snapshot was taken, so a contribution landing mid-reset is never
// lost (it is either in this round's snapshot or in next week's pot).
export async function archiveAndResetPot(round) {
  const store = getStore("pot");
  for (let i = 0; i < 10; i++) {
    const { value, etag } = await readWithEtag(store, KEY);
    const { applied, ...snap } = normalize(value);
    await store.setJSON("round:" + round, { ...snap, round, closedAt: Date.now() });
    const fresh = { ...zero(), ...(applied ? { applied } : {}) };
    if (etag ? await putIfMatch(store, KEY, fresh, etag) : await putIfNew(store, KEY, fresh)) return snap;
  }
  throw new CasError("pot busy — retry the draw reset");
}
