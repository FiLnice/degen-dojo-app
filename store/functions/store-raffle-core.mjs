// Burn Raffle (owner 2026-10-28) — the ONE place the raffle's tickets, pot and weekly draw live.
//
// Holders burn NFTs they don't want. The SAME transaction — built and simulated in their browser (/raffle,
// dojo-raffle.js), signed by them — sends the rent those burns freed to the raffle wallet with a "ddraffle:<round>"
// memo. Nothing is custodial: nobody sends us an NFT and the server holds no key. Every 0.001 SOL of freed rent is one
// ticket in that week's draw of the raffle's own pot.
//
//   inspectRaffleTx(tx)    pure: who burned (fee payer = first signer), the memo's round, the SOL sent to the raffle
//                          wallet (top-level System transfers from the burner) and the rent the burn instructions freed
//                          (the accounts each burn closes — Core: shrinks to a 1-byte stub — read from the tx's own
//                          balances). tickets = floor(min(sent, freed) / 0.001 SOL): SOL + a memo with no burn = 0 tickets.
//   recordBurn(sig)        /api/raffle POST: judge it now, or queue it (pending:<sig>) when the node can't read it yet
//   verifyRaffleBurns()    verify-cron, every minute: finds new ddraffle transactions on the raffle wallet itself (so a
//                          closed tab loses nothing), then judges the queue
//   creditBurn             exactly once per signature: a create-only marker (credited:<sig>) fixes the round and the
//                          amounts, then the tickets and the pot are added with id-guarded compare-and-swap writes
//   commitRaffle / drawRaffle / verifyRaffleDraw   the Dojo Pot's commit-reveal (store-draw-core primitives): a secret
//                          seed is committed AND the round frozen at draw time, the entries are published, only then a
//                          future slot is chosen — its blockhash mixed with the seed picks the winners (ticket-weighted)
//   raffleTick(week)       the payout cron's weekly step, on the Dojo Pot's schedule (DRAW_DAY / DRAW_HOUR_UTC)
//   raffleForPlan(round)   the drawn winners not yet in a payout plan → payees (kind "raffle") of the weekly /payouts batch
//
// Money: every lamport sent with a raffle memo is split 88% prize / 12% Reserve (the Reserve's part never leaves the
// Treasury). A round's prize = Degen Dojo's ORE seed + 88% of the SOL burned in that round + whatever rolled in.
// Winners by the prize's ORE value at the draw (SOL valued at the draw's prices): ≤ 1 ORE → 1 winner (100%) ·
// ≤ 3 ORE → 3 (60/25/15) · more → 5 (40/25/15/10/10). Ranks nobody filled (and a round nobody entered) roll into the
// next round's pot. The SOL parts are swapped to ORE when the owner pays (the payout plan's server quote).
//
// Tickets go to the OPEN round (latest committed + 1) at the moment they are credited — a round is frozen when it is
// committed, so a burn landing during a draw counts for the next one. The memo's round only has to be a real one
// (1 … the open round): it says which round the page showed, not where the tickets go.
//
// "Add to the prize" (owner 2026-10-28) — gifts: anyone adds SOL, ORE, any token or NFTs to the OPEN round's prize from
// their own wallet (dojo-gift.js), with a signed "ddpot:<round>[:<name>]" memo. Gifts NEVER give tickets and take NO cut.
// SOL + ORE join the ORE prize (and count for the 1/3/5 tier); other tokens and NFTs are BONUS prizes: each token split
// by the same % as the ORE prize (raw floor — the dust rolls over), NFTs one per winner in rank order (1st place gets the
// first NFT given, …; extra NFTs roll to the next round). SOL / ORE / SKR / USDC, Jupiter-verified tokens and NFTs from
// Degen Dojo, Demon Dojo or a collection / mint the owner trusts show at once; anything else waits for the owner
// (/payouts "Raffle gifts": approve · approve + trust · hide) and joins the OPEN round when approved.
//   inspectGiftTx(tx)      pure: the donor (first signer), the memo's round + name, and what the raffle wallet received in
//                          THAT transaction (its SOL balance, its token balances by mint, Core TransferV1s to it)
//   recordGift(sig)        /api/raffle POST {action:"gift"} — judge it now or queue it (the wallet scan finds missed ones)
//   moderateGift(id, op)   the owner's approve / trust / hide
//
// Blobs:
//   "raffle"          latest, public:<n>, seed:<n>, drawing:<n>, snap:<n>, entries:<n>, pot:r<n>, cycle, planned:r<n>
//   "raffle-tickets"  r<n>:player:<wallet> { wallet, name, tickets, lamports, burns, free, ids[] }
//   "raffle-burns"    burn:<sig> (the verdict the page reads), pending:<sig>, credited:<sig> (one-time marker), cursor
//   "raffle-gifts"    g:<sig> (verdict), gpending:<sig>, gcredited:<sig> (one-time marker), item:<sig>:<i> (one gift item:
//                     shown | pending | hidden), trust:coll:<addr> / trust:mint:<addr>, asset:<id> (DAS, cached),
//                     jup:<mint> (Jupiter token info, ≤ once a day), wall (the latest gifts), counts
// Env: SOLANA_RPC, RAFFLE_WALLET (default TREASURY_WALLET, then the Treasury 5w55…), JUPITER_BASE.
import { getStore } from "@netlify/blobs";
import { randomBytes } from "node:crypto";
import { sha256, pickWinners, entriesFromRecords, entriesHash, blockhashAtOrAfter, firstBlockSlot, DrawError, oreUsd, solUsd, SLOTS_AHEAD, SETTLE_MS, BLOCK } from "./store-draw-core.mjs";
import { casUpdate, readWithEtag, putIfNew, pushId } from "./store-cas-core.mjs";
import { memosOf, b58decode } from "./store-ref-core.mjs";

const ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SIG_RE = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;
const DAY = 86400e3;
export const RAFFLE_MEMO = "ddraffle:";
export const LAMPORTS_PER_TICKET = 1_000_000;        // 0.001 SOL of freed rent = 1 ticket
export const RESERVE_PCT = 12n;                      // of every lamport sent; the prize gets the rest (88%)
export const MAX_AGE_MS = 14 * DAY;                  // a burn is credited only within two weeks of landing
export const UNREADABLE_DROP_MS = 15 * 60e3;         // a POSTed signature no node can read after this is dropped
export const SEED_ORE_MAX = 25;                      // per seed action — a typo guard; seed again for more
export const RAFFLE_WAIT_MS = 2 * 3600e3;            // the weekly payout plan waits at most this long for the raffle draw
const ORE_DEC = 11;
const TREASURY_DEFAULT = "5w55F58ia3H71QjBD9bYvNQF2DcNu8K3AfJj9A4WMuWp";
export const raffleWallet = () => [process.env.RAFFLE_WALLET, process.env.TREASURY_WALLET, TREASURY_DEFAULT]
  .map((w) => String(w || "").trim()).find((w) => ADDR_RE.test(w));

export const TOKEN_METADATA = "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s";
export const CORE = "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d";
const SYSTEM = "11111111111111111111111111111111";
// The burn instructions we recognise, and the positions (in each one's account list) of the accounts it CLOSES — only
// those count as freed rent, so an unrelated account that loses lamports elsewhere in the tx never buys tickets.
const BURN_IXS = [
  { program: TOKEN_METADATA, tag: 41, freed: [2, 3, 4, 5, 10] },   // Burn (V1): metadata · edition · mint · token account · token record
  { program: TOKEN_METADATA, tag: 29, freed: [0, 2, 3, 4] },       // BurnNft (legacy): metadata · mint · token account · master edition
  { program: CORE, tag: 12, freed: [0] },                          // Core BurnV1: the asset (left as a 1-byte stub)
];

// gifts
export const GIFT_MEMO = "ddpot:";
export const GIFT_NAME_RE = /^[A-Za-z0-9 _-]{1,24}$/;   // the donor's name inside the signed memo: no dots, slashes or colons → no links
export const GIFT_MAX_ITEMS = 40;                        // tokens + NFTs one gift transaction may carry
export const ORE_MINT = "oreoU2P8bN6jkk3jbaiVxYnG1dCXcYxwhwyK9jSybcp";
const SKR_MINT = "SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3", USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", TOKEN22 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const AUTO_TOKENS = new Set([SKR_MINT, USDC_MINT]);      // (SOL and ORE are the prize itself)
// Degen Dojo · Demon Dojo (store-keeper-core / store-genuine-core). DAS lists only VERIFIED collections, and nobody but
// Degen Dojo can verify into these — but "verified collection" alone is no proof for any other collection (anyone can
// make and verify their own), so other NFTs wait for the owner until he trusts their collection.
export const AUTO_COLLECTIONS = new Set(["2m9DupVeheZ5vfuXZxqV3KSQ7HnVDk2tG6ouH1ZnLwYb", "WyUy9qjJekjqTAYGanANjhtviwgu1uhCkXx1uas8fWb"]);
const CORE_TRANSFER = 14;                                // Metaplex Core TransferV1

