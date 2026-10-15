// Shared, dependency-free auth primitives for the store's Netlify functions.
//
//   sessionSecret()          → SESSION_SECRET if it is set and ≥ 32 chars, else null. NEVER falls back
//                              to ADMIN_KEY (separation of duties: the admin key must not be able to
//                              mint player sessions) and never to a hard-coded dev secret.
//   sessionReady()           → true when a usable SESSION_SECRET is configured.
//   issueToken(wallet, exp)  → "wallet.exp.hmac" (same wire format as before) or null if not configured.
//   checkToken(token)        → wallet if the token is genuine and unexpired, else null (also null when
//                              SESSION_SECRET is missing — fail closed, never "accept anything").
//   keyMatches(given, want)  → constant-time admin-key compare. false when `want` is unset/empty, so a
//                              missing env var can never be matched (not even by "", "\0" or "%00").
//   adminKeyOk(given, ...envNames) → keyMatches against the first env var in the list that is set.
//   sessionUnavailable(headers) → the 503 Response auth/play return when SESSION_SECRET isn't configured.
//
// Imported by store-fn-auth.mjs (issues tokens) and store-fn-play.mjs (accepts them), plus the admin-gated
// functions. Copied next to them by build-store-deploy.mjs.
import { createHmac, createHash, timingSafeEqual } from "node:crypto";

export const MIN_SECRET_LEN = 32;
const ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function sessionSecret() {
  const s = process.env.SESSION_SECRET;
  return typeof s === "string" && s.length >= MIN_SECRET_LEN ? s : null;
}
export const sessionReady = () => sessionSecret() !== null;

const mac = (secret, body) => createHmac("sha256", secret).update(body).digest("hex");

export function issueToken(wallet, exp) {
  const secret = sessionSecret();
  if (!secret || !ADDR_RE.test(String(wallet || "")) || !Number.isFinite(exp)) return null;
  const body = wallet + "." + exp;
  return body + "." + mac(secret, body);
}

export function checkToken(token, now = Date.now()) {
  const secret = sessionSecret();
  if (!secret || !token || typeof token !== "string" || token.length > 200) return null;
  const i = token.lastIndexOf(".");
  if (i < 0) return null;
  const body = token.slice(0, i), got = token.slice(i + 1);
  const parts = body.split(".");
  if (parts.length !== 2) return null;
  const [wallet, expStr] = parts;
  if (!ADDR_RE.test(wallet) || !/^\d{1,16}$/.test(expStr)) return null;
  const want = mac(secret, body);
  if (got.length !== want.length || !timingSafeEqual(Buffer.from(got), Buffer.from(want))) return null;
  if (now > Number(expStr)) return null;
  return wallet;
}

// Hash both sides first so the compare is constant-time AND doesn't leak the key's length.
export function keyMatches(given, want) {
  if (typeof want !== "string" || want.length === 0) return false;
  if (typeof given !== "string" || given.length === 0) return false;
  const a = createHash("sha256").update(given, "utf8").digest();
  const b = createHash("sha256").update(want, "utf8").digest();
  return timingSafeEqual(a, b);
}
export function adminKeyOk(given, ...envNames) {
  const name = envNames.find((n) => typeof process.env[n] === "string" && process.env[n].length > 0);
  return name ? keyMatches(given, process.env[name]) : false;
}

export function sessionUnavailable(headers = {}) {
  return new Response(JSON.stringify({ error: "Sign-in is temporarily unavailable (server not configured)." }), {
    status: 503,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });
}
