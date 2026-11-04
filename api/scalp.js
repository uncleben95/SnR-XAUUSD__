import { sendPushToAll, redis } from "./push-lib.js";

// H1 BREAKOUT ENGINE + H4 SUPPORT/RESISTANCE
// Closed H1 candles are the only breakout trigger. H4 supplies the levels.
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const key = process.env.TWELVE_DATA_API_KEY;
  if (!key) return res.status(500).json({ ok:false, error:"TWELVE_DATA_API_KEY is not configured" });

  const symbol = "XAU/USD";
  const cronSecret = process.env.XAU_CRON_SECRET;
  const authorizedPush = req.query?.source === "github-actions" && cronSecret && req.headers["x-xau-cron-secret"] === cronSecret;

  const get = async (url, label) => {
    const r = await fetch(url, { signal: AbortSignal.timeout(12_000) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.status === "error" || j.code) throw new Error(j.message || `${label} request failed`);
    return j;
  };
  const series = async (interval, outputsize) => {
    const u = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}&interval=${interval}&outputsize=${outputsize}&apikey=${key}`;
    const j = await get(u, interval);
    return (j.values || []).reverse().map(x => ({
      time:x.datetime, open:+x.open, high:+x.high, low:+x.low, close:+x.close
    })).filter(x => [x.open,x.high,x.low,x.close].every(Number.isFinite));
  };
  const fmt = n => Number.isFinite(n) ? Number(n.toFixed(2)) : null;
  const atr = (d,p=14) => {
    if (d.length < p + 1) return null;
    const tr=[]; for(let i=1;i<d.length;i++){ const c=d[i],q=d[i-1]; tr.push(Math.max(c.high-c.low,Math.abs(c.high-q.close),Math.abs(c.low-q.close))); }
    return tr.slice(-p).reduce((a,b)=>a+b,0)/p;
  };
  const ema = (d,p) => {
    if (d.length < p) return null;
    const k=2/(p+1); let v=d.slice(0,p).reduce((s,x)=>s+x.close,0)/p;
    for(let i=p;i<d.length;i++) v=d[i].close*k+v*(1-k); return v;
  };

  function h4Levels(data, price) {
    const candidates=[];
    // Confirmed pivots only: two candles on each side.
    for(let i=2;i<data.length-2;i++) {
      const x=data[i], left=data.slice(i-2,i), right=data.slice(i+1,i+3);
      if (x.high >= Math.max(...left.map(a=>a.high),...right.map(a=>a.high))) candidates.push({ price:x.high, type:"RESISTANCE", time:x.time, touches:1 });
      if (x.low <= Math.min(...left.map(a=>a.low),...right.map(a=>a.low))) candidates.push({ price:x.low, type:"SUPPORT", time:x.time, touches:1 });
    }
    const cluster = (arr,type) => {
      const tol=Math.max((atr(data)||10)*0.35, 2);
      const groups=[];
      for(const x of arr.sort((a,b)=>a.price-b.price)){
        const g=groups.at(-1);
        if(g && Math.abs(x.price-g.anchor)<=tol){g.items.push(x); g.anchor=g.items.reduce((s,z)=>s+z.price,0)/g.items.length;}
        else groups.push({anchor:x.price,items:[x]});
      }
      return groups.map(g=>({price:g.anchor,type,time:g.items.at(-1).time,touches:g.items.length,timeframe:"H4"}));
    };
    const supports=cluster(candidates.filter(x=>x.type==="SUPPORT"),"SUPPORT").filter(x=>x.price<price).sort((a,b)=>b.price-a.price).slice(0,8);
    const resistances=cluster(candidates.filter(x=>x.type==="RESISTANCE"),"RESISTANCE").filter(x=>x.price>price).sort((a,b)=>a.price-b.price).slice(0,8);
    return { supports, resistances, nearestSupport:supports[0]||null, nearestResistance:resistances[0]||null };
  }

  try {
    const [h1Raw,h4Raw,pr] = await Promise.all([
      series("1h",300), series("4h",220), get(`https://api.twelvedata.com/price?symbol=${encodeURIComponent(symbol)}&apikey=${key}`,"price")
    ]);
    if (h1Raw.length < 30 || h4Raw.length < 30) throw new Error("Insufficient H1/H4 candle history");
    // Provider can include an in-progress candle. Breakout detection never uses it.
    const h1=h1Raw.slice(0,-1), h4=h4Raw.slice(0,-1);
    const livePrice=Number(pr?.price);
    const price=Number.isFinite(livePrice) ? livePrice : h1.at(-1).close;
    const levels=h4Levels(h4,price);
    const prev=h1.at(-2), last=h1.at(-1);
    const allLevels=[...levels.supports,...levels.resistances];
    const hits=[];
    for(const level of allLevels){
      if(level.type==="RESISTANCE" && prev.close<=level.price && last.close>level.price) hits.push({direction:"BUY",level:level.price,levelType:"H4_RESISTANCE",...level});
      if(level.type==="SUPPORT" && prev.close>=level.price && last.close<level.price) hits.push({direction:"SELL",level:level.price,levelType:"H4_SUPPORT",...level});
    }
    hits.sort((a,b)=>Math.abs(last.close-a.level)-Math.abs(last.close-b.level));
    const hit=hits[0]||null;
    const breakoutWatch=hit ? {
      state:"BREAKOUT_DETECTED", direction:hit.direction, level:fmt(hit.level), levelType:hit.levelType,
      price:fmt(last.close), candleTime:last.time, timeframe:"H1",
      message:`H1 closed ${hit.direction === "BUY" ? "above" : "below"} H4 ${hit.type.toLowerCase()} ${fmt(hit.level)}`
    } : {state:"NO_BREAKOUT",direction:"WAIT",level:null,price:fmt(price),candleTime:last.time,timeframe:"H1",message:"No new confirmed H1 breakout through an H4 level."};

    const h1Atr=atr(h1), h4Atr=atr(h4), h1Ema20=ema(h1,20), h1Ema50=ema(h1,50), h1Ema200=ema(h1,200);
    const trend = h1Ema20 && h1Ema50 && h1Ema200 ? (h1Ema20>h1Ema50&&h1Ema50>h1Ema200?"BULLISH":h1Ema20<h1Ema50&&h1Ema50<h1Ema200?"BEARISH":"MIXED") : "UNKNOWN";
    const signal=hit?.direction||"WAIT";
    const signalKey=hit ? `h1-breakout|${hit.direction}|${fmt(hit.level)}|${last.time}` : null;
    let push={authorized:Boolean(authorizedPush),sent:false,skipped:false,reason:null};
    if (authorizedPush && hit && signalKey) {
      const lockKey=`xau_h1_breakout_push:${signalKey}`;
      const locked=await redis.get(lockKey).catch(()=>null);
      if (locked) push={...push,skipped:true,reason:"Duplicate H1 breakout already notified"};
      else {
        const delivery=await sendPushToAll({
          title:`XAU/USD H1 ${hit.direction} BREAKOUT`,
          body:`H1 candle closed ${hit.direction === "BUY" ? "above" : "below"} H4 ${hit.type.toLowerCase()} ${fmt(hit.level)}. Close: ${fmt(last.close)}`,
          tag:`xau-h1-breakout-${signalKey}`, url:"/"
        });
        await redis.set(lockKey,"1",{ex:60*60*48}).catch(()=>{});
        push={...push,sent:delivery.sent>0,delivery,reason:delivery.sent>0?"Push sent":"No active subscription or delivery failed"};
      }
    }

    return res.status(200).json({
      ok:true, engine:"H1_BREAKOUT_H4_SR_V1", symbol, signal, status:hit?"BREAKOUT":"MONITORING", execution:hit?"ALERT":"WAIT",
      score:hit?100:0, signalKey, livePrice:{price:fmt(price),source:"Twelve Data"}, price:fmt(price),
      breakoutWatch, reasons:hit?[breakoutWatch.message,"Breakout is based on a closed H1 candle only; H4 provides the broken level."]:["Monitoring closed H1 candles against confirmed H4 support and resistance."],
      h1:{time:last.time,open:fmt(last.open),high:fmt(last.high),low:fmt(last.low),close:fmt(last.close),atr:fmt(h1Atr),ema20:fmt(h1Ema20),ema50:fmt(h1Ema50),ema200:fmt(h1Ema200),direction:trend},
      h4:{atr:fmt(h4Atr),supportResistance:levels,levels:[...levels.supports,...levels.resistances].sort((a,b)=>a.price-b.price)},
      srAnalysis:{support:levels.nearestSupport,resistance:levels.nearestResistance,supportDistance:levels.nearestSupport?fmt(price-levels.nearestSupport.price):null,resistanceDistance:levels.nearestResistance?fmt(levels.nearestResistance.price-price):null,position:"H4_CONTEXT"},
      data:{h1Candles:h1.length,h4Candles:h4.length}, candles:h1.slice(-80), h1ChartCandles:h1.slice(-80), marketStatus:{open:true,reasons:[]}, push,
      timestamp:new Date().toISOString()
    });
  } catch(e) {
    console.error("H1/H4 engine:",e?.message||e);
    return res.status(502).json({ok:false,error:e?.name==="TimeoutError"?"Twelve Data request timed out":e.message||"Engine error"});
  }
}