// Prize tiers by the pot's ORE value at the draw (owner 2026-10-28). Exactly 1 ORE → 1 winner; exactly 3 ORE → 3.
export const TIERS = [{ upTo: 1, pcts: [100n] }, { upTo: 3, pcts: [60n, 25n, 15n] }, { upTo: Infinity, pcts: [40n, 25n, 15n, 10n, 10n] }];
export const prizeTiers = (potOre) => TIERS.find((t) => !(Number(potOre) > t.upTo)).pcts;
// the pot's ORE value where the next tier starts (null at the top tier)
export const nextTierAt = (potOre) => { const t = TIERS.find((x) => !(Number(potOre) > x.upTo)); return Number.isFinite(t.upTo) ? t.upTo : null; };
// Integer split of `total` base units over the ranks: floor(total × pct / 100) each, the rounding dust to 1st. Sum === total.
export function splitBy(total, pcts) {
  total = BigInt(total);
  const out = pcts.map((p) => (total * BigInt(p)) / 100n);
  out[0] += total - out.reduce((a, b) => a + b, 0n);
  return out;
}
// The bonus prizes (gifts that aren't SOL / ORE) for `n` winners on the tier `pcts`: every token split by the same % as
// the ORE prize, floored in raw units (the dust and the shares of ranks nobody filled roll over); NFTs one per winner
// in donation order — 1st place the first NFT — the rest roll over. → { ranks: [{ tokens, nfts }] (one per tier rank), carry }
export function allocateGifts(gifts, pcts, n) {
  const ranks = pcts.map(() => ({ tokens: [], nfts: [] })), carry = { tokens: {}, nfts: [] };
  n = Math.max(0, Math.min(n, pcts.length));
  for (const mint of Object.keys(gifts?.tokens || {}).sort()) {
    const t = gifts.tokens[mint], total = B(t.raw);
    if (total <= 0n) continue;
    const parts = pcts.map((p) => (total * BigInt(p)) / 100n);
    let rest = total - parts.reduce((a, b) => a + b, 0n);
    parts.forEach((v, i) => { if (i < n) { if (v > 0n) ranks[i].tokens.push({ ...t, mint, raw: S(v) }); } else rest += v; });
    if (rest > 0n) carry.tokens[mint] = { ...t, raw: S(rest) };
  }
  (gifts?.nfts || []).forEach((x, i) => { if (i < n) ranks[i].nfts.push(x); else carry.nfts.push(x); });
  return { ranks, carry };
}
// a winner's bonus, comparable (the draw's re-check)
const bonusKey = (w) => JSON.stringify([(w?.tokens || []).map((t) => t.mint + ":" + t.raw).sort(), (w?.nfts || []).map((x) => x.mint)]);
export const splitSent = (sent) => { sent = BigInt(sent); const reserve = (sent * RESERVE_PCT) / 100n; return { prize: sent - reserve, reserve }; };
export const ticketsFor = (lamports) => Number(BigInt(lamports) / BigInt(LAMPORTS_PER_TICKET));
const S = (b) => BigInt(b || 0).toString();
const B = (s) => { try { return BigInt(s || 0); } catch { return 0n; } };
export const oreToRaw = (ore) => BigInt(Math.round(Number(ore) * 1e6)) * 10n ** BigInt(ORE_DEC - 6);   // 6 decimals of input, exact in raw
export const rawToOre = (raw) => Number(B(raw)) / 10 ** ORE_DEC;
// The pot's value in ORE (its SOL at the given prices) — the ONE formula the draw and its re-check use for the tier
export const potOreOf = (oreRaw, solLamports, orePx, solPx) => rawToOre(oreRaw) + (orePx > 0 && solPx > 0 ? (Number(B(solLamports)) / 1e9) * solPx / orePx : 0);

// ---------- reading a transaction ----------
const keyStr = (k) => (typeof k === "string" ? k : k?.pubkey || String(k));
function allKeys(tx) {
  const keys = (tx.transaction.message.accountKeys || []).map(keyStr);
  if (keys.length < (tx.meta?.preBalances || []).length)
    keys.push(...(tx.meta.loadedAddresses?.writable || []), ...(tx.meta.loadedAddresses?.readonly || []));
  return keys;
}
function signersOf(tx) {
  const msg = tx.transaction.message, ak = msg.accountKeys || [];
  if (ak.length && typeof ak[0] === "object" && "signer" in ak[0]) return ak.filter((k) => k.signer).map((k) => k.pubkey);
  return ak.slice(0, msg.header?.numRequiredSignatures || 0).map(keyStr);
}
// a top-level instruction in either getTransaction encoding ("json": indexes + base58 data · "jsonParsed": keys + parsed)
function ixView(ix, keys) {
  const program = ix.programId || keys[ix.programIdIndex];
  const accounts = Array.isArray(ix.accounts) ? ix.accounts.map((a) => (typeof a === "number" ? keys[a] : a)) : [];
  return { program, accounts, data: typeof ix.data === "string" ? b58decode(ix.data) : null, parsed: ix.parsed && typeof ix.parsed === "object" ? ix.parsed : null };
}
const u32 = (b, o) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] * 0x1000000);
const u64 = (b, o) => { let n = 0n; for (let i = 7; i >= 0; i--) n = (n << 8n) + BigInt(b[o + i]); return n; };
/** Top-level System Program transfers → [{ from, to, lamports: BigInt }] */
export function systemTransfers(tx) {
  const keys = allKeys(tx), out = [];
  for (const ix of tx.transaction.message.instructions || []) {
    const v = ixView(ix, keys);
    if (v.program !== SYSTEM) continue;
    if (v.parsed) { if (v.parsed.type === "transfer" && v.parsed.info) out.push({ from: v.parsed.info.source, to: v.parsed.info.destination, lamports: B(v.parsed.info.lamports) }); continue; }
    if (v.data && v.data.length === 12 && u32(v.data, 0) === 2) out.push({ from: v.accounts[0], to: v.accounts[1], lamports: u64(v.data, 4) });
  }
  return out;
}
/** The rent the transaction's burn instructions freed: the lamports the accounts they close lost (signers excluded). */
export function freedByBurns(tx) {
  const keys = allKeys(tx), signers = new Set(signersOf(tx)), counted = new Set();
  let burns = 0;
  for (const ix of tx.transaction.message.instructions || []) {
    const v = ixView(ix, keys);
    const spec = v.data && v.data.length ? BURN_IXS.find((b) => b.program === v.program && b.tag === v.data[0]) : null;
    if (!spec) continue;
    burns++;
    for (const p of spec.freed) { const a = v.accounts[p]; if (a && !signers.has(a) && a !== TOKEN_METADATA && a !== CORE && a !== SYSTEM) counted.add(a); }
  }
  let lamports = 0n;
  const pre = tx.meta?.preBalances || [], post = tx.meta?.postBalances || [];
  for (const a of counted) { const i = keys.indexOf(a); if (i < 0) continue; const d = BigInt(pre[i] || 0) - BigInt(post[i] || 0); if (d > 0n) lamports += d; }
  return { lamports, burns };
}
/** The verdict on one transaction: { wallet, round, sent, freed, burns, credited, tickets, blockTime } | { reject } | { retry } */
export function inspectRaffleTx(tx, to = raffleWallet()) {
  if (!tx) return { retry: "the transaction isn't readable yet" };
  if (tx.meta?.err) return { reject: "the transaction failed" };
  const signers = signersOf(tx), wallet = signers[0] || null;
  if (!wallet || !ADDR_RE.test(wallet)) return { reject: "no signer" };
  if (signers.includes(to)) return { reject: "the raffle wallet's own transaction" };
  const tags = memosOf(tx).filter((m) => m.startsWith(RAFFLE_MEMO));
  if (!tags.length) return { reject: "no ddraffle memo — not a raffle burn" };
  if (tags.length > 1) return { reject: "more than one ddraffle memo" };
  const mm = /^ddraffle:([1-9]\d{0,5})$/.exec(tags[0]);
  if (!mm) return { reject: "bad ddraffle memo" };
  const sent = systemTransfers(tx).filter((t) => t.from === wallet && t.to === to).reduce((s, t) => s + t.lamports, 0n);
  if (sent <= 0n) return { reject: "nothing was sent to the raffle wallet" };
  const f = freedByBurns(tx);
  const credited = sent < f.lamports ? sent : f.lamports;
  return { wallet, round: Number(mm[1]), sent, freed: f.lamports, burns: f.burns, credited, tickets: ticketsFor(credited), blockTime: tx.blockTime || null };
}

/** Top-level Metaplex Core TransferV1 instructions → [{ asset, collection, to }] (either getTransaction encoding). */
export function coreTransfersOf(tx) {
  const keys = allKeys(tx), out = [];
  for (const ix of tx.transaction.message.instructions || []) {
    const v = ixView(ix, keys);
    if (v.program !== CORE || !v.data || v.data[0] !== CORE_TRANSFER) continue;
    out.push({ asset: v.accounts[0] || null, collection: v.accounts[1] && v.accounts[1] !== CORE ? v.accounts[1] : null, to: v.accounts[4] || null });
  }
  return out;
}
/** What `owner` holds MORE of after the transaction, per mint (both token programs): [{ mint, raw, decimals, program }]. */
export function tokenGains(tx, owner) {
  const by = {};
  const add = (b, sign) => {
    if (!b || b.owner !== owner || !b.mint) return;
    const x = (by[b.mint] ||= { raw: 0n, decimals: Number(b.uiTokenAmount?.decimals) || 0, program: b.programId || TOKEN });
    x.raw += B(b.uiTokenAmount?.amount) * sign;
  };
  for (const b of tx.meta?.postTokenBalances || []) add(b, 1n);
  for (const b of tx.meta?.preTokenBalances || []) add(b, -1n);
  return Object.entries(by).filter(([, x]) => x.raw > 0n).map(([mint, x]) => ({ mint, raw: x.raw, decimals: x.decimals, program: x.program }));
}
/** A gift: { donor, round, name, nameRejected, sol, ore, tokens: [{mint, raw, decimals, program}], nfts: [{mint, program}],
 *  cores: [{asset, collection}], blockTime } | { reject } | { retry }. Only what the RAFFLE WALLET received counts. */
export function inspectGiftTx(tx, to = raffleWallet()) {
  if (!tx) return { retry: "the transaction isn't readable yet" };
  if (tx.meta?.err) return { reject: "the transaction failed" };
  const signers = signersOf(tx), donor = signers[0] || null;
  if (!donor || !ADDR_RE.test(donor)) return { reject: "no signer" };
  if (signers.includes(to)) return { reject: "the raffle wallet's own transaction" };
  const memos = memosOf(tx);
  if (memos.some((m) => m.startsWith(RAFFLE_MEMO))) return { reject: "a raffle burn is not a gift — one kind per transaction" };
  const tags = memos.filter((m) => m.startsWith(GIFT_MEMO));
  if (!tags.length) return { reject: "no ddpot memo — not a gift" };
  if (tags.length > 1) return { reject: "more than one ddpot memo" };
  const mm = /^ddpot:([1-9]\d{0,5})(?::([\s\S]*))?$/.exec(tags[0]);
  if (!mm) return { reject: "bad ddpot memo" };
  const said = mm[2] == null ? null : mm[2].trim(), name = said && GIFT_NAME_RE.test(said) ? said : null;
  const keys = allKeys(tx), i = keys.indexOf(to);
  const dSol = i < 0 ? 0n : B(tx.meta?.postBalances?.[i]) - B(tx.meta?.preBalances?.[i]);
  let ore = 0n;
  const tokens = [], nfts = [];
  for (const g of tokenGains(tx, to)) {
    if (g.mint === ORE_MINT) ore += g.raw;
    else if (g.decimals === 0 && g.raw === 1n) nfts.push({ mint: g.mint, program: g.program });   // decimals 0, amount 1, now the raffle wallet's
    else tokens.push(g);
  }
  const seen = new Set(), cores = [];
  for (const c of coreTransfersOf(tx)) if (c.to === to && ADDR_RE.test(c.asset || "") && !seen.has(c.asset)) { seen.add(c.asset); cores.push({ asset: c.asset, collection: c.collection }); }
  const sol = dSol > 0n ? dSol : 0n;
  if (sol === 0n && ore === 0n && !tokens.length && !nfts.length && !cores.length) return { reject: "nothing was sent to the raffle wallet" };
  if (tokens.length + nfts.length + cores.length > GIFT_MAX_ITEMS) return { reject: `more than ${GIFT_MAX_ITEMS} items in one gift` };
  return { donor, round: Number(mm[1]), name, nameRejected: !!said && !name, sol, ore, tokens, nfts, cores, blockTime: tx.blockTime || null };
}

