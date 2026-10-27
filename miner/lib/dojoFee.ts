// The Dojo fee on auto-mining deposits — the pure math, kept free of browser/web3 imports so the sizing in lib/burnMine.ts
// (and its tests) can use it. lib/minerTip.ts re-exports these and adds the transfer + memo instructions.
export const DOJO_FEE_BPS = 100;
export const dojoFeeOf = (depositLamports: number) => Math.floor((Math.max(0, depositLamports) * DOJO_FEE_BPS) / 10_000);
/** The largest deposit whose deposit + 1% fee fits in `lamports` (Burn to Mine spends exactly what came back). */
export const depositWithin = (lamports: number) => {
  let d = Math.floor((Math.max(0, lamports) * 10_000) / (10_000 + DOJO_FEE_BPS));
  while (d > 0 && d + dojoFeeOf(d) > lamports) d--;
  return d;
};
