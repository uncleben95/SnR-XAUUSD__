// XAU/USD SCALP ENGINE V4
// Primary: M5 standalone trigger.
// M15: confirmation / quality scoring.
// H1: swing context only. NEVER blocks a scalp entry.
// Signals are emitted only from CLOSED candles.

import { sendPushToAll, redis } from "./push-lib.js";

const TD_KEY = process.env.TWELVEDATA_API_KEY || process.env.TWELVE_DATA_API_KEY;
const BASE = "https://api.twelvedata.com/time_series";

const CFG = {
  symbol: "XAU/USD",
  pivotL: 2,
  pivotR: 2,

  // Entry quality threshold. The score is a confluence score, not a probability.
  minScore: 85,

  // Risk model
  minRR: 1.5,
  slAtrBuffer: 0.15,

  // Avoid firing on an old breakout after a scheduler delay.
  scanClosedM5: 3,
  maxSignalAgeMin: 10,

  // Data/cache plan for a free Twelve Data account:
  // background M5 refresh every 5m; M15 cached 15m; H1 cached 60m.
  outputM5: 500,
  outputM15: 200,
  outputH1: 150,
  m5CacheTTL: 5 * 60 * 1000,
  m15CacheTTL: 15 * 60 * 1000,
  h1CacheTTL: 60 * 60 * 1000,

  notifyPrefix: "xau:scalp:v4:notified:",
  statePrefix: "xau:scalp:v4:state:"
};

function num(v){ const n = Number(v); return Number.isFinite(n) ? n : null; }

function utcTime(x){
  return new Date(String(x).replace(" ","T").replace("Z","")+"Z").getTime();
}

function cleanRows(values){
  return (values || [])
    .map(x => ({
      time: String(x.datetime || x.time || "").replace("T"," ").replace("Z",""),
      open: Number(x.open),
      high: Number(x.high),
      low: Number(x.low),
      close: Number(x.close),
      volume: Number(x.volume || 0)
    }))
    .filter(x =>
      x.time &&
      [x.open,x.high,x.low,x.close].every(Number.isFinite)
    )
    .sort((a,b) => utcTime(a.time)-utcTime(b.time));
}

function closedRows(rows, minutes, now=Date.now()){
  return rows.filter(x => utcTime(x.time) + minutes*60000 <= now);
}

function pivots(c, L=2, R=2){
  const highs = [], lows = [];
  for(let i=L; i<c.length-R; i++){
    let hi = true, lo = true;
    for(let j=1;j<=L;j++){
      if(c[i].high <= c[i-j].high) hi=false;
      if(c[i].low >= c[i-j].low) lo=false;
    }
    for(let j=1;j<=R;j++){
      if(c[i].high < c[i+j].high) hi=false;
      if(c[i].low > c[i+j].low) lo=false;
    }
    if(hi) highs.push({price:c[i].high,time:c[i].time,index:i,type:"SWING_HIGH"});
    if(lo) lows.push({price:c[i].low,time:c[i].time,index:i,type:"SWING_LOW"});
  }
  return {highs,lows};
}

function structure(c){
  const p = pivots(c,CFG.pivotL,CFG.pivotR);
  const last = c.length-1;
  const hs = p.highs.filter(x=>x.index<last);
  const ls = p.lows.filter(x=>x.index<last);
  const h1 = hs.at(-1), h2 = hs.at(-2);
  const l1 = ls.at(-1), l2 = ls.at(-2);

  let direction = "RANGE";
  if(h1 && h2 && h1.price > h2.price) direction = "BULLISH";
  if(l1 && l2 && l1.price < l2.price) direction = "BEARISH";

  const x = c[last];
  let event="NONE", side=null, level=null;

  // A trigger is a CROSS of a confirmed swing, not simply being above/below it.
  const prev = c[last-1];
  if(h1 && prev.close <= h1.price && x.close > h1.price){
    side="BUY";
    level=h1;
    event=direction==="BEARISH" ? "CHOCH_UP" : "BOS_UP";
    direction="BULLISH";
  }else if(l1 && prev.close >= l1.price && x.close < l1.price){
    side="SELL";
    level=l1;
    event=direction==="BULLISH" ? "CHOCH_DOWN" : "BOS_DOWN";
    direction="BEARISH";
  }

  return {direction,event,side,level,candle:x,pivots:p};
}