// ---------- RPC ----------
async function rpcCall(method, params) {
  const r = await fetch(process.env.SOLANA_RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  if (!r.ok) throw new Error(`rpc http ${r.status}`);
  const j = await r.json();
  if (j.error) {
    if (method === "getTransaction" && params?.[1]?.maxSupportedTransactionVersion === 0 && (j.error.code === -32015 || /transaction version/i.test(j.error.message || "")))
      return rpcCall(method, [params[0], { ...params[1], maxSupportedTransactionVersion: 1 }]);
    const e = new Error(j.error.message || method + " failed"); e.code = j.error.code; throw e;
  }
  return j.result;
}
const readTx = (sig) => rpcCall("getTransaction", [sig, { maxSupportedTransactionVersion: 0, encoding: "json", commitment: "confirmed" }]);

const strong = async (store, key) => (await readWithEtag(store, key)).value;
const raffle = () => getStore("raffle"), ticketStore = () => getStore("raffle-tickets"), burnStore = () => getStore("raffle-burns"), giftStore = () => getStore("raffle-gifts");

// ---------- rounds ----------
// The latest COMMITTED round (repairs a commit that crashed between public:<n+1> and "latest", like store-draw-core).
export async function latestRaffleRound() {
  const store = raffle();
  let n = Number((await strong(store, "latest")) || 0);
  const start = n;
  while (await strong(store, "public:" + (n + 1))) n++;
  if (n > start) await casUpdate(store, "latest", (cur) => (Number(cur || 0) >= n ? undefined : n));
  return n;
}
export async function getRafflePublic(round) { return round ? await strong(raffle(), "public:" + round) : null; }
export async function raffleEntries(round) { return round ? await strong(raffle(), "entries:" + round) : null; }
// Tickets always go to the OPEN round: a round is frozen the moment it is committed.
export const raffleTicketRound = async () => (await latestRaffleRound()) + 1;
// A raffle round is being drawn right now → its number, else null (the payout plan waits for it).
export async function raffleBusy() { const n = await latestRaffleRound(); const p = await getRafflePublic(n); return p?.status === "committed" ? n : null; }

// ---------- the pot (one record per round) ----------
const emptyPot = (round) => ({ round, oreRaw: "0", solLamports: "0", reserveLamports: "0", credited: "0", tickets: 0, burns: 0, seeds: [], carriedIn: [], applied: [],
  giftOreRaw: "0", giftSolLamports: "0", donations: 0, gifts: { tokens: {}, nfts: [] } });
const normPot = (p, round) => ({ ...emptyPot(round), ...(p || {}) });
export async function getRafflePot(round) { const { applied, ...p } = normPot(await strong(raffle(), "pot:r" + round), round); return p; }
// id-guarded add (the id is a burn signature, "seed:<id>", "gift:<sig>", "show:<item>:<n>", "carry:r<n>", "rollover:…") —
// a repeat is a no-op. Gifts: giftOre / giftSol say how much of oreRaw / solLamports was given (shown on the page);
// giftItems = bonus tokens and NFTs (giftsFirst: carried ones go in front — they were given earlier).
export async function addToRafflePot(round, { id, oreRaw = 0n, solLamports = 0n, reserveLamports = 0n, credited = 0n, tickets = 0, burns = 0, seed = null, carry = null,
  giftOre = 0n, giftSol = 0n, giftItems = [], giftsFirst = false, donations = 0 }) {
  if (!id) throw new DrawError("pot add without an id", 500);
  const { value } = await casUpdate(raffle(), "pot:r" + round, (cur) => {
    const p = normPot(cur, round);
    if ((p.applied || []).includes(id)) return undefined;
    p.oreRaw = S(B(p.oreRaw) + B(oreRaw)); p.solLamports = S(B(p.solLamports) + B(solLamports));
    p.reserveLamports = S(B(p.reserveLamports) + B(reserveLamports)); p.credited = S(B(p.credited) + B(credited));
    p.tickets += Number(tickets) || 0; p.burns += Number(burns) || 0;
    p.giftOreRaw = S(B(p.giftOreRaw) + B(giftOre)); p.giftSolLamports = S(B(p.giftSolLamports) + B(giftSol)); p.donations = (p.donations || 0) + (Number(donations) || 0);
    if (giftItems.length) p.gifts = mergeGifts(p.gifts, giftItems, giftsFirst);
    if (seed) p.seeds = pushId(p.seeds, seed, 50);
    if (carry) p.carriedIn = pushId(p.carriedIn, carry, 20);
    p.applied = pushId(p.applied, id, 5000); p.updatedAt = Date.now();
    return p;
  });
  return value;
}
// Degen Dojo's own ORE added to the OPEN round's prize (admin: /api/payouts "seed-raffle"). No transfer happens — the
// winners are paid from the Treasury by the owner anyway. `id` makes a double click a no-op.
export async function seedRaffle({ ore, id }) {
  ore = Number(ore);
  if (!(ore > 0) || ore > SEED_ORE_MAX) throw new DrawError(`seed between 0 and ${SEED_ORE_MAX} ORE`, 400);
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(String(id || ""))) throw new DrawError("bad seed id", 400);
  const round = await raffleTicketRound();
  const p = await addToRafflePot(round, { id: "seed:" + id, oreRaw: oreToRaw(ore), seed: { ore, at: Date.now() } });
  return { round, pot: normPot(p, round) };
}

// ---------- tickets ----------
async function addTickets(round, wallet, { id, tickets = 0, lamports = 0n, burns = 0, free = 0 }) {
  const { value } = await casUpdate(ticketStore(), `r${round}:player:${wallet}`, (cur) => {
    const v = cur || { wallet, name: wallet, tickets: 0, lamports: "0", burns: 0, free: 0, ids: [] };
    if ((v.ids || []).includes(id)) return undefined;
    v.tickets += Number(tickets) || 0; v.lamports = S(B(v.lamports) + B(lamports)); v.burns += Number(burns) || 0; v.free += Number(free) || 0;
    v.ids = pushId(v.ids, id, 3000); v.updatedAt = Date.now();
    return v;
  });
  return value;
}
export async function walletTickets(round, wallet) {
  if (!ADDR_RE.test(String(wallet || ""))) return null;
  const v = await strong(ticketStore(), `r${round}:player:${wallet}`);
  return v ? { tickets: v.tickets || 0, burns: v.burns || 0, lamports: v.lamports || "0", free: v.free || 0 } : { tickets: 0, burns: 0, lamports: "0", free: 0 };
}
// No free tickets (owner 2026-10-28: a bot with 1,000 wallets would get 1,000 of them) — tickets come only from burns.

// ---------- crediting a burn ----------
// → the burn:<sig> record { status: "credited" | "rejected" | "pending", … }
async function creditBurn(sig, v, now) {
  const bs = burnStore();
  const T = await raffleTicketRound();
  if (v.round > T) return reject(sig, v, "the memo names a raffle round that hasn't started");
  if (v.blockTime && now - v.blockTime * 1000 > MAX_AGE_MS) return reject(sig, v, "claimed more than two weeks after it landed");
  const { prize, reserve } = splitSent(v.sent);
  await putIfNew(bs, "credited:" + sig, { sig, wallet: v.wallet, round: T, memoRound: v.round, sent: S(v.sent), freed: S(v.freed), credited: S(v.credited),
    tickets: v.tickets, burns: v.burns, prize: S(prize), reserve: S(reserve), blockTime: v.blockTime, at: now });
  return finishCredit(sig, now);
}
// Apply a credited:<sig> marker (idempotent — a crash anywhere is finished by the next call for the same signature)
async function finishCredit(sig, now) {
  const bs = burnStore(), T = await raffleTicketRound();
  let m = await strong(bs, "credited:" + sig);
  if (!m.done) {
    // a credit resumed after its round froze, with nothing written yet → it moves to the open round
    if (m.round < T && (await getRafflePublic(m.round))) {
      const t = await strong(ticketStore(), `r${m.round}:player:${m.wallet}`), p = await strong(raffle(), "pot:r" + m.round);
      if (!(t?.ids || []).includes(sig) && !(p?.applied || []).includes(sig))
        m = (await casUpdate(bs, "credited:" + sig, (c) => (c && !c.done && c.round < T ? { ...c, round: T, moved: m.round } : undefined))).value;
    }
    await addTickets(m.round, m.wallet, { id: sig, tickets: m.tickets, lamports: B(m.credited), burns: m.burns });
    await addToRafflePot(m.round, { id: sig, solLamports: B(m.prize), reserveLamports: B(m.reserve), credited: B(m.credited), tickets: m.tickets, burns: m.burns });
    m = (await casUpdate(bs, "credited:" + sig, (c) => (c && !c.done ? { ...c, done: Date.now() } : undefined))).value;
  }
  const rec = { sig, status: "credited", wallet: m.wallet, round: m.round, tickets: m.tickets, burns: m.burns, sent: m.sent, freed: m.freed, credited: m.credited, at: m.done || now };
  await bs.setJSON("burn:" + sig, rec);
  await bs.delete("pending:" + sig).catch(() => {});
  return rec;
}
async function reject(sig, v, why) {
  const rec = { sig, status: "rejected", why, wallet: v?.wallet || null, at: Date.now() };
  const bs = burnStore();
  await bs.setJSON("burn:" + sig, rec);
  await bs.delete("pending:" + sig).catch(() => {});
  return rec;
}

