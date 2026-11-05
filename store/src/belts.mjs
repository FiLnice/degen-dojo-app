// EARN YOUR BELT (owner 2026-11-03): every card's rank. It is the card's BORDER colour and the on-chain trait
// "Belt" (which replaces the old "Condition" trait). The single source of truth — the site, store, games and every
// Keeper/S3 script read these rules from here (the browser copy is injected by the site/store builds).
//
// SIX belts, ranked like real karate belts, highest first (owner 11-03 evening, mockup Downloads/degendojo-belts/belts-6.png):
// Red > Black > Purple > Green > Orange > White. Red = the 42 Framed; Black = the mythic races and the 1/1 characters;
// Purple = the plain Mint; Green = the Mint Demons; Orange = Mint with gold gear; White = PAID, a repaired piece or a claimed
// one (White is the beginner's belt: a fighter starting over). When a card fits two the higher wins, except that a paid card
// is White. THE REPAIR LADDER (owner 2026-11-04): Torn + 0.05 ORE → ALWAYS White (mythics and 1/1s too); a White card paying
// again (CLIMB_ORE) → its own belt: Black (mythic / 1/1), Orange (gold gear), Green (Demon), Purple (a plain fighter; owner
// 2026-11-04: "purple someone can get now if they come back … and then pay"), while the 555 has room (CLIMB). Brown and Blue are gone (owner 11-03: "remove the brown
// border", "if they pay it becomes with white border", "stay at 6").
// TORN (owner 11-03: "torn just stay as images no cards", "normal OG images without being cards"; the trait value is "Torn"
// since 11-04, owner: "Belt : Torn", with "None" kept for the pieces of a RUGD collection): a cracked piece is not a
// card — it shows its plain OG art (S3 degen/img/<mint>.png), no cracks, no border, with the trait Belt "Torn" (NO_BELT, key
// "none"; BELT_BY_NAME reads an old "None" the same). UPDATE 2026-11-04 (owner: "in Degen Dojo there will not be any OG
// images alone", "BELT TORN means they are TORN"): its picture is the TORN CARD (tornUrl: the White card with its ring torn
// and the art cracked, keeper/render_cracked.py), never the plain OG art. It is not in BELTS (the ladder: card borders, Pagoda floors, belt pages); BELT / BELT_BY_NAME know it so lookups
// work. A repair (or a claim) makes it a White card.
// COLOURS (owner 11-03, the agreed sheet Downloads/degendojo-belts/belts-8-from-backgrounds.png): each ring is five shades
// sampled top → bottom down the left edge of one of DD's own backgrounds (`ring`), the thin lines take the middle shade
// (`base`). Black is the grey of its own lines with the gold stitch (no shoji lattice, never gold lines); Green, the Demons'
// belt, is the snake-saliva green from the owner's crop; White is Bright Hell's white with a soft sheen.
// Twins (Degen/Demon pairs) show their own belt like every card — no half and half border (owner 2026-11-03).
// A belt is kept for good: no belt ever cracks (owner 11-03) — crack-batch / crack-stragglers are retired. The only move is
// up: no belt → White, by a repair or a claim.
// `name` is the trait value = the COLOUR, like a real karate belt (owner 11-03: players read "Belt: Black" at once and
// never have to learn what a word means). `title` is the rank shown beside it on legends: "Red belt · Dojocho" (道場長,
// not Sensei, which is a Race), Shuren 修練 = discipline (the Mint that never cracked), Derugged = the paid White.
export const BELTS = [   // highest first; rank 6 (Red) … 1 (White)
  { key: "red",    rank: 6, name: "Red",    title: "Dojocho",  who: "the 42 Framed",              from: "Red High Moon",            ring: ["#c33743", "#c13541", "#bd323d", "#c73b49", "#c93352"], base: "#bd323d", hi: "#c73b49", lo: "#bd323d" },
  { key: "black",  rank: 5, name: "Black",  title: "Master",   who: "Mint mythics + the 1/1s",    from: "its lines' grey + gold stitch", ring: ["#3a3b40", "#3a3b40", "#3a3b40", "#3a3b40", "#3a3b40"], base: "#3a3b40", hi: "#45464b", lo: "#2a2b2f" },
  { key: "purple", rank: 4, name: "Purple", title: "Shuren",   who: "the rest of the 555",        from: "Purple Night",             ring: ["#424072", "#434174", "#444474", "#515182", "#64679b"], base: "#444474", hi: "#64679b", lo: "#424072" },
  { key: "green",  rank: 3, name: "Green",  title: "Demon",    who: "Mint demons",                from: "the snake saliva",         ring: ["#78ea82", "#66cc6c", "#5fc365", "#5aba60", "#4fa64a"], base: "#5fc365", hi: "#78ea82", lo: "#4fa64a" },
  { key: "orange", rank: 2, name: "Orange", title: "Loaded",   who: "Mint with gold gear",        from: "Orange Afternoon",         ring: ["#f68750", "#f6874f", "#f5884d", "#f07b49", "#f07948"], base: "#f5884d", hi: "#f5884d", lo: "#f07948" },
  { key: "white",  rank: 1, name: "White",  title: "Derugged", who: "paid: a repair or a claim",  from: "Bright Hell",              ring: ["#ededed", "#ededed", "#ededed", "#ededed", "#ededed"], base: "#ededed", hi: "#ffffff", lo: "#b2b2b2" },
];
// No belt: the plain OG art, not a card. Not a rung of the ladder (not in BELTS).
export const NO_BELT = { key: "none", rank: 0, name: "Torn", title: "Torn card", who: "torn: a 0.05 ORE repair makes it White", from: "", ring: [], base: "", hi: "", lo: "" };
export const BELT = Object.fromEntries([...BELTS, NO_BELT].map((b) => [b.key, b]));
export const BELT_BY_NAME = { ...Object.fromEntries([...BELTS, NO_BELT].map((b) => [b.name.toLowerCase(), b])), none: NO_BELT };   // "None": the value before 11-04 (and a RUGD piece)
export const beltRank = (key) => (BELT[key] ? BELT[key].rank : 0);   // for games and sorting: higher = senior belt
export const TRAIT = "Belt";
// The Torn card picture (owner 2026-11-04, look 1: the White card, its ring torn, the art cracked): S3 degen/card-cracked/<mint>.png.
// Bump TORN_V with any re-render of them (3c = the 11-03 pictures on the old layout, 3d = the 11-04 ones on the 9e card).
export const TORN_V = "3d";
export const tornUrl = (pub, mint) => `${pub}degen/card-cracked/${mint}.png?v=${TORN_V}`;
export const REPAIR_ORE = 0.05;   // a repair (Torn → White) costs 0.05 ORE per card (owner 2026-11-03, was 0.01)
export const CLIMB_ORE = 0.05;    // the second payment (White → its own belt), owner 2026-11-04 "when they pay again"
// The belts a White card can climb to with the second payment. THE CLIMB WINDOW (owner 2026-11-04): Black + Orange + Green + Purple
// are capped at 555 together (the 42 Red not counted; everyone else in the Dojo is White, 1,080 seats). A climb is open only while it isn't full (store-keeper-core MINT_CAP: live Mint cards + repairs granted) —
// "black and orange can be claimed if someone acts before the 555 are filled"; once full, no more climbs, and a new Demon gets
// Green only if a holder SELLS their belt: the buyer's card takes it, the seller's card becomes White. NOT BUILT yet (the
// second-payment flow and the belt sale); beltOf only knows `climbed`.
export const CLIMB = new Set(["black", "orange", "green", "purple"]);

