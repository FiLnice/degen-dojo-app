// JPEG DOJO data (owner idea 2026-11-04, page asked for 2026-11-05 "its own page … fun and creative"):
// the unclaimed designs (claim-data.json, the pool that never got an NFT) are "just JPEGs". Anyone can bring one into
// Degen Dojo: pay its price in ORE and a Rugged Dojo piece they hold takes this fighter's art + stats + traits and walks
// back into Degen Dojo as a White belt card (S3 at once, the collection move in the owner's daily DfaGo3 batch).
//
//   node scripts/build-jpeg-dojo.mjs            → scripts/jpeg-dojo.json (page data) + scripts/jpeg-pool.json (server price list)
//   node scripts/build-jpeg-dojo.mjs --live     also checks the pool against the LIVE Degen Dojo + Rugged Dojo collections (DAS,
//                                               HELIUS_RPC from .env.local, ~5 calls) and drops any design that is on a live NFT
// Nothing is uploaded. build-store-deploy copies both files into the store zip.
import { readFileSync, writeFileSync } from "fs";
import { renameAttrs } from "./trait-renames.mjs";
import { beltOf, BELT } from "./belts.mjs";

const ROOT = "C:/Users/sazei/Documents/DEGEN DOJO/BULKITOR/bulkitor";
const S = `${ROOT}/scripts`;
const read = (f) => JSON.parse(readFileSync(`${S}/${f}`, "utf8"));
export const ORE_PER_FUEL = 0.15;                                     // the claim price since 2026-10-31: 0.15 ORE per burn point
export const priceOf = (b) => +(b * ORE_PER_FUEL).toFixed(2);          // 2 → 0.3 ORE … 15 → 2.25 ORE
const DD = "2m9DupVeheZ5vfuXZxqV3KSQ7HnVDk2tG6ouH1ZnLwYb", RD = "dgd6We3oS4M5LSVzT6Ep39wwVpjLC336tCpyPZkLAHx";
const VISIBLE = ["Weapon", "Clothing", "Hair", "Glasses", "Accessories", "Background"];

const pool = read("claim-data.json");
const taken = new Set(read("rugged-taken.json").ids);
const degStats = read("unclaimed-degen-stats.json"), demStats = read("demon-stats-ready.json").unclaimed;
const tidy = (v) => String(v ?? "").trim();

let items = [];
for (const x of pool) {
  if (taken.has(x.id)) continue;
  const n = +x.id.split("_")[1];
  const st = (x.k === "d" ? demStats : degStats)[String(n)];
  if (!st) throw new Error(`no stats for ${x.id}`);
  const attrs = renameAttrs(Object.entries(x.t).map(([trait_type, value]) => ({ trait_type, value: tidy(value) })));
  const t = Object.fromEntries(attrs.map((a) => [a.trait_type, a.value]));
  const own = beltOf(attrs);
  items.push({ id: x.id, raw: x.t, b0: x.b, k: x.k === "d" ? "d" : "g", no: n, n: tidy(t.Character || x.n), b: x.b, p: priceOf(x.b), r: x.r,
    s: [st.A, st.D, st.H, st.S], m: st.move || "", t, own: BELT[own]?.name || "" });
}

if (process.argv.includes("--live")) {
  const env = {}; for (const l of readFileSync(`${ROOT}/.env.local`, "utf8").split(/\r?\n/)) { const m = l.match(/^([A-Z_0-9]+)=(.*)$/); if (m) env[m[1]] = m[2].trim().replace(/^"|"$/g, ""); }
  const rpc = async (method, params) => { const r = await fetch(env.HELIUS_RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }); const j = await r.json(); if (j.error) throw new Error(j.error.message); return j.result; };
  // the face is a layer too: Character (Face on Rugged Dojo pieces). Same 6 traits + a different face = a different picture.
  const face = (attrs) => tidy(attrs.find((a) => a.trait_type === "Character" || a.trait_type === "Face")?.value).toLowerCase();
  const fp = (attrs, demon) => (demon ? "d|" : "g|") + VISIBLE.map((k) => tidy(attrs.find((a) => a.trait_type === k)?.value).toLowerCase()).join("|") + "|" + face(attrs);
  const live = new Set(); let count = { [DD]: 0, [RD]: 0 };
  for (const coll of [DD, RD]) for (let page = 1; ; page++) {
    const r = await rpc("getAssetsByGroup", { groupKey: "collection", groupValue: coll, page, limit: 1000 });
    for (const a of r.items) {
      if (a.burnt) continue; count[coll]++;
      const attrs = renameAttrs((a.content?.metadata?.attributes || []).map((x) => ({ trait_type: x.trait_type, value: tidy(x.value) })));
      const race = String(attrs.find((x) => x.trait_type === "Race" || x.trait_type === "Body")?.value || "").toLowerCase();
      live.add(fp(attrs, race.startsWith("demon")));
    }
    if (r.items.length < 1000) break;
  }
  const before = items.length;
  const clash = items.filter((x) => live.has(fp(Object.entries(x.t).map(([trait_type, value]) => ({ trait_type, value })), x.k === "d")));
  items = items.filter((x) => !clash.includes(x));
  console.log(`live check: Degen Dojo ${count[DD]} · Rugged Dojo ${count[RD]} → ${clash.length} of ${before} designs share form + face + all 6 traits with a live NFT${clash.length ? " (dropped: " + clash.map((x) => x.id).join(", ") + ")" : ""}`);
  writeFileSync(`${S}/jpeg-dojo-live.json`, JSON.stringify({ at: new Date().toISOString(), dd: count[DD], rd: count[RD], dropped: clash.map((x) => x.id) }));
}