// Judge one signature now. `post` = a page POSTed it (an unreadable one is queued); the cron passes post=false.
export async function recordBurn(sig, { now = Date.now(), post = true } = {}) {
  sig = String(sig || "").trim();
  if (!SIG_RE.test(sig)) throw new DrawError("bad signature", 400);
  const bs = burnStore();
  const prev = await strong(bs, "burn:" + sig);
  if (prev && prev.status !== "pending") return prev;
  if (await strong(bs, "credited:" + sig)) return finishCredit(sig, now);   // judged already — finish what a crash left
  let tx;
  try { tx = await readTx(sig); } catch (e) { return queue(sig, prev, now, "the network is busy — retrying"); }
  const v = inspectRaffleTx(tx);
  if (v.retry) {
    if (prev && now - (prev.firstAt || now) > UNREADABLE_DROP_MS) { await bs.delete("burn:" + sig).catch(() => {}); await bs.delete("pending:" + sig).catch(() => {}); return { sig, status: "unknown", why: "no node could read this transaction" }; }
    return queue(sig, prev, now, v.retry);
  }
  if (v.reject) {
    // a readable transaction that isn't a raffle burn: refused, and only remembered if someone already queued it
    if (!prev && post) return { sig, status: "rejected", why: v.reject };
    return reject(sig, v, v.reject);
  }
  return creditBurn(sig, v, now);
}
async function queue(sig, prev, now, why) {
  const bs = burnStore();
  const rec = { sig, status: "pending", why, firstAt: prev?.firstAt || now, at: now };
  await bs.setJSON("burn:" + sig, rec);
  await bs.setJSON("pending:" + sig, { at: now });
  return rec;
}
export async function burnStatus(sig) { return SIG_RE.test(String(sig || "")) ? await strong(burnStore(), "burn:" + sig) : null; }

// New ddraffle transactions on the raffle wallet (getSignaturesForAddress carries each tx's memo): queued, so a burn
// whose page was closed before it could POST is still credited. A cursor remembers the newest signature seen.
// Only a backstop (the page POSTs each burn itself), so it runs at most every 10 minutes — Helius free-plan credits
// are tight (owner 2026-10-28: 437k of 1M used), and a per-minute scan alone would be ~1,440 calls a day.
export const DISCOVER_EVERY_MS = 10 * 60 * 1000;
export async function discoverRaffleSigs({ pages = 3, now = Date.now(), minGapMs = DISCOVER_EVERY_MS } = {}) {
  const bs = burnStore(), wallet = raffleWallet();
  const cur = await strong(bs, "cursor");
  if (minGapMs && cur?.at && now - cur.at < minGapMs) return { seen: 0, found: 0, skipped: true };
  let before = null, newest = null, found = 0, seen = 0;
  for (let p = 0; p < pages; p++) {
    const sigs = await rpcCall("getSignaturesForAddress", [wallet, { limit: 100, ...(cur?.sig ? { until: cur.sig } : {}), ...(before ? { before } : {}) }]);
    if (!Array.isArray(sigs) || !sigs.length) break;
    if (!newest) newest = sigs[0].signature;
    for (const x of sigs) {
      seen++;
      const memo = String(x.memo || "");
      if (x.err) continue;
      if (memo.includes(RAFFLE_MEMO)) {
        if (await strong(bs, "burn:" + x.signature)) continue;
        await queue(x.signature, null, now, "found on-chain");
        found++;
      } else if (memo.includes(GIFT_MEMO)) {   // a gift whose page closed before it could report it (same call, no extra RPC)
        if (await strong(giftStore(), "g:" + x.signature)) continue;
        await gqueue(x.signature, null, now, "found on-chain");
        found++;
      }
    }
    if (sigs.length < 100 || !cur?.sig) break;   // first run: only the newest page (never the wallet's whole history)
    before = sigs[sigs.length - 1].signature;
  }
  await bs.setJSON("cursor", { sig: newest || cur?.sig || null, at: now });   // `at` moves on even when nothing is new
  return { seen, found };
}
// verify-cron: discover, then judge the queue within the time budget (random start, so no key starves)
export async function verifyRaffleBurns({ budgetMs = 6000, now = Date.now() } = {}) {
  const t0 = Date.now(), out = { credited: 0, rejected: 0, left: 0, found: 0 };
  if (!process.env.SOLANA_RPC) return out;
  try { out.found = (await discoverRaffleSigs({ now })).found; } catch (e) { out.discoverError = String(e?.message || e).slice(0, 120); }
  const bs = burnStore();
  const keys = (await bs.list({ prefix: "pending:" })).blobs.map((b) => b.key.slice(8));
  const start = keys.length ? Math.floor(Math.random() * keys.length) : 0;
  for (let i = 0; i < keys.length; i++) {
    if (Date.now() - t0 > budgetMs) { out.left = keys.length - i; break; }
    const sig = keys[(start + i) % keys.length];
    try {
      const r = await recordBurn(sig, { now, post: false });
      if (r.status === "credited") out.credited++; else if (r.status === "rejected") out.rejected++;
    } catch { /* retried next minute */ }
  }
  // gifts waiting to be read (a page that couldn't report, or one the wallet scan found)
  const gkeys = (await giftStore().list({ prefix: "gpending:" })).blobs.map((b) => b.key.slice(9));
  for (let i = 0; i < gkeys.length; i++) {
    if (Date.now() - t0 > budgetMs) { out.left += gkeys.length - i; break; }
    try {
      const r = await recordGift(gkeys[i], { now, post: false });
      if (r.status === "credited") out.gifts = (out.gifts || 0) + 1; else if (r.status === "rejected") out.rejected++;
    } catch { /* retried next minute */ }
  }
  return out;
}

// ---------- "Add to the prize": gifts ----------
const safeImg = (u) => { try { const x = new URL(String(u || "")); return x.protocol === "https:" && x.href.length <= 600 ? x.href : ""; } catch { return ""; } };
// DAS facts about donated assets (one getAssetBatch per 100 uncached ids, kept for good): kind, name, image, collection
async function assetInfo(ids, { names = true } = {}) {
  const gs = giftStore(), out = {}, need = [];
  for (const id of [...new Set(ids)]) { const c = await gs.get("asset:" + id, { type: "json" }).catch(() => null); if (c) out[id] = c; else need.push(id); }
  for (let k = 0; k < need.length; k += 100) {
    let res = null;
    try { res = await rpcCall("getAssetBatch", { ids: need.slice(k, k + 100) }); } catch { res = null; }   // unread → the item waits for the owner
    for (const a of res || []) {
      if (!a?.id) continue;
      const md = a.content?.metadata || {}, g = (a.grouping || []).find((x) => x.group_key === "collection");
      const info = { id: a.id, interface: a.interface || null, name: String(md.name || "").trim().slice(0, 80), symbol: String(a.token_info?.symbol || md.symbol || "").trim().slice(0, 16),
        image: safeImg(a.content?.links?.image), collection: g?.group_value || null, compressed: !!a.compression?.compressed };
      out[a.id] = info;
      await gs.setJSON("asset:" + a.id, info).catch(() => {});
    }
  }
  if (names) {   // collection names (cosmetic; the same cache)
    const colls = [...new Set(Object.values(out).map((x) => x.collection).filter(Boolean))];
    if (colls.length) { const ci = await assetInfo(colls, { names: false }); for (const x of Object.values(out)) if (x.collection) x.collectionName = ci[x.collection]?.name || ""; }
  }
  return out;
}
const jupBase = () => String(process.env.JUPITER_BASE || "https://lite-api.jup.ag").replace(/\/+$/, "");
// Jupiter's facts about a token (verified?, symbol, icon, price) — asked at most once a day per mint. null = couldn't ask.
export async function jupToken(mint, now = Date.now()) {
  const gs = giftStore(), k = "jup:" + mint;
  const c = await gs.get(k, { type: "json" }).catch(() => null);
  if (c && now - (c.at || 0) < DAY) return c;
  try {
    const r = await fetch(`${jupBase()}/tokens/v2/search?query=${encodeURIComponent(mint)}`);
    if (!r.ok) throw new Error("http " + r.status);
    const arr = await r.json(), t = (Array.isArray(arr) ? arr : []).find((x) => x?.id === mint) || null;
    const tags = Array.isArray(t?.tags) ? t.tags : [];
    const v = { at: now, found: !!t, verified: !!t && (t.isVerified === true || tags.includes("verified") || tags.includes("strict")),
      symbol: String(t?.symbol || "").slice(0, 16), name: String(t?.name || "").slice(0, 60), icon: safeImg(t?.icon), usdPrice: +t?.usdPrice > 0 ? +t.usdPrice : null };
    await gs.setJSON(k, v).catch(() => {});
    return v;
  } catch { return null; }   // fail closed: the token waits for the owner
}
// Shown now, or waiting for the owner? → { status, why }
async function giftVerdict(it, gift) {
  const gs = giftStore();
  if (gift.approved) return { status: "shown", why: "registered by the owner" };
  if (gift.nameRejected) return { status: "pending", why: "the donor's name didn't pass the check (letters, digits, space, _ and - only)" };
  if (it.kind === "token") {
    if (AUTO_TOKENS.has(it.mint)) return { status: "shown", why: "SKR / USDC" };
    if (await gs.get("trust:mint:" + it.mint)) return { status: "shown", why: "a token you trust" };
    if (it.program === TOKEN22) return { status: "pending", why: "a Token-2022 token — check its extensions before it shows" };
    if (!it.jup) return { status: "pending", why: "Jupiter's token list couldn't be reached" };
    return it.jup.verified ? { status: "shown", why: "verified on Jupiter" } : { status: "pending", why: "not on Jupiter's verified list" };
  }
  if (!it.known) return { status: "pending", why: "couldn't read this NFT's details" };
  if (it.collection && AUTO_COLLECTIONS.has(it.collection)) return { status: "shown", why: "a Degen Dojo / Demon Dojo NFT" };
  if (it.collection && (await gs.get("trust:coll:" + it.collection))) return { status: "shown", why: "a collection you trust" };
  if (await gs.get("trust:mint:" + it.mint)) return { status: "shown", why: "an NFT you trust" };
  return { status: "pending", why: it.collection ? "a collection you haven't trusted yet" : "no verified collection" };
}
// what the pot keeps of an item (the page shows it; the draw hands it out)
const potItem = (it) => (it.kind === "token"
  ? { kind: "token", mint: it.mint, raw: S(it.raw), decimals: Number(it.decimals) || 0, program: it.program || TOKEN, symbol: it.symbol || "", title: it.title || "", image: it.image || "", usdPrice: it.usdPrice ?? null }
  : { id: it.id, kind: it.kind, mint: it.mint, program: it.program || null, collection: it.collection || null, collectionName: it.collectionName || "", title: it.title || "", image: it.image || "",
      donor: it.donor || null, dname: it.dname || null });
