// Registers the Solana Mobile wallets as Wallet-Standard wallets so the store's wallet-picker
// (which enumerates Wallet-Standard wallets) can connect the Seeker / Saga native wallet.
// Bundled by build.mjs -> ../mwa.js, loaded before wallet-picker.js.
//
// Two entries on Android ("Seeker Connect" only on Seeker-like devices, see looksLikeSeeker):
//  1. "Mobile Wallet Adapter" — the standard MWA local association (Seed Vault over a
//     ws://localhost session). build.mjs patches the library's Local-Network-Access gate so
//     it no longer hangs forever when Chrome never shows its native LNA prompt (the Seeker bug
//     we hit: "Continue to Allow" -> nothing -> no account).
//  2. "Seeker Connect" — Solana Mobile's Seeker web connect: the same MWA protocol carried over
//     a Nostr relay (no localhost, so no Local-Network-Access permission at all), launched via
//     the verified App Link https://connect.solanamobile.com. Solana Mobile's own relay host is
//     gated, so this uses a public Nostr relay; MWA messages are end-to-end encrypted between
//     the page and the wallet, the relay only forwards ciphertext. Override per visit with
//     ?relay=<domain> to try another relay without rebuilding.
import {
  registerMwa,
  createDefaultAuthorizationCache,
  createDefaultChainSelector,
  createDefaultWalletNotFoundHandler,
} from '@solana-mobile/wallet-standard-mobile';
import { registerSeekerConnect } from '@solana-mobile/seeker-connect-wallet-standard';

const DEFAULT_PUBLIC_RELAY = 'relay.damus.io';

// identity.uri MUST be the origin the page is served from, and identity.icon MUST be a relative
// URI resolved against it — the Seed Vault Wallet rejects the authorize call otherwise
// (solana-mobile/mobile-wallet-adapter#1458).
const identity = {
  name: 'Degen Dojo',
  uri: location.origin,
  icon: 'icon-192.png',
};

try {
  registerMwa({
    appIdentity: identity,
    authorizationCache: createDefaultAuthorizationCache(),
    chains: ['solana:mainnet'],
    chainSelector: createDefaultChainSelector(),
    onWalletNotFound: createDefaultWalletNotFoundHandler(),
  });
} catch (e) {
  // non-Android / unsupported context — registration is a no-op there
  console.debug('MWA register skipped:', e && e.message);
}

// URL overrides persist (localStorage) so they survive moving between store pages:
//   ?seekerconnect=1 / =0   force the Seeker Connect option on / off
//   ?relay=<domain>          use a different Nostr relay
function pref(param, storeKey) {
  let v = null;
  try { v = new URLSearchParams(location.search).get(param); } catch (_) {}
  try {
    if (v !== null) localStorage.setItem(storeKey, v);
    else v = localStorage.getItem(storeKey);
  } catch (_) {}
  return v;
}

// Seeker Connect launches through the https App Link connect.solanamobile.com. Android only hands
// that to a Solana Mobile wallet (Seeker/Saga); on any other phone the browser just opens the
// solanamobile.com page and the visitor leaves the store. So only offer it on Seeker-like devices.
async function looksLikeSeeker() {
  const forced = pref('seekerconnect', 'dd_seekerconnect');
  if (forced === '1') return true;
  if (forced === '0') return false;
  try {
    const uad = navigator.userAgentData;
    if (uad && uad.getHighEntropyValues) {
      const { model } = await uad.getHighEntropyValues(['model']);
      console.info('[DD] device model:', model || '(unreported)');
      if (model) return /seeker|saga|solana/i.test(model);
    }
  } catch (_) {}
  return true; // model unknown — offer it; the option is labelled for Seeker
}

(async () => {
  try {
    if (!/android/i.test(navigator.userAgent) || !window.isSecureContext) return;
    if (!(await looksLikeSeeker())) return;
    const relayDomain = pref('relay', 'dd_relay') || DEFAULT_PUBLIC_RELAY;
    registerSeekerConnect({ identity, relayDomain, chain: 'solana:mainnet', associationTimeoutMs: 60000 });
  } catch (e) {
    console.debug('Seeker Connect register skipped:', e && e.message);
  }
})();
