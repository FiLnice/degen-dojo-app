/* Dojo Wallet — the one client bridge to the server-authoritative economy.
 *
 * Every game uses this instead of trusting localStorage. The rule: you sign in
 * with your Solana wallet (a free signature, never a transaction), the SERVER
 * holds your coins (credited only by verified on-chain purchases) and mints your
 * raffle tickets after it recomputes the game's outcome itself. Nothing here can
 * grant a coin or a ticket — it only relays what the backend decides.
 *
 *   const p = await DojoWallet.begin('cluck')      // signs in if needed, debits 1 coin → {playId, commitHash, seed?} or null
 *   const r = await DojoWallet.finishPlay(p.playId, { pick: 3 })  // server verifies → {won, awarded, tickets}
 *   await DojoWallet.signIn()                       // connect (reuses the store's connected wallet) + prove ownership
 *   await DojoWallet.refresh()                      // pull {coins, tickets}
 *   await DojoWallet.claimSeeker()                  // Seeker owners: one free coin per Seeker device
 *   DojoWallet.on(state => renderCoins(state.coins))   // subscribe to changes
 *
 * API base: same-origin by default. If a game is hosted off the store, set
 *   window.DOJO_API = 'https://store.degendojo.xyz'  before this script loads.
 */
(function () {
  if (window.DojoWallet) return;   // loaded by the page AND the shared nav wire — keep the first copy
  var API = (window.DOJO_API || '').replace(/\/$/, '');   // '' = same-origin
  var SES_KEY = 'dojo_session';
  var CREDITS_URL = '/credits';
  var B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

  function b58encode(bytes) {
    var i, j, zeros = 0;
    while (zeros < bytes.length && bytes[zeros] === 0) zeros++;   // leading zero bytes → leading '1's
    var digits = [];
    for (i = zeros; i < bytes.length; i++) {
      var carry = bytes[i];
      for (j = 0; j < digits.length; j++) { carry += digits[j] << 8; digits[j] = carry % 58; carry = (carry / 58) | 0; }
      while (carry) { digits.push(carry % 58); carry = (carry / 58) | 0; }
    }
    var out = '';
    for (i = 0; i < zeros; i++) out += '1';
    for (j = digits.length - 1; j >= 0; j--) out += B58[digits[j]];
    return out;
  }

  function b64(bytes) { var u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), s = ''; for (var i = 0; i < u.length; i++) s += String.fromCharCode(u[i]); return btoa(s); }

  async function api(path, body) {
    var res = await fetch(API + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    var j = {}; try { j = await res.json(); } catch (e) {}
    if (!res.ok) { var err = new Error(j.error || ('request failed (' + res.status + ')')); err.status = res.status; err.body = j; throw err; }
    return j;
  }

  function provider() {
    // Phantom / Solflare / Backpack all inject a Solana provider
    var p = window.solana || window.solflare || window.backpack;
    if (!p) throw new Error('No Solana wallet found. Install Phantom (or Solflare/Backpack) to play.');
    return p;
  }

  // small feedback via the shared coin toast (dojo-credits.js); silent if it isn't on the page
  function say(msg, warn, href) { try { if (window.DojoCredits && DojoCredits.toast) DojoCredits.toast(msg, warn, href); } catch (e) {} }
  function clean(e) { return String((e && e.message) || e || '').replace(/^Error:\s*/, ''); }
  function cancelled(e) { return /cancel|reject|declin|denied|closed/i.test(clean(e)); }

  var listeners = [];
  var signing = null;   // one sign-in at a time (a double-tap must not open two wallet prompts)
  var W = {
    API: API,
    token: null, wallet: null, exp: 0, coins: 0, tickets: 0, wins: 0, plays: 0, grandSlam: false, loaded: false,

    /** True if a non-expired session is loaded. */
    signedIn: function () { return !!(W.token && W.wallet && (!W.exp || W.exp > Date.now())); },

    on: function (fn) { listeners.push(fn); try { fn(W.state()); } catch (e) {} return function () { listeners = listeners.filter(function (x) { return x !== fn; }); }; },
    state: function () { return { wallet: W.wallet, coins: W.coins, tickets: W.tickets, wins: W.wins, plays: W.plays, grandSlam: W.grandSlam, signedIn: W.signedIn(), loaded: W.loaded }; },
    _fire: function () {
      var s = W.state(); listeners.forEach(function (fn) { try { fn(s); } catch (e) {} });
      try { window.dispatchEvent(new Event('dojo-coins-change')); } catch (e) {}   // dojo-credits.js repaints every coin readout
    },

    /** Connect the wallet (reusing the store's connected one) and prove ownership by signing a
     *  server nonce — one free signature, good for 12h. */
    signIn: function () {
      if (signing) return signing;
      signing = (async function () {
        var a = window.DOJO_WALLET && window.DOJO_WALLET.signMessage ? window.DOJO_WALLET : null;   // the nav's live connection
        if (!a && window.DojoWalletPicker) {
          // Wallet Standard picker (official icons: Phantom / Solflare / Backpack / Jupiter). Hand the
          // new connection to the store nav so its button shows it and every page shares it.
          a = await DojoWalletPicker.pick();
          if (window.dojoNavSetWallet) window.dojoNavSetWallet(a);
          else { window.DOJO_WALLET = a; try { window.dispatchEvent(new Event('dojo-wallet-change')); } catch (e) {} }
        }
        if (!a) { var p = provider(); var resp = await p.connect(); a = { pubkey: (p.publicKey || resp.publicKey).toString(), signMessage: function (b) { return p.signMessage(b, 'utf8').then(function (s) { return { signature: s.signature || s }; }); } }; }
        W._adapter = a;
        var pubkey = a.pubkey;
        // Wallets with Sign-In With Solana (solana:signIn) sign the server's fields themselves and check the domain;
        // the others sign the same text with signMessage. If the wallet built a text the server can't match, sign
        // once more the plain way (fresh nonce). The nonce travels with verify (the server keys it by nonce).
        var v = null;
        for (var attempt = 0; attempt < 2 && !v; attempt++) {
          var n = await api('/api/auth', { action: 'nonce', wallet: pubkey });
          var body = { action: 'verify', wallet: pubkey, nonce: n.nonce };
          var siws = null;
          if (attempt === 0 && a.signIn && n.siws) {
            try { siws = await a.signIn(n.siws); } catch (e) { if (cancelled(e)) throw e; siws = null; }
          }
          var sig;
          if (siws) { sig = siws.signature; body.signedMessage = b64(siws.signedMessage); }
          else sig = (await a.signMessage(new TextEncoder().encode(n.message))).signature;   // Uint8Array
          body.signature = b58encode(sig instanceof Uint8Array ? sig : new Uint8Array(sig));
          try { v = await api('/api/auth', body); }
          catch (e) { if (!(siws && e.body && e.body.siwsMismatch)) throw e; }
        }
        W.token = v.token; W.wallet = v.wallet; W.exp = v.exp || 0;
        try { localStorage.setItem(SES_KEY, JSON.stringify({ token: v.token, wallet: v.wallet, exp: v.exp })); } catch (e) {}
        await W.refresh();
        return W.state();
      })();
      signing.then(function () { signing = null; }, function () { signing = null; });
      return signing;
    },

    /** Drop the game session (the wallet connection itself is the nav's business). */
    signOut: function () { W.token = null; W.wallet = null; W.exp = 0; W.coins = 0; W.tickets = 0; W.wins = 0; W.plays = 0; W.grandSlam = false; W.loaded = false; try { localStorage.removeItem(SES_KEY); } catch (e) {} W._fire(); },

    /** Pull the current coin + ticket balance from the server. */
    refresh: async function () {
      if (!W.signedIn()) return W.state();
      try {
        var m = await api('/api/play', { action: 'me', token: W.token });
        W.coins = m.coins; W.tickets = m.tickets; W.wins = m.wins; W.plays = m.plays; W.grandSlam = m.grandSlam; W.loaded = true;
      } catch (e) { if (e.status === 401) W.signOut(); throw e; }
      W._fire(); return W.state();
    },

    /** Begin a paid play: debits 1 coin server-side, commits the outcome seed.
     *  `extra` carries per-game choices locked at start (Dojo Flip: {stat, mode}). */
    startPlay: async function (game, extra) {
      if (!W.signedIn()) throw new Error('Sign in to play.');
      var body = Object.assign({}, extra || {}, { action: 'start', token: W.token, game: game });
      var s;
      try { s = await api('/api/play', body); }
      catch (e) { if (e.status === 402 && e.body && e.body.coins != null) { W.coins = e.body.coins; W._fire(); } throw e; }
      W.coins = s.coins; W._fire();
      return s;   // { playId, commitHash, seed? }
    },

    /** The store's play button: make sure the player is signed in (connect + one signature if
     *  needed), then debit 1 server coin. Resolves the start record, or null when the player
     *  backed out or is out of coins — that case is already explained with a toast. */
    begin: async function (game, extra) {
      try {
        if (!W.signedIn()) { say('Sign in with your wallet to play — one free signature, good for 12h'); await W.signIn(); }
        try { return await W.startPlay(game, extra); }
        catch (e) {
          if (e.status !== 401) throw e;
          W.signOut(); await W.signIn();             // session expired → sign in once more, retry once
          return await W.startPlay(game, extra);
        }
      } catch (e) {
        if (e && e.status === 402) say('Out of coins — tap here to buy more 🪙 (free practice: degendojo.xyz/play)', true, CREDITS_URL);
        else if (!cancelled(e)) say(clean(e) || 'Could not start the game', true);
        return null;
      }
    },

    /** Finish a play: the server recomputes the outcome and mints tickets. */
    finishPlay: async function (playId, submission) {
      if (!W.signedIn()) throw new Error('Sign in to play.');
      var body = Object.assign({}, submission || {}, { action: 'finish', token: W.token, playId: playId });
      var r = await api('/api/play', body);
      W.refresh().catch(function () {});
      return r;   // { won, awarded, grandSlam, tickets, seed, winUnverified, winner? }
    },

    /** Seeker owners: claim the one free coin for this Seeker (checked on-chain by the server —
     *  the wallet must hold a Seeker Genesis Token). Resolves {ok, message, coins?}. */
    claimSeeker: async function () {
      try {
        if (!W.signedIn()) await W.signIn();
        var r = await api('/api/play', { action: 'seeker', token: W.token });
        W.coins = r.coins; W.loaded = true; W._fire();
        return { ok: true, message: '🎉 +' + r.claimed + ' free coin claimed — thanks for playing on Seeker!', coins: r.coins };
      } catch (e) {
        if (e && e.status === 401) { W.signOut(); return { ok: false, message: 'Your session expired — tap again to sign in.' }; }
        if (cancelled(e)) return { ok: false, message: 'Sign-in cancelled.' };
        return { ok: false, already: !!(e.body && e.body.already), noSeeker: !!(e.body && e.body.noSeeker), message: clean(e) || 'Could not claim — try again.' };
      }
    },
  };

  // The session belongs to ONE wallet: if the store's connected wallet changes or disconnects,
  // drop the session so coins are never shown/spent for a wallet that isn't connected.
  window.addEventListener('dojo-wallet-change', function () {
    var a = window.DOJO_WALLET;
    if (W.wallet && (!a || a.pubkey !== W.wallet)) W.signOut();
  });

  // restore a saved session on load
  try {
    var saved = JSON.parse(localStorage.getItem(SES_KEY) || 'null');
    if (saved && saved.exp > Date.now()) { W.token = saved.token; W.wallet = saved.wallet; W.exp = saved.exp; W.refresh().catch(function () {}); }
    else if (saved) localStorage.removeItem(SES_KEY);
  } catch (e) {}

  window.DojoWallet = W;
})();