// a pot's gifts + more items (tokens add up per mint; NFTs keep donation order — `first` puts them in front: carried ones)
function mergeGifts(g, items, first = false) {
  const out = { tokens: { ...(g?.tokens || {}) }, nfts: [...(g?.nfts || [])] }, add = [];
  for (const raw of items) {
    const it = potItem(raw);
    if (it.kind === "token") { const t = out.tokens[it.mint]; out.tokens[it.mint] = t ? { ...t, raw: S(B(t.raw) + B(it.raw)), usdPrice: it.usdPrice ?? t.usdPrice ?? null } : it; }
    else if (!out.nfts.some((n) => n.mint === it.mint)) add.push(it);
  }
  out.nfts = first ? [...add, ...out.nfts] : [...out.nfts, ...add];
  return out;
}
async function bumpCounts(d) {
  await casUpdate(giftStore(), "counts", (c) => { const v = c || { pending: 0 }; v.pending = Math.max(0, (v.pending || 0) + d); return v; }).catch(() => {});
}

/** Judge one gift signature now (`post` = the page reported it; the cron passes post=false). */
export async function recordGift(sig, { now = Date.now(), post = true } = {}) {
  sig = String(sig || "").trim();
  if (!SIG_RE.test(sig)) throw new DrawError("bad signature", 400);
  const gs = giftStore();
  const prev = await strong(gs, "g:" + sig);
  if (prev && prev.status !== "pending") return prev;
  if (await strong(gs, "gcredited:" + sig)) return finishGift(sig, now);
  let tx;
  try { tx = await readTx(sig); } catch { return gqueue(sig, prev, now, "the network is busy — retrying"); }
  const v = inspectGiftTx(tx);
  if (v.retry) {
    if (prev && now - (prev.firstAt || now) > UNREADABLE_DROP_MS) { await gs.delete("g:" + sig).catch(() => {}); await gs.delete("gpending:" + sig).catch(() => {}); return { sig, status: "unknown", why: "no node could read this transaction" }; }
    return gqueue(sig, prev, now, v.retry);
  }
  if (v.reject) { if (!prev && post) return { sig, status: "rejected", why: v.reject }; return greject(sig, v, v.reject); }
  return creditGift(sig, v, now);
}
async function gqueue(sig, prev, now, why) {
  const gs = giftStore(), rec = { sig, status: "pending", why, firstAt: prev?.firstAt || now, at: now };
  await gs.setJSON("g:" + sig, rec);
  await gs.setJSON("gpending:" + sig, { at: now });
  return rec;
}
async function greject(sig, v, why) {
  const gs = giftStore(), rec = { sig, status: "rejected", why, donor: v?.donor || null, at: Date.now() };
  await gs.setJSON("g:" + sig, rec);
  await gs.delete("gpending:" + sig).catch(() => {});
  return rec;
}
export async function giftStatusOf(sig) { return SIG_RE.test(String(sig || "")) ? await strong(giftStore(), "g:" + sig) : null; }
// Fix what the gift is (DAS + Jupiter) and whether each item shows, in a create-only marker; then apply it.
async function creditGift(sig, v, now, { approved = false, direct = false } = {}) {
  const T = await raffleTicketRound();
  if (!direct) {
    if (v.round > T) return greject(sig, v, "the memo names a raffle round that hasn't started");
    if (v.blockTime && now - v.blockTime * 1000 > MAX_AGE_MS) return greject(sig, v, "reported more than two weeks after it landed");
  }
  const info = await assetInfo([...v.tokens.map((t) => t.mint), ...v.nfts.map((n) => n.mint), ...v.cores.map((c) => c.asset)]);
  const items = [];
  for (const t of v.tokens) items.push({ kind: "token", mint: t.mint, raw: S(t.raw), decimals: t.decimals, program: t.program });
  for (const n of v.nfts) {
    const a = info[n.mint], f = a?.interface;
    if (f === "FungibleToken" || f === "FungibleAsset") { items.push({ kind: "token", mint: n.mint, raw: "1", decimals: 0, program: n.program }); continue; }
    items.push({ kind: f === "ProgrammableNFT" ? "pnft" : "nft", mint: n.mint, program: n.program, known: !!a && /^(V1_NFT|LEGACY_NFT|ProgrammableNFT)$/.test(f || "") });
  }
  for (const c of v.cores) { const a = info[c.asset]; items.push({ kind: "core", mint: c.asset, program: null, collection: c.collection || a?.collection || null, known: !!a }); }
  const gift = { approved, nameRejected: !!v.nameRejected };
  for (let i = 0; i < items.length; i++) {
    const it = items[i], a = info[it.mint];
    it.id = sig + ":" + i;
    it.title = a?.name || ""; it.image = a?.image || ""; it.symbol = a?.symbol || "";
    if (it.kind !== "core") it.collection = it.collection || a?.collection || null;
    it.collectionName = (it.collection && info[it.mint]?.collectionName) || "";
    if (it.kind === "token") {
      it.jup = await jupToken(it.mint, now);
      if (it.jup) { it.symbol = it.jup.symbol || it.symbol; it.title = it.jup.name || it.title; it.image = it.jup.icon || it.image; it.usdPrice = it.jup.usdPrice; }
    }
    Object.assign(it, await giftVerdict(it, gift));
    delete it.jup; delete it.known;
  }
  await putIfNew(giftStore(), "gcredited:" + sig, { sig, donor: v.donor, name: v.name || null, nameRejected: !!v.nameRejected, direct, round: T, memoRound: v.round || null,
    sol: S(v.sol), ore: S(v.ore), items, blockTime: v.blockTime, at: now });
  return finishGift(sig, now);
}
// Apply a gcredited:<sig> marker (idempotent — a crash anywhere is finished by the next call for the same signature)
async function finishGift(sig, now) {
  const gs = giftStore(), T = await raffleTicketRound();
  let m = await strong(gs, "gcredited:" + sig);
  if (!m.done) {
    // resumed after its round froze, with nothing written yet → it moves to the open round
    if (m.round < T && (await getRafflePublic(m.round)) && !((await strong(raffle(), "pot:r" + m.round))?.applied || []).includes("gift:" + sig))
      m = (await casUpdate(gs, "gcredited:" + sig, (c) => (c && !c.done && c.round < T ? { ...c, round: T, moved: c.round } : undefined))).value;
    const shown = m.items.filter((it) => it.status === "shown").map((it) => ({ ...it, donor: m.donor, dname: m.name }));
    await addToRafflePot(m.round, { id: "gift:" + sig, oreRaw: B(m.ore), solLamports: B(m.sol), giftOre: B(m.ore), giftSol: B(m.sol), giftItems: shown, donations: 1 });
    let waiting = 0;
    for (const it of m.items) {
      if (await putIfNew(gs, "item:" + it.id, { ...it, sig, donor: m.donor, dname: m.name, round: it.status === "shown" ? m.round : null, at: m.at, shows: it.status === "shown" ? 1 : 0 }) && it.status === "pending") waiting++;
    }
    if (waiting) await bumpCounts(waiting);
    await casUpdate(gs, "wall", (c) => {
      const list = (c?.list || []).filter((x) => x.sig !== sig);
      list.unshift({ sig, donor: m.donor, name: m.name || null, at: m.at, round: m.round, sol: m.sol, ore: m.ore,
        shown: m.items.filter((it) => it.status === "shown").map((it) => ({ kind: it.kind, symbol: it.symbol, title: it.title, raw: it.raw || "1", decimals: it.decimals || 0 })),
        pending: m.items.filter((it) => it.status === "pending").length });
      return { list: list.slice(0, 40) };
    });
    m = (await casUpdate(gs, "gcredited:" + sig, (c) => (c && !c.done ? { ...c, done: Date.now() } : undefined))).value;
  }
  const rec = { sig, status: "credited", donor: m.donor, name: m.name, round: m.round, sol: m.sol, ore: m.ore, direct: !!m.direct,
    shown: m.items.filter((it) => it.status === "shown").length, pending: m.items.filter((it) => it.status === "pending").length, at: m.done || now };
  await gs.setJSON("g:" + sig, rec);
  await gs.delete("gpending:" + sig).catch(() => {});
  return rec;
}

// ---- "Register a direct gift" (owner 2026-10-28: "send gifts to shamanchef.sol") ----
// A plain send to the raffle wallet carries no ddpot memo, so the owner registers it by signature on /payouts. Refused:
// anything our own wallets signed (so the owner can't turn his own transfers into prizes), anything already booked as
// something else (a raffle burn, a ddpot gift, a coin buy, a sweep fee, a repair, a tip, a marketplace sale — any "dd…"
// memo or marketplace program), and a signature already registered. Registered by the owner = approved: it shows at once.
// No automatic scanning for memo-less sends (Helius credits).
const MARKET_PROGRAMS = new Set(["hausS13jsjafwWwGqZTUQRmWyvyxn9EQpqMwV1PBBmk", "M2mx93ekt1fmXSVkTrUL9xVFHkmME8HTUi5Cyc5aF7K",
  "mmm3XBJg5gk8XJxEKBvdgptZz6SgK4tXvn36sodowMc", "TSWAPaqyCSx2KABk68Shruf4rp7CxcNi8hAsbdwmHbN", "TCMPhJdwDryooaGtiocG1u3xcYbRpiJzb283XfCZsDp"]);   // = store-royalty-core MARKETPLACES