// ── Bounty (owner 2026-11-05: "gold accessories should be more than no gold … gold weapons more … reshape according to
//    how rare something is, using the current system as a reference"). Fuel → price stays 0.15 ORE per point.
//    1. the CURRENT rule is the base (build-claim-export.mjs cost(): hand-priced traits, gold weapon 8, gold gear 5, floor 2),
//       now also counting gold in Hair (Golden Kasa Fisherman was at the floor)
//    2. +2 for every premium trait beyond the first (gold weapon + gold robe used to cost the same as the weapon alone)
//    3. rarity: +2 in the rarest 2% of the wall, +1 in the rarest 10% (trait-frequency rank, recomputed on this wall)
//    4. tiers never overlap: plain fighters stay below gold gear (max 4), gold-gear fighters below gold weapons (max 7)
const WEAPON_COST = { "Poop Cleaner Hoe": 13, "Shaman Soup": 10, "Mr. Rumi The Rat": 5,
  "Shaman Skull Staff": 4, "Tekko-Kagi Claws": 4, "Runed Yumi": 4,
  "Katana": 5, "Enchanted Snake": 5, "Wooden Warhammer": 5,
  "Golden Katana": 10, "Golden Warhammer": 10, "Golden Snake": 10 };          // same table as build-claim-export.mjs
const TRAIT_COST = { "Golden Monk Robes": 15, "Black Iron Tosei Gusoku": 10,
  "Rainbow Kimono": 3, "Tatami Tosei Gusoku": 3, "Loose Parasol Kimono": 3, "Warlock Wannabe": 3,
  "Kung Fu Beetle": 10, "Golden Kabuto": 10, "Wise Greatness": 4 };             // same table as build-claim-export.mjs
const goldish = (v) => /gold/i.test(String(v || ""));
{ // rarity rank on the wall (same method as the claim export: sum of log(N / count) over the 6 visible traits)
  const freq = {}; for (const it of items) for (const k of VISIBLE) { const key = k + "=" + tidy(it.raw[k]); freq[key] = (freq[key] || 0) + 1; }
  for (const it of items) it._s = VISIBLE.reduce((s, k) => s + Math.log(items.length / freq[k + "=" + tidy(it.raw[k])]), 0);
  [...items].sort((a, b) => b._s - a._s || a.id.localeCompare(b.id)).forEach((it, i) => { it.r = i + 1; delete it._s; });
}
export function fuelOf(raw, r, N) {
  const prem = [];                                                   // every premium trait this fighter carries
  const w = tidy(raw.Weapon);
  if (WEAPON_COST[w]) prem.push({ c: WEAPON_COST[w], weapon: WEAPON_COST[w] >= 8 }); else if (goldish(w)) prem.push({ c: 8, weapon: true });
  for (const k of ["Accessories", "Clothing", "Glasses", "Hair"]) { const v = tidy(raw[k]);
    if (TRAIT_COST[v]) prem.push({ c: TRAIT_COST[v] }); else if (goldish(v)) prem.push({ c: 5 }); }
  if (TRAIT_COST[tidy(raw.Background)]) prem.push({ c: TRAIT_COST[tidy(raw.Background)] });
  prem.sort((a, b) => b.c - a.c);
  const base = prem.length ? Math.max(2, prem[0].c) : 2;
  const extra = 2 * Math.max(0, prem.filter((x) => x.c >= 3).length - 1);
  const bonus = r <= N * 0.02 ? 2 : r <= N * 0.10 ? 1 : 0;
  let f = base + extra + bonus;
  if (base < 5) f = Math.min(f, 4);                                  // plain stays below gold gear
  else if (base < 8 && !prem.some((x) => x.weapon)) f = Math.min(f, 7); // gold gear stays below gold weapons
  return f;
}
{ const N = items.length, moved = {};
  for (const it of items) { it.b = fuelOf(it.raw, it.r, N); it.p = priceOf(it.b); const k = `${priceOf(it.b0)} → ${it.p}`; moved[k] = (moved[k] || 0) + 1; }
  console.log("bounty changes (old ORE → new ORE: fighters):");
  for (const [k, v] of Object.entries(moved).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(14)} ${v}`);
  for (const it of items) { delete it.raw; delete it.b0; }
}
items.sort((a, b) => a.r - b.r);
writeFileSync(`${S}/jpeg-dojo.json`, JSON.stringify(items));
// the server's list: design id → price in raw ORE (11 decimals) — the only thing the payment check trusts
writeFileSync(`${S}/jpeg-pool.json`, JSON.stringify(Object.fromEntries(items.map((x) => [x.id, String(BigInt(Math.round(x.p * 100)) * 10n ** 9n)]))));
const by = (f) => items.reduce((o, x) => ((o[f(x)] = (o[f(x)] || 0) + 1), o), {});
console.log(`jpeg-dojo.json: ${items.length} fighters (${by((x) => (x.k === "d" ? "Demons" : "Degens")).Degens} Degens, ${by((x) => (x.k === "d" ? "Demons" : "Degens")).Demons} Demons) · prices ${JSON.stringify(by((x) => x.p + " ORE"))}`);