function nearestSR(m5,m15,price){
  const a=pivots(m5,CFG.pivotL,CFG.pivotR);
  const b=pivots(m15,CFG.pivotL,CFG.pivotR);

  const lows=[...a.lows,...b.lows]
    .filter(x=>x.price<price)
    .sort((x,y)=>y.price-x.price);
  const highs=[...a.highs,...b.highs]
    .filter(x=>x.price>price)
    .sort((x,y)=>x.price-y.price);

  return {
    support:lows[0] || null,
    resistance:highs[0] || null,
    reference:"Nearest confirmed M5/M15 swing"
  };
}

function latestSwing(c, type){
  const p=pivots(c,CFG.pivotL,CFG.pivotR);
  return type==="HIGH" ? p.highs.at(-1) || null : p.lows.at(-1) || null;
}

function atr(c,n=14){
  if(c.length<n+1) return null;
  const tr=[];
  for(let i=1;i<c.length;i++){
    tr.push(Math.max(
      c[i].high-c[i].low,
      Math.abs(c[i].high-c[i-1].close),
      Math.abs(c[i].low-c[i-1].close)
    ));
  }
  const a=tr.slice(-n);
  return a.reduce((x,y)=>x+y,0)/a.length;
}

function ema(c,n){
  if(c.length<n) return null;
  const k=2/(n+1);
  let e=c.slice(0,n).reduce((a,x)=>a+x.close,0)/n;
  for(let i=n;i<c.length;i++) e=c[i].close*k+e*(1-k);
  return e;
}

function rsi(c,n=14){
  if(c.length<n+1) return null;
  let gain=0, loss=0;
  for(let i=1;i<=n;i++){
    const d=c[i].close-c[i-1].close;
    gain += Math.max(d,0);
    loss += Math.max(-d,0);
  }
  let avgG=gain/n, avgL=loss/n;
  for(let i=n+1;i<c.length;i++){
    const d=c[i].close-c[i-1].close;
    avgG=(avgG*(n-1)+Math.max(d,0))/n;
    avgL=(avgL*(n-1)+Math.max(-d,0))/n;
  }
  if(avgL===0) return 100;
  return 100-(100/(1+avgG/avgL));
}

function macd(c){
  if(c.length<35) return null;
  const e12=ema(c,12), e26=ema(c,26);
  if(e12==null || e26==null) return null;
  const line=e12-e26;

  // Signal line from the latest MACD history.
  const vals=[];
  for(let i=25;i<c.length;i++){
    const fast=ema(c.slice(0,i+1),12);
    const slow=ema(c.slice(0,i+1),26);
    if(fast!=null && slow!=null) vals.push(fast-slow);
  }
  if(vals.length<9) return {line,signal:null,hist:null};
  let s=vals.slice(0,9).reduce((a,x)=>a+x,0)/9;
  const k=2/10;
  for(let i=9;i<vals.length;i++) s=vals[i]*k+s*(1-k);
  return {line,signal:s,hist:line-s};
}

function adx(c,n=14){
  if(c.length<n*2+2) return null;
  const tr=[], plus=[], minus=[];
  for(let i=1;i<c.length;i++){
    const up=c[i].high-c[i-1].high;
    const dn=c[i-1].low-c[i].low;
    tr.push(Math.max(
      c[i].high-c[i].low,
      Math.abs(c[i].high-c[i-1].close),
      Math.abs(c[i].low-c[i-1].close)
    ));
    plus.push(up>dn && up>0 ? up : 0);
    minus.push(dn>up && dn>0 ? dn : 0);
  }
  const smooth=(arr)=>{
    let v=arr.slice(0,n).reduce((a,x)=>a+x,0)/n;
    const out=[v];
    for(let i=n;i<arr.length;i++){
      v=(v*(n-1)+arr[i])/n;
      out.push(v);
    }
    return out;
  };
  const T=smooth(tr), P=smooth(plus), M=smooth(minus);
  const dx=[];
  for(let i=0;i<T.length;i++){
    const p=T[i] ? 100*P[i]/T[i] : 0;
    const m=T[i] ? 100*M[i]/T[i] : 0;
    dx.push((p+m) ? 100*Math.abs(p-m)/(p+m) : 0);
  }
  if(dx.length<n) return null;
  let a=dx.slice(0,n).reduce((x,y)=>x+y,0)/n;
  for(let i=n;i<dx.length;i++) a=(a*(n-1)+dx[i])/n;
  return a;
}