// the Dojo's own wallets (the Reserve classifier's OWN + OURS, the payout plan's reserved wallets)
export function ourWallets() {
  const env = (k, d) => String(process.env[k] || d || "");
  return new Set([raffleWallet(), TREASURY_DEFAULT, env("TREASURY_WALLET"), env("POT_WALLET"), env("ROYALTY_WALLET"),
    "DfaGo3Qht6MC2bqgFCBHgUWjaeXDNmsbE7XjyRKWM3qS", "ED3GMCfoX3XNvavnWADvd6oCsohGg1ukdhv3PaUpvwJe", "HEyazxpV2wxMUvNx53UZUXthRS9Rjsbv7hoHYJNbVedC",
    env("COSIGNER_PUBKEY", "8KUWwAHMb7TL31JGbucCi8YE1ax7njWi46ajVbWnvDqr"), env("OPERATOR_WALLET"), env("OPS_WALLET"),
    "7SSYaNT1iAh2L5WbwmJ4vNeQ2RGnSDumn98k8naFBGDD", "7u53XF8q8Axoy9gtFAqEGeZHCFnEevwRhogrM3qKsmce", "Gus9HWzX9x6oKvWr1Z6GyoV4TBUAPLAhDV5X8He4K5ws", "2nYhMAbfLKtNQhRtJcaWBv5SaFUm8GGjbz7DKowFPpwZ",
    ...env("OWNER_WALLETS", "FTrH7Q3jJ2gkPwvpgR8KDGtmewRbB2RKBeKYaZH7hiNy").split(/[\s,]+/), ...env("TEAM_WALLETS").split(/[\s,]+/)].map((w) => w.trim()).filter((w) => ADDR_RE.test(w)));
}
/** A memo-less send to the raffle wallet: same reading as inspectGiftTx, minus the memo. */
export function inspectDirectGift(tx, to = raffleWallet(), ours = ourWallets()) {
  if (!tx) return { retry: "the transaction isn't readable yet" };
  if (tx.meta?.err) return { reject: "the transaction failed" };
  const signers = signersOf(tx), donor = signers[0] || null;
  if (!donor || !ADDR_RE.test(donor)) return { reject: "no signer" };
  const mine = signers.find((s) => ours.has(s));
  if (mine) return { reject: `signed by one of our own wallets (${mine.slice(0, 4)}…) — your own transfers can't become prizes` };
  const tag = memosOf(tx).find((m) => /^dd/i.test(m));
  if (tag) return { reject: `it carries a Degen Dojo memo ("${tag.slice(0, 24)}") — it's already booked as that` };
  if (allKeys(tx).some((k) => MARKET_PROGRAMS.has(k))) return { reject: "a marketplace transaction (a sale or royalty) — not a gift" };
  const keys = allKeys(tx), i = keys.indexOf(to);
  const dSol = i < 0 ? 0n : B(tx.meta?.postBalances?.[i]) - B(tx.meta?.preBalances?.[i]);
  let ore = 0n;
  const tokens = [], nfts = [];
  for (const g of tokenGains(tx, to)) {
    if (g.mint === ORE_MINT) ore += g.raw; else if (g.decimals === 0 && g.raw === 1n) nfts.push({ mint: g.mint, program: g.program }); else tokens.push(g);
  }
  const seen = new Set(), cores = [];
  for (const c of coreTransfersOf(tx)) if (c.to === to && ADDR_RE.test(c.asset || "") && !seen.has(c.asset)) { seen.add(c.asset); cores.push({ asset: c.asset, collection: c.collection }); }
  const sol = dSol > 0n ? dSol : 0n;
  if (sol === 0n && ore === 0n && !tokens.length && !nfts.length && !cores.length) return { reject: "nothing was sent to the raffle wallet in this transaction" };
  if (tokens.length + nfts.length + cores.length > GIFT_MAX_ITEMS) return { reject: `more than ${GIFT_MAX_ITEMS} items in one transaction` };
  return { donor, round: null, name: null, nameRejected: false, sol, ore, tokens, nfts, cores, blockTime: tx.blockTime || null };
}
/** Admin: register a plain send to the raffle wallet as a gift to the OPEN round (shown at once). */
export async function registerDirectGift(sig, { name = null, now = Date.now() } = {}) {
  sig = String(sig || "").trim();
  if (!SIG_RE.test(sig)) throw new DrawError("that isn't a transaction signature", 400);
  const nm = name == null ? "" : String(name).trim();
  if (nm && !GIFT_NAME_RE.test(nm)) throw new DrawError("the donor name: up to 24 letters, digits, spaces, _ or - (no links)", 400);
  const gs = giftStore();
  const prev = await strong(gs, "g:" + sig);
  if (prev?.status === "credited") throw new DrawError(`already registered (round ${prev.round})`, 409);
  if (await strong(gs, "gcredited:" + sig)) return finishGift(sig, now);
  if (await strong(burnStore(), "burn:" + sig)) throw new DrawError("that's a Burn Raffle burn — it's booked as tickets", 409);
  if (await getStore("coin-purchases").get("buy:" + sig).catch(() => null)) throw new DrawError("that's a game-coin purchase — it's booked as coins", 409);
  let tx;
  try { tx = await readTx(sig); } catch { throw new DrawError("couldn't read the transaction right now — try again in a minute", 503); }
  const v = inspectDirectGift(tx);
  if (v.retry) throw new DrawError("the transaction isn't readable yet — try again in a minute", 409);
  if (v.reject) throw new DrawError("Not registered: " + v.reject, 400);
  // a Degen Dojo / Demon Dojo card sent to the Treasury WITHOUT a ddpot memo is the Keeper's burn claim (store-keeper-core)
  const ids = [...v.nfts.map((n) => n.mint), ...v.cores.map((c) => c.asset)];
  if (ids.length) {
    const info = await assetInfo(ids, { names: false });
    const card = ids.find((id) => AUTO_COLLECTIONS.has(info[id]?.collection || ""));
    if (card) throw new DrawError("Not registered: a Degen Dojo card sent to the Treasury without a ddpot memo is a burn claim (the Keeper's), not a gift", 400);
  }
  v.name = nm || null;
  return creditGift(sig, v, now, { approved: true, direct: true });
}

// ---- the owner's moderation (/payouts "Raffle gifts") ----
const ITEM_ID_RE = /^[1-9A-HJ-NP-Za-km-z]{64,90}:\d{1,3}$/;
async function unshowGift(round, it) {
  await casUpdate(raffle(), "pot:r" + round, (cur) => {
    const p = normPot(cur, round), key = `unshow:${it.id}:${it.shows || 1}`;
    if ((p.applied || []).includes(key)) return undefined;
    const g = { tokens: { ...(p.gifts?.tokens || {}) }, nfts: [...(p.gifts?.nfts || [])] };
    if (it.kind === "token") { const t = g.tokens[it.mint]; if (t) { const r = B(t.raw) - B(it.raw); if (r > 0n) g.tokens[it.mint] = { ...t, raw: S(r) }; else delete g.tokens[it.mint]; } }
    else g.nfts = g.nfts.filter((n) => n.id !== it.id);
    p.gifts = g; p.applied = pushId(p.applied, key, 5000); p.updatedAt = Date.now();
    return p;
  });
}
/** op: "approve" | "trust" (approve + future gifts of this collection / token show at once) | "hide". */
export async function moderateGift(id, op, { now = Date.now() } = {}) {
  id = String(id || "");
  if (!ITEM_ID_RE.test(id)) throw new DrawError("bad gift id", 400);
  if (!["approve", "trust", "hide"].includes(op)) throw new DrawError("op: approve, trust or hide", 400);
  const gs = giftStore();
  const it = await strong(gs, "item:" + id);
  if (!it) throw new DrawError("no such gift", 404);
  if (op === "hide") {
    if (it.status === "hidden") return it;
    let drawn = null;
    if (it.status === "shown") {
      const T = await raffleTicketRound(), open = normPot(await strong(raffle(), "pot:r" + T), T);
      const inOpen = it.kind === "token" ? it.round === T : (open.gifts?.nfts || []).some((n) => n.id === it.id);
      if (inOpen) await unshowGift(T, it);
      else {
        if ((await getRafflePublic(T - 1))?.status === "committed") throw new DrawError("that round is being drawn right now — try again in a few minutes", 409);
        if (it.kind === "token") throw new DrawError("that token is already in a drawn prize — exclude the winner on the payout plan instead", 409);
        drawn = it.round;   // an NFT in a drawn prize: left out of the payout plan (raffleForPlan lists it for you)
      }
    }
    const { value } = await casUpdate(gs, "item:" + id, (c) => (c && c.status !== "hidden" ? { ...c, status: "hidden", wasStatus: c.status, hiddenAt: now, drawnRound: drawn } : undefined));
    if (it.status === "pending") await bumpCounts(-1);
    return value || it;
  }
  if (op === "trust") await gs.setJSON(it.kind !== "token" && it.collection ? "trust:coll:" + it.collection : "trust:mint:" + it.mint, { at: now, by: id, kind: it.kind });
  if (it.status === "shown") return it;
  if (it.status === "hidden" && it.drawnRound) {   // un-hiding an NFT of a drawn prize: back into that winner's payout, never a second pot
    const { value } = await casUpdate(gs, "item:" + id, (c) => (c && c.status === "hidden" ? { ...c, status: "shown", drawnRound: null, approvedAt: now } : undefined));
    return value || it;
  }
  const T = await raffleTicketRound();
  const { value } = await casUpdate(gs, "item:" + id, (c) => (c && c.status !== "shown" ? { ...c, status: "shown", round: T, shows: (c.shows || 0) + 1, approvedAt: now } : undefined));
  const cur = value || (await strong(gs, "item:" + id));
  await addToRafflePot(cur.round, { id: `show:${id}:${cur.shows}`, giftItems: [cur] });
  if (it.status === "pending") await bumpCounts(-1);
  return cur;
}
/** The owner's list: waiting · shown · hidden (newest first) + recent rejected gift transactions + what he trusts. */
export async function listGifts({ limit = 300 } = {}) {
  const gs = giftStore(), out = { pending: [], shown: [], hidden: [], rejected: [], trusted: [] };
  const { blobs } = await gs.list({ prefix: "item:" });
  for (const b of blobs.slice(-limit)) { const it = await gs.get(b.key, { type: "json" }).catch(() => null); if (it && out[it.status]) out[it.status].push(it); }
  for (const k of ["pending", "shown", "hidden"]) out[k].sort((a, b) => (b.at || 0) - (a.at || 0));
  const g = (await gs.list({ prefix: "g:" })).blobs.slice(-200);
  for (const b of g) { const r = await gs.get(b.key, { type: "json" }).catch(() => null); if (r?.status === "rejected") out.rejected.push(r); }
  out.rejected.sort((a, b) => (b.at || 0) - (a.at || 0)); out.rejected = out.rejected.slice(0, 20);
  for (const b of (await gs.list({ prefix: "trust:" })).blobs) out.trusted.push(b.key.slice(6));
  out.round = await raffleTicketRound();
  return out;
}

