// What counts as a Degen Dojo NFT — one rule for every surface (listing index, co-signer, resolver, /nft pages).
// GENUINE = in one of our verified on-chain collections. DAS only lists a collection in `grouping` once it is
// VERIFIED, and verifying needs our update authority's signature — so nobody else can make one.
// LOOK-ALIKE = not genuine, but borrowing our name, our collection name, our creator wallets or our artwork
// (S3 / degendojo.xyz). Look-alikes are never listed, shown, priced as Degens, or co-signed.
// The browser pages carry a copy of this rule (store-template.html / dd-case.js / shelf-mockup.html).
import { collectionOf } from "./store-min-core.mjs";

export const DOJO_COLLECTIONS = {
  "2m9DupVeheZ5vfuXZxqV3KSQ7HnVDk2tG6ouH1ZnLwYb": "Degen Dojo",
  WyUy9qjJekjqTAYGanANjhtviwgu1uhCkXx1uas8fWb: "Demon Dojo",
  dgd6We3oS4M5LSVzT6Ep39wwVpjLC336tCpyPZkLAHx: "TETO",
};
// creator / royalty wallets that appear on genuine Degens (anyone can list them UNVERIFIED on a fake).
// TRUSTED when verified (verifying needs the wallet's signature): the original creator, the authority, the Reserve.
const OUR_CREATORS = new Set(["HEyazxpV2wxMUvNx53UZUXthRS9Rjsbv7hoHYJNbVedC", "DoJoE6b8Lbb1t8qcdm4qDRXLS7RvadZo9Rfz8xq2VgLx", "DfaGo3Qht6MC2bqgFCBHgUWjaeXDNmsbE7XjyRKWM3qS", "5w55F58ia3H71QjBD9bYvNQF2DcNu8K3AfJj9A4WMuWp"]);
// RETIRED wallets (ED3GMC, the old shamanchef.sol wallet — the name now resolves to the Treasury 5w55; its old key may be out there): never proof of "ours", only a look-alike mark.
const RETIRED_CREATORS = new Set(["ED3GMCfoX3XNvavnWADvd6oCsohGg1ukdhv3PaUpvwJe"]);
const OUR_NAMES = /degen\s*dojo|demon\s*dojo|oni\s*sensei/i;

/** "Degen Dojo" | "Demon Dojo" | "TETO" for a genuine NFT, else null. */
export const dojoOf = (asset) => DOJO_COLLECTIONS[collectionOf(asset)] || null;

const ourHost = (u) => { try { return /degendojo/i.test(new URL(u).hostname); } catch { return false; } };

/** Ours = in our verified collections, OR carrying one of our creator wallets as a VERIFIED creator (verifying a
 *  creator needs that wallet's signature) — covers our own pieces outside the 3 collections (RIP stones, DAFAKK…). */
export const isOurs = (asset) => !!(dojoOf(asset) || (asset?.creators || []).some((x) => x.verified && OUR_CREATORS.has(x.address)));

/** true when an NFT that is NOT ours copies our name, collection name, creator wallets or artwork. */
export function isLookalike(asset) {
  if (!asset || isOurs(asset)) return false;
  const c = asset.content || {};
  const collName = (asset.grouping || []).find((g) => g.group_key === "collection")?.collection_metadata?.name || "";
  if (OUR_NAMES.test(c.metadata?.name || "") || OUR_NAMES.test(collName)) return true;
  if ((asset.creators || []).some((x) => OUR_CREATORS.has(x.address) || RETIRED_CREATORS.has(x.address))) return true;
  return [c.links?.image, c.json_uri, ...(c.files || []).map((f) => f.uri)].filter(Boolean).some(ourHost);
}
