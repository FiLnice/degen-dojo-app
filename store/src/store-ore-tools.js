// Shared by /orewizard and /oreparties: ORE's maths and the live market numbers.
// Both pages hold the market in read-only inputs with the same ids, so anything that reads them works on either page.
window.OreTools = (function(){
  const $ = id => document.getElementById(id);
  const ML_ODDS = 1/500;
  const MINER_FEE = 0.01;   // /mine's fee on the SOL funded, paid once when a run starts

  // ---------- core model (pure) ----------
  function model(p){
    const x = Math.max(0, p.perTile), S = clampInt(p.soloTiles,0,10), P = clampInt(p.splitTiles,0,15);
    const T = Math.max(0, p.tilePot), k = S + P;
    const D = x * k;                                   // your SOL per round
    const share = x > 0 ? x / (T + x) : 0;             // your share of a tile you're on
    // ORE returns each miner's own SOL (checkpoint.rs): 1% admin fee on every tile,
    // plus 10% of the rest on tiles that lose. Nothing moves between players.
    const lossPerTile = 0.01 * x + (24 / 25) * 0.1 * 0.99 * x;
    const solLoss = k * lossPerTile + (D > 0 ? p.autoFee : 0);
    const soloP = (S / 25) * share;                    // chance you win the solo this round
    const splitOre = (P / 25) * share;                 // expected split ORE
    const cap = p.maxMl > 0 ? p.maxMl : Infinity;
    const capped = p.mlPool > cap;                     // miner waits for the Motherlode to pop first
    const mlPoolEff = capped ? cap / 2 : Math.min(p.mlPool, cap); // typical pool while you mine
    const mlOre = ML_ODDS * mlPoolEff * (k / 25) * share;
    const orePerRound = soloP + splitOre + mlOre;
    const rounds = solLoss > 0 ? Math.floor(p.budget / solLoss) : 0;
    const perDay = 86400 / Math.max(30, p.roundSec);
    const lam = rounds * soloP;
    const pois = n => Math.exp(-lam) * Math.pow(lam, n) / fact(n);
    const dist = [pois(0), pois(1), pois(2)];
    dist.push(Math.max(0, 1 - dist[0] - dist[1] - dist[2]));
    const mlAnyHit = 1 - Math.pow(1 - ML_ODDS, rounds);
    const mlOnYou = 1 - Math.pow(1 - ML_ODDS * k / 25, rounds);
    const valuePerSol = solLoss > 0 ? orePerRound * p.orePrice / solLoss : 0;
    // rounds needed for 50% chance of a solo
    const r50 = soloP > 0 ? Math.ceil(Math.log(2) / soloP) : Infinity;
    return {x,S,P,k,T,D,share,solLoss,soloP,splitOre,mlOre,orePerRound,rounds,perDay,lam,dist,
      mlAnyHit,mlOnYou,mlIfYours:mlPoolEff*share,mlMax:(isFinite(cap)?cap:p.mlPool)*share,capped,valuePerSol,r50,
      runOre: rounds*orePerRound, runSplit: rounds*splitOre, runMl: rounds*mlOre,
      runSol: rounds*solLoss, days: rounds/perDay};
  }
  function clampInt(v,a,b){v=Math.round(+v||0);return Math.min(b,Math.max(a,v))}
  function fact(n){let f=1;for(let i=2;i<=n;i++)f*=i;return f}

  // ---------- formatting ----------
  const pct = v => !isFinite(v) ? "—" : v >= 0.995 ? ">99%" : v < 0.001 && v > 0 ? "<0.1%" : (v*100).toFixed(v < 0.1 ? 1 : 0) + "%";
  const pctFine = v => v <= 0 ? "0%" : v < 0.0001 ? (v*100).toExponential(1)+"%" : (v*100).toPrecision(2)+"%";
  const ore = v => v >= 10 ? v.toFixed(1) : v >= 1 ? v.toFixed(2) : v >= 0.01 ? v.toFixed(3) : v.toFixed(4);
  const sol = v => v >= 1 ? v.toFixed(2) : v >= 0.01 ? v.toFixed(3) : v.toPrecision(2);
  const int = v => isFinite(v) ? Math.round(v).toLocaleString("en") : "—";
  const dur = d => !isFinite(d) ? "—" : d < 1/24 ? Math.round(d*1440)+" min" : d < 2 ? (d*24).toFixed(1)+" hrs" : d.toFixed(1)+" days";

  // ---------- Motherlode bands (35,655 rounds, Sep–Oct 2026) ----------
  // share = fraction of rounds in that range; f = average pot relative to the overall average
  const BANDS = [
    {lo:0,hi:50,share:.385,f:.920},{lo:50,hi:100,share:.232,f:.978},{lo:100,hi:150,share:.121,f:1.025},
    {lo:150,hi:200,share:.082,f:1.100},{lo:200,hi:250,share:.061,f:1.235},{lo:250,hi:300,share:.045,f:1.353},
    {lo:300,hi:350,share:.032,f:1.484},{lo:350,hi:400,share:.022,f:1.555},{lo:400,hi:500,share:.019,f:1.487}];
  const bandOf = pool => BANDS.find(b=>pool<b.hi) || BANDS[BANDS.length-1];

  // Average per-round results over the Motherlode ranges a cap lets you mine
  function capRun(p, x, S, P, cap, minMl=0){
    const fNow = bandOf(p.mlPool).f, Tavg = p.tilePot / fNow;
    let w=0, acc={soloP:0,splitOre:0,mlOre:0,solLoss:0,f:0,mlRate:0,share:0};
    for(const b of BANDS){
      const top = b === BANDS[BANDS.length-1] ? Math.max(b.hi, cap>1e8?b.hi:cap) : b.hi;
      const lo = Math.max(b.lo, minMl), hi = Math.min(top, cap);
      if(hi <= lo) continue;
      const frac = Math.min(1, (hi - lo) / (top - b.lo));
      const wb = b.share * frac; if(wb<=0) continue;
      const pool = (lo + hi) / 2;
      const q = model({...p, perTile:x, soloTiles:S, splitTiles:P, tilePot:Tavg*b.f, mlPool:pool, maxMl:0});
      acc.soloP+=wb*q.soloP; acc.splitOre+=wb*q.splitOre; acc.mlOre+=wb*q.mlOre; acc.solLoss+=wb*q.solLoss;
      acc.f+=wb*b.f; acc.mlRate+=wb*(1/500)*(q.k/25); acc.share+=wb*q.share*pool; w+=wb;
    }
    if(!w) return {active:0,rounds:0,days:Infinity,lam:0,pSolo:0,drip:0,ml:0,total:0,mlOnYou:0,mlPayout:0,fAvg:1,perRound:x*(S+P),sol:0};
    for(const k in acc) acc[k]/=w;
    const rounds = acc.solLoss>0 ? Math.floor(p.budget/acc.solLoss) : 0;
    const perDay = 86400/Math.max(30,p.roundSec);
    const lam = rounds*acc.soloP;
    return {active:w, rounds, days: rounds/perDay/w, lam, pSolo:1-Math.exp(-lam),
      drip: rounds*acc.splitOre, ml: rounds*acc.mlOre, total: rounds*(acc.soloP+acc.splitOre+acc.mlOre),
      mlOnYou: 1-Math.pow(1-acc.mlRate, rounds), mlPayout: acc.share, fAvg: acc.f,
      perRound: x*(S+P), sol: rounds*acc.solLoss};
  }

  // ---------- live market numbers ----------
  // They read live, so they take no typing; one that couldn't be fetched opens up to be entered by hand.
  const LIVE=["tilePot","mlPool","orePrice","prodCost","roundSec"], POLL_MS=20000;   // a round lasts ~77s, so 20s shows each new one promptly
  let marketLive=false, redraw=()=>{};
  const readMarket = () => Object.fromEntries([...LIVE,"autoFee"].map(k=>[k,parseFloat($(k).value)||0]));
  function setStatus(cls,txt){const s=$("liveStatus");s.className="status "+cls;$("liveText").textContent=txt;}
  function lock(k,on){ $(k).readOnly=on; $(k).tabIndex=on?-1:0; }
  function applyMarket(mk){
    const upd={mlPool:+mk.motherlode.toFixed(1), prodCost:+mk.prodCost.toFixed(3)};
    if(mk.tilePot!=null) upd.tilePot=+mk.tilePot.toFixed(3);
    if(mk.orePrice!=null) upd.orePrice=+mk.orePrice.toFixed(3);
    if(mk.roundSec!=null) upd.roundSec=Math.round(mk.roundSec);
    const changed=Object.keys(upd).some(k=>+$(k).value!==upd[k]);
    Object.keys(upd).forEach(k=>{$(k).value=upd[k];});
    LIVE.forEach(k=>lock(k,k in upd));
    marketLive=true; $("marketNote").hidden=false;
    setStatus("ok",`Live · round ${mk.roundId}`);
    const missing=[mk.tilePot==null?"others' SOL per tile":null,mk.orePrice==null?"ORE price":null,mk.roundSec==null?"seconds per round":null].filter(Boolean);
    $("liveMsg").textContent=missing.length?`Couldn't fetch ${missing.join(" and ")}, so enter it by hand.`:"";
    return changed;
  }
  async function pollMarket(){
    if(document.hidden) return;
    let mk=null;
    try{ const r=await fetch("/api/wizard?market=1"); if(r.ok) mk=(await r.json()).market; }catch(e){}
    if(mk){ if(applyMarket(mk)) redraw(); return; }
    if(marketLive){ setStatus("warn","Reconnecting…"); return; }
    LIVE.forEach(k=>lock(k,false)); $("marketNote").hidden=true;
    setStatus("warn","Example values"); $("liveMsg").textContent="Live numbers couldn't load, so these are examples. Enter your own or reload the page.";
  }
  function startMarket(fn){
    redraw=fn; pollMarket(); setInterval(pollMarket,POLL_MS);
    document.addEventListener("visibilitychange",pollMarket);   // polling stops in a hidden tab, so catch up on return
  }
  return {$,MINER_FEE,model,capRun,pct,pctFine,ore,sol,int,dur,LIVE,readMarket,startMarket};
})();