// ---------- the weekly draw ----------
async function setOnce(store, round, fields) {
  const { value } = await casUpdate(store, "drawing:" + round, (cur) => {
    if (!cur) throw new DrawError("raffle draw state missing", 500);
    const add = Object.fromEntries(Object.entries(fields).filter(([k]) => cur[k] === undefined));
    return Object.keys(add).length ? { ...cur, ...add } : undefined;
  });
  return value;
}
// Commit + freeze the open round: secret seed, its sha256 published; from now on tickets go to the next round.
export async function commitRaffle({ now = Date.now() } = {}) {
  const store = raffle();
  const latest = await latestRaffleRound();
  const open = await getRafflePublic(latest);
  if (open && open.status !== "drawn") throw new DrawError("a raffle round is already being drawn");
  const round = latest + 1;
  await putIfNew(store, "seed:" + round, { seed: randomBytes(32).toString("hex") });
  const { seed } = (await strong(store, "seed:" + round)) || {};
  if (!seed) throw new DrawError("seed missing", 500);
  const pub = { round, kind: "raffle", status: "committed", commitHash: sha256(Buffer.from(seed, "hex")), targetSlot: null, committedAt: now };
  let out = pub;
  if (!(await putIfNew(store, "public:" + round, pub))) {
    const cur = await getRafflePublic(round);
    if (cur?.status !== "committed") throw new DrawError(`raffle round ${round} already exists`, 409);
    out = cur;
  }
  await putIfNew(store, "drawing:" + round, { round, phase: "frozen", frozenAt: now });
  await casUpdate(store, "latest", (cur) => (Number(cur || 0) >= round ? undefined : round));
  return out;
}
// Draw the committed round — resumable, every step stored once (the same state machine as the Dojo Pot's draw):
//   settle → ticket snapshot → entries published → target slot set → its blockhash → pot + prices → winners → carry → drawn
export async function drawRaffle({ now = Date.now() } = {}) {
  const store = raffle();
  const round = await latestRaffleRound();
  let pub = await getRafflePublic(round);
  if (!pub || pub.status !== "committed") throw new DrawError("no raffle round to draw — commit one first");
  const { seed } = (await strong(store, "seed:" + round)) || {};
  if (!seed) throw new DrawError("seed missing", 500);
  await putIfNew(store, "drawing:" + round, { round, phase: "frozen", frozenAt: now });
  let st = await strong(store, "drawing:" + round);
  const wait = st.frozenAt + SETTLE_MS - now;
  if (wait > 0) throw new DrawError(`raffle round ${round} is frozen — tickets are settling; draw again in ${Math.ceil(wait / 1000)} s`, 409);

  // the exact ticket ledger (create-only) — what the pick runs on and what verifyRaffleDraw re-checks
  let snap = await strong(store, "snap:" + round);
  if (!snap) {
    const ts = ticketStore(), records = [];
    for (const b of (await ts.list({ prefix: `r${round}:` })).blobs) {
      const v = await strong(ts, b.key);
      if (v) { const { ids, ...rest } = v; records.push({ key: b.key.slice(`r${round}:`.length), value: rest }); }
    }
    records.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    const e = entriesFromRecords(records);
    await putIfNew(store, "snap:" + round, { round, takenAt: Date.now(), records, entriesHash: entriesHash(e.entries), totalTickets: e.totalTickets });
    snap = await strong(store, "snap:" + round);
  }
  const { entries, totalTickets } = entriesFromRecords(snap.records);

  // entries published, THEN the target slot chosen (its blockhash doesn't exist until after the entries are public)
  await putIfNew(store, "entries:" + round, { round, entriesHash: entriesHash(entries), totalTickets, entries: entries.map((e) => [e.wallet, e.tickets]) });
  if (!pub.targetSlot) {
    const fin = await rpcCall("getSlot", [{ commitment: "finalized" }]);
    await casUpdate(store, "public:" + round, (cur) => (cur && cur.status === "committed" && !cur.targetSlot
      ? { ...cur, targetSlot: fin + SLOTS_AHEAD, entriesSlot: fin, entriesAt: Date.now(), entriesHash: entriesHash(entries), totalTickets, entrants: entries.length } : undefined));
    pub = await getRafflePublic(round);
    if (pub?.status !== "committed") throw new DrawError(`raffle round ${round} was drawn meanwhile — reload`, 409);
  }
  if (!st.blockhash) {
    const fin = await rpcCall("getSlot", [{ commitment: "finalized" }]);
    if (fin < pub.targetSlot) throw new DrawError(`raffle round ${round}: entries frozen (${totalTickets} tickets, ${entries.length} players) — waiting for target slot ${pub.targetSlot} (now ${fin})`, 409);
    const b = await blockhashAtOrAfter(pub.targetSlot);
    st = await setOnce(store, round, { blockSlot: b.slot, blockhash: b.blockhash });
  }
  // the pot (nothing writes into a frozen round's pot after the settle) + the prices that value its SOL in ORE
  if (!st.pot) {
    const p = await getRafflePot(round);
    const [orePx, solPx] = await Promise.all([oreUsd(), solUsd()]);
    if (!(orePx > 0) || !(solPx > 0)) throw new DrawError("no ORE / SOL price right now — draw again shortly", 503);
    st = await setOnce(store, round, { phase: "pot", orePx, solPx,
      pot: { oreRaw: p.oreRaw, solLamports: p.solLamports, reserveLamports: p.reserveLamports, credited: p.credited, tickets: p.tickets, burns: p.burns, seeds: p.seeds, carriedIn: p.carriedIn,
        giftOreRaw: p.giftOreRaw, giftSolLamports: p.giftSolLamports, donations: p.donations, gifts: p.gifts } });
  }
  if (!st.result) {
    const ore = B(st.pot.oreRaw), sol = B(st.pot.solLamports);
    const potOre = potOreOf(ore, sol, st.orePx, st.solPx);
    const pcts = prizeTiers(potOre);
    const picks = pickWinners(seed, st.blockhash, entries, pcts.length);
    const os = splitBy(ore, pcts), ss = splitBy(sol, pcts);
    const ga = allocateGifts(st.pot.gifts, pcts, picks.length);   // bonus tokens by the same %, NFTs one per rank
    const usdOf = (o, s) => +(rawToOre(o) * st.orePx + (Number(s) / 1e9) * st.solPx).toFixed(2);
    const winners = picks.map((w, i) => ({ rank: i + 1, pct: Number(pcts[i]), wallet: w.wallet, tickets: w.tickets, ore: S(os[i]), sol: S(ss[i]), usd: usdOf(os[i], ss[i]),
      ...(ga.ranks[i].tokens.length ? { tokens: ga.ranks[i].tokens } : {}), ...(ga.ranks[i].nfts.length ? { nfts: ga.ranks[i].nfts } : {}) }));
    const carryOre = os.slice(picks.length).reduce((a, b) => a + b, 0n), carrySol = ss.slice(picks.length).reduce((a, b) => a + b, 0n);
    st = await setOnce(store, round, { phase: "result", result: { ...pub, status: "drawn", seed, blockSlot: st.blockSlot, blockhash: st.blockhash,
      pot: { ore: rawToOre(ore), sol: Number(sol) / 1e9, oreRaw: S(ore), solLamports: S(sol), reserveLamports: st.pot.reserveLamports, burns: st.pot.burns, credited: st.pot.credited,
        giftOreRaw: st.pot.giftOreRaw || "0", giftSolLamports: st.pot.giftSolLamports || "0", donations: st.pot.donations || 0, gifts: st.pot.gifts || { tokens: {}, nfts: [] } },
      potOre: +potOre.toFixed(6), potUsd: usdOf(ore, sol), orePx: st.orePx, solPx: st.solPx, tiers: pcts.map(Number), nWinners: pcts.length,
      winners, carry: { oreRaw: S(carryOre), solLamports: S(carrySol), ranks: pcts.slice(picks.length).map((_, i) => picks.length + i + 1), gifts: ga.carry },
      totalTickets, entrants: entries.length, entriesHash: entriesHash(entries), drawnAt: Date.now(), ...(picks.length ? {} : { rolledOver: true }) } });
  }
  // what nobody won (unfilled ranks, or the whole pot when nobody entered; the token dust + extra NFTs) starts the next round's pot — once
  const c = st.result.carry, cg = c.gifts || { tokens: {}, nfts: [] };
  const carryItems = [...Object.entries(cg.tokens || {}).map(([mint, t]) => ({ ...t, kind: "token", mint })), ...(cg.nfts || [])];
  if (B(c.oreRaw) > 0n || B(c.solLamports) > 0n || carryItems.length)
    await addToRafflePot(round + 1, { id: "carry:r" + round, oreRaw: B(c.oreRaw), solLamports: B(c.solLamports), giftItems: carryItems, giftsFirst: true,
      carry: { from: round, oreRaw: c.oreRaw, solLamports: c.solLamports, ...(carryItems.length ? { gifts: carryItems.length } : {}) } });
  await casUpdate(store, "public:" + round, (cur) => (cur && cur.status === "committed" ? st.result : undefined));
  try { const ts = ticketStore(); for (const b of (await ts.list({ prefix: `r${round}:` })).blobs) await ts.delete(b.key); } catch { /* the snapshot keeps them */ }
  return getRafflePublic(round);
}

// Independently re-check a drawn round: commitment, entries-before-slot, the on-chain blockhash, the snapshot, the pick
// and the prize split. → { ok, problems, unchecked }
export async function verifyRaffleDraw(round) {
  const problems = [], unchecked = [];
  const pub = await getRafflePublic(round);
  if (!pub || pub.status !== "drawn") return { ok: false, problems: ["raffle round " + round + " is not drawn"], unchecked };
  if (sha256(Buffer.from(pub.seed || "", "hex")) !== pub.commitHash) problems.push("revealed seed does not match the published commitment");
  if (!(pub.blockSlot >= pub.targetSlot)) problems.push("draw block slot is before the committed target slot");
  if (!(pub.entriesSlot < pub.targetSlot)) problems.push("the entries were published after the target slot was set");
  try {
    const b = await rpcCall("getBlock", [pub.blockSlot, BLOCK]);
    if (!b?.blockhash) unchecked.push("on-chain blockhash (block not returned)");
    else if (b.blockhash !== pub.blockhash) problems.push(`blockhash ${pub.blockhash} is not slot ${pub.blockSlot}'s on-chain hash`);
  } catch (e) { unchecked.push("on-chain blockhash (" + (e.message || e) + ")"); }
  try {
    const first = await firstBlockSlot(pub.targetSlot, pub.blockSlot);
    if (first != null && first !== pub.blockSlot) problems.push(`slot ${first} had a block — the draw should have used it, not slot ${pub.blockSlot}`);
  } catch (e) { unchecked.push("first block after the target slot (" + (e.message || e) + ")"); }
  const snap = await strong(raffle(), "snap:" + round);
  const { entries, totalTickets } = entriesFromRecords(snap?.records || []);
  if (entriesHash(entries) !== pub.entriesHash) problems.push("the ticket snapshot differs from the entries that were drawn");
  const published = await raffleEntries(round);
  if (published && entriesHash((published.entries || []).map(([wallet, tickets]) => ({ wallet, tickets }))) !== pub.entriesHash) problems.push("the published entries list differs from the snapshot that was drawn");
  if (totalTickets !== pub.totalTickets) problems.push(`snapshot tickets ${totalTickets} ≠ drawn total ${pub.totalTickets}`);
  const pcts = prizeTiers(potOreOf(pub.pot?.oreRaw, pub.pot?.solLamports, pub.orePx, pub.solPx));   // exact, not the rounded potOre
  if (pcts.length !== pub.nWinners) problems.push("the number of winners doesn't match the pot's tier");
  const again = pickWinners(pub.seed, pub.blockhash, entries, pcts.length);
  if (again.map((w) => w.wallet).join(",") !== (pub.winners || []).map((w) => w.wallet).join(",")) problems.push("recomputed winners differ from the published winners");
  const os = splitBy(B(pub.pot?.oreRaw), pcts), ss = splitBy(B(pub.pot?.solLamports), pcts);
  (pub.winners || []).forEach((w, i) => { if (w.ore !== S(os[i]) || w.sol !== S(ss[i])) problems.push(`rank ${i + 1}'s prize doesn't match the tier split`); });
  const ga = allocateGifts(pub.pot?.gifts, pcts, (pub.winners || []).length);
  (pub.winners || []).forEach((w, i) => { if (bonusKey(w) !== bonusKey(ga.ranks[i])) problems.push(`rank ${i + 1}'s bonus prizes (gift tokens / NFTs) don't match the split`); });
  return { ok: !problems.length, problems, unchecked };
}

