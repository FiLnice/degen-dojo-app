// Netlify Function: /api/tensor-listings — the CURRENT live Tensor book for Degen Dojo, so the
// store tower shows Tensor listings in real time (not just the deploy-time snapshot). The fetch,
// parsing and 30 s cache live in store-tensor-core.mjs (shared with /api/collection) — if nothing
// parses, it echoes the raw shape in `debug` so the field mapping can be corrected in one shot.
//
// Env: TENSOR_API_KEY (dev.tensor.trade). Optional: TENSOR_COLL_VOC (collection mint, defaulted).
import { limited } from "./store-ratelimit-core.mjs";
import { tensorBook } from "./store-tensor-core.mjs";
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store", "access-control-allow-origin": "*" } });

export default async (request) => {
  const blocked = limited(request, "tensor-listings", 60); if (blocked) return blocked;   // 60 / minute / IP (DD-04)
  const key = process.env.TENSOR_API_KEY;
  if (!key) return json({ error: "Tensor API key not set", needKey: true }, 501);
  try {
    const { items, collId, cached, debug } = await tensorBook(key);
    if (!items.length) return json({ items: [], note: "parsed 0 — check field mapping", debug });
    return json(cached ? { items, cached: true, collId } : { items, collId });
  } catch (e) { return e.debug ? json({ error: e.message, debug: e.debug }, 502) : json({ error: e.message || String(e) }, 502); }
};

export const config = { path: "/api/tensor-listings" };