export const MYTHIC_RACE = /^(gods?|devil|ruggers?|derugger|oni senseis|senseis|mutants|rowdy sensei|pirate)$/i;
export const DEMON_RACE = /^demons?$/i;
// The 1/1 characters (a Character trait value only one card has, owner 11-03) are masters too. Of the 7, only Shigusa Azuma
// wasn't Black by race; Snakey Oleg and BBQ Ben are Torn: White when repaired, Black when they climb. The Framed 1/1s stay Red.
export const ONE_OF_ONE = /^(shigusa azuma|fever azuma|hakari|mao fuzen|melting goro|snakey oleg|bbq ben)$/i;
export const GOLD_GEAR = /gold/i;                                       // the 12 gold/golden gear values (no gold backgrounds exist)

// attrs: [{trait_type, value}] of the card · cracked: the piece is Cracked now (card-states, or its S3 image is the OG art /
// the torn card picture) · paidRepair: the holder PAID to repair it · claimed: a claim piece was bought onto it · climbed: a White
// card paid the second time (CLIMB_ORE). Framed comes from Condition "Framed" (old metadata) or Belt "Red" (new metadata). A paid
// card is White, mythics too (owner 11-04); an existing Belt "White" keeps White until it climbs; Belt "Torn" (or the old "None")
// stays Torn until it is paid. A card that never cracked keeps its own belt (natural: Black / Green / Orange / Purple).
export function beltOf(attrs, { cracked = false, paidRepair = false, claimed = false, climbed = false } = {}) {
  const at = {}; for (const a of attrs || []) at[String(a.trait_type)] = String(a.value);
  const was = BELT_BY_NAME[(at[TRAIT] || "").toLowerCase()]?.key;
  const vals = Object.entries(at).filter(([k]) => k !== TRAIT && k !== "Condition").map(([, v]) => v);
  const framed = at.Condition === "Framed" || was === "red";
  const race = at.Race || "";
  const paid = paidRepair || claimed || was === "white";
  if (framed) return "red";
  if (cracked || (was === "none" && !paid && !climbed)) return "none";
  const own = MYTHIC_RACE.test(race) || ONE_OF_ONE.test(at.Character || "") ? "black" : DEMON_RACE.test(race) ? "green"
    : vals.some((v) => GOLD_GEAR.test(v)) ? "orange" : "purple";
  if (climbed) return CLIMB.has(own) ? own : "white";   // the second payment: its own belt (every fighter has one)
  if (paid) return "white";                             // the first payment (or kept White): White for every fighter
  return own;
}

// border CSS for a belt (the card's padding ring + the two thin rules around the art): the ring runs its five shades top to
// bottom like the background it came from; White has a soft sheen. No belt ("none") is never drawn as a card.
const sheen = (b) => `linear-gradient(150deg,${b.hi} 0%,${b.base} 24%,${b.lo} 55%,${b.base} 82%,${b.hi} 100%)`;
const ringCSS = (b) => `linear-gradient(180deg,${b.ring[0]} 0%,${b.ring[1]} 25%,${b.ring[2]} 50%,${b.ring[3]} 75%,${b.ring[4]} 100%)`;
export const beltFlat = (key) => (key === "white" ? sheen(BELT.white) : ringCSS(BELT[key]));
export const beltBackground = beltFlat;
export const beltRule = (key) => BELT[key].base;   // Black: the same grey as its ring (owner 11-03, option A)
export const beltStitch = (key) => (key === "black" ? "inset 0 0 0 1.2px rgba(232,184,75,.9)" : "");   // black belt's gold embroidery