function session(now=Date.now()){
  const d=new Date(now);
  const day=d.getUTCDay();
  const mins=d.getUTCHours()*60+d.getUTCMinutes();

  if(day===6) return {status:"CLOSED",reason:"Saturday"};
  if(day===0 && mins<1320) return {status:"CLOSED",reason:"Before Sunday 22:00 UTC"};
  if(day===5 && mins>=1260) return {status:"CLOSED",reason:"Friday after 21:00 UTC"};
  if(day>=1 && day<=5 && mins>=1260 && mins<1320)
    return {status:"CLOSED",reason:"Daily maintenance break"};

  return {status:"OPEN",reason:"Market session open"};
}

async function td(interval,outputsize,key,ttl,force=false){
  let cached=null;
  try{
    if(!force) cached=await redis.get(key);
    if(cached){
      const parsed=typeof cached==="string" ? JSON.parse(cached) : cached;
      if(Array.isArray(parsed?.rows) && parsed.rows.length){
        return {
          rows:cleanRows(parsed.rows),
          savedAt:Number(parsed.savedAt||0),
          cacheHit:true
        };
      }
    }
  }catch{}

  const u=new URL(BASE);
  u.searchParams.set("symbol",CFG.symbol);
  u.searchParams.set("interval",interval);
  u.searchParams.set("outputsize",outputsize);
  u.searchParams.set("apikey",TD_KEY);
  u.searchParams.set("timezone","UTC");

  const r=await fetch(u);
  let j=null;
  try{j=await r.json();}catch{}

  if(!r.ok || j?.status==="error" || !Array.isArray(j?.values)){
    try{
      const fallback=await redis.get(key);
      if(fallback){
        const parsed=typeof fallback==="string" ? JSON.parse(fallback) : fallback;
        if(Array.isArray(parsed?.rows) && parsed.rows.length){
          return {
            rows:cleanRows(parsed.rows),
            savedAt:Number(parsed.savedAt||0),
            cacheHit:true,
            staleFallback:true
          };
        }
      }
    }catch{}
    throw new Error(j?.message || `Twelve Data HTTP ${r.status}`);
  }

  const rows=cleanRows(j.values);
  if(!rows.length) throw new Error(`No ${interval} candles returned`);

  const savedAt=Date.now();
  try{
    await redis.set(key,JSON.stringify({rows,savedAt}),{
      ex:Math.max(60,Math.round(ttl/1000)+60)
    });
  }catch{}

  return {rows,savedAt,cacheHit:false};
}

