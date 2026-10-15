// Netlify Function: claim reservations at /api/claim
//
// The claim gallery (degendojo.xyz/claim) shows every piece NOT currently in the
// on-chain collection. But a Discord claim isn't on-chain until the art is minted,
// so between "claimed" and "minted" a piece would still look available. This holds a
// small admin-maintained list of RESERVED claim ids so those pieces vanish for
// everyone the instant they're claimed — no rebuild, no redeploy.
//
// GET   (no key)                      → { reserved: ["demon_1601", ...] }   (CORS-open; the
//                                        gallery on the apex fetches it cross-origin)
// POST  { key, add:[ids], remove:[ids] } → mutate the list, returns the new { reserved }
//   ids are "degen_<n>" / "demon_<n>"; a bare "<n>" expands to BOTH forms.
//
// Env: CLAIM_ADMIN_KEY (preferred) or ATTR_ADMIN_KEY as a fallback. Netlify Blobs needs
// no config on Netlify.
import { getStore } from "@netlify/blobs";
import { adminKeyOk } from "./store-session-core.mjs";

const ID_RE = /^(?:degen|demon)_\d{1,5}$/;
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type",
};

// normalize a token into 0..2 valid ids: "demon_12" stays; "12" → both forms.
function expand(tok) {
  const t = String(tok || "").trim().toLowerCase();
  if (!t) return [];
  if (ID_RE.test(t)) return [t];
  if (/^\d{1,5}$/.test(t)) return ["degen_" + t, "demon_" + t];
  return [];
}

export default async (request) => {
  if (request.method === "OPTIONS") return new Response("", { headers: CORS });
  const store = getStore("claim-reserved");
  const read = async () => (await store.get("reserved", { type: "json" })) || [];

  if (request.method === "GET") {
    const reserved = await read();
    return new Response(JSON.stringify({ reserved }), {
      headers: { ...CORS, "content-type": "application/json", "cache-control": "no-store" },
    });
  }

  if (request.method !== "POST") return new Response("POST only", { status: 405, headers: CORS });

  let r; try { r = await request.json(); } catch { return new Response("bad json", { status: 400, headers: CORS }); }
  if (!adminKeyOk(r?.key, "CLAIM_ADMIN_KEY", "ATTR_ADMIN_KEY")) return new Response(JSON.stringify({ error: "forbidden" }), { status: 403, headers: { ...CORS, "content-type": "application/json" } });

  const add = [].concat(r.add || []).flatMap(expand);
  const remove = new Set([].concat(r.remove || []).flatMap(expand));
  let reserved = await read();
  const set = new Set(reserved);
  for (const id of add) set.add(id);
  for (const id of remove) set.delete(id);
  reserved = [...set].sort((a, b) => {
    const na = +a.split("_")[1], nb = +b.split("_")[1];
    return na - nb || a.localeCompare(b);
  });
  await store.setJSON("reserved", reserved);
  return new Response(JSON.stringify({ ok: true, reserved }), {
    headers: { ...CORS, "content-type": "application/json" },
  });
};

export const config = { path: "/api/claim" };