// The payout cron's weekly step (store-fn-payout-cron, before the Dojo Pot's cronTick): commit when this week's draw
// time has passed, then draw once the target slot is final. `week` = lastDrawTime(now) from store-payout-core.
export async function raffleTick({ now = Date.now(), week, catchupMs = 48 * 3600e3 } = {}) {
  const store = raffle();
  const round = await latestRaffleRound();
  const pub = await getRafflePublic(round);
  if (pub?.status === "committed") {
    try { const r = await drawRaffle({ now }); return { step: "raffle-drawn", round, winners: (r?.winners || []).length }; }
    catch (e) { if (e instanceof DrawError) return { step: "raffle-waiting", round, why: e.message }; throw e; }
  }
  if (!(week > 0)) return { step: "raffle-idle", round };
  const state = (await store.get("cycle", { type: "json" })) || {};
  if (pub?.committedAt >= week && state.committedFor !== week) { state.committedFor = week; await store.setJSON("cycle", state); }
  if (state.committedFor !== week && now >= week) {
    if (now - week > catchupMs) { state.committedFor = week; await store.setJSON("cycle", state); return { step: "raffle-skipped-late", week }; }
    const c = await commitRaffle({ now });
    state.committedFor = week; state.lastCommit = { round: c.round, at: now };
    await store.setJSON("cycle", state);
    return { step: "raffle-committed", round: c.round };
  }
  return { step: "raffle-idle", round };
}

// ---------- the payout plan (store-payout-core buildPlan) ----------
// Drawn rounds (the newest 8) whose winners are in no other plan → payees of plan `planRound`. A round is tied to the
// first plan that stores it (planned:r<n>, create-only), so rebuilding that plan keeps it and no other plan ever pays it.
// A winner's gift tokens / NFTs ride along as pay.bonus: [{ kind: "token", mint, raw, decimals, program, symbol } |
// { kind: "nft"|"pnft"|"core", id, mint, raw: "1", program, collection, title }] — sent from the Treasury in the same batch
// (dojo-gift.js builds the transfers; payout-tx.js checks them) and verified per mint / per Core asset. An NFT the owner
// hid after the draw is left out and listed in out.hiddenGifts.
export async function raffleForPlan(planRound) {
  const out = { payees: [], rounds: [], draws: [], hiddenGifts: [] };
  const latest = await latestRaffleRound();
  for (let n = latest; n >= 1 && n > latest - 8; n--) {
    const pub = await getRafflePublic(n);
    if (pub?.status !== "drawn" || !(pub.winners || []).length) continue;
    const mark = await strong(raffle(), "planned:r" + n);
    if (mark && mark.plan !== planRound) continue;
    out.rounds.push(n);
    out.draws.push({ round: n, commitHash: pub.commitHash, seed: pub.seed, blockhash: pub.blockhash, blockSlot: pub.blockSlot, targetSlot: pub.targetSlot,
      totalTickets: pub.totalTickets, entrants: pub.entrants, potOre: pub.potOre, potUsd: pub.potUsd, tiers: pub.tiers, drawnAt: pub.drawnAt });
    for (const w of pub.winners) {
      const bonus = (w.tokens || []).map((t) => ({ kind: "token", mint: t.mint, raw: S(t.raw), decimals: Number(t.decimals) || 0, program: t.program || TOKEN, symbol: t.symbol || "" }));
      for (const x of w.nfts || []) {
        const it = x.id ? await strong(giftStore(), "item:" + x.id) : null;
        if (it?.status === "hidden") { out.hiddenGifts.push({ round: n, rank: w.rank, wallet: w.wallet, id: x.id, mint: x.mint, title: x.title || "" }); continue; }
        bonus.push({ kind: x.kind, id: x.id || null, mint: x.mint, raw: "1", program: x.program || null, collection: x.collection || null, title: x.title || "" });
      }
      out.payees.push({ id: `rf:${n}:${w.wallet}`, kind: "raffle", raffleRound: n, rank: w.rank, pct: w.pct, wallet: w.wallet,
        label: w.wallet, tickets: w.tickets || 0, usd: +(+w.usd || 0).toFixed(2), pay: { ORE: S(w.ore), SKR: "0", SOL: S(w.sol), USDC: "0", ...(bonus.length ? { bonus } : {}) } });
    }
  }
  return out;
}
export async function markRafflePlanned(rounds, planRound) {
  for (const n of rounds || []) await putIfNew(raffle(), "planned:r" + n, { plan: planRound, at: Date.now() });
}
// An excluded raffle winner's share goes back into the OPEN round's pot when the plan is paid (once per payee).
export async function rollbackRafflePrize(planRound, payee) {
  const round = await raffleTicketRound();
  const giftItems = (payee.pay?.bonus || []).map((b) => (b.kind === "token" ? { ...b, kind: "token" } : { ...b, id: b.id || `rollover:${payee.id}:${b.mint}` }));
  return addToRafflePot(round, { id: `rollover:p${planRound}:${payee.id}`, oreRaw: B(payee.pay?.ORE), solLamports: B(payee.pay?.SOL), giftItems, giftsFirst: true,
    carry: { from: "excluded " + payee.id, plan: planRound } });
}

// ---------- the page's view ----------
export async function raffleStatus({ wallet = null } = {}) {
  const latest = await latestRaffleRound(), round = latest + 1;
  const [pot, lastPub, prices] = await Promise.all([getRafflePot(round), getRafflePublic(latest), Promise.all([oreUsd(), solUsd()])]);
  const [orePx, solPx] = prices;
  const ore = rawToOre(pot.oreRaw), sol = Number(B(pot.solLamports)) / 1e9;
  const potOre = potOreOf(pot.oreRaw, pot.solLamports, orePx, solPx);
  const pcts = prizeTiers(potOre);
  let last = lastPub?.status === "drawn" ? lastPub : null;
  if (!last && latest > 1) { const p = await getRafflePublic(latest - 1); if (p?.status === "drawn") last = p; }
  const gs = giftStore(), [wall, counts] = await Promise.all([gs.get("wall", { type: "json" }).catch(() => null), gs.get("counts", { type: "json" }).catch(() => null)]);
  const g = pot.gifts || { tokens: {}, nfts: [] }, short = (a) => (a ? String(a).slice(0, 4) + "…" + String(a).slice(-4) : "");
  const tokens = Object.entries(g.tokens || {}).map(([mint, t]) => {
    const amount = Number(B(t.raw)) / 10 ** (Number(t.decimals) || 0);
    return { mint, symbol: t.symbol || "", title: t.title || "", image: t.image || "", amount, raw: t.raw, decimals: t.decimals, usd: t.usdPrice > 0 ? +(amount * t.usdPrice).toFixed(2) : null };
  });
  return {
    round, wallet: raffleWallet(), memo: RAFFLE_MEMO + round, giftMemo: GIFT_MEMO + round, lamportsPerTicket: LAMPORTS_PER_TICKET, reservePct: Number(RESERVE_PCT),
    drawing: lastPub?.status === "committed" ? latest : null,
    pot: { ore: +ore.toFixed(6), sol: +sol.toFixed(6), potOre: +potOre.toFixed(6), usd: orePx > 0 ? +(potOre * orePx).toFixed(2) : null,
      solBurned: +(Number(B(pot.credited)) / 1e9).toFixed(6), seeded: (pot.seeds || []).reduce((s, x) => s + (+x.ore || 0), 0), carried: (pot.carriedIn || []).length > 0,
      giftSol: +(Number(B(pot.giftSolLamports)) / 1e9).toFixed(6), giftOre: +rawToOre(pot.giftOreRaw).toFixed(6), donations: pot.donations || 0 },
    // bonus prizes on top of the ORE prize (shown items only — anything waiting for review is just counted)
    gifts: { tokens, nfts: (g.nfts || []).map((x) => ({ mint: x.mint, kind: x.kind, title: x.title || "", image: x.image || "", collection: x.collection || null,
      collectionName: x.collectionName || "", by: x.dname || short(x.donor) })), pending: counts?.pending || 0 },
    wall: (wall?.list || []).slice(0, 20).map((w) => ({ sig: w.sig, by: w.name || short(w.donor), at: w.at, round: w.round, sol: +(Number(B(w.sol)) / 1e9).toFixed(6), ore: +rawToOre(w.ore).toFixed(6),
      shown: w.shown || [], pending: w.pending || 0 })),
    tickets: pot.tickets, burns: pot.burns, winners: pcts.length, tiers: pcts.map(Number), nextTierAt: nextTierAt(potOre), orePx: orePx || null, solPx: solPx || null,
    me: wallet ? await walletTickets(round, wallet) : null,
    last: last ? { round: last.round, drawnAt: last.drawnAt, potOre: last.potOre, potUsd: last.potUsd, totalTickets: last.totalTickets, entrants: last.entrants,
      winners: (last.winners || []).map((w) => ({ rank: w.rank, pct: w.pct, wallet: w.wallet, tickets: w.tickets, usd: w.usd,
        bonus: (w.tokens || []).map((t) => ({ symbol: t.symbol || short(t.mint), amount: Number(B(t.raw)) / 10 ** (Number(t.decimals) || 0) })), nfts: (w.nfts || []).map((x) => x.title || short(x.mint)) })),
      rolledOver: !!last.rolledOver } : null,
  };
}
