// Tiny QR code encoder (byte mode, ISO/IEC 18004) — no external service, no library.
// Used for Solana Pay links (e.g. the /repair page). Verified module-for-module against the `qrcode`
// npm package for every mask (scratchpad qr-verify test).
//
//   DojoQR.svg(text, { ecc: 'M', scale: 5, border: 4, dark: '#000', light: '#fff' }) → '<svg …>'
//   DojoQR.matrix(text, ecc, forcedMask?) → { size, modules: boolean[][] (modules[y][x], true = dark), mask, version }
(function (global) {
  // [L, M, Q, H] tables, index = version (0 unused)
  var ECC_PER_BLOCK = {
    L: [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    M: [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
    Q: [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    H: [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  };
  var NUM_BLOCKS = {
    L: [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
    M: [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
    Q: [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
    H: [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
  };
  var ECC_FORMAT = { L: 1, M: 0, Q: 3, H: 2 };

  function numRawDataModules(ver) {
    var r = (16 * ver + 128) * ver + 64;
    if (ver >= 2) { var na = Math.floor(ver / 7) + 2; r -= (25 * na - 10) * na - 55; if (ver >= 7) r -= 36; }
    return r;
  }
  function numDataCodewords(ver, ecl) { return Math.floor(numRawDataModules(ver) / 8) - ECC_PER_BLOCK[ecl][ver] * NUM_BLOCKS[ecl][ver]; }

  // GF(256) Reed–Solomon, primitive polynomial 0x11D
  function rsMul(x, y) { var z = 0; for (var i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11D); z ^= ((y >>> i) & 1) * x; } return z & 0xFF; }
  function rsDivisor(degree) {
    var res = []; for (var i = 0; i < degree - 1; i++) res.push(0); res.push(1);
    var root = 1;
    for (var k = 0; k < degree; k++) {
      for (var j = 0; j < res.length; j++) { res[j] = rsMul(res[j], root); if (j + 1 < res.length) res[j] ^= res[j + 1]; }
      root = rsMul(root, 0x02);
    }
    return res;
  }
  function rsRemainder(data, divisor) {
    var res = divisor.map(function () { return 0; });
    data.forEach(function (b) {
      var f = b ^ res.shift(); res.push(0);
      divisor.forEach(function (c, i) { res[i] ^= rsMul(c, f); });
    });
    return res;
  }

  function utf8Bytes(s) { return Array.from(new TextEncoder().encode(s)); }

  function encode(text, ecl, forcedMask) {
    ecl = ecl || 'M';
    var data = utf8Bytes(text), ver, cap;
    for (ver = 1; ver <= 40; ver++) {
      cap = numDataCodewords(ver, ecl) * 8;
      var ccBits = ver <= 9 ? 8 : 16;
      if (4 + ccBits + data.length * 8 <= cap) break;
    }
    if (ver > 40) throw new Error('QR: text too long');
    // bit stream: byte mode 0100, char count, data, terminator, pad
    var bits = [];
    var put = function (val, len) { for (var i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
    put(4, 4); put(data.length, ver <= 9 ? 8 : 16); data.forEach(function (b) { put(b, 8); });
    put(0, Math.min(4, cap - bits.length));
    put(0, (8 - bits.length % 8) % 8);
    for (var pad = 0xEC; bits.length < cap; pad ^= 0xEC ^ 0x11) put(pad, 8);
    var codewords = []; for (var i = 0; i < bits.length; i += 8) { var v = 0; for (var j = 0; j < 8; j++) v = (v << 1) | bits[i + j]; codewords.push(v); }

    // split into blocks, add ECC, interleave
    var numBlocks = NUM_BLOCKS[ecl][ver], blockEccLen = ECC_PER_BLOCK[ecl][ver], rawCodewords = Math.floor(numRawDataModules(ver) / 8);
    var numShort = numBlocks - rawCodewords % numBlocks, shortLen = Math.floor(rawCodewords / numBlocks);
    var blocks = [], div = rsDivisor(blockEccLen);
    for (var b = 0, k = 0; b < numBlocks; b++) {
      var dat = codewords.slice(k, k + shortLen - blockEccLen + (b < numShort ? 0 : 1)); k += dat.length;
      var ecc = rsRemainder(dat, div);
      if (b < numShort) dat.push(0);
      blocks.push(dat.concat(ecc));
    }
    var all = [];
    for (var x = 0; x < blocks[0].length; x++) blocks.forEach(function (blk, bi) { if (x !== shortLen - blockEccLen || bi >= numShort) all.push(blk[x]); });

    // matrix
    var size = ver * 4 + 17, M = [], F = [];
    for (var y = 0; y < size; y++) { M.push(new Array(size).fill(false)); F.push(new Array(size).fill(false)); }
    var setF = function (x, y, d) { M[y][x] = d; F[y][x] = true; };
    for (var t = 0; t < size; t++) { setF(6, t, t % 2 === 0); setF(t, 6, t % 2 === 0); }
    [[3, 3], [size - 4, 3], [3, size - 4]].forEach(function (c) {
      for (var dy = -4; dy <= 4; dy++) for (var dx = -4; dx <= 4; dx++) {
        var xx = c[0] + dx, yy = c[1] + dy, dist = Math.max(Math.abs(dx), Math.abs(dy));
        if (xx >= 0 && xx < size && yy >= 0 && yy < size) setF(xx, yy, dist !== 2 && dist !== 4);
      }
    });
    if (ver >= 2) {
      var na = Math.floor(ver / 7) + 2, step = ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (na * 2 - 2)) * 2, pos = [6];
      for (var p = size - 7; pos.length < na; p -= step) pos.splice(1, 0, p);
      for (var ai = 0; ai < na; ai++) for (var aj = 0; aj < na; aj++) {
        if ((ai === 0 && aj === 0) || (ai === 0 && aj === na - 1) || (ai === na - 1 && aj === 0)) continue;
        for (var ady = -2; ady <= 2; ady++) for (var adx = -2; adx <= 2; adx++) setF(pos[ai] + adx, pos[aj] + ady, Math.max(Math.abs(adx), Math.abs(ady)) !== 1);
      }
    }
    var drawFormat = function (mask) {
      var d = (ECC_FORMAT[ecl] << 3) | mask, rem = d;
      for (var i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
      var bitsF = ((d << 10) | rem) ^ 0x5412, g = function (i) { return ((bitsF >>> i) & 1) !== 0; };
      for (var i1 = 0; i1 <= 5; i1++) setF(8, i1, g(i1));
      setF(8, 7, g(6)); setF(8, 8, g(7)); setF(7, 8, g(8));
      for (var i2 = 9; i2 < 15; i2++) setF(14 - i2, 8, g(i2));
      for (var i3 = 0; i3 < 8; i3++) setF(size - 1 - i3, 8, g(i3));
      for (var i4 = 8; i4 < 15; i4++) setF(8, size - 15 + i4, g(i4));
      setF(8, size - 8, true);
    };
    drawFormat(0);
    if (ver >= 7) {
      var rv = ver; for (var r7 = 0; r7 < 12; r7++) rv = (rv << 1) ^ ((rv >>> 11) * 0x1F25);
      var vb = (ver << 12) | rv;
      for (var vi = 0; vi < 18; vi++) { var bit = ((vb >>> vi) & 1) !== 0, a = size - 11 + vi % 3, bb = Math.floor(vi / 3); setF(a, bb, bit); setF(bb, a, bit); }
    }
    // codewords, zig-zag from the bottom-right
    var bi2 = 0;
    for (var right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (var vert = 0; vert < size; vert++) for (var jj = 0; jj < 2; jj++) {
        var cx = right - jj, upward = ((right + 1) & 2) === 0, cy = upward ? size - 1 - vert : vert;
        if (!F[cy][cx] && bi2 < all.length * 8) { M[cy][cx] = ((all[bi2 >>> 3] >>> (7 - (bi2 & 7))) & 1) !== 0; bi2++; }
      }
    }
    var maskFn = [
      function (x, y) { return (x + y) % 2 === 0; }, function (x, y) { return y % 2 === 0; }, function (x) { return x % 3 === 0; },
      function (x, y) { return (x + y) % 3 === 0; }, function (x, y) { return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; },
      function (x, y) { return x * y % 2 + x * y % 3 === 0; }, function (x, y) { return (x * y % 2 + x * y % 3) % 2 === 0; },
      function (x, y) { return ((x + y) % 2 + x * y % 3) % 2 === 0; },
    ];
    var applyMask = function (m) { for (var y2 = 0; y2 < size; y2++) for (var x2 = 0; x2 < size; x2++) if (!F[y2][x2] && maskFn[m](x2, y2)) M[y2][x2] = !M[y2][x2]; };
    var mask = forcedMask;
    if (mask == null) {   // pick the mask with the lowest standard penalty
      var best = Infinity;
      for (var m = 0; m < 8; m++) { applyMask(m); drawFormat(m); var pen = penalty(M, size); if (pen < best) { best = pen; mask = m; } applyMask(m); }
    }
    applyMask(mask); drawFormat(mask);
    return { size: size, modules: M, mask: mask, version: ver };
  }

  function penalty(M, size) {
    var p = 0, dark = 0, i, j;
    var lines = [];
    for (i = 0; i < size; i++) { lines.push(M[i]); var col = []; for (j = 0; j < size; j++) col.push(M[j][i]); lines.push(col); }
    lines.forEach(function (ln) {
      var run = 1;
      for (var k = 1; k <= ln.length; k++) {
        if (k < ln.length && ln[k] === ln[k - 1]) run++;
        else { if (run >= 5) p += 3 + (run - 5); run = 1; }
      }
      var s = ln.map(function (b) { return b ? '1' : '0'; }).join('');
      var a = '0000' + s + '0000';
      for (var q = a.indexOf('10111010000'); q >= 0; q = a.indexOf('10111010000', q + 1)) p += 40;
      for (var q2 = a.indexOf('00001011101'); q2 >= 0; q2 = a.indexOf('00001011101', q2 + 1)) p += 40;
    });
    for (i = 0; i < size - 1; i++) for (j = 0; j < size - 1; j++) { var c = M[i][j]; if (c === M[i][j + 1] && c === M[i + 1][j] && c === M[i + 1][j + 1]) p += 3; }
    for (i = 0; i < size; i++) for (j = 0; j < size; j++) if (M[i][j]) dark++;
    var total = size * size, kk = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
    return p + Math.max(0, kk) * 10;
  }

  function svg(text, o) {
    o = o || {};
    var q = encode(text, o.ecc || 'M'), b = o.border == null ? 4 : o.border, n = q.size + b * 2, path = '';
    for (var y = 0; y < q.size; y++) for (var x = 0; x < q.size; x++) if (q.modules[y][x]) path += 'M' + (x + b) + ',' + (y + b) + 'h1v1h-1z';
    var px = n * (o.scale || 5);
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + n + ' ' + n + '" width="' + px + '" height="' + px + '" shape-rendering="crispEdges" role="img" aria-label="QR code">'
      + '<rect width="100%" height="100%" fill="' + (o.light || '#fff') + '"/><path d="' + path + '" fill="' + (o.dark || '#000') + '"/></svg>';
  }

  global.DojoQR = { svg: svg, matrix: encode };
})(typeof window !== 'undefined' ? window : globalThis);
