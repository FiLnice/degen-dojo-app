// Atomic ledger writes over Netlify Blobs conditional writes (compare-and-swap).
//
// Blobs is last-write-wins by default, so a read-then-write on a balance / play / pot can lose an
// update or apply one twice when two requests (or two overlapping cron runs) interleave. Every
// money/ticket mutation goes through here instead:
//
//   casUpdate(store, key, fn)   read (strong) + etag → fn(value) → write only if the etag still
//                               matches; on a conflict re-read and re-run fn (bounded retries)
//   putIfNew(store, key, v)     create-only write (one-time markers / claims) → true if WE created it
//   putIfMatch(store, key, v, etag)
//
// Needs @netlify/blobs >= 10 (conditional writes). build-store-deploy.mjs pins 10.7.13. NOTE: in
// 10.0.0–10.7.11 `setJSON(..., {onlyIfMatch|onlyIfNew})` silently ignores the condition (it spreads
// the options into the wrong field) while `set()` honours it — so this module always writes with
// `set(key, JSON.stringify(v), cond)`. If the runtime lacks conditional writes we FAIL CLOSED
// (throw) rather than fall back to an unguarded write.

export class CasError extends Error { constructor(msg, status = 503) { super(msg); this.status = status; } }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function assertConditional(store) {
  const C = store && Object.getPrototypeOf(store)?.constructor;
  if (typeof C?.getConditions !== "function")
    throw new CasError("conditional writes unavailable — the vendored @netlify/blobs must be >= 10.7.12", 500);
}
function modifiedOf(res) {
  if (!res || typeof res.modified !== "boolean")
    throw new CasError("conditional write returned no result — the vendored @netlify/blobs must be >= 10.7.12", 500);
  return res.modified;
}

// Strong read with etag (falls back to the eventual read only when this runtime has no uncached
// edge URL — a stale etag then just makes the conditional write fail and retry, never double-apply).
export async function readWithEtag(store, key) {
  let r;
  try { r = await store.getWithMetadata(key, { type: "json", consistency: "strong" }); }
  catch (e) {
    if (!/uncachedEdgeURL|strong consistency/i.test(String(e?.message || e))) throw e;
    r = await store.getWithMetadata(key, { type: "json" });
  }
  if (!r || r.data == null) return { value: null, etag: null };
  return { value: r.data, etag: r.etag ?? null };
}

export async function putIfNew(store, key, value) {
  assertConditional(store);
  return modifiedOf(await store.set(key, JSON.stringify(value), { onlyIfNew: true }));
}
export async function putIfMatch(store, key, value, etag) {
  assertConditional(store);
  if (!etag) throw new CasError("missing etag for a conditional write", 500);
  return modifiedOf(await store.set(key, JSON.stringify(value), { onlyIfMatch: etag }));
}

// Atomic read-modify-write. `fn(current | null)` returns the new value, or `undefined` to leave the
// key untouched (e.g. "already applied"). fn may throw to abort (the error propagates unchanged).
// fn can run more than once (once per conflict), so it must be a pure function of its input.
// → { value, changed }   value = what is stored now (new value, or the unchanged current one)
export async function casUpdate(store, key, fn, { tries = 10 } = {}) {
  assertConditional(store);
  for (let i = 0; i < tries; i++) {
    const { value, etag } = await readWithEtag(store, key);
    const next = await fn(value == null ? null : structuredClone(value));
    if (next === undefined) return { value, changed: false };
    const ok = etag ? await putIfMatch(store, key, next, etag) : await putIfNew(store, key, next);
    if (ok) return { value: next, changed: true };
    await sleep(Math.min(400, 15 * 2 ** i) * (0.5 + Math.random()));   // jittered backoff, then re-read
  }
  throw new CasError("ledger busy — please retry");
}

// Append an idempotency id to a bounded list (newest last).
export const pushId = (list, id, max) => [...(Array.isArray(list) ? list : []), id].slice(-max);
