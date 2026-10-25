// The Content-Security-Policy both Netlify sites send (store.degendojo.xyz + degendojo.xyz), via their _headers files
// (and the store's function-rendered /nft/<mint> pages, which _headers doesn't reach — store-fn-nft.mjs).
// It tells the browser what our pages may load and talk to: an injected script could not load code from elsewhere,
// nor open a connection (fetch / WebSocket) to an unknown host.
//
// Honest limits (security review 2026-10-23, L8): the pages still use inline <script> blocks and onclick= handlers, so
// 'unsafe-inline' stays for scripts — this CSP is NOT an XSS backstop; escaping at every innerHTML sink is. And img-src
// stays "https:" because the marketplace shows art from any collection's host (S3, Arweave, IPFS gateways, CDNs…), so
// an injected script could still leak data through an image URL. The real protection is the connect-src allow-list.
// ADD A HOST HERE before using a new outside service, or the browser will refuse it.
const base = (scriptExtra) => [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'" + scriptExtra,
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "img-src 'self' data: blob: https:",                                          // NFT art lives on many hosts (S3, Arweave, IPFS, wsrv…)
  "media-src 'self' data: blob: https:",
  "connect-src 'self'" +
    " https://store.degendojo.xyz https://degendojo.xyz" +                      // site ↔ store economy API (Duel, coins)
    " https://degendojo.s3.us-west-1.amazonaws.com" +                           // metadata JSON, card-states.json
    " https://lite-api.jup.ag https://api.jup.ag" +                             // prices + the Get ORE swap
    " https://api.mainnet-beta.solana.com https://solana-rpc.publicnode.com" +  // public RPC fallbacks (draw / Cluck-Fu entropy)
    " https://mainnet.helius-rpc.com" +                                         // /rescue: bring-your-own Helius key
    " wss://relay.damus.io" +                                                   // Seeker Connect (Nostr relay)
    " ws://localhost:* ws://127.0.0.1:*",                                       // Mobile Wallet Adapter (Seed Vault on the phone)
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  // no page embeds an outside site; mwa.js opens the wallet through a hidden frame on Firefox (solana-wallet: link)
  "frame-src 'self' solana-wallet:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",                                                     // no other site may frame ours (clickjacking)
].join("; ");

// degendojo.xyz: the card download uses html2canvas from cdnjs.
export const SITE_CSP = base(" https://cdnjs.cloudflare.com");
// store.degendojo.xyz: loads nothing from cdnjs (security review L8) — no outside script host at all.
export const STORE_CSP = base("");
// old name (site policy) for any script that still imports it
export const CSP = SITE_CSP;
