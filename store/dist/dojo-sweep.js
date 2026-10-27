// Dojo Sweep (/sweep) — everything a wallet can get back, on top of the shared /dojo-burn.js (empty accounts + burns):
//   escrow  — SOL left in the wallet's Magic Eden bidding wallet (read-only; withdrawn on Magic Eden)
//   GemFarm — NFTs staked in any farm on the standard GemFarm program: unstake (×2 when the farm has no cooldown) +
//             withdraw_gem back to the wallet — reverse-engineered + verified on a real tx (GEMFARM-RESCUE-SPEC.md)
//   revoke  — "soft-staked" NFTs (a delegate on an unfrozen NFT): a plain Token Revoke takes the permission back
// Free: nothing is taken. Nothing here signs or sends; every transaction is simulated before the wallet sees it.
// Needs /web3.js and /dojo-burn.js loaded first (window.DojoBurn).
(function (global) {
  var B = global.DojoBurn, _ = B._;
  var W3 = function () { return global.solanaWeb3 || global.SolanaWeb3 || global.web3; };
  var PK = _.PK, acct = _.acct, ix = _.ix, utf8 = _.utf8, b64 = _.b64, rdU64 = _.rdU64, keyAt = _.keyAt, u64le = _.u64le;
  var findPda = function (seeds, prog) { return W3().PublicKey.findProgramAddressSync(seeds, PK(prog)); };
  var M2 = 'M2mx93ekt1fmXSVkTrUL9xVFHkmME8HTUi5Cyc5aF7K', M2_HOUSE = 'E8cU1WiRWjanGxmn96ewBgk9vPTcL6AEZ1t6F6fkgUWe';
  var meEscrowOf = function (owner) { return findPda([utf8('m2'), PK(M2_HOUSE).toBuffer(), PK(owner).toBuffer()], M2)[0]; };
  // GemFarm (the open-source gemworks farm — every farm on the main program). GEMFARM_FEE is GemFarm's OWN program fee
  // account, which its unstake instruction requires; nothing goes to Degen Dojo.
  var FARM = 'farmL4xeBFVXJqtfxCzU9b28QACM7E2W2ctT6epAjvE', BANK = 'bankHHdqMuaaST4qQk6mkzxGeKPHWmqdgor6Gs8r88m';
  var GEMFARM_FEE = 'Ht6qrds8bC6JfWHjsUkgtZko6yVqng5hTEy89yCVB5sh'   // the deployed program's fee account (the Atadia spec's 2xhBx… is from before an upgrade)
    , FARMER_DISC = 'jXX2LSteZVk', GDR_DISC = 'cugAXF7JS7L';
  var UNSTAKE_DISC = [0x5a, 0x5f, 0x6b, 0x2a, 0xcd, 0x7c, 0x32, 0xe1], WITHDRAW_DISC = [0xe7, 0x19, 0x27, 0x0d, 0x6c, 0xd1, 0x62, 0x13];
  // GemFarm rescue fee (owner 2026-10-27): a FLAT 0.01 ORE to the Treasury (DojoBurn.splFeeIxs, memo "ddsweep:fee"), in the
  // SAME transaction as the withdraw that hands the NFT(s) back — so it is only paid when the rescue works. Never on a
  // cooldown farm's free 'start unstake' step, nor on follow-up withdraw batches. Without 0.01 ORE in the wallet's ORE
  // account the rescue isn't built at all (the page offers Get ORE).
  var ORE = 'oreoU2P8bN6jkk3jbaiVxYnG1dCXcYxwhwyK9jSybcp', ORE_DECIMALS = 11, RESCUE_FEE_ORE_RAW = 1000000000, RESCUE_FEE_ORE = 0.01;
  var FEE_TREASURY = B.FEE_WALLET;
  var feeIxs = function (owner) { return B.splFeeIxs(owner, ORE, ORE_DECIMALS, RESCUE_FEE_ORE_RAW); };
  // raw ORE in the wallet's ORE account (the one the fee is paid from); 0 if it has none
  var oreRawOf = async function (rpc, owner) { try { var r = await rpc('getTokenAccountBalance', [B.ataOf(owner, ORE).toBase58()]); return Number((r && r.value && r.value.amount) || 0); } catch (e) { return /could not find|not found|invalid param/i.test(e.message || '') ? 0 : -1; } };
  var TOKEN = _.TOKEN, SYS = _.SYS, ATA = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', RENT = 'SysvarRent111111111111111111111111111111111';
  // account layouts (gem-farm Farmer / Farm.config / gem-bank Vault, GemDepositReceipt) — verified on Atadia's farm
  var F_FARM = 8, F_VAULT = 72, F_STATE = 104, F_GEMS = 105, F_MIN_END = 121, F_COOL_END = 129;   // Farmer
  var FM_BANK = 139, FM_MIN = 171, FM_COOL = 179, FM_FEE = 187;                                   // Farm
  var V_LOCKED = 169;                                                                               // Vault

  // ── scan: Dojo Burn's scan + the Magic Eden escrow + GemFarm stakes ──────────
  // onList(out): the burn scan's early list (before floor prices), with the escrow + GemFarm extras already filled in
  async function scan(rpc, owner, onStep, onList) {
    var step = onStep || function () {};
    var t0 = Date.now(), c0 = rpc.stats ? rpc.stats.calls : 0;
    // the burn scan queues its first reads first (the list is what the page waits for); the extras run alongside it, and a
    // failure there is partial (out.unread), never the whole scan
    var listCb = null, scanP = B.scan(rpc, owner, step, function (partial) { if (listCb) listCb(partial); });
    var escAddr = meEscrowOf(owner).toBase58();
    var escP = rpc('getBalance', [escAddr]).then(function (eb) { return { lamports: (eb && eb.value) || 0 }; }, function () { return { lamports: 0, unread: true }; });
    var farmP = scanGemFarm(rpc, owner).then(function (f) { return { farms: f }; }, function (e) { return { farms: [], error: e.message || String(e) }; });
    var extras = Promise.all([escP, farmP]);
    var fill = function (out, r) {
      if (out._extras) return; out._extras = true;
      out.escrow = { address: escAddr, lamports: r[0].lamports }; if (r[0].unread) { out.escrow.unread = true; out.unread++; }
      out.farms = r[1].farms; if (r[1].error != null) { out.farmError = r[1].error; out.unread++; }
    };
    if (onList) listCb = function (partial) { extras.then(function (r) { fill(partial, r); if (partial.floorsPending) onList(partial); }); };
    var out = await scanP;
    fill(out, await extras);
    if (rpc.stats) { out.calls = rpc.stats.calls - c0; out.ms = Date.now() - t0; }
    return out;
  }

  // The wallet's GemFarm farmers with NFTs still in a live vault, each with its farm config, NFTs and what can be done now
  async function scanGemFarm(rpc, owner) {
    var r = await rpc('getProgramAccounts', [FARM, { encoding: 'base64', dataSlice: { offset: 0, length: 137 },
      filters: [{ memcmp: { offset: 0, bytes: FARMER_DISC } }, { memcmp: { offset: 40, bytes: owner } }] }]);
    var fs = (r || []).map(function (a) { var d = b64(a.account.data[0]);
      return { farmer: a.pubkey, farm: keyAt(d, F_FARM), vault: keyAt(d, F_VAULT), state: d[F_STATE], gems: Number(rdU64(d, F_GEMS)), minEnd: Number(rdU64(d, F_MIN_END)), coolEnd: Number(rdU64(d, F_COOL_END)) }; })
      .filter(function (f) { return f.gems > 0; });
    if (!fs.length) return [];
    // ≤ 100 keys a call (the proxy's cap), one call after another
    var many = async function (keys, slice) { var o = []; for (var i = 0; i < keys.length; i += 100) { var m = await rpc('getMultipleAccounts', [keys.slice(i, i + 100), { encoding: 'base64', dataSlice: slice }]); o = o.concat((m && m.value) || []); } return { value: o }; };
    var fa = await many(fs.map(function (f) { return f.farm; }), { offset: FM_BANK, length: 56 });
    var va = await many(fs.map(function (f) { return f.vault; }), { offset: 0, length: V_LOCKED + 1 });
    var live = [];
    fs.forEach(function (f, i) {
      var fv = fa.value[i], vv = va.value[i];
      if (!fv || !vv) return;   // the vault is closed: the farmer's counter is stale, nothing is held there any more
      var fd = b64(fv.data[0]), vd = b64(vv.data[0]);
      f.bank = keyAt(fd, 0); f.minStake = Number(rdU64(fd, FM_MIN - FM_BANK)); f.cooldown = Number(rdU64(fd, FM_COOL - FM_BANK)); f.feeLamports = Number(rdU64(fd, FM_FEE - FM_BANK));
      f.vaultLocked = vd[V_LOCKED] === 1;
      live.push(f);
    });
    for (var i = 0; i < live.length; i++) {
      var f = live[i];
      var g = await rpc('getProgramAccounts', [BANK, { encoding: 'base64', dataSlice: { offset: 72, length: 40 },
        filters: [{ memcmp: { offset: 0, bytes: GDR_DISC } }, { memcmp: { offset: 8, bytes: f.vault } }] }]);
      f.mints = (g || []).map(function (a) { var d = b64(a.account.data[0]); return { mint: keyAt(d, 0), count: Number(rdU64(d, 32)) }; }).filter(function (m) { return m.count > 0; });
      f.status = statusOf(f);
    }
    var all = [].concat.apply([], live.map(function (f) { return f.mints.map(function (m) { return m.mint; }); }));
    var meta = {};
    for (var k = 0; k < all.length; k += 100) {
      var ab = await rpc('getAssetBatch', { ids: all.slice(k, k + 100) });
      (ab || []).forEach(function (a) { if (a) meta[a.id] = { name: String((a.content && a.content.metadata && a.content.metadata.name) || 'NFT'), image: (a.content && a.content.links && a.content.links.image) || '' }; });
    }
    live.forEach(function (f) { f.mints.forEach(function (m) { var x = meta[m.mint] || {}; m.name = x.name || 'NFT'; m.image = x.image || ''; }); });
    return live.filter(function (f) { return f.mints.length; });
  }
  // What can be done right now. Farmer state: 0 unstaked · 1 staked · 2 cooling down.
  function statusOf(f, nowSec) {
    var now = nowSec || Math.floor(Date.now() / 1000);
    if (f.state === 1 && now < f.minEnd) return { kind: 'locked', until: f.minEnd };
    if (f.state === 1 && f.cooldown === 0) return { kind: 'ready', unstakes: 2 };
    if (f.state === 1) return { kind: 'start', unstakes: 1 };
    if (f.state === 2 && now < f.coolEnd) return { kind: 'cooldown', until: f.coolEnd };
    if (f.state === 2) return { kind: 'ready', unstakes: 1 };
    return { kind: 'ready', unstakes: 0 };
  }

  function gemPdas(owner, farm, bank, mint) {
    var p = {}, r;
    r = findPda([PK(farm).toBuffer()], FARM); p.farmAuth = r[0]; p.bAuth = r[1];
    r = findPda([utf8('treasury'), PK(farm).toBuffer()], FARM); p.farmTreasury = r[0]; p.bTreasury = r[1];
    r = findPda([utf8('farmer'), PK(farm).toBuffer(), PK(owner).toBuffer()], FARM); p.farmer = r[0]; p.bFarmer = r[1];
    r = findPda([utf8('vault'), PK(bank).toBuffer(), PK(owner).toBuffer()], BANK); p.vault = r[0];
    r = findPda([p.vault.toBuffer()], BANK); p.vaultAuth = r[0]; p.bVaultAuth = r[1];
    if (mint) {
      r = findPda([utf8('gem_box'), p.vault.toBuffer(), PK(mint).toBuffer()], BANK); p.gemBox = r[0]; p.bGemBox = r[1];
      r = findPda([utf8('gem_deposit_receipt'), p.vault.toBuffer(), PK(mint).toBuffer()], BANK); p.gdr = r[0]; p.bGdr = r[1];
      r = findPda([utf8('gem_rarity'), PK(bank).toBuffer(), PK(mint).toBuffer()], BANK); p.gemRarity = r[0]; p.bRarity = r[1];
      p.gemDest = findPda([PK(owner).toBuffer(), PK(TOKEN).toBuffer(), PK(mint).toBuffer()], ATA)[0];
    }
    return p;
  }
  function unstakeIx(owner, f, skipRewards) {
    var p = gemPdas(owner, f.farm, f.bank), data = new Uint8Array(12);
    data.set(UNSTAKE_DISC, 0); data[8] = p.bAuth; data[9] = p.bTreasury; data[10] = p.bFarmer; data[11] = skipRewards ? 1 : 0;
    return ix(FARM, [acct(f.farm, false, true), acct(p.farmAuth, false, true), acct(p.farmTreasury, false, true), acct(p.farmer, false, true),
      acct(owner, true, true), acct(f.bank, false, true), acct(p.vault, false, true), acct(BANK, false, false), acct(GEMFARM_FEE, false, true), acct(SYS, false, false)], data);
  }
  function withdrawIx(owner, f, m) {
    var p = gemPdas(owner, f.farm, f.bank, m.mint), data = new Uint8Array(20);
    data.set(WITHDRAW_DISC, 0); data[8] = p.bVaultAuth; data[9] = p.bGemBox; data[10] = p.bGdr; data[11] = p.bRarity; data.set(u64le(m.count || 1), 12);
    return ix(BANK, [acct(f.bank, false, true), acct(p.vault, false, true), acct(owner, true, true), acct(p.vaultAuth, false, false),
      acct(p.gemBox, false, true), acct(p.gdr, false, true), acct(p.gemDest, false, true), acct(m.mint, false, false),
      acct(p.gemRarity, false, false), acct(owner, true, true), acct(TOKEN, false, false), acct(ATA, false, false), acct(SYS, false, false), acct(RENT, false, false)], data);
  }

  /** Plan the next GemFarm step for one farm.
   *  start → one unstake (the farm's cooldown begins); ready → the needed unstakes + as many withdraws as fit in ONE tx
   *  (the vault only unlocks once that lands, so the rest are planned after it: planGemWithdraws).
   *  A farm whose rewards can't be settled any more is retried with skip_rewards (noted on the result). */
  async function planGemFarm(rpc, owner, f) {
    var st = statusOf(f);
    if (st.kind !== 'ready' && st.kind !== 'start') return { error: st.kind === 'locked' ? 'locked until ' + new Date(st.until * 1000).toLocaleString() : 'cooling down until ' + new Date(st.until * 1000).toLocaleString() };
    var build = function (skip, mints, noFee) {
      var ixs = _.budget(200000 + 120000 * mints.length);
      for (var u = 0; u < st.unstakes; u++) ixs.push(unstakeIx(owner, f, skip));
      mints.forEach(function (m) { ixs.push(withdrawIx(owner, f, m)); });
      return mints.length && !noFee ? ixs.concat(feeIxs(owner)) : ixs;   // the fee rides only on the step that returns NFTs
    };
    var mints = st.kind === 'ready' ? f.mints.slice() : [], take = [];
    while (mints.length && _.sizeOf(owner, build(false, take.concat([mints[0]]))) <= B.TX_MAX) take.push(mints.shift());   // sized WITH the fee
    var watch = take.length ? take.map(function (m) { return gemPdas(owner, f.farm, f.bank, m.mint).gemDest.toBase58(); }).concat([B.ataOf(FEE_TREASURY, ORE).toBase58()]) : [gemPdas(owner, f.farm, f.bank).farmer.toBase58()];
    // 1) does the rescue itself work? Simulated WITHOUT the fee first, so nobody is sent to buy ORE for an NFT that can't come back
    var sim = await B.simulate(rpc, owner, build(false, take, true), watch), skip = false;
    if (sim.err) { var s2 = await B.simulate(rpc, owner, build(true, take, true), watch); if (!s2.err) { sim = s2; skip = true; } }
    if (sim.err) return { error: _.reasonOf(sim), sim: sim };
    if (take.length) {
      // 2) the 0.01 ORE fee: without it in the wallet's ORE account nothing is built (the page offers Get ORE) …
      var have = await oreRawOf(rpc, owner);
      if (have >= 0 && have < RESCUE_FEE_ORE_RAW) return { needOre: RESCUE_FEE_ORE - have / Math.pow(10, ORE_DECIMALS), oreHave: have / Math.pow(10, ORE_DECIMALS), error: 'Rescue costs ' + RESCUE_FEE_ORE + ' ORE — get ORE' };
      // 3) … with it, the transaction the owner signs is simulated as a whole
      var sf = await B.simulate(rpc, owner, build(skip, take), watch);
      if (sf.err) return { error: _.reasonOf(sf), sim: sf };
      sim = sf;
    }
    return { batches: [{ ixs: build(skip, take), items: take, lamports: 0, units: sim.units }], rest: mints, skipRewards: skip, kind: st.kind, sim: sim,
      feeOre: take.length ? RESCUE_FEE_ORE : 0, farmFeeLamports: f.feeLamports || 0 };
  }
  /** Withdraws for the NFTs left in an UNLOCKED vault (after the first step landed), packed and simulated. */
  async function planGemWithdraws(rpc, owner, f, mints) {
    var queue = mints.slice(), batches = [], dropped = [];
    var mk = function (ms) { return _.budget(Math.min(1400000, 120000 * ms.length + 20000)).concat(ms.map(function (m) { return withdrawIx(owner, f, m); })); };
    while (queue.length) {
      var take = [];
      while (queue.length && _.sizeOf(owner, mk(take.concat([queue[0]]))) <= B.TX_MAX) take.push(queue.shift());
      if (!take.length) { dropped.push({ item: queue.shift(), reason: 'does not fit in a transaction' }); continue; }
      var sim = await B.simulate(rpc, owner, mk(take));
      if (sim.err) { take.forEach(function (m) { dropped.push({ item: m, reason: _.reasonOf(sim) }); }); continue; }
      batches.push({ ixs: mk(take), items: take, lamports: 0, units: sim.units });
    }
    return { batches: batches, dropped: dropped };
  }

  /** Revoke the delegate on soft-staked NFTs (Token Revoke: the owner takes the permission back), packed + simulated. */
  async function planRevokes(rpc, owner, soft) {
    var mk = function (items) { return _.budget(20000 + 5000 * items.length).concat(items.map(function (c) { return ix(TOKEN, [acct(c.tokenAccount, false, true), acct(owner, true, false)], new Uint8Array([5])); })); };
    var queue = soft.slice(), batches = [], dropped = [];
    while (queue.length) {
      var take = [];
      while (queue.length && _.sizeOf(owner, mk(take.concat([queue[0]]))) <= B.TX_MAX) take.push(queue.shift());
      var sim = await B.simulate(rpc, owner, mk(take));
      if (sim.err) { take.forEach(function (c) { dropped.push({ item: c, reason: _.reasonOf(sim) }); }); continue; }
      batches.push({ ixs: mk(take), items: take, lamports: 0, units: sim.units });
    }
    return { batches: batches, dropped: dropped };
  }

  global.DojoSweep = { scan: scan, scanGemFarm: scanGemFarm, statusOf: statusOf, planGemFarm: planGemFarm, planGemWithdraws: planGemWithdraws, planRevokes: planRevokes,
    gemPdas: gemPdas, meEscrowOf: meEscrowOf, FARM: FARM, BANK: BANK, unstakeIx: unstakeIx, withdrawIx: withdrawIx,
    RESCUE_FEE_ORE: RESCUE_FEE_ORE, RESCUE_FEE_ORE_RAW: RESCUE_FEE_ORE_RAW, ORE: ORE, FEE_TREASURY: FEE_TREASURY, oreRawOf: oreRawOf,
    planCloses: B.planCloses, planBurns: B.planBurns, finalize: B.finalize, simulate: B.simulate, KEEP: B.KEEP, TX_MAX: B.TX_MAX };
})(typeof window !== 'undefined' ? window : globalThis);