function scoreSetup(m5,m15,side){
  const c=m5.at(-1);
  const a=atr(m5,14) || Math.max(c.high-c.low,0.1);
  const e20=ema(m5,20), e50=ema(m5,50);
  const e20_15=ema(m15,20), e50_15=ema(m15,50);
  const r15=rsi(m15,14);
  const mac15=macd(m15);
  const adx15=adx(m15,14);

  const range=Math.max(c.high-c.low,0.0001);
  const bodyRatio=Math.abs(c.close-c.open)/range;
  const atrRatio=range/a;

  let score=25; // confirmed M5 structure break = mandatory base
  const reasons=[];

  if(bodyRatio>=0.55){score+=15; reasons.push("M5 body is strong");}
  else if(bodyRatio>=0.35){score+=8; reasons.push("M5 body is acceptable");}
  else reasons.push("M5 body is weak");

  if((side==="BUY" && c.close>c.open) || (side==="SELL" && c.close<c.open)){
    score+=5; reasons.push("M5 candle direction agrees");
  }

  if(e20!=null && e50!=null &&
    ((side==="BUY" && e20>e50)||(side==="SELL" && e20<e50))){
    score+=15; reasons.push("M5 EMA20/50 aligned");
  }else reasons.push("M5 EMA20/50 not aligned");

  if(e20_15!=null && e50_15!=null &&
    ((side==="BUY" && e20_15>e50_15)||(side==="SELL" && e20_15<e50_15))){
    score+=15; reasons.push("M15 trend aligned");
  }else reasons.push("M15 trend not aligned");

  if(r15!=null &&
    ((side==="BUY" && r15>=52)||(side==="SELL" && r15<=48))){
    score+=10; reasons.push(`M15 RSI confirms (${r15.toFixed(1)})`);
  }else if(r15!=null){
    reasons.push(`M15 RSI neutral (${r15.toFixed(1)})`);
  }

  if(mac15?.hist!=null &&
    ((side==="BUY" && mac15.hist>0)||(side==="SELL" && mac15.hist<0))){
    score+=10; reasons.push("M15 MACD momentum aligned");
  }else reasons.push("M15 MACD momentum not aligned");

  if(adx15!=null && adx15>=20){
    score+=5; reasons.push(`M15 ADX active (${adx15.toFixed(1)})`);
  }else if(adx15!=null){
    reasons.push(`M15 ADX weak (${adx15.toFixed(1)})`);
  }

  if(atrRatio>=0.7 && atrRatio<=1.8){
    score+=5; reasons.push("M5 expansion is usable");
  }else if(atrRatio>1.8){
    score-=5; reasons.push("M5 candle is over-extended");
  }

  score=Math.max(0,Math.min(100,Math.round(score)));

  return {
    score,
    grade:score>=90?"A+":score>=85?"A":score>=75?"B":"C",
    atr:Number(a.toFixed(2)),
    bodyRatio:Number(bodyRatio.toFixed(2)),
    atrRatio:Number(atrRatio.toFixed(2)),
    m5:{ema20:num(e20?.toFixed?.(2)),ema50:num(e50?.toFixed?.(2))},
    m15:{
      ema20:num(e20_15?.toFixed?.(2)),
      ema50:num(e50_15?.toFixed?.(2)),
      rsi:num(r15?.toFixed?.(1)),
      macdHist:num(mac15?.hist?.toFixed?.(3)),
      adx:num(adx15?.toFixed?.(1))
    },
    reasons
  };
}

function buildTrade(m5,m15,side,level,quality){
  const c=m5.at(-1);
  const a=quality.atr || Math.max(c.high-c.low,0.1);
  const rawSL=side==="BUY"
    ? c.low-Math.max(0.10,a*CFG.slAtrBuffer)
    : c.high+Math.max(0.10,a*CFG.slAtrBuffer);

  const risk=Math.abs(c.close-rawSL);
  if(!Number.isFinite(risk) || risk<=0) return null;

  const p5=pivots(m5,CFG.pivotL,CFG.pivotR);
  const p15=pivots(m15,CFG.pivotL,CFG.pivotR);

  const levels=side==="BUY"
    ? [...p5.highs,...p15.highs]
      .filter(x=>x.price>c.close)
      .sort((a,b)=>a.price-b.price)
    : [...p5.lows,...p15.lows]
      .filter(x=>x.price<c.close)
      .sort((a,b)=>b.price-a.price);

  const usable=levels.filter(x=>Math.abs(x.price-c.close)>=risk*CFG.minRR);
  const t1=usable[0]?.price ?? (side==="BUY" ? c.close+risk*CFG.minRR : c.close-risk*CFG.minRR);
  const t2=usable[1]?.price ?? null;
  const t3=usable[2]?.price ?? null;

  return {
    status:quality.score>=CFG.minScore?"ENTRY_READY":"WAIT_QUALITY",
    side,
    entry:c.close,
    level:level.price,
    sl:Number(rawSL.toFixed(2)),
    tp1:Number(t1.toFixed(2)),
    tp2:t2!=null?Number(t2.toFixed(2)):null,
    tp3:t3!=null?Number(t3.toFixed(2)):null,
    rr:Number((Math.abs(t1-c.close)/risk).toFixed(2)),
    risk:Number(risk.toFixed(2)),
    triggerCandle:c.time,
    execution:"CLOSED M5 BREAKOUT — RETEST NOT REQUIRED"
  };
}

