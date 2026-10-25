/* Dojo Scores — shared raffle-ticket ledger across every game.
 *
 * The economy: you buy coins, spend one to play. You never win money. Every
 * finished game earns weekly RAFFLE TICKETS — 1 for a play, 3 for a win, and a
 * one-time +3 for winning all four games at least once — and the weekly Dojo Pot
 * is drawn among ticket-holders (Degen Dojo keeps 12%).
 *
 * One localStorage ledger keyed by a single username, so per-game and OVERALL
 * scoreboards all read the same source. It is a LOCAL scoreboard only: the real
 * draw tickets are minted server-side by /api/play (paid coin + verified outcome).
 *
 *   DojoScores.record('cluck', won)   // after a game ends
 *   DojoScores.setName('Sensei')
 *   DojoScores.ranking('cluck')       // per-game, ranked by wins
 *   DojoScores.ranking()              // overall, ranked by tickets
 */
(function () {
  var NAME_KEY = 'dojo_name', DATA_KEY = 'dojo_scores';
  // 1 coin per play. A win = 3 raffle chances; a loss still earns 1 for playing.
  // Winning at least once on ALL FOUR games grants a one-time +3 "grand slam" bonus.
  var WIN_TICKETS = 3, PLAY_TICKETS = 1, GRAND_SLAM = 3;
  var ALL_GAMES = ['duel', 'flip', 'teto', 'cluck', 'brawl'];
  var GAMES = { duel: 'Degen Duel', flip: 'Dojo Flip', teto: 'Teto Wars', cluck: 'Cluck-Fu', brawl: 'Cock Brawl' };

  var DojoScores = {
    WIN_TICKETS: WIN_TICKETS, PLAY_TICKETS: PLAY_TICKETS, GAMES: GAMES,
    getName: function () { return (localStorage.getItem(NAME_KEY) || '').trim(); },
    setName: function (n) { localStorage.setItem(NAME_KEY, String(n || '').trim().slice(0, 16)); fire(); },
    load: function () { try { return JSON.parse(localStorage.getItem(DATA_KEY)) || {}; } catch (e) { return {}; } },
    save: function (o) { localStorage.setItem(DATA_KEY, JSON.stringify(o)); fire(); },

    /** Log a finished game for the current player. Returns the tickets awarded (0 if no name set). */
    record: function (game, won) {
      var name = this.getName(); if (!name) return 0;
      var o = this.load();
      var p = o[name] || (o[name] = { tickets: 0, games: {}, grandSlam: false });
      var g = p.games[game] || (p.games[game] = { plays: 0, wins: 0 });
      g.plays++; if (won) g.wins++;
      var awarded = won ? WIN_TICKETS : PLAY_TICKETS;
      p.tickets += awarded;
      // one-time grand-slam bonus: a win in every one of the four games
      if (!p.grandSlam && ALL_GAMES.every(function (k) { return p.games[k] && p.games[k].wins > 0; })) {
        p.grandSlam = true; awarded += GRAND_SLAM; p.tickets += GRAND_SLAM;
      }
      this.save(o);
      // local scoreboard only — the weekly draw's tickets are minted server-side by /api/play
      return awarded;
    },

    myTickets: function () { var p = this.load()[this.getName()]; return p ? p.tickets : 0; },

    /** Ranked players. `game` → by wins in that game; omit → OVERALL by tickets. */
    ranking: function (game) {
      var o = this.load();
      return Object.keys(o).map(function (name) {
        var p = o[name];
        if (game) { var g = p.games[game] || { plays: 0, wins: 0 }; return { name: name, plays: g.plays, wins: g.wins, tickets: p.tickets }; }
        var plays = 0, wins = 0;
        for (var k in p.games) { plays += p.games[k].plays; wins += p.games[k].wins; }
        return { name: name, plays: plays, wins: wins, tickets: p.tickets };
      }).filter(function (r) { return game ? r.plays > 0 : r.tickets > 0; })
        .sort(function (a, b) { return game ? (b.wins - a.wins || b.tickets - a.tickets) : (b.tickets - a.tickets || b.wins - a.wins); });
    },
    /** Inject the shared scoreboard stylesheet once. */
    mountStyles: function () {
      if (document.getElementById('ds-style')) return;
      var s = document.createElement('style'); s.id = 'ds-style';
      s.textContent =
        ".ds-wrap{text-align:left;font-family:'Inter',system-ui,sans-serif;}" +
        ".ds-id{display:flex;gap:8px;margin-bottom:10px;}" +
        ".ds-id input{flex:1;min-width:0;background:rgba(0,0,0,.3);border:1px solid #4a3c2a;border-radius:8px;color:#ece4d6;font-size:14px;padding:8px 11px;outline:none;}" +
        ".ds-id input:focus{border-color:#c9973a;}" +
        ".ds-id button{font-family:'Teko','Trebuchet MS',sans-serif;font-size:16px;text-transform:uppercase;letter-spacing:.05em;padding:0 16px;border-radius:8px;cursor:pointer;border:1px solid #c9973a;background:linear-gradient(180deg,#e8b84b,#c9973a);color:#1a1206;}" +
        ".ds-me{font-family:'Teko','Trebuchet MS',sans-serif;font-size:16px;color:#a99a7e;margin-bottom:10px;min-height:18px;}" +
        ".ds-me b{color:#e8b84b;font-size:19px;margin:0 3px;}" +
        ".ds-tabs{display:flex;gap:6px;margin-bottom:8px;}" +
        ".ds-tab{flex:1;font-family:'Teko','Trebuchet MS',sans-serif;font-size:15px;letter-spacing:.03em;text-transform:uppercase;padding:7px;border-radius:8px;cursor:pointer;border:1px solid #4a3c2a;background:transparent;color:#a99a7e;}" +
        ".ds-tab.on{background:linear-gradient(180deg,#e8b84b,#c9973a);color:#1a1206;border-color:transparent;}" +
        ".ds-head,.ds-list li{display:grid;grid-template-columns:24px 1fr 40px 52px;align-items:center;gap:4px;}" +
        ".ds-head{font-family:'Teko','Trebuchet MS',sans-serif;font-size:12px;letter-spacing:.05em;text-transform:uppercase;color:#a99a7e;padding:0 4px 5px;border-bottom:1px solid #4a3c2a;}" +
        ".ds-head span:nth-child(n+3),.ds-list li span:nth-child(n+3){text-align:right;}" +
        ".ds-list{list-style:none;margin:6px 0 0;padding:0;max-height:200px;overflow-y:auto;}" +
        ".ds-list li{padding:6px 4px;border-bottom:1px solid rgba(74,60,42,.5);font-size:13px;color:#ece4d6;}" +
        ".ds-list li.you{background:rgba(232,184,75,.1);border-radius:6px;}" +
        ".ds-list li .rk{font-family:'Teko','Trebuchet MS',sans-serif;font-size:15px;color:#e8b84b;}" +
        ".ds-list li .tk{color:#e8b84b;font-weight:600;}" +
        ".ds-empty{color:#a99a7e;font-size:13px;text-align:center;padding:16px 0;}" +
        ".ds-note{margin-top:12px;font-size:12px;color:#a99a7e;line-height:1.5;}.ds-note b{color:#e8b84b;}";
      document.head.appendChild(s);
    },

    /** Render the full scoreboard (name + my tickets + This-game/Overall tabs) into `el`. */
    renderBoard: function (el, game) {
      var self = this; this.mountStyles();
      var tab = el._dsTab || 'game';
      el.classList.add('ds-wrap');
      el.innerHTML =
        '<div class="ds-id"><input class="ds-name" maxlength="16" placeholder="Your name"><button class="ds-save">Save</button></div>' +
        '<div class="ds-me"></div>' +
        '<div class="ds-tabs"><button class="ds-tab" data-t="game">' + esc(GAMES[game] || 'This game') + '</button><button class="ds-tab" data-t="all">Overall · 🎟</button></div>' +
        '<div class="ds-head"><span>#</span><span>Player</span><span>W</span><span>🎟</span></div>' +
        '<ol class="ds-list"></ol>' +
        '<div class="ds-note"><b>Win</b> = 3 raffle chances · <b>play</b> = 1 · win all 4 games = <b>+3</b> bonus. The weekly Dojo Pot is drawn among ticket-holders — Degen Dojo keeps <b>12%</b>.</div>';
      el.querySelector('.ds-name').value = self.getName();
      function paint() {
        el.querySelectorAll('.ds-tab').forEach(function (b) { b.classList.toggle('on', b.dataset.t === tab); });
        var me = self.load()[self.getName()], g = me && me.games[game];
        el.querySelector('.ds-me').innerHTML = self.getName()
          ? 'You: <b>' + (me ? me.tickets : 0) + '</b>🎟' + (g ? ' · ' + g.wins + 'W / ' + g.plays + ' played' : '')
          : 'Set a name to start earning tickets.';
        var rows = self.ranking(tab === 'all' ? null : game), list = el.querySelector('.ds-list');
        list.innerHTML = rows.length ? rows.slice(0, 50).map(function (r, i) {
          return '<li class="' + (r.name === self.getName() ? 'you' : '') + '"><span class="rk">' + (i + 1) + '</span><span>' + esc(r.name) + '</span><span>' + r.wins + '</span><span class="tk">' + r.tickets + '</span></li>';
        }).join('') : '<li class="ds-empty">No games logged yet. Play to appear here.</li>';
      }
      el.querySelector('.ds-save').onclick = function () { self.setName(el.querySelector('.ds-name').value); paint(); };
      el.querySelector('.ds-name').addEventListener('keydown', function (e) { if (e.key === 'Enter') el.querySelector('.ds-save').click(); });
      el.querySelectorAll('.ds-tab').forEach(function (b) { b.onclick = function () { tab = b.dataset.t; el._dsTab = tab; paint(); }; });
      paint();
    },
  };
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  window.DojoScores = DojoScores;

  // let listeners (scoreboards, ticket readouts) refresh on any change, including other tabs
  function fire() { try { window.dispatchEvent(new Event('dojo-scores')); } catch (e) {} }
  window.addEventListener('storage', function (e) { if (e.key === DATA_KEY || e.key === NAME_KEY) fire(); });
})();
