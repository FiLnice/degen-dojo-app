/* Dojo Buy — shared "buy any Solana NFT in ORE/SKR/SOL" engine, extracted from the store so
 * SHELVES can buy inline (no redirect). Same reverse-engineered Magic Eden (M2) layout the
 * store uses, verified with simulateTransaction. Reads the LIVE listing for any mint on-chain
 * (works for external collections), swaps ORE/SKR→SOL if needed, then buys — simulating first
 * so a stale listing fails before the user signs.
 *
 *   await DojoBuy.buy({ mint, currency:'SOL'|'ORE'|'SKR', adapter, rpcUrl:'/api/rpc',
 *                       jup:'https://lite-api.jup.ag', onState:fn })
 *   adapter = a wallet adapter with .pubkey + .signAndSendTransaction(txObjectOrBytes)->{signature}
 * Needs window.solanaWeb3 (web3.js) + window.Buffer (polyfill) loaded first.
 */
(function (global) {
  var M2_PROGRAM = 'M2mx93ekt1fmXSVkTrUL9xVFHkmME8HTUi5Cyc5aF7K';
  var ME_AH = 'E8cU1WiRWjanGxmn96ewBgk9vPTcL6AEZ1t6F6fkgUWe';
  var ME_NOTARY = 'NTYeYJ1wr4bpM5xo6zx5En44SvJFAd35zTxxNoERYqd';
  var ME_ESCROW = '1BWutmTvYPwDtmw9abTkS4Ssr8no61spGAvW1X6NDix';
  var ME_FEE = 'rFqFJ9g7TGBD8Ed7TPDnvGKZ5pWLPDyxLcvcH2eRCtt';
  var ME_REF = 'autMW8SgBkVYeBgqYiTuJZnkvDZMVU2MHJh9Jh7CSQ2';
  var TMP_ID = 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s';
  var AUTH_ID = 'auth9SigNpDKz4sJJ1DfCTuZrZNSAgh9sFD3rboVmgg';
  var RULESET_ID = 'AdH2Utn6Fus15ZhtenW4hZBQnvtLgM1YCW2MfVp7pYS5';
  var TOKEN_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
  var ATA_ID = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
  var MINTS = { SOL: 'So11111111111111111111111111111111111111112', ORE: 'oreoU2P8bN6jkk3jbaiVxYnG1dCXcYxwhwyK9jSybcp', SKR: 'SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3' };
  var M2_SELL_DISCS = { 'a40e5c647b39eacc': 1, '01ee48898a15fef9': 1, 'c3372e293607e19b': 1 };
  var SWAP_SLIPPAGE_BPS = 100;

  var W3 = function () { return global.solanaWeb3; };
  var PK = function (s) { return new (W3().PublicKey)(s); };
  var pda = function (seeds, programId) { return W3().PublicKey.findProgramAddressSync(seeds, PK(programId))[0]; };
  var utf8 = function (s) { return new TextEncoder().encode(s); };
  var b64 = function (bytes) { return btoa(String.fromCharCode.apply(null, new Uint8Array(bytes))); };
  var hexBytes = function (h) { return Uint8Array.from(h.match(/../g).map(function (b) { return parseInt(b, 16); })); };
  function ixData(hexDisc, fields) {
    var total = 8 + fields.reduce(function (n, f) { return n + f[0]; }, 0);
    var buf = new Uint8Array(total); buf.set(hexBytes(hexDisc), 0);
    var dv = new DataView(buf.buffer), o = 8;
    for (var i = 0; i < fields.length; i++) { var sz = fields[i][0], v = fields[i][1];
      if (sz === 8) dv.setBigUint64(o, BigInt(v), true); else if (sz === 4) dv.setUint32(o, Number(v), true);
      else if (sz === 2) dv.setUint16(o, Number(v), true); else if (sz === 1) dv.setUint8(o, Number(v)); o += sz; }
    return buf;
  }
  var ataOf = function (owner, mint) { return pda([owner.toBuffer(), PK(TOKEN_ID).toBuffer(), mint.toBuffer()], ATA_ID); };
  var metaOf = function (mint) { return pda([utf8('metadata'), PK(TMP_ID).toBuffer(), mint.toBuffer()], TMP_ID); };
  var edOf = function (mint) { return pda([utf8('metadata'), PK(TMP_ID).toBuffer(), mint.toBuffer(), utf8('edition')], TMP_ID); };
  var trOf = function (mint, tok) { return pda([utf8('metadata'), PK(TMP_ID).toBuffer(), mint.toBuffer(), utf8('token_record'), tok.toBuffer()], TMP_ID); };

  var RPC = '/api/rpc';
  function rpcCall(method, params) {
    return fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: method, params: params }) })
      .then(function (r) { return r.json(); }).then(function (j) { if (j.error) throw new Error(j.error.message); return j.result; });
  }
  function readRoyaltyB(mint) {
    return rpcCall('getAccountInfo', [metaOf(PK(mint)).toBase58(), { encoding: 'base64' }]).then(function (r) {
      // No Token-Metadata account = this isn't a standard Metaplex NFT (e.g. Metaplex Core or
      // Token-2022). The M2 buy layout below only fits standard NFTs, so flag it for a fallback.
      if (!r || !r.value) return { creators: [], royaltyBps: 0, ruleSet: null, standard: false };
      var b = global.Buffer.from(r.value.data[0], 'base64'), o = 1 + 32 + 32;
      var skip = function () { var n = b.readUInt32LE(o); o += 4; o += n; };
      skip(); skip(); skip();
      var royaltyBps = b.readUInt16LE(o); o += 2; var creators = [];
      if (b[o++]) { var n = b.readUInt32LE(o); o += 4; for (var i = 0; i < n; i++) { creators.push(PK(b.subarray(o, o + 32)).toBase58()); o += 34; } }
      var ruleSet = null;
      try { o += 1; o += 1; if (b[o++]) o += 1; if (b[o++]) o += 1; if (b[o++]) o += 33; if (b[o++]) o += 17; if (b[o++]) o += 9;
        if (b[o++]) { o += 1; if (b[o++]) { ruleSet = PK(b.subarray(o, o + 32)).toBase58(); o += 32; } } } catch (e) { ruleSet = null; }
      return { creators: creators, royaltyBps: royaltyBps, ruleSet: ruleSet, standard: true };
    });
  }
  function resolveListing(mint) {
    // Retry the account scan a couple times: getProgramAccounts on a busy RPC intermittently returns
    // an empty set for a listing that's really there. A genuine miss (sold / AMM-pool listing with no
    // M2 sell-state) still resolves to null after the retries → caller can fall back to ME's builder.
    function scan(tries) {
      return rpcCall('getProgramAccounts', [M2_PROGRAM, { encoding: 'base64', filters: [{ memcmp: { offset: 112, bytes: mint } }] }]).then(function (res) {
        for (var i = 0; i < (res || []).length; i++) {
          var b = global.Buffer.from(res[i].account.data[0], 'base64');
          if (!M2_SELL_DISCS[b.subarray(0, 8).toString('hex')]) continue;
          var price = b.readBigUInt64LE(104); if (price === 0n) continue;
          return { seller: PK(b.subarray(40, 72)).toBase58(), sellerReferral: PK(b.subarray(72, 104)).toBase58(), priceLamports: price, tokenAccount: PK(b.subarray(144, 176)).toBase58() };
        }
        if (tries > 0) return new Promise(function (r) { setTimeout(r, 600); }).then(function () { return scan(tries - 1); });
        return null;
      }, function (err) { if (tries > 0) return new Promise(function (r) { setTimeout(r, 600); }).then(function () { return scan(tries - 1); }); throw err; });
    }
    return scan(2).then(function (state) {
      if (!state) return null;
      return rpcCall('getAccountInfo', [state.tokenAccount, { encoding: 'jsonParsed' }]).then(function (tok) {
        var tokenOwner = tok && tok.value && tok.value.data && tok.value.data.parsed && tok.value.data.parsed.info.owner || null;
        return readRoyaltyB(mint).then(function (rr) {
          var priceSol = Number(state.priceLamports) / 1e9;
          return { mint: mint, seller: state.seller, sellerReferral: state.sellerReferral, price: priceSol, royaltyBps: rr.royaltyBps,
            priceAllIn: priceSol * (1 + rr.royaltyBps / 1e4 + 0.02), creators: rr.creators, tokenAccount: state.tokenAccount, tokenOwner: tokenOwner, ruleSet: rr.ruleSet,
            standard: rr.standard, magicEdenUrl: 'https://magiceden.io/item-details/' + mint, source: 'magiceden' };
        });
      });
    });
  }
  function buildM2BuyIxs(buyer, listing, buyerReferral) {
    var W = W3(), SystemProgram = W.SystemProgram, SYSVAR_INSTRUCTIONS_PUBKEY = W.SYSVAR_INSTRUCTIONS_PUBKEY, SYSVAR_RENT_PUBKEY = W.SYSVAR_RENT_PUBKEY;
    var mint = PK(listing.mint), seller = PK(listing.seller), price = Math.round(listing.price * 1e9);
    var srcTok = listing.tokenAccount ? PK(listing.tokenAccount) : ataOf(PK(ME_ESCROW), mint);
    var srcOwner = listing.tokenOwner ? PK(listing.tokenOwner) : PK(ME_ESCROW);
    var ruleSet = listing.ruleSet ? PK(listing.ruleSet) : PK(RULESET_ID);
    var buyerTok = ataOf(buyer, mint), meta = metaOf(mint);
    var buyerEscrow = pda([utf8('m2'), PK(ME_AH).toBuffer(), buyer.toBuffer()], M2_PROGRAM);
    var buyerTS = pda([utf8('m2'), buyer.toBuffer(), PK(ME_AH).toBuffer(), mint.toBuffer()], M2_PROGRAM);
    var sellerTS = pda([utf8('m2'), seller.toBuffer(), PK(ME_AH).toBuffer(), srcTok.toBuffer(), mint.toBuffer()], M2_PROGRAM);
    var sRef = PK(listing.sellerReferral || ME_REF), bRef = PK(buyerReferral || ME_REF);
    var a = function (pubkey, isSigner, isWritable) { return { pubkey: pubkey, isSigner: isSigner, isWritable: isWritable }; };
    var buyData = ixData('b817ee6167c5d33d', [[8, price], [8, 1], [8, 0], [2, 10000], [4, 0]]);
    var extra = Math.ceil(price * ((listing.royaltyBps || 0) + 200) / 10000);
    var exData = ixData('eca3ccad4790eb76', [[8, price], [2, 0], [2, 200]]);
    return [
      { programId: PK(M2_PROGRAM), data: buyData, keys: [a(buyer, true, true), a(PK(ME_NOTARY), false, false), a(mint, false, false), a(meta, false, true), a(buyerEscrow, false, true), a(bRef, false, true), a(PK(ME_AH), false, false), a(buyerTS, false, true), a(bRef, false, true), a(PK(TOKEN_ID), false, false), a(SystemProgram.programId, false, false)] },
      SystemProgram.transfer({ fromPubkey: buyer, toPubkey: buyerEscrow, lamports: extra }),
      { programId: PK(M2_PROGRAM), data: exData, keys: [a(buyer, true, true), a(buyer, true, true), a(seller, false, true), a(PK(ME_NOTARY), false, false), a(srcOwner, false, false), a(srcTok, false, true), a(buyerTok, false, true), a(mint, false, false), a(meta, false, true), a(PK(ME_AH), false, false), a(PK(ME_FEE), false, true), a(sellerTS, false, true), a(buyerTS, false, true), a(buyerEscrow, false, true), a(bRef, false, true), a(sRef, false, true), a(PK(TMP_ID), false, false), a(edOf(mint), false, false), a(PK(AUTH_ID), false, false), a(ruleSet, false, false), a(trOf(mint, srcTok), false, true), a(trOf(mint, buyerTok), false, true), a(SYSVAR_INSTRUCTIONS_PUBKEY, false, false), a(PK(ATA_ID), false, false), a(PK(TOKEN_ID), false, false), a(SystemProgram.programId, false, false), a(SYSVAR_RENT_PUBKEY, false, false)].concat((listing.creators || []).map(function (c) { return a(PK(c), false, true); })) },
    ];
  }
  function waitForConfirm(signature) {
    var tries = 0;
    return new Promise(function (resolve, reject) {
      (function loop() {
        rpcCall('getSignatureStatuses', [[signature]]).then(function (st) {
          var s = st.value && st.value[0];
          if (s && s.err) return reject(new Error('The transaction failed on chain.'));
          if (s && (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized')) return resolve();
          if (++tries > 40) return reject(new Error('Timed out waiting for confirmation — check your wallet.'));
          setTimeout(loop, 1500);
        }).catch(function () { if (++tries > 40) reject(new Error('confirm failed')); else setTimeout(loop, 1500); });
      })();
    });
  }
  // Sign with the wallet, then broadcast through OUR RPC (Helius) instead of the wallet's own
  // sender — some wallets (e.g. Jupiter) broadcast via wallet-api.jup.ag, which intermittently 500s.
  // Falls back to the wallet's signAndSend if it can't sign-only.
  function signAndBroadcast(adapter, txObj, onState) {
    // Default: the wallet signs AND sends (exactly like the working store buy).
    return adapter.signAndSendTransaction(txObj).then(function (sig) { return sig.signature || sig; })
      .catch(function (err) {
        var m = (err && err.message) || '';
        // ONLY if the wallet's own broadcaster fails (e.g. jup.ag 500, timeout) do we retry:
        // sign-only, then broadcast through our Helius RPC. Never for a user cancel or a real sim error.
        var broadcastFail = /broadcast|jup\.ag|failed to send|timed out|502|503|500|network/i.test(m);
        var cancelled = err && (err.code === 4001 || /reject|declin|denied|cancel|abort/i.test(m));
        if (!cancelled && broadcastFail && typeof adapter.signTransaction === 'function') {
          onState && onState('Retrying through Dojo RPC…');
          var serialized; try { serialized = txObj.serialize(); } catch (_) { serialized = txObj; }
          return adapter.signTransaction(serialized).then(function (signed) {
            var bytes = signed instanceof Uint8Array ? signed : new Uint8Array(signed);
            return rpcCall('sendTransaction', [b64(bytes), { skipPreflight: true, maxRetries: 3, encoding: 'base64' }]);
          });
        }
        throw err;
      });
  }
  // Total raw balance the owner holds of a given SPL mint (across token accounts). null on error.
  function tokenBalanceRaw(owner, mint) {
    return rpcCall('getTokenAccountsByOwner', [owner, { mint: mint }, { encoding: 'jsonParsed' }]).then(function (res) {
      var accts = (res && res.value) || [], total = 0;
      for (var i = 0; i < accts.length; i++) { var a = accts[i].account.data.parsed.info.tokenAmount; total += Number(a.amount); }
      return total;
    }).catch(function () { return null; });   // best-effort — if it fails, we just skip the pre-check
  }
  // Build (but do NOT send) the ORE/SKR→SOL swap as an unsigned VersionedTransaction with a fresh
  // blockhash. Shared by the two-step flow (swapToSol) and the one-approval flow (batched sign).
  function buildSwapTx(listing, currency, adapter, JUP, onState) {
    // The swap only funds the NFT's PRICE. The buy is a separate tx whose rent (~0.002) and network
    // fee are paid from the buyer's own SOL (they hold SOL to sign anyway). So keep this pad tiny —
    // just ExactOut slippage rounding. A bigger pad forces the swap to pull more of the pay-token
    // than a thin wallet holds, and the ExactOut swap then fails ("will likely fail") even though
    // the buy itself is affordable.
    var need = Math.ceil((listing.priceAllIn + 0.002) * 1e9);
    var inputMint = currency === 'ORE' ? MINTS.ORE : MINTS.SKR;
    onState && onState('Quoting ' + currency + '…');
    return fetch(JUP + '/swap/v1/quote?inputMint=' + inputMint + '&outputMint=' + MINTS.SOL + '&amount=' + need + '&swapMode=ExactOut&slippageBps=' + SWAP_SLIPPAGE_BPS)
      .then(function (r) { return r.json(); }).then(function (q) {
        if (q.error) throw new Error('No ' + currency + ' route right now — try SOL.');
        // Check the buyer actually holds enough of the pay-token BEFORE building/signing anything, so
        // we can show a clean "not enough ORE" notice instead of a cryptic wallet simulation failure.
        return tokenBalanceRaw(adapter.pubkey, inputMint).then(function (balRaw) {
          var maxIn = Number(q.otherAmountThreshold || q.inAmount || 0);
          if (balRaw != null && maxIn > 0 && balRaw < maxIn) {
            var dec = currency === 'ORE' ? 1e11 : 1e6, dp = currency === 'ORE' ? 4 : 2;
            throw new Error('Not enough ' + currency + ' — this buy needs about ' + (maxIn / dec).toFixed(dp) + ' ' + currency + ' and you have ' + (balRaw / dec).toFixed(dp) + '. Nothing was swapped.');
          }
          return q;
        });
      }).then(function (q) {
        return fetch(JUP + '/swap/v1/swap', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ quoteResponse: q, userPublicKey: adapter.pubkey, wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true }) })
          .then(function (r) { return r.json(); }).then(function (s) {
            if (!s.swapTransaction) throw new Error('The ' + currency + ' swap could not be built.');
            var raw = Uint8Array.from(atob(s.swapTransaction), function (ch) { return ch.charCodeAt(0); });
            // Hand Jupiter's transaction to the wallet UNTOUCHED — exactly like the working store swap.
            // Jupiter's blockhash is fresh (its /swap call just returned) and Phantom can see it. MUTATING
            // the blockhash on the deserialized versioned tx made Phantom reject it ("Simulation failed"),
            // which is why the shelves failed while the store — which never touches it — succeeded.
            return W3().VersionedTransaction.deserialize(raw);
          });
      });
  }
  // Two-step swap: build → sign+broadcast → wait. Used when the wallet can't batch-sign.
  function swapToSol(listing, currency, adapter, JUP, onState) {
    return buildSwapTx(listing, currency, adapter, JUP, onState).then(function (swapTx) {
      onState && onState('Approve the ' + currency + ' swap…');
      return signAndBroadcast(adapter, swapTx, onState).then(function (sig) { onState && onState('Confirming the swap…'); return waitForConfirm(sig); });
    });
  }
  // Build (but do NOT send) our own M2 buy as an unsigned VersionedTransaction. Same instructions
  // payAndBuy uses — only standard NFTs (Core/pNFT go through Magic Eden's builder in two-step).
  function buildOurBuyTx(listing, adapter, buyerReferral, blockhash) {
    var W = W3(), buyer = PK(adapter.pubkey);
    var ixs = [W.ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }), W.ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1400000 })].concat(buildM2BuyIxs(buyer, listing, buyerReferral));
    var msg = new W.TransactionMessage({ payerKey: buyer, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message();
    return new W.VersionedTransaction(msg);
  }
  // ONE-APPROVAL pay-in-token: the wallet signs the swap AND the buy in a SINGLE prompt, then we
  // broadcast the swap, wait for it to land, and broadcast the pre-signed buy. Returns a buy
  // signature, or null (BEFORE anything is broadcast) when this path can't apply — so the caller can
  // safely fall back to the two-step flow. Once signed+broadcast, any failure REJECTS (never falls
  // back, so the swap can't run twice).
  function oneApprovalTokenBuy(opts, listing, currency, adapter, JUP, onState) {
    if (listing.standard === false || typeof adapter.signAll !== 'function') return Promise.resolve(null);
    onState && onState('Preparing your ' + currency + ' payment…');
    return buildSwapTx(listing, currency, adapter, JUP, onState).then(function (swapTx) {
      return rpcCall('getLatestBlockhash', [{ commitment: 'confirmed' }]).then(function (bh) {
        var buyTx = buildOurBuyTx(listing, adapter, opts.buyerReferral, bh.value.blockhash);
        onState && onState('Approve once — pay in ' + currency + '…');
        return adapter.signAll([swapTx, buyTx]).then(function (signed) {
          var sSwap = signed[0] instanceof Uint8Array ? signed[0] : new Uint8Array(signed[0]);
          var sBuy = signed[1] instanceof Uint8Array ? signed[1] : new Uint8Array(signed[1]);
          onState && onState('Swapping ' + currency + ' → SOL…');
          return rpcCall('sendTransaction', [b64(sSwap), { skipPreflight: true, maxRetries: 3, encoding: 'base64' }]).then(function (swapSig) {
            return waitForConfirm(swapSig).then(function () {
              onState && onState('Buying your NFT…');
              return rpcCall('sendTransaction', [b64(sBuy), { skipPreflight: false, maxRetries: 3, encoding: 'base64' }]).then(function (buySig) {
                onState && onState('Confirming…');
                return waitForConfirm(buySig).then(function () { return buySig; });
              });
            });
          });
        }, function (signErr) {
          // Rejected at the SIGN step — nothing broadcast yet, so it's safe to decide here.
          var m = (signErr && signErr.message) || '';
          if (/cannot sign multiple|not.*support|signAll/i.test(m)) return null;   // wallet can't batch → fall back
          throw signErr;                                                            // user cancelled / real error
        });
      });
    });
  }
  function payAndBuy(listing, adapter, buyerReferral, onState) {
    var W = W3(), buyer = PK(adapter.pubkey);
    onState && onState('Building the transaction…');
    var ixs = [W.ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }), W.ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1400000 })].concat(buildM2BuyIxs(buyer, listing, buyerReferral));
    return rpcCall('getLatestBlockhash', [{ commitment: 'confirmed' }]).then(function (bh) {
      var blockhash = bh.value.blockhash;
      var msg = new W.TransactionMessage({ payerKey: buyer, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message();
      var tx = new W.VersionedTransaction(msg);
      onState && onState('Checking it against the chain…');
      return rpcCall('simulateTransaction', [b64(tx.serialize()), { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed' }]).then(function (sim) {
        if (sim.value.err) {
          console.error('sim failed', sim.value);
          var logs = (sim.value.logs || []).join('\n');
          // The most common real-world failure: the wallet can't cover price + fees + rent.
          if (/insufficient lamports|insufficient funds/i.test(logs)) {
            var m = logs.match(/need (\d+)/); var needSol = m ? (Number(m[1]) / 1e9) : null;
            throw new Error('Not enough SOL in this wallet' + (needSol ? ' — this buy needs about ' + needSol.toFixed(3) + ' SOL' : '') + '. Nothing was signed.');
          }
          if (/already in use|AccountAlreadyInitialized/i.test(logs)) throw new Error('You may already own this NFT. Nothing was signed.');
          throw new Error('The listing may have just sold or changed price. Nothing was signed.');
        }
        onState && onState('Approve in your wallet…');
        return adapter.signAndSendTransaction(tx).then(function (sig) { var s = sig.signature || sig; onState && onState('Confirming…'); return waitForConfirm(s).then(function () { return s; }); });
      });
    });
  }

  // Universal path: let Magic Eden build the buy tx (handles regular NFTs, pNFTs AND Core). Returns
  // a signature on success, or null when the store has no ME key configured (→ inline fallback).
  // Fetch ME's built buy tx (deserialized), or null when ME can't build it (no key, or — like our own
  // resolver — no M2 sell-state for a pool/Tensor listing). NO side effects, so it's safe to call as a
  // PRE-FLIGHT before swapping: if this returns null, the buy can't complete and we must NOT swap.
  function fetchMEBuyTx(opts) {
    var meUrl = (opts.rpcUrl || '/api/rpc').replace(/\/rpc(\?|$)/, '/mebuy$1');
    // Pass ME's own listing data (from /api/listings) so mebuy can build POOL listings, which have no
    // M2 sell-state for its on-chain scan to find. Harmless for M2 listings (the scan wins there).
    var extra = '';
    if (opts.fallbackSeller) extra += '&seller=' + encodeURIComponent(opts.fallbackSeller);
    if (opts.fallbackPrice) extra += '&price=' + encodeURIComponent(opts.fallbackPrice);
    if (opts.fallbackTokenATA) extra += '&tokenATA=' + encodeURIComponent(opts.fallbackTokenATA);
    return fetch(meUrl + '?mint=' + encodeURIComponent(opts.mint) + '&buyer=' + encodeURIComponent(opts.adapter.pubkey) + extra)
      .then(function (r) { return r.json().then(function (j) { return { status: r.status, j: j }; }); })
      .then(function (res) {
        if (res.status === 501 || (res.j && res.j.needKey)) return null;
        if (!res.j || !res.j.txBase64) return null;
        var W = W3();
        var raw = Uint8Array.from(atob(res.j.txBase64), function (c) { return c.charCodeAt(0); });
        return res.j.versioned ? W.VersionedTransaction.deserialize(raw) : W.Transaction.from(raw);
      });
  }
  // PRE-FLIGHT a ME buy: build it AND simulate it, so we only swap when the buy will actually work.
  // Returns the tx when it's structurally sound (sim passes, OR fails ONLY because the buyer doesn't
  // have the SOL yet — which the swap is about to provide). Returns null when ME can't build it, or the
  // built tx fails simulation for a REAL reason (e.g. buy_now returned a bogus tx for a pool listing) —
  // in which case we must NOT swap. This is what stops "swapped ORE but the buy failed" strandings.
  function probeMEBuyTx(opts) {
    return fetchMEBuyTx(opts).then(function (tx) {
      if (!tx) return null;
      var W = W3(), isV0 = tx instanceof W.VersionedTransaction;
      var b64tx = isV0 ? b64(tx.serialize()) : b64(tx.serialize({ requireAllSignatures: false, verifySignatures: false }));
      return rpcCall('simulateTransaction', [b64tx, { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed' }]).then(function (sim) {
        if (!sim.value.err) return tx;                                   // fully valid
        var logs = (sim.value.logs || []).join('\n');
        if (/insufficient lamports|insufficient funds|debit an account/i.test(logs)) return tx;  // only needs the SOL the swap provides
        return null;                                                     // real failure → don't swap
      }, function () { return tx; });   // sim RPC itself errored → don't block a possibly-fine buy
    });
  }
  // Simulate, then sign+send a ME-built buy tx.
  function sendMEBuyTx(tx, adapter, onState) {
    var W = W3(), isV0 = tx instanceof W.VersionedTransaction;
    onState && onState('Checking it against the chain…');
    var b64tx = isV0 ? b64(tx.serialize()) : b64(tx.serialize({ requireAllSignatures: false, verifySignatures: false }));
    return rpcCall('simulateTransaction', [b64tx, { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: false, commitment: 'confirmed' }]).then(function (sim) {
      if (sim.value.err) {
        var logs = (sim.value.logs || []).join('\n');
        if (/insufficient lamports|insufficient funds/i.test(logs)) throw new Error('Not enough SOL in this wallet to cover the price + fees. Nothing was signed.');
        throw new Error('The listing may have just sold or changed price. Nothing was signed.');
      }
      onState && onState('Approve in your wallet…');
      return adapter.signAndSendTransaction(tx).then(function (sig) { var s = sig.signature || sig; onState && onState('Confirming…'); return waitForConfirm(s).then(function () { return s; }); });
    });
  }
  // Tensor AGGREGATOR buy — builds a buy tx for ANY listing, including Magic Eden AMM/MMM pools that
  // ME's own public API can't build (pool fulfills need ME's cosigner, which Tensor's backend supplies).
  // Returns the deserialized tx, or null if Tensor has no key / can't build it. No side effects → safe
  // as a pre-flight before swapping. maxPrice/royalty come from the resolved/fallback listing.
  function fetchTensorBuyTx(opts, listing) {
    var url = (opts.rpcUrl || '/api/rpc').replace(/\/rpc(\?|$)/, '/tensorbuy$1');
    var maxPrice = ((listing.priceAllIn || listing.price) * 1.05).toFixed(6);   // 5% headroom over all-in
    var qs = '?mint=' + encodeURIComponent(opts.mint) + '&buyer=' + encodeURIComponent(opts.adapter.pubkey) + '&maxPrice=' + maxPrice;
    if (listing.seller) qs += '&owner=' + encodeURIComponent(listing.seller);
    if (listing.royaltyBps != null) qs += '&royaltyPct=' + Math.round(listing.royaltyBps / 100);
    return fetch(url + qs).then(function (r) { return r.json().then(function (j) { return { status: r.status, j: j }; }); })
      .then(function (res) {
        if (res.status === 501 || (res.j && res.j.needKey)) return null;
        if (!res.j || !res.j.txBase64) return null;
        var W = W3(), raw = Uint8Array.from(atob(res.j.txBase64), function (c) { return c.charCodeAt(0); });
        return res.j.versioned ? W.VersionedTransaction.deserialize(raw) : W.Transaction.from(raw);
      }).catch(function () { return null; });
  }
  // Build + simulate a Tensor buy — same safe pre-flight logic as probeMEBuyTx (proceed only if the tx
  // is sound or merely lacks the SOL the swap is about to add; never swap for a genuinely broken tx).
  function probeTensorBuyTx(opts, listing) {
    return fetchTensorBuyTx(opts, listing).then(function (tx) {
      if (!tx) return null;
      var W = W3(), isV0 = tx instanceof W.VersionedTransaction;
      var b64tx = isV0 ? b64(tx.serialize()) : b64(tx.serialize({ requireAllSignatures: false, verifySignatures: false }));
      return rpcCall('simulateTransaction', [b64tx, { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed' }]).then(function (sim) {
        if (!sim.value.err) return tx;
        var logs = (sim.value.logs || []).join('\n');
        if (/insufficient lamports|insufficient funds|debit an account/i.test(logs)) return tx;
        return null;
      }, function () { return tx; });
    });
  }
  // Universal path: let Magic Eden build the buy tx (handles regular NFTs, pNFTs AND Core). Returns a
  // signature on success, or null when ME can't build it (→ inline engine for standard NFTs).
  function tryMagicEden(opts, listing) {
    opts.onState && opts.onState('Building the transaction…');
    return fetchMEBuyTx(opts).then(function (tx) {
      if (!tx) return null;
      return sendMEBuyTx(tx, opts.adapter, opts.onState);
    });
  }

  function buy(opts) {
    RPC = opts.rpcUrl || '/api/rpc';
    var JUP = opts.jup || 'https://lite-api.jup.ag';
    var currency = opts.currency || 'SOL', adapter = opts.adapter, onState = opts.onState;
    if (!adapter) return Promise.reject(new Error('Connect a wallet first.'));
    if (!W3()) return Promise.reject(new Error('Wallet library still loading — one moment.'));
    onState && onState('Finding the live listing…');
    // A token buy still needs a little SOL of its own: the ORE/SKR→SOL swap creates a temporary wSOL
    // account (~0.002 SOL rent, refunded when it closes) and every tx pays a network fee. With a
    // near-empty SOL balance the swap can't even simulate, so check up front and say so plainly
    // instead of leaving the user staring at a cryptic "Simulation failed" in their wallet.
    var checkFunds = currency === 'SOL' ? Promise.resolve() : rpcCall('getBalance', [adapter.pubkey]).then(function (bal) {
      var lamports = (bal && bal.value != null) ? bal.value : (typeof bal === 'number' ? bal : 0);
      if (lamports < 3000000) throw new Error('Add a little SOL to your wallet (~0.005). Even paying in ' + currency + ', Solana needs SOL for the swap’s temporary account and network fees — you have ' + (lamports / 1e9).toFixed(4) + ' SOL.');
    });
    return checkFunds.then(function () { return resolveListing(opts.mint); }).then(function (listing) {
      if (!listing) {
        // Our M2 decoder found no sell-state (AMM-pool listing, or a variant we don't decode). If the
        // caller passed the shelf's live price, we can still buy through Magic Eden's OWN builder — we
        // just need a price to size the ORE/SKR swap. Over-fund a touch (ME's buy pays the exact amount;
        // any surplus SOL is harmless dust) so an unknown-royalty pool listing can't underfund the buy.
        if (opts.fallbackPrice > 0) {
          var royFrac = Math.max((opts.fallbackRoyaltyBps || 0) / 1e4, 0.075);   // floor at 7.5% — most pool collections enforce royalty
          listing = { mint: opts.mint, price: opts.fallbackPrice, royaltyBps: Math.round(royFrac * 1e4),
            priceAllIn: opts.fallbackPrice * (1 + royFrac + 0.02 + 0.01), standard: true, _fallback: true,
            seller: opts.fallbackSeller || null,   // ME's listing owner — Tensor/ME builders use it (else resolved on-chain)
            magicEdenUrl: 'https://magiceden.io/item-details/' + opts.mint, source: 'magiceden' };
        } else {
          throw new Error('No live Magic Eden listing for that NFT — it may have sold, delisted, or be listed only on Tensor.');
        }
      }
      // Paying in a token for a standard NFT with a batch-signing wallet → ONE prompt (swap + buy signed
      // together). NOT for _fallback listings: our M2 engine can't build those (no seller/token data),
      // so they must go through ME's builder in the two-step flow.
      var canOne = !listing._fallback && currency !== 'SOL' && listing.standard !== false && typeof adapter.signAll === 'function';
      var flow = canOne
        ? oneApprovalTokenBuy(opts, listing, currency, adapter, JUP, onState).then(function (sig) { return sig || twoStepBuy(opts, listing, currency, adapter, JUP, onState); })
        : twoStepBuy(opts, listing, currency, adapter, JUP, onState);
      return flow.catch(function (err) {
        var msg = (err && err.message) || '';
        // If the USER cancelled the wallet popup, do NOT bounce them to Magic Eden — just stop.
        var cancelled = err.code === 4001 || /reject|declin|denied|cancel|user.*(refus|abort)|abort/i.test(msg);
        err.cancelled = cancelled;
        // Only for a genuine build/asset failure (pNFT/Core/variant) do we hand off to ME.
        if (!cancelled && listing.magicEdenUrl && !err.magicEdenUrl && !/Not enough|Add a little SOL/i.test(msg)) { err.magicEdenUrl = listing.magicEdenUrl; err.fallback = true; }
        throw err;
      });
    });
  }
  // The classic two-prompt flow: swap (if paying in a token), then buy via Magic Eden's builder,
  // falling back to our own M2 engine for standard NFTs. Used for SOL, for Core/pNFT, and whenever
  // the wallet can't batch-sign.
  function twoStepBuy(opts, listing, currency, adapter, JUP, onState) {
    var meOnly = listing._fallback || listing.standard === false;   // our own M2 engine can't build these
    // For a token payment on an ME-only listing, PRE-FLIGHT the ME build BEFORE swapping. If ME can't
    // build it (genuine pool/Tensor listing — same M2 lookup our resolver failed on), bounce to ME
    // WITHOUT touching the user's tokens. Only swap once we know the buy can actually complete.
    if (meOnly && currency !== 'SOL') {
      onState && onState('Checking this listing…');
      // Pre-flight ME first (M2 our resolver just missed), then the Tensor aggregator (pool/Tensor
      // listings ME's public API can't build). Only swap once one of them proves a sound buy tx.
      return probeMEBuyTx(opts).then(function (me) {
        if (me) return 'me';
        return probeTensorBuyTx(opts, listing).then(function (ts) { return ts ? 'tensor' : null; });
      }).then(function (route) {
        if (!route) { var e = new Error('This one isn’t available to buy in-app (it may have just sold, or it’s an unbuyable pool listing). Your ' + currency + ' was NOT swapped.'); e.magicEdenUrl = listing.magicEdenUrl; e.fallback = true; throw e; }
        return swapToSol(listing, currency, adapter, JUP, onState).then(function () {
          if (route === 'me') return tryMagicEden(opts, listing).then(function (sig) { if (sig) return sig; var e2 = new Error('Magic Eden could not finish the buy just now.'); e2.magicEdenUrl = listing.magicEdenUrl; e2.fallback = true; throw e2; });
          return fetchTensorBuyTx(opts, listing).then(function (tx) { if (!tx) { var e3 = new Error('Tensor could not finish the buy just now.'); e3.magicEdenUrl = listing.magicEdenUrl; e3.fallback = true; throw e3; } return sendMEBuyTx(tx, adapter, onState); });
        });
      });
    }
    var pre = currency === 'SOL' ? Promise.resolve() : swapToSol(listing, currency, adapter, JUP, onState);
    return pre.then(function () {
      return tryMagicEden(opts, listing).then(function (sig) {
        if (sig) return sig;
        if (meOnly) {   // Core / pool with no swap involved (SOL payment) → try Tensor, then hand off to ME
          return fetchTensorBuyTx(opts, listing).then(function (tx) {
            if (tx) return sendMEBuyTx(tx, adapter, onState);
            var e = new Error('This listing needs Magic Eden to finish the buy — opening it there.');
            e.magicEdenUrl = listing.magicEdenUrl; e.fallback = true; throw e;
          });
        }
        return payAndBuy(listing, adapter, opts.buyerReferral, onState);
      });
    });
  }

  global.DojoBuy = { buy: buy, resolveListing: resolveListing };
})(window);
