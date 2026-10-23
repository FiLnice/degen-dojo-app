// The Content-Security-Policy both Netlify sites send (store.degendojo.xyz + degendojo.xyz), via their _headers files.
// It tells the browser what our pages may load and talk to. If a script were ever slipped into a page (a booby-trapped
// NFT name, a hacked outside script), it could not load code from elsewhere or send a wallet's data to an unknown host.
//
// The pages still use inline <script> blocks and onclick= handlers, so 'unsafe-inline' stays for scripts; the real
// protection here is the allow-lists: scripts only from us + cdnjs (html2canvas), network calls only to the hosts below.
// ADD A HOST HERE before using a new outside service, or the browser will refuse it.
export const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com",            // cdnjs: html2canvas (site's card download)
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
  "frame-src 'self' https:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",                                                     // no other site may frame ours (clickjacking)
].join("; ");