function swingContext(h1,scalpSide){
  const s=structure(h1);
  const e20=ema(h1,20), e50=ema(h1,50);
  const emaBias=e20!=null&&e50!=null
    ? (e20>e50?"BUY":e20<e50?"SELL":"NEUTRAL")
    : "NEUTRAL";

  let swingBias=s.direction==="BULLISH"?"BUY":s.direction==="BEARISH"?"SELL":"NEUTRAL";
  if(emaBias!==swingBias && emaBias!=="NEUTRAL" && swingBias!=="NEUTRAL"){
    swingBias="NEUTRAL";
  }

  let hold="NEUTRAL";
  if(scalpSide && swingBias===scalpSide) hold="ALIGNED — HOLD BIAS";
  else if(scalpSide && swingBias && swingBias!=="NEUTRAL") hold="OPPOSED — MANAGE HOLD";
  else if(scalpSide) hold="NEUTRAL — SCALP STANDS ALONE";

  const high=latestSwing(h1,"HIGH");
  const low=latestSwing(h1,"LOW");

  return {
    bias:swingBias,
    hold,
    role:"CONTEXT_ONLY",
    neverBlocksScalp:true,
    structure:s.direction,
    structureEvent:s.event,
    ema20:num(e20?.toFixed?.(2)),
    ema50:num(e50?.toFixed?.(2)),
    lastSwingHigh:high,
    lastSwingLow:low
  };
}

async function notify(entry,quality){
  const key=`${entry.side}|${entry.triggerCandle}|${entry.level}`;
  const lock=CFG.notifyPrefix+key.replace(/[^A-Za-z0-9_.:-]/g,"_");

  try{
    if(await redis.get(lock)){
      return {attempted:false,sent:false,status:"ALREADY_NOTIFIED",signalKey:key};
    }

    const result=await sendPushToAll({
      title:`XAU/USD ${entry.side} SCALP TRIGGER`,
      body:`M5 ${entry.side} • Entry ${entry.entry.toFixed(2)} • SL ${entry.sl.toFixed(2)} • TP1 ${entry.tp1.toFixed(2)} • Score ${quality.score}/100`,
      tag:`xau-scalp-${key}`,
      url:"/"
    });

    const sent=Number(result.sent||0)>0;
    if(sent) await redis.set(lock,"1",{ex:86400});

    return {
      attempted:true,
      sent,
      status:sent?"PUSH_SENT":"NO_SUBSCRIPTIONS",
      signalKey:key,
      details:result
    };
  }catch(e){
    return {
      attempted:true,
      sent:false,
      status:"PUSH_ERROR",
      error:e.message,
      signalKey:key
    };
  }
}

function pickTrigger(m5,m15,h1s,now){
  const first=Math.max(60,m5.length-CFG.scanClosedM5);
  let newest=null;

  for(let i=m5.length-1;i>=first;i--){
    const rows=m5.slice(0,i+1);
    const s=structure(rows);
    if(!s.side || !s.level) continue;

    const ageMin=(now-(utcTime(s.candle.time)+5*60000))/60000;
    if(ageMin>CFG.maxSignalAgeMin) continue;

    const q=scoreSetup(rows,m15,s.side);
    const trade=buildTrade(rows,m15,s.side,s.level,q);
    if(!trade) continue;

    newest={s,q,trade,ageMin};
    break;
  }

  return newest;
}

