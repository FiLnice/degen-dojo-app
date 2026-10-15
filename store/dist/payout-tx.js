/* Dojo payout transaction builder — shared by /payouts (browser: window.DojoPayoutTx, needs
 * window.solanaWeb3 + window.Buffer) and the Node tests (require('./payout-tx.js') with
 * @solana/web3.js). Builds ONLY unsigned transactions; the owner's wallet signs them.
 *
 *   transfersForPlan(plan, swapOre)  → [{id, owner, cur, mint, decimals, amount}] (raw units)
 *   swapBuckets(plan)                → {SOL:{total, parts:[{id, weight}]}, USDC:{…}}
 *   allocate(totalRaw, parts)        → {id: raw} proportional split of the swap's ORE
 *   packTransfers({W3, payer, blockhash, transfers}) → [{tx, owners, transfers}] v0 txs ≤ 1232 bytes,
 *                                      each: compute budget + per recipient (create ATA idempotent +
 *                                      TransferChecked) — a recipient's ORE+SKR stay in one tx
 *   jupiterSwap({fetch, base, payer, inputMint, amount, slippageBps}) → {quote, minOut, swapTransaction(b64)}
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api; else root.DojoPayoutTx = api;
})(typeof self !== 'undefined' ? self : this, function () {
  var TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
  var ATA = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
  var SYS = '11111111111111111111111111111111';
  var CB = 'ComputeBudget111111111111111111111111111111';
  var MINTS = { ORE: 'oreoU2P8bN6jkk3jbaiVxYnG1dCXcYxwhwyK9jSybcp', SKR: 'SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3', USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', SOL: 'So11111111111111111111111111111111111111112' };
  var DEC = { ORE: 11, SKR: 6, SOL: 9, USDC: 6 };
  var MAX_TX = 1232;
  var CU_PER_RECIPIENT_MINT = 32000;   // create-ATA-idempotent (~25k when it creates) + TransferChecked (~6k)

  function bytes(arr) { var B = (typeof Buffer !== 'undefined') ? Buffer : null; return B ? B.from(arr) : Uint8Array.from(arr); }
  function u64le(v) { var b = new Uint8Array(8), dv = new DataView(b.buffer); dv.setBigUint64(0, BigInt(v), true); return b; }
  function u32le(v) { var b = new Uint8Array(4), dv = new DataView(b.buffer); dv.setUint32(0, v >>> 0, true); return b; }
  function cat() { var n = 0, i, o = 0; for (i = 0; i < arguments.length; i++) n += arguments[i].length; var out = new Uint8Array(n); for (i = 0; i < arguments.length; i++) { out.set(arguments[i], o); o += arguments[i].length; } return out; }

  function ataAddress(W3, owner, mint) {
    return W3.PublicKey.findProgramAddressSync([new W3.PublicKey(owner).toBytes(), new W3.PublicKey(TOKEN).toBytes(), new W3.PublicKey(mint).toBytes()], new W3.PublicKey(ATA))[0];
  }
  function meta(W3, k, s, w) { return { pubkey: new W3.PublicKey(k), isSigner: !!s, isWritable: !!w }; }
  function ix(W3, programId, keys, data) { return new W3.TransactionInstruction({ programId: new W3.PublicKey(programId), keys: keys, data: bytes(data) }); }

  // [create recipient ATA (idempotent — no-op if it exists), TransferChecked payer→recipient]
  function transferIxs(W3, payer, t) {
    var src = ataAddress(W3, payer, t.mint), dst = ataAddress(W3, t.owner, t.mint);
    return [
      ix(W3, ATA, [meta(W3, payer, true, true), meta(W3, dst, false, true), meta(W3, t.owner, false, false), meta(W3, t.mint, false, false), meta(W3, SYS, false, false), meta(W3, TOKEN, false, false)], [1]),
      ix(W3, TOKEN, [meta(W3, src, false, true), meta(W3, t.mint, false, false), meta(W3, dst, false, true), meta(W3, payer, true, false)], cat([12], u64le(t.amount), [t.decimals])),
    ];
  }
  function computeIxs(W3, units, microLamports) {
    var out = [ix(W3, CB, [], cat([2], u32le(units)))];
    if (microLamports > 0) out.push(ix(W3, CB, [], cat([3], u64le(microLamports))));
    return out;
  }
  function compile(W3, payer, blockhash, transfers, cuPrice) {
    var ixs = computeIxs(W3, Math.min(1400000, 5000 + CU_PER_RECIPIENT_MINT * transfers.length), cuPrice);
    transfers.forEach(function (t) { ixs = ixs.concat(transferIxs(W3, payer, t)); });
    var msg = new W3.TransactionMessage({ payerKey: new W3.PublicKey(payer), recentBlockhash: blockhash, instructions: ixs }).compileToV0Message();
    return new W3.VersionedTransaction(msg);
  }
  function sizeOf(tx) { try { return tx.serialize().length; } catch (e) { return Infinity; } }

  // Greedy pack, keeping each recipient's transfers together.
  function packTransfers(o) {
    var W3 = o.W3, payer = o.payer, bh = o.blockhash, cuPrice = o.cuPrice == null ? 20000 : o.cuPrice;
    var groups = [], byOwner = {};
    (o.transfers || []).forEach(function (t) { if (!(t.amount > 0)) return; if (!byOwner[t.owner]) { byOwner[t.owner] = []; groups.push(byOwner[t.owner]); } byOwner[t.owner].push(t); });
    var out = [], cur = [];
    function flush() { if (!cur.length) return; var tx = compile(W3, payer, bh, cur, cuPrice); out.push({ tx: tx, size: sizeOf(tx), transfers: cur, owners: cur.map(function (t) { return t.owner; }).filter(function (v, i, a) { return a.indexOf(v) === i; }) }); cur = []; }
    groups.forEach(function (g) {
      var tryList = cur.concat(g);
      if (sizeOf(compile(W3, payer, bh, tryList, cuPrice)) <= MAX_TX) { cur = tryList; return; }
      flush();
      if (sizeOf(compile(W3, payer, bh, g, cuPrice)) > MAX_TX) throw new Error('one recipient does not fit in a transaction');
      cur = g.slice();
    });
    flush();
    return out;
  }

  // proportional integer split of totalRaw by weights (remainder to the largest weights)
  function allocate(totalRaw, parts) {
    var res = {}, sum = 0, given = 0;
    parts.forEach(function (p) { sum += p.weight; });
    if (!(sum > 0) || !(totalRaw > 0)) { parts.forEach(function (p) { res[p.id] = 0; }); return res; }
    parts.forEach(function (p) { res[p.id] = Math.floor(totalRaw * p.weight / sum); given += res[p.id]; });
    var order = parts.slice().sort(function (a, b) { return b.weight - a.weight; });
    for (var k = 0, rem = totalRaw - given; rem > 0 && order.length; k++, rem--) res[order[k % order.length].id] += 1;
    return res;
  }
  function payable(plan, skipIds) {
    var ex = {}; (plan.excluded || []).forEach(function (id) { ex[id] = 1; });
    var paid = (plan.payment && plan.payment.paidIds) || {};
    return (plan.payees || []).filter(function (p) { return !ex[p.id] && !paid[p.id] && !(skipIds && skipIds[p.id]); });
  }
  function swapBuckets(plan, skipIds) {
    var b = { SOL: { total: 0, parts: [] }, USDC: { total: 0, parts: [] } };
    payable(plan, skipIds).forEach(function (p) {
      ['SOL', 'USDC'].forEach(function (c) { var v = p.pay[c] || 0; if (v > 0) { b[c].total += v; b[c].parts.push({ id: p.id, weight: v }); } });
    });
    return b;
  }
  function transfersForPlan(plan, swapOre, skipIds) {
    var out = [];
    payable(plan, skipIds).forEach(function (p) {
      var ore = (p.pay.ORE || 0) + ((swapOre && swapOre[p.id]) || 0);
      if (ore > 0) out.push({ id: p.id, owner: p.wallet, cur: 'ORE', mint: MINTS.ORE, decimals: DEC.ORE, amount: ore });
      if ((p.pay.SKR || 0) > 0) out.push({ id: p.id, owner: p.wallet, cur: 'SKR', mint: MINTS.SKR, decimals: DEC.SKR, amount: p.pay.SKR });
    });
    return out;
  }
  // totals still to send per token (raw)
  function need(plan, skipIds) {
    var t = { ORE: 0, SKR: 0, SOL: 0, USDC: 0 };
    payable(plan, skipIds).forEach(function (p) { ['ORE', 'SKR', 'SOL', 'USDC'].forEach(function (c) { t[c] += p.pay[c] || 0; }); });
    return t;
  }

  // Jupiter ExactIn swap X → ORE; minOut = the ORE guaranteed after slippage (what we hand out).
  function jupiterSwap(o) {
    var f = o.fetch || fetch, base = o.base || 'https://lite-api.jup.ag';
    var q = base + '/swap/v1/quote?inputMint=' + o.inputMint + '&outputMint=' + MINTS.ORE + '&amount=' + o.amount + '&swapMode=ExactIn&slippageBps=' + (o.slippageBps || 100);
    return f(q).then(function (r) { return r.json(); }).then(function (quote) {
      if (!quote || quote.error || !quote.outAmount) throw new Error('No swap route to ORE right now' + (quote && quote.error ? ' (' + quote.error + ')' : ''));
      return f(base + '/swap/v1/swap', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ quoteResponse: quote, userPublicKey: o.payer, wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true }) })
        .then(function (r) { return r.json(); }).then(function (s) {
          if (!s || !s.swapTransaction) throw new Error('The swap to ORE could not be built' + (s && s.error ? ' (' + s.error + ')' : ''));
          return { quote: quote, minOut: Number(quote.otherAmountThreshold || quote.outAmount), outAmount: Number(quote.outAmount), swapTransaction: s.swapTransaction };
        });
    });
  }

  return { MINTS: MINTS, DEC: DEC, TOKEN: TOKEN, ATA: ATA, MAX_TX: MAX_TX, ataAddress: ataAddress, transferIxs: transferIxs, packTransfers: packTransfers,
    allocate: allocate, swapBuckets: swapBuckets, transfersForPlan: transfersForPlan, need: need, payable: payable, jupiterSwap: jupiterSwap };
});
