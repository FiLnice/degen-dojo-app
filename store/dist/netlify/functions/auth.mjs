// Netlify Function: wallet sign-in at /api/auth  (no password, no custody)
//
// Anti-cheat identity: a player IS their Solana wallet. They prove ownership by
// signing a one-time nonce with the wallet — never a password, never a key we
// hold. In return we issue a short-lived HMAC session token that /api/play trusts
// to move that wallet's server-side coins and mint its raffle tickets.
//
//   POST {action:"nonce",  wallet}                 → { nonce, message }  (sign `message`)
//   POST {action:"verify", wallet, signature}      → { token, exp }      (signature = base58 of the 64-byte sig)
//
// Env: SESSION_SECRET (≥ 32 chars) signs the session token. FAIL-CLOSED: if it is missing or too
// short every action answers 503 — there is NO fallback to ADMIN_KEY or a built-in dev secret
// (see store-session-core.mjs, shared with /api/play which accepts the tokens).
import { getStore } from "@netlify/blobs";
import { createPublicKey, verify as edVerify, randomBytes } from "node:crypto";
import { issueToken, checkToken as checkSessionToken, sessionReady, sessionUnavailable } from "./store-session-core.mjs";

const ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const NONCE_TTL = 5 * 60 * 1000;        // a nonce is good for 5 minutes
const SESSION_TTL = 12 * 60 * 60 * 1000; // a session lasts 12 hours

// ── base58 decode (Bitcoin alphabet), for Solana pubkeys & signatures ──
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const B58MAP = Object.fromEntries([...B58].map((c, i) => [c, i]));
function b58decode(str) {
  let bytes = [0];
  for (const ch of str) {
    const val = B58MAP[ch]; if (val === undefined) throw new Error("bad base58");
    let carry = val;
    for (let j = 0; j < bytes.length; j++) { carry += bytes[j] * 58; bytes[j] = carry & 0xff; carry >>= 8; }
    while (carry) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  for (let k = 0; k < str.length && str[k] === "1"; k++) bytes.push(0);
  return Uint8Array.from(bytes.reverse());
}

// verify an ed25519 signature from a raw 32-byte Solana pubkey (wrap it as SPKI)
const ED_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex"); // fixed DER header for ed25519
function verifyWalletSig(walletB58, message, sigB58) {
  const pub = b58decode(walletB58); if (pub.length !== 32) return false;
  const sig = b58decode(sigB58); if (sig.length !== 64) return false;
  const key = createPublicKey({ key: Buffer.concat([ED_SPKI_PREFIX, Buffer.from(pub)]), format: "der", type: "spki" });
  return edVerify(null, Buffer.from(message, "utf8"), key, Buffer.from(sig));
}

// Kept as an export for compatibility: returns wallet if valid, else null (null when unconfigured).
export const checkToken = checkSessionToken;

function msg(wallet, nonce, iso) {
  return `Degen Dojo sign-in\nWallet: ${wallet}\nNonce: ${nonce}\nIssued: ${iso}\n\nSign to prove you own this wallet. This is free and never a transaction.`;
}

const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "content-type" };

export default async (request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (request.method !== "POST") return new Response("POST only", { status: 405, headers: CORS });
  if (!sessionReady()) return sessionUnavailable(CORS);   // no SESSION_SECRET → issue nothing
  let r; try { r = await request.json(); } catch { return new Response("bad json", { status: 400, headers: CORS }); }
  if (!r || typeof r !== "object") return new Response("bad json", { status: 400, headers: CORS });
  const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS } });
  if (!ADDR_RE.test(r.wallet || "")) return json({ error: "bad wallet" }, 400);
  const store = getStore("auth-nonces");

  if (r.action === "nonce") {
    const nonce = randomBytes(16).toString("hex");
    const iso = new Date().toISOString();
    await store.setJSON("n:" + r.wallet, { nonce, iso, exp: Date.now() + NONCE_TTL });
    return json({ nonce, message: msg(r.wallet, nonce, iso) });
  }

  if (r.action === "verify") {
    const rec = await store.get("n:" + r.wallet, { type: "json" });
    if (!rec || Date.now() > rec.exp) return json({ error: "nonce expired — request a new one" }, 401);
    let ok = false;
    try { ok = typeof r.signature === "string" && r.signature.length <= 100 && verifyWalletSig(r.wallet, msg(r.wallet, rec.nonce, rec.iso), r.signature); } catch { ok = false; }
    if (!ok) return json({ error: "signature did not verify" }, 401);
    await store.delete("n:" + r.wallet);                 // one-time use
    const exp = Date.now() + SESSION_TTL;
    const token = issueToken(r.wallet, exp);
    if (!token) return sessionUnavailable(CORS);
    return json({ token, exp, wallet: r.wallet });
  }

  return json({ error: "unknown action" }, 400);
};

export const config = { path: "/api/auth" };
