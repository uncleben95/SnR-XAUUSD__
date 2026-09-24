// XAUUSD SCALP PRO ENGINE
// Strategy: M15 bias + M5 confirmed breakout -> retest -> M5 continuation.
// H1 never blocks the scalp.
// Entry is filtered by minimum RR and targets are based on meaningful structure/liquidity.

const TD_KEY = process.env.TWELVEDATA_API_KEY || process.env.TWELVE_DATA_API_KEY;
const BASE = "https://api.twelvedata.com/time_series";

const CFG = {
  symbol: "XAU/USD",
  intervalM5: "5min",
  intervalM15: "15min",
  intervalH1: "1h",
  outputM5: 500,
  outputM15: 300,
  outputH1: 200,
  pivot: 2,
  retestBars: 3,
  minRR: 1.5,
  preferredRR: 2.0,
  maxEntryDistanceATR: 0.35,
  maxRetestDepthATR: 0.65
};

function cleanRows(values){
  return (values || []).map(x => ({
    time: String(x.datetime || x.time || "").replace("T"," ").replace("Z",""),
    open: Number(x.open), high: Number(x.high), low: Number(x.low), close: Number(x.close),
    volume: Number(x.volume || 0)
  })).filter(x => x.time && [x.open,x.high,x.low,x.close].every(Number.isFinite))
    .sort((a,b)=>new Date(a.time.replace(" ","T")+"Z")-new Date(b.time.replace(" ","T")+"Z"));
}
function atr(c,n=14){
  if(c.length<n+1)return null;
  let s=0;
  for(let i=c.length-n;i<c.length;i++){
    const p=c[i-1], x=c[i];
    s+=Math.max(x.high-x.low,Math.abs(x.high-p.close),Math.abs(x.low-p.close));
  }
  return s/n;
}
function pivots(c,L=2,R=2){
  const hi=[],lo=[];
  for(let i=L;i<c.length-R;i++){
    let H=true,LW=true;
    for(let j=1;j<=L;j++){if(c[i].high<=c[i-j].high)H=false;if(c[i].low>=c[i-j].low)LW=false;}
    for(let j=1;j<=R;j++){if(c[i].high<c[i+j].high)H=false;if(c[i].low>c[i+j].low)LW=false;}
    if(H)hi.push({price:c[i].high,time:c[i].time,index:i,type:"SWING_HIGH"});
    if(LW)lo.push({price:c[i].low,time:c[i].time,index:i,type:"SWING_LOW"});
  }
  return {hi,lo};
}
function structure(c){
  const p=pivots(c,CFG.pivot,CFG.pivot), last=c.length-1;
  const hs=p.hi.filter(x=>x.index<last), ls=p.lo.filter(x=>x.index<last);
  const prevH=hs.at(-1), prevL=ls.at(-1);
  let event="NONE", direction="RANGE", level=null;
  const x=c[last];
  if(prevH && x.close>prevH.price){event="BOS_UP";direction="BULLISH";level=prevH;}
  else if(prevL && x.close<prevL.price){event="BOS_DOWN";direction="BEARISH";level=prevL;}
  else {
    const h2=hs.at(-2), l2=ls.at(-2);
    if(prevH&&h2&&prevH.price>h2.price) direction="BULLISH";
    if(prevL&&l2&&prevL.price<l2.price) direction="BEARISH";
  }
  return {direction,event,level,candle:x,pivots:p};
}
function nearestSR(c, price){
  const p=pivots(c,CFG.pivot,CFG.pivot);
  const supports=p.lo.filter(x=>x.price<price).sort((a,b)=>price-b.price);
  const resistances=p.hi.filter(x=>x.price>price).sort((a,b)=>a.price-price);
  return {support:supports[0]||null,resistance:resistances[0]||null};
}
async function td(interval,outputsize){
  const u=new URL(BASE);
  u.searchParams.set("symbol",CFG.symbol);u.searchParams.set("interval",interval);
  u.searchParams.set("outputsize",outputsize);u.searchParams.set("apikey",TD_KEY);
  u.searchParams.set("timezone","UTC");
  const r=await fetch(u); if(!r.ok) throw new Error(`Twelve Data HTTP ${r.status}`);
  const j=await r.json(); if(j.status==="error") throw new Error(j.message||"Twelve Data error");
  return cleanRows(j.values);
}

