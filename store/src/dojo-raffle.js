// Burn Raffle (/raffle) — the holder's own transactions: Dojo Burn's burns (no 1% fee) + ONE transfer of exactly the rent
// those burns free to the raffle wallet + a "ddraffle:<round>" memo, all in the SAME transaction (it lands whole or not at
// all). The freed rent is measured the way the server counts it (store-raffle-core freedByBurns: what the accounts each
// burn closes lose — read before, then from a simulation), so the SOL sent and the tickets match: 1 per 0.001 SOL.
// Nothing here signs or sends — it plans and SIMULATES; the page hands the transactions to the owner's wallet.
// Needs /web3.js and /dojo-burn.js loaded first (window.DojoBurn).
(function (global) {
  var B = global.DojoBurn, _ = B._;
  var W3 = function () { return global.solanaWeb3 || global.SolanaWeb3 || global.web3; };
  var MEMO = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr', META = 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s', CORE = B.CORE;
  var SYS = _.SYS, LAMPORTS_PER_TICKET = 1000000, PREFIX = 'ddraffle:';
  // the accounts each burn instruction closes — the SAME positions the server counts (store-raffle-core BURN_IXS)
  var FREED = [{ program: META, tag: 41, at: [2, 3, 4, 5, 10] }, { program: META, tag: 29, at: [0, 2, 3, 4] }, { program: CORE, tag: 12, at: [0] }];
  var ticketsFor = function (lamports) { return Math.floor(Number(lamports || 0) / LAMPORTS_PER_TICKET); };

  /** The transfer + memo that ride in every raffle transaction. */
  function raffleIxs(owner, to, lamports, round) {
    return [W3().SystemProgram.transfer({ fromPubkey: _.PK(owner), toPubkey: _.PK(to), lamports: lamports }),
      _.ix(MEMO, [_.acct(owner, true, false)], _.utf8(PREFIX + round))];
  }
  /** The accounts the burns in `ixs` close (signers and program ids left out). */
  function freedAccounts(ixs) {
    var out = [];
    ixs.forEach(function (ix) {
      var pid = ix.programId.toBase58(), d = ix.data, spec = d && d.length ? FREED.filter(function (f) { return f.program === pid && f.tag === d[0]; })[0] : null;
      if (!spec) return;
      spec.at.forEach(function (i) {
        var k = ix.keys[i]; if (!k || k.isSigner) return;
        var a = k.pubkey.toBase58();
        if (a !== META && a !== CORE && a !== SYS && out.indexOf(a) < 0) out.push(a);
      });
    });
    return out;
  }
  /** The raffle's wallet scan: Dojo Burn's, plus Degen Dojo / Demon Dojo / TETO cards (owner 2026-10-28 — "holders want to
   *  burn some for fun", "any NFT can burn"; each comes tagged c.dojo and the page asks twice). DeFi positions and frozen /
   *  staked / listed NFTs stay unburnable; Sweep / Burn to Mine never do this. */
  function scan(rpc, owner, onStep, onList) { return B.scan(rpc, owner, onStep, onList, { allowDojo: true }); }
  /** The ticked Degen Dojo cards — the burn confirm lists them by name and needs its own extra tick. */
  function dojoCards(items) { return (items || []).filter(function (c) { return !!c.dojo; }); }
  /** May the burn go ahead? The "burning is permanent" tick — and, when any Degen Dojo card is ticked, the second one too. */
  function canBurn(items, sure, dojoSure) { return !!sure && (!dojoCards(items).length || !!dojoSure); }
  /** Plan the raffle transactions for the ticked NFTs.
   *  → { batches: [{ items, ixs, lamports (the rent sent = freed), tickets, units }], dropped: [{ item, reason }] } */
  async function plan(rpc, owner, nfts, o) {
    var step = o.onStep || function () {}, to = o.to, round = o.round;
    var p = await B.planBurns(rpc, owner, nfts, step, { fee: false, room: raffleIxs(owner, to, 1e9, round) });
    var batches = [], dropped = p.dropped.slice();
    for (var i = 0; i < p.batches.length; i++) {
      var b = p.batches[i];
      step('Measuring the rent in batch ' + (i + 1) + ' of ' + p.batches.length + '…');
      var accts = freedAccounts(b.ixs);
      var pre = await rpc('getMultipleAccounts', [accts, { encoding: 'base64', dataSlice: { offset: 0, length: 0 } }]);
      var sim = await B.simulate(rpc, owner, b.ixs, accts);
      if (sim.err || !sim.accounts) { b.items.forEach(function (x) { dropped.push({ item: x, reason: sim.err ? _.reasonOf(sim) : 'couldn’t measure the rent' }); }); continue; }
      var freed = 0;
      accts.forEach(function (a, j) {
        var before = pre && pre.value && pre.value[j] ? pre.value[j].lamports : 0, after = sim.accounts[j] ? sim.accounts[j].lamports : 0;
        if (before > after) freed += before - after;
      });
      if (!(freed > 0)) { b.items.forEach(function (x) { dropped.push({ item: x, reason: 'frees no rent' }); }); continue; }
      var ixs = b.ixs.concat(raffleIxs(owner, to, freed, round));
      var fin = await B.simulate(rpc, owner, ixs);
      if (fin.err) { b.items.forEach(function (x) { dropped.push({ item: x, reason: _.reasonOf(fin) }); }); continue; }
      batches.push({ items: b.items, ixs: ixs, lamports: freed, tickets: ticketsFor(freed), units: fin.units });
    }
    return { batches: batches, dropped: dropped };
  }

  global.DojoRaffle = { plan: plan, scan: scan, dojoCards: dojoCards, canBurn: canBurn, raffleIxs: raffleIxs, freedAccounts: freedAccounts, ticketsFor: ticketsFor, LAMPORTS_PER_TICKET: LAMPORTS_PER_TICKET, PREFIX: PREFIX };
})(typeof window !== 'undefined' ? window : globalThis);
