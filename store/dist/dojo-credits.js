/* Dojo Credits — one shared balance across every game.
 *
 * All games live on the same origin, so a single localStorage key ('dojo_credits')
 * IS the shared wallet: buy on the credits page, spend in any game, watch it move.
 * Include this on every game page:  <script src="/dojo-credits.js"></script>
 *
 * The balance is shown INSIDE each game (not a floating top badge): place a
 *   <span data-dc-credits></span>
 * wherever you want it — this script keeps every such element in sync (on load,
 * on spend, on cross-tab change). Games put it between their info (i) and 🏆.
 *
 * Call DojoCredits.play('Game Name') when a paid game begins — it spends one
 * credit (≈ $1) and returns true, or returns false and shows a small toast
 * nudging the player to buy.
 */
(function () {
  var KEY = 'dojo_credits';
  var CREDITS_URL = '/dojo-credits.html';   // where to buy more (routed to /credits on deploy)
  var WELCOME = 3;                          // demo/onboarding: first-ever visitor gets a few credits
  if (localStorage.getItem(KEY) === null) localStorage.setItem(KEY, String(WELCOME));

  var DojoCredits = {
    get: function () { return Number(localStorage.getItem(KEY) || 0); },
    set: function (n) { localStorage.setItem(KEY, String(Math.max(0, Math.floor(n)))); paint(); },
    add: function (n) { this.set(this.get() + n); },
    /** Spend one credit to start a paid game. Returns true if paid, false if broke.
     *  In demo mode (economy gated off) every game is FREE — never blocks, never charges. */
    play: function (game) {
      try { localStorage.setItem('dojo_games_played', String((this.gamesPlayed()) + 1)); } catch (e) {}
      if (!econOn()) return true;   // free demo (economy off)
      var b = this.get();
      if (b <= 0) { toast('Out of coins — buy more on the coins page', true); return false; }
      this.set(b - 1);
      toast('−1 coin · ' + (game || 'game') + ' · ' + this.get() + ' left');
      return true;
    },
    /** How many paid/played games this browser has started (for the profile view). */
    gamesPlayed: function () { return Number(localStorage.getItem('dojo_games_played') || 0); },
    creditsUrl: CREDITS_URL,
    refresh: function () { paint(); },
  };
  window.DojoCredits = DojoCredits;

  // ---- ranked/demo gate (canonical, loaded first so every game shares it) ----
  // OFF everywhere until testing: no coins, no scoreboard, no wallet — pure free demo.
  // ?ranked turns it on (persists); ?noranked turns it off.
  if (!window.dojoRankedOn) window.dojoRankedOn = function () {
    try {
      if (/[?&]noranked\b/.test(location.search)) localStorage.removeItem('dojo_ranked');
      else if (/[?&]ranked\b/.test(location.search)) localStorage.setItem('dojo_ranked', '1');
      return localStorage.getItem('dojo_ranked') === '1';
    } catch (e) { return false; }
  };

  // Economy is ON when explicitly ranked, OR when a page opts into the LOCAL coin economy
  // (window.DOJO_LOCAL_ECON — the store sets this so games display + spend the shared local
  // 'dojo_credits' balance instead of the server-verified ledger, which isn't wired yet).
  function econOn() { return !!window.DOJO_LOCAL_ECON || (window.dojoRankedOn && window.dojoRankedOn()); }

  // ---- keep every in-game credits readout in sync (and enforce the demo gate) ----
  function paint() {
    if (!econOn()) {
      // demo mode: hide coin balances, 🏆 scoreboard buttons, and any economy copy
      // (pots, raffle chances, coin prices) marked `.dojo-econ`. Pure free game only.
      var hide = document.querySelectorAll('[data-dc-credits],[title="Scoreboard"],.dojo-econ');
      for (var h = 0; h < hide.length; h++) hide[h].style.display = 'none';
      return;
    }
    var els = document.querySelectorAll('[data-dc-credits]');
    // Coins belong to a CONNECTED wallet — don't show a balance (or the demo welcome
    // credits) to an anonymous visitor. No wallet → no coin readout at all.
    if (!window.DOJO_WALLET) {
      for (var j = 0; j < els.length; j++) els[j].style.display = 'none';
      return;
    }
    var n = DojoCredits.get();
    for (var i = 0; i < els.length; i++) {
      var style = els[i].getAttribute('data-dc-credits');   // "" = plain number, "icon" = 🪙 N
      els[i].style.display = '';
      els[i].textContent = (style === 'icon' ? '🪙 ' : '') + n;
    }
  }

  // ---- tiny transient toast (feedback only, auto-hides — not a persistent bar) ----
  var toastEl, toastT;
  function toast(msg, warn) {
    if (!toastEl) {
      var css = document.createElement('style');
      css.textContent = '#dc-toast{position:fixed;left:50%;bottom:22px;transform:translate(-50%,140%);z-index:99999;' +
        'background:#241d18;border:1px solid #c9973a;color:#ece4d6;padding:9px 16px;border-radius:11px;' +
        "font-family:'Teko','Trebuchet MS',sans-serif;font-size:17px;letter-spacing:.03em;opacity:0;" +
        'transition:transform .28s,opacity .28s;pointer-events:none;box-shadow:0 8px 24px rgba(0,0,0,.5);}' +
        '#dc-toast.show{transform:translate(-50%,0);opacity:1;}#dc-toast.warn{border-color:#c1443a;color:#f0c9c4;}';
      document.head.appendChild(css);
      toastEl = document.createElement('div'); toastEl.id = 'dc-toast'; document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg; toastEl.className = warn ? 'warn' : '';
    void toastEl.offsetWidth; toastEl.classList.add('show');
    clearTimeout(toastT); toastT = setTimeout(function () { toastEl.classList.remove('show'); }, 2400);
  }

  window.addEventListener('storage', function (e) { if (e.key === KEY) paint(); });
  window.addEventListener('dojo-wallet-change', paint);   // show/hide coins the moment a wallet connects/disconnects
  // a light interval catches same-tab changes made by other scripts without a storage event
  setInterval(paint, 900);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', paint);
  else paint();
})();