export default async function handler(req,res){
  try{
    if(!TD_KEY) return res.status(500).json({ok:false,error:"Missing TWELVEDATA_API_KEY"});
    const [m5,m15,h1]=await Promise.all([td(CFG.intervalM5,CFG.outputM5),td(CFG.intervalM15,CFG.outputM15),td(CFG.intervalH1,CFG.outputH1)]);
    if(m5.length<80||m15.length<40) throw new Error("Insufficient market data");

    const s5=structure(m5), s15=structure(m15);
    const price=m5.at(-1).close, a=atr(m5,14)||1;
    const sr=nearestSR(m5,price);

    // Confirmed breakout must break an existing M5/M15 structural level.
    let breakout=null;
    if(s5.event==="BOS_UP" && s5.level) breakout={side:"BUY",level:s5.level,candle:s5.candle};
    else if(s5.event==="BOS_DOWN" && s5.level) breakout={side:"SELL",level:s5.level,candle:s5.candle};

    // M15 is a directional filter, but H1 is context only.
    if(breakout && ((breakout.side==="BUY"&&s15.direction!=="BULLISH")||(breakout.side==="SELL"&&s15.direction!=="BEARISH"))) breakout=null;

    let trade={action:"WAIT",reason:"Waiting for confirmed M5 breakout aligned with M15 structure."};
    let entry={status:"WAIT_BREAKOUT",price:null,level:null,sl:null,tp1:null,tp2:null,tp3:null,rr:null};

    if(breakout){
      const bi=m5.findIndex(x=>x.time===breakout.candle.time);
      const after=bi>=0?m5.slice(bi+1,bi+1+CFG.retestBars):[];
      const ret=after.find(x=>breakout.side==="BUY"
        ? x.low<=breakout.level.price && x.close>breakout.level.price
        : x.high>=breakout.level.price && x.close<breakout.level.price);

      if(ret){
        const ci=m5.findIndex(x=>x.time===ret.time);
        const confirm=m5[ci+1];
        if(confirm){
          const valid=breakout.side==="BUY"
            ? confirm.close>ret.high
            : confirm.close<ret.low;
          if(valid){
            const ep=confirm.close;
            const sl=breakout.side==="BUY"
              ? Math.min(ret.low,breakout.level.price-a*0.10)
              : Math.max(ret.high,breakout.level.price+a*0.10);
            const risk=Math.abs(ep-sl);
            const p=pivots(m5,CFG.pivot,CFG.pivot);
            const targets=breakout.side==="BUY"
              ? p.hi.filter(x=>x.price>ep+risk*CFG.minRR).sort((a,b)=>a.price-b.price)
              : p.lo.filter(x=>x.price<ep-risk*CFG.minRR).sort((a,b)=>b.price-a.price);
            const t1=targets[0]?.price;
            const t2=targets[1]?.price;
            const t3=targets[2]?.price;
            const rr=t1?Math.abs(t1-ep)/risk:null;
            if(rr && rr>=CFG.minRR){
              trade={action:"ENTRY_READY",reason:"Closed breakout + M5 retest + M5 continuation confirmed with minimum RR filter."};
              entry={status:"ENTRY_READY",price:ep,level:breakout.level.price,sl,
                tp1:t1,tp2:t2||null,tp3:t3||null,rr:Number(rr.toFixed(2)),
                side:breakout.side,breakoutCandle:breakout.candle.time,retestCandle:ret.time,confirmationCandle:confirm.time};
            } else {
              trade={action:"WAIT",reason:"Structure confirmed, but nearest valid target does not meet minimum 1.5R."};
              entry={status:"WAIT_RR",price:null,level:breakout.level.price,sl:null,tp1:t1||null,tp2:t2||null,tp3:t3||null,rr:rr?Number(rr.toFixed(2)):null};
            }
          } else trade={action:"WAIT",reason:"Retest occurred but M5 continuation confirmation failed."};
        } else trade={action:"WAIT_RETEST",reason:"Retest found; waiting for next closed M5 confirmation candle."};
      } else trade={action:"WAIT_RETEST",reason:"Confirmed breakout; waiting up to 3 M5 candles for retest."};
    }

    const h1s=structure(h1);
    const h1p=pivots(h1,CFG.pivot,CFG.pivot);
    const h1Price=h1.at(-1).close;
    const h1RangeHigh=h1p.hi.filter(x=>x.index<h1.length-1).at(-1)||null;
    const h1RangeLow=h1p.lo.filter(x=>x.index<h1.length-1).at(-1)||null;

    // H1 is analysis/context only. It never blocks an M5+M15 scalp.
    const h1Analysis = {
      direction:h1s.direction,
      structureEvent:h1s.event,
      lastSwingHigh:h1p.hi.filter(x=>x.index<h1.length-1).at(-1)||null,
      lastSwingLow:h1p.lo.filter(x=>x.index<h1.length-1).at(-1)||null,
      rangeHigh:h1RangeHigh,
      rangeLow:h1RangeLow,
      price:h1Price,
      scalpAlignment:
        s5.direction===h1s.direction && s15.direction===h1s.direction
          ? "ALIGNED"
          : (s5.direction!==h1s.direction && s15.direction!==h1s.direction ? "OPPOSED" : "MIXED"),
      role:"CONTEXT_ONLY"
    };

    return res.status(200).json({
      ok:true,engine:"XAUUSD-SCALP-PRO-RR-FILTER",timestamp:new Date().toISOString(),
      marketStatus:"OPEN",price,scalpOnly:true,
      m15:{structure:{direction:s15.direction,event:s15.event,level:s15.level,candle:s15.candle}},
      m5:{structure:{direction:s5.direction,event:s5.event,level:s5.level,candle:s5.candle}},
      scalpSR:{support:sr.support,resistance:sr.resistance,reference:"Nearest confirmed M5 swing structure"},
      tradeDecision:trade,entry,
      h1Context:{direction:h1s.direction,hold:"CONTEXT_ONLY",analysis:h1Analysis},
      rules:{primary:"M5 + M15 scalp",breakout:"closed candle",entry:"breakout -> M5 retest -> M5 continuation",
        minimumRR:CFG.minRR,target:"next confirmed swing beyond minimum RR",
        h1:"analysis/context only; never blocks scalp"},
      push:{attempted:false,status:trade.action==="ENTRY_READY"?"ENTRY_READY":"NO_ENTRY"}
    });
  }catch(e){return res.status(500).json({ok:false,error:e.message});}
}