export default async function handler(req,res){
  if(req.method && req.method!=="GET"){
    return res.status(405).json({ok:false,error:"Method not allowed"});
  }

  try{
    if(!TD_KEY){
      return res.status(500).json({ok:false,error:"Missing TWELVEDATA_API_KEY"});
    }

    const source=String(req.query?.source || req.headers?.["x-signal-source"] || "dashboard");
    const background=/github|cron|background/i.test(source);
    const now=Date.now();

    const [m5d,m15d,h1d]=await Promise.all([
      td("5min",CFG.outputM5,"xau:td:m5:v4",CFG.m5CacheTTL,background),
      td("15min",CFG.outputM15,"xau:td:m15:v4",CFG.m15CacheTTL,false),
      td("1h",CFG.outputH1,"xau:td:h1:v4",CFG.h1CacheTTL,false)
    ]);

    const m5=closedRows(m5d.rows,5,now);
    const m15=closedRows(m15d.rows,15,now);
    const h1=closedRows(h1d.rows,60,now);

    if(m5.length<80 || m15.length<50 || h1.length<60){
      throw new Error("Insufficient closed market data");
    }

    const price=m5.at(-1).close;
    const m5s=structure(m5);
    const m15s=structure(m15);
    const sr=nearestSR(m5,m15,price);
    const market=session(now);

    const candidate=market.status==="OPEN" ? pickTrigger(m5,m15,structure(h1),now) : null;

    let entry={
      status:"WAIT",
      side:null,entry:null,level:null,sl:null,tp1:null,tp2:null,tp3:null,rr:null
    };
    let quality={score:0,grade:"WAIT",reasons:[]};
    let decision={action:"WAIT",reason:"Waiting for a fresh closed M5 structure trigger."};
    let breakout=null;
    let push={attempted:false,sent:false,status:"NO_NEW_SETUP"};

    if(candidate){
      entry=candidate.trade;
      quality=candidate.q;
      breakout={
        confirmed:true,
        side:candidate.s.side,
        event:candidate.s.event,
        level:candidate.s.level,
        candle:candidate.s.candle,
        ageMinutes:Number(candidate.ageMin.toFixed(1))
      };

      if(quality.score>=CFG.minScore){
        entry.status="ENTRY_READY";
        decision={
          action:"ENTRY_READY",
          reason:`Fresh M5 ${candidate.s.event} trigger. Scalp is standalone; H1 is context only.`
        };

        if(background){
          push=await notify(entry,quality);
        }
      }else{
        entry.status="WAIT_QUALITY";
        decision={
          action:"WAIT",
          reason:`M5 trigger detected but quality is ${quality.score}/100; minimum is ${CFG.minScore}/100.`
        };
      }
    }else if(market.status!=="OPEN"){
      decision={action:"WAIT",reason:`Market closed — ${market.reason}.`};
    }

    const signal=entry.status==="ENTRY_READY"
      ? {
          signal:entry.side,
          direction:entry.side,
          signalKey:push.signalKey || `${entry.side}|${entry.triggerCandle}|${entry.level}`,
          reason:decision.reason
        }
      : {
          signal:"WAIT",
          direction:"NEUTRAL",
          signalKey:null,
          reason:decision.reason
        };

    const h1ctx=swingContext(h1,entry.side || null);

    return res.status(200).json({
      ok:true,
      engine:"XAUUSD-SCALP-V4",
      source,
      background,
      timestamp:new Date().toISOString(),
      marketStatus:market.status,
      marketReason:market.reason,
      price,
      scalpOnly:true,

      candles:m5.slice(-60).map(x=>({
        time:x.time,datetime:x.time,
        open:x.open,high:x.high,low:x.low,close:x.close,volume:x.volume
      })),

      m5:{
        structure:{
          direction:m5s.direction,
          event:m5s.event,
          side:m5s.side,
          level:m5s.level,
          candle:m5s.candle
        }
      },

      m15:{
        structure:{
          direction:m15s.direction,
          event:m15s.event,
          side:m15s.side,
          level:m15s.level,
          candle:m15s.candle
        }
      },

      scalpSR:sr,
      h1Context:h1ctx,
      breakout,
      tradeDecision:decision,
      entry,
      signal,
      quality,

      data:{
        m5Candles:m5.length,
        m15Candles:m15.length,
        h1Candles:h1.length,
        cache:{
          m5AgeSeconds:m5d.savedAt ? Math.max(0,Math.round((now-m5d.savedAt)/1000)) : null,
          m15AgeSeconds:m15d.savedAt ? Math.max(0,Math.round((now-m15d.savedAt)/1000)) : null,
          h1AgeSeconds:h1d.savedAt ? Math.max(0,Math.round((now-h1d.savedAt)/1000)) : null
        },
        staleFallback:Boolean(m5d.staleFallback||m15d.staleFallback||h1d.staleFallback)
      },

      rules:{
        primary:"M5 standalone scalp trigger",
        trigger:"Closed M5 cross of confirmed 2-left / 2-right swing",
        m15:"Confirmation and quality scoring; never a swing hold signal",
        h1:"Swing context only; NEVER blocks scalp entry",
        minimumScore:CFG.minScore,
        minimumRR:CFG.minRR,
        stop:"Trigger candle extreme + 0.15 ATR buffer",
        entry:"Closed M5 breakout price; retest is NOT required",
        push:"Backend only; duplicate locked by signal key for 24h"
      },

      push
    });
  }catch(e){
    console.error(e);
    const msg=String(e?.message||e||"Unknown error");
    const status=/429|rate.?limit|too many requests/i.test(msg) ? 503 : 500;
    return res.status(status).json({
      ok:false,
      error:msg,
      hint:status===503
        ?"Twelve Data rate limit. The engine keeps cached data as fallback."
        :undefined
    });
  }
}
