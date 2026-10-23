// Netlify Function: /api/burnclaim — fix a burned card's vault as a stORE claim (paid in the weekly batch).
//
//   POST { sig } → { ok, mint, claim: { store, usd, kind, wallet, status }, status: "due", claims: [...] }
//
// Two ways to burn, both without trusting the page:
//   • the holder burned the NFT themselves (the /burn page's one-click) — verified: the holder signed, held it
//     before, the token supply is now 0, and it is a Degen Dojo / Demon Dojo / TETO NFT
//   • the holder SENT the NFT to the Treasury (no wallet connection needed; the Treasury reader also finds
//     these by itself) — the weekly batch burns it
// The claim = the card's vault in stORE at that moment, fixed once per card (create-only).
import { limited } from "./store-ratelimit-core.mjs";
import { processSig, claimFromBurn, getClaim, SIG_RE, MAX_AGE_MS, KeeperError, TREASURY, burnEnabled } from "./store-keeper-core.mjs";
import { getTx } from "./store-payout-core.mjs";

const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });
function ownOrigin(request) {
  const o = request.headers.get("origin") || request.headers.get("referer") || "";
  let h; try { h = new URL(o).host.toLowerCase(); } catch { return false; }
  const own = new Set(); const hh = (request.headers.get("host") || "").trim().toLowerCase(); if (hh) own.add(hh);
  try { own.add(new URL(request.url).host.toLowerCase()); } catch {}
  return own.has(h);
}
const pub = (c) => ({ store: c.store, storeRaw: c.storeRaw, usd: c.usd, kind: c.kind, wallet: c.wallet, status: c.status, at: c.at });

export default async (request) => {
  const blocked = limited(request, "burnclaim", 20); if (blocked) return blocked;   // 20 / minute / IP (DD-04)
  if (request.method !== "POST") return json({ error: "POST only" }, 405);
  if (!burnEnabled()) return json({ error: "Burning isn't open yet" }, 409);   // BURN_ENABLED (env) — off until the owner launches it
  if (!ownOrigin(request)) return json({ error: "use the Degen Dojo store page" }, 403);
  if (!process.env.SOLANA_RPC) return json({ error: "SOLANA_RPC is not set" }, 500);
  let body; try { body = await request.json(); } catch { return json({ error: "bad json" }, 400); }
  const sig = String(body?.sig || "");
  if (!SIG_RE.test(sig)) return json({ error: "bad signature" }, 400);
  try {
    let tx = null;
    for (let i = 0; i < 4 && !tx; i++) { tx = await getTx(sig, "jsonParsed").catch(() => null); if (!tx) await new Promise((r) => setTimeout(r, 1500)); }
    if (!tx) return json({ error: "that transaction isn't on-chain yet — try again in a moment" }, 404);
    if (tx.meta?.err) return json({ error: "that transaction failed on-chain" }, 400);
    if (tx.blockTime && Date.now() - tx.blockTime * 1000 > MAX_AGE_MS) return json({ error: "that transaction is older than 48 hours" }, 400);
    // sent to the Treasury? (decided once, same as the Treasury reader)
    const toTreasury = (tx.meta?.postTokenBalances || []).some((b) => b.owner === TREASURY && b.uiTokenAmount?.decimals === 0 && String(b.uiTokenAmount?.amount) === "1");
    let claims;
    if (toTreasury) {
      const d = await processSig(sig, { tx });
      if (d.kind === "retry") return json({ error: "couldn't price it right now — try again in a minute" }, 503);
      if (d.kind !== "sent") return json({ error: d.why || "no Dojo card was sent to the Treasury in that transaction" }, 400);
      claims = (await Promise.all(d.cards.map((c) => getClaim(c.mint)))).filter(Boolean);
    } else claims = await claimFromBurn(sig, tx);
    if (!claims.length) return json({ error: "no claim recorded for that transaction" }, 400);
    return json({ ok: true, mint: claims[0].mint, claim: pub(claims[0]), status: claims[0].status, claims: claims.map((c) => ({ mint: c.mint, ...pub(c) })) });
  } catch (e) {
    if (e instanceof KeeperError) return json({ error: e.message }, e.status);
    return json({ error: "couldn't check it right now — try again in a minute" }, 502);
  }
};

export const config = { path: "/api/burnclaim" };
