// Netlify Function: /api/dd-royalty — feed the Dojo Pot from marketplace royalties.
//
// When a Degen sells, the 13% creator royalty lands in the creator wallet (ED3GMC). This
// routes HALF of that royalty (ROYALTY_TO_POT) into the weekly pot ledger — verified against
// the ACTUAL amount the creator wallet received in the sale tx, so the pot only ever grows by
// real, on-chain royalty income (never a claimed number). Idempotent per signature.
//
//   POST { sig, currency }  → credits 50% of the royalty in `sig` to the pot's "royalty" route.
//
// Env: SOLANA_RPC, optionally ROYALTY_WALLET (defaults to the ED3GMC creator wallet).
import { getStore } from "@netlify/blobs";
import { addToPot } from "./store-pot-core.mjs";
import { walletReceived, livePrice } from "./store-verify-core.mjs";

const CREATOR = process.env.ROYALTY_WALLET || "ED3GMCfoX3XNvavnWADvd6oCsohGg1ukdhv3PaUpvwJe";
const ROYALTY_TO_POT = 0.5;                       // 50% of every royalty feeds the pot
const CURS = new Set(["ORE", "SKR", "USDC", "SOL"]);
const SIG_RE = /^[1-9A-HJ-NP-Za-km-z]{80,90}$/;
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default async (request) => {
  if (request.method !== "POST") return new Response("POST only", { status: 405 });
  if (!process.env.SOLANA_RPC) return json({ error: "SOLANA_RPC not set" }, 500);
  let d; try { d = await request.json(); } catch { return json({ error: "bad json" }, 400); }
  const sig = String(d?.sig || ""), currency = String(d?.currency || "").toUpperCase();
  if (!SIG_RE.test(sig) || !CURS.has(currency)) return json({ error: "bad fields" }, 400);

  const store = getStore("dd-royalties");
  const prior = await store.get(sig, { type: "json" });
  if (prior && prior.credited) return json({ ok: true, already: true, potNative: prior.potNative, potUsd: prior.potUsd });

  // Read the REAL royalty the creator wallet received in this tx (retry a few times for propagation).
  let got = null;
  for (let i = 0; i < 5 && got == null; i++) { got = await walletReceived(sig, currency, CREATOR); if (got == null) await sleep(1500); }
  if (got == null) { await store.setJSON(sig, { credited: false, pending: true, currency, at: Date.now() }); return json({ ok: false, pending: true }); }
  if (!(got > 0)) { await store.setJSON(sig, { credited: true, potNative: 0, potUsd: 0, note: "no royalty to creator in this tx", at: Date.now() }); return json({ ok: true, potNative: 0 }); }

  const price = await livePrice(currency);
  if (price == null) return json({ ok: false, retry: "no price" }, 200);     // fail-closed; client/cron can retry
  const potNative = got * ROYALTY_TO_POT;
  const potUsd = potNative * price;
  await addToPot({ usd: potUsd, currency, native: potNative, route: "royalty" });
  await store.setJSON(sig, { credited: true, currency, royalty: got, potNative, potUsd: +potUsd.toFixed(4), at: Date.now() });
  return json({ ok: true, royalty: got, potNative, potUsd: +potUsd.toFixed(4) });
};

export const config = { path: "/api/dd-royalty" };
