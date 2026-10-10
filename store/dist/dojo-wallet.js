/* Dojo Wallet — the one client bridge to the server-authoritative economy.
 *
 * Every game uses this instead of trusting localStorage. The rule: you sign in
 * with your Solana wallet (a free signature, never a transaction), the SERVER
 * holds your coins (credited only by verified on-chain purchases) and mints your
 * raffle tickets after it recomputes the game's outcome itself. Nothing here can
 * grant a coin or a ticket — it only relays what the backend decides.
 *
 *   await DojoWallet.signIn()                 // connect + prove wallet ownership
 *   await DojoWallet.refresh()                // pull {coins, tickets}
 *   const p = await DojoWallet.startPlay('cluck')   // debits 1 coin, returns {playId, commitHash, seed?}
 *   const r = await DojoWallet.finishPlay(p.playId, { pick: 3 })  // server verifies → {won, awarded, tickets}
 *   DojoWallet.on(state => renderCoins(state.coins))   // subscribe to changes
 *
 * API base: same-origin by default. If a game is hosted off the store, set
 *   window.DOJO_API = 'https://store.degendojo.xyz'  before this script loads.
 */
(function () {
  var API = (window.DOJO_API || '').replace(/\/$/, '');   // '' = same-origin
  var SES_KEY = 'dojo_session';
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

  async function api(path, body) {
    var res = await fetch(API + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    var j = {}; try { j = await res.json(); } catch (e) {}
    if (!res.ok) throw new Error(j.error || ('request failed (' + res.status + ')'));
    return j;
  }

  function provider() {
    // Phantom / Solflare / Backpack all inject a Solana provider
    var p = window.solana || window.solflare || window.backpack;
    if (!p) throw new Error('No Solana wallet found. Install Phantom (or Solflare/Backpack) to play.');
    return p;
  }

  var listeners = [];
  var W = {
    API: API,
    token: null, wallet: null, coins: 0, tickets: 0, wins: 0, plays: 0, grandSlam: false,

    /** True if a non-expired session is loaded. */
    signedIn: function () { return !!(W.token && W.wallet); },

    on: function (fn) { listeners.push(fn); try { fn(W.state()); } catch (e) {} return function () { listeners = listeners.filter(function (x) { return x !== fn; }); }; },
    state: function () { return { wallet: W.wallet, coins: W.coins, tickets: W.tickets, wins: W.wins, plays: W.plays, grandSlam: W.grandSlam, signedIn: W.signedIn() }; },
    _fire: function () { var s = W.state(); listeners.forEach(function (fn) { try { fn(s); } catch (e) {} }); },

    /** Connect the wallet and prove ownership by signing a server nonce. */
    signIn: async function () {
      // Wallet Standard picker (official icons: Phantom / Solflare / Backpack / Jupiter). Falls
      // back to the legacy injected provider if the picker script isn't present for some reason.
      var a;
      if (window.DojoWalletPicker) { a = W._adapter = await DojoWalletPicker.pick(); }
      else { var p = provider(); var resp = await p.connect(); a = { pubkey: (p.publicKey || resp.publicKey).toString(), signMessage: function (b) { return p.signMessage(b, 'utf8').then(function (s) { return { signature: s.signature || s }; }); } }; }
      var pubkey = a.pubkey;
      var n = await api('/api/auth', { action: 'nonce', wallet: pubkey });
      var msgBytes = new TextEncoder().encode(n.message);
      var signed = await a.signMessage(msgBytes);
      var sig = signed.signature;                 // Uint8Array
      var sigB58 = b58encode(sig instanceof Uint8Array ? sig : new Uint8Array(sig));
      var v = await api('/api/auth', { action: 'verify', wallet: pubkey, signature: sigB58 });
      W.token = v.token; W.wallet = v.wallet;
      try { localStorage.setItem(SES_KEY, JSON.stringify({ token: v.token, wallet: v.wallet, exp: v.exp })); } catch (e) {}
      await W.refresh();
      return W.state();
    },

    signOut: function () { W.token = null; W.wallet = null; W.coins = 0; W.tickets = 0; try { localStorage.removeItem(SES_KEY); } catch (e) {} W._fire(); },

    /** Pull the current coin + ticket balance from the server. */
    refresh: async function () {
      if (!W.signedIn()) return W.state();
      var m = await api('/api/play', { action: 'me', token: W.token });
      W.coins = m.coins; W.tickets = m.tickets; W.wins = m.wins; W.plays = m.plays; W.grandSlam = m.grandSlam;
      W._fire(); return W.state();
    },

    /** Begin a paid play: debits 1 coin server-side, commits the outcome seed. */
    startPlay: async function (game) {
      if (!W.signedIn()) throw new Error('Sign in to play.');
      var s = await api('/api/play', { action: 'start', token: W.token, game: game });
      W.coins = s.coins; W._fire();
      return s;   // { playId, commitHash, seed? }
    },

    /** Finish a play: the server recomputes the outcome and mints tickets. */
    finishPlay: async function (playId, submission) {
      if (!W.signedIn()) throw new Error('Sign in to play.');
      var body = Object.assign({ action: 'finish', token: W.token, playId: playId }, submission || {});
      var r = await api('/api/play', body);
      await W.refresh();
      return r;   // { won, awarded, grandSlam, tickets, seed, winUnverified, winner? }
    },
  };

  // restore a saved session on load
  try {
    var saved = JSON.parse(localStorage.getItem(SES_KEY) || 'null');
    if (saved && saved.exp > Date.now()) { W.token = saved.token; W.wallet = saved.wallet; W.refresh().catch(function () {}); }
  } catch (e) {}

  window.DojoWallet = W;
})();
