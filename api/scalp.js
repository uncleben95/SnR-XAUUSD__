// XAU/USD SCALP PRO
// M5 breakout engine: no retest required.
// M15 + H1 remain context. Every fresh closed M5 structure breakout is evaluated.

import { sendPushToAll, redis } from "./push-lib.js";

const TD_KEY = process.env.TWELVEDATA_API_KEY || process.env.TWELVE_DATA_API_KEY;
const BASE = "https://api.twelvedata.com/time_series";

const CFG = {
  symbol: "XAU/USD",
  pivot: 2,
  minRR: 1.5,
  minScore: 60,
  outputM5: 500,
  outputH1: 200,
  m5CacheTTL: 60 * 1000,
  h1CacheTTL: 60 * 60 * 1000,
  notifiedPrefix: "xau:scalp:v41:notified:",
  eventSeenPrefix: "xau:scalp:v41:event-seen:"
};

function utcTime(x){ return new Date(String(x).replace(" ","T")+"Z").getTime(); }
function fmtTime(ms){ return new Date(ms).toISOString().replace("T"," ").replace(".000Z",""); }

function cleanRows(values){
  return (values||[]).map(x=>({
    time:String(x.datetime||x.time||"").replace("T"," ").replace("Z",""),
    open:Number(x.open), high:Number(x.high), low:Number(x.low), close:Number(x.close), volume:Number(x.volume||0)
  })).filter(x=>x.time && [x.open,x.high,x.low,x.close].every(Number.isFinite))
    .sort((a,b)=>utcTime(a.time)-utcTime(b.time));
}

function closedRows(rows, minutes, now=Date.now()){
  return rows.filter(x=>utcTime(x.time)+minutes*60000<=now);
}

function pivots(c,L=2,R=2){
  const hi=[],lo=[];
  for(let i=L;i<c.length-R;i++){
    let H=true,LW=true;
    for(let j=1;j<=L;j++){ if(c[i].high<=c[i-j].high)H=false; if(c[i].low>=c[i-j].low)LW=false; }
    for(let j=1;j<=R;j++){ if(c[i].high<c[i+j].high)H=false; if(c[i].low>c[i+j].low)LW=false; }
    if(H)hi.push({price:c[i].high,time:c[i].time,index:i,type:"SWING_HIGH"});
    if(LW)lo.push({price:c[i].low,time:c[i].time,index:i,type:"SWING_LOW"});
  }
  return {highs:hi,lows:lo};
}

function structure(c){
  const p=pivots(c,CFG.pivot,CFG.pivot);
  const last=c.length-1;
  const hs=p.highs.filter(x=>x.index<last), ls=p.lows.filter(x=>x.index<last);
  const h1=hs.at(-1), h2=hs.at(-2), l1=ls.at(-1), l2=ls.at(-2);
  let direction="RANGE";
  if(h1&&h2&&h1.price>h2.price) direction="BULLISH";
  if(l1&&l2&&l1.price<l2.price) direction="BEARISH";

  const x=c[last];
  let event="NONE", level=null, side=null;
  if(h1 && x.close>h1.price){
    side="BUY";
    level=h1;
    event=direction==="BEARISH" ? "CHOCH_UP" : "BOS_UP";
    direction="BULLISH";
  }else if(l1 && x.close<l1.price){
    side="SELL";
    level=l1;
    event=direction==="BULLISH" ? "CHOCH_DOWN" : "BOS_DOWN";
    direction="BEARISH";
  }
  return {direction,event,level,side,candle:x,pivots:p};
}

function combinedSR(m5,m15,price){
  const a=pivots(m5,CFG.pivot,CFG.pivot), b=pivots(m15,CFG.pivot,CFG.pivot);
  const lows=[...a.lows,...b.lows].filter(x=>x.price<price).sort((x,y)=>y.price-x.price);
  const highs=[...a.highs,...b.highs].filter(x=>x.price>price).sort((x,y)=>x.price-y.price);
  return {
    support:lows[0]||null,
    resistance:highs[0]||null,
    reference:"Nearest confirmed M5/M15 swing structure"
  };
}

function aggregateM5ToM15(m5){
  const buckets=new Map();
  for(const c of m5){
    const t=utcTime(c.time);
    if(!Number.isFinite(t)) continue;
    const d=new Date(t);
    const bucket=Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate(),d.getUTCHours(),Math.floor(d.getUTCMinutes()/15)*15,0,0);
    const k=String(bucket);
    if(!buckets.has(k)) buckets.set(k,[]);
    buckets.get(k).push(c);
  }
  return [...buckets.entries()].map(([k,rows])=>({
    time:fmtTime(Number(k)),
    open:rows[0].open,
    high:Math.max(...rows.map(x=>x.high)),
    low:Math.min(...rows.map(x=>x.low)),
    close:rows.at(-1).close,
    volume:rows.reduce((a,x)=>a+(Number(x.volume)||0),0)
  })).sort((a,b)=>utcTime(a.time)-utcTime(b.time));
}

function h1Range(h1){
  const p=pivots(h1,CFG.pivot,CFG.pivot), last=h1.length-1;
  return {
    high:p.highs.filter(x=>x.index<last).at(-1)||null,
    low:p.lows.filter(x=>x.index<last).at(-1)||null
  };
}

function marketSession(now=Date.now()){
  const d=new Date(now), day=d.getUTCDay(), mins=d.getUTCHours()*60+d.getUTCMinutes();
  if(day===6) return {status:"CLOSED",reason:"Saturday"};
  if(day===0 && mins<1320) return {status:"CLOSED",reason:"Before Sunday 22:00 UTC"};
  if(day===5 && mins>=1260) return {status:"CLOSED",reason:"Friday after 21:00 UTC"};
  if(day>=1&&day<=5&&mins>=1260&&mins<1320) return {status:"CLOSED",reason:"Daily maintenance break"};
  return {status:"OPEN",reason:"XAU/USD session open"};
}

async function td(interval,outputsize,cacheKey,ttlMs,forceRefresh=false){
  const key=cacheKey || `xau:td:${interval}`;
  try{
    const cached=forceRefresh ? null : await redis.get(key);
    if(cached){
      const parsed=typeof cached==="string" ? JSON.parse(cached) : cached;
      if(Array.isArray(parsed?.rows) && parsed.rows.length) return cleanRows(parsed.rows);
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
  try{ j=await r.json(); }catch{}

  if(!r.ok || j?.status==="error" || !Array.isArray(j?.values)){
    try{
      const cached=await redis.get(key);
      if(cached){
        const parsed=typeof cached==="string" ? JSON.parse(cached) : cached;
        if(Array.isArray(parsed?.rows) && parsed.rows.length) return cleanRows(parsed.rows);
      }
    }catch{}
    throw new Error(j?.message || `Twelve Data HTTP ${r.status}`);
  }

  const rows=cleanRows(j.values);
  if(!rows.length) throw new Error(`No ${interval} candles returned`);

  try{
    await redis.set(key,JSON.stringify({rows,savedAt:Date.now()}),{
      ex:Math.max(30,Math.round((ttlMs||300000)/1000))
    });
  }catch{}
  return rows;
}

function atr(c,n=14){
  if(c.length<n+1) return null;
  const trs=[];
  for(let i=1;i<c.length;i++){
    trs.push(Math.max(c[i].high-c[i].low,Math.abs(c[i].high-c[i-1].close),Math.abs(c[i].low-c[i-1].close)));
  }
  const a=trs.slice(-n);
  return a.reduce((x,y)=>x+y,0)/a.length;
}

function ema(c,n){
  if(c.length<n) return null;
  const k=2/(n+1);
  let e=c.slice(0,n).reduce((a,x)=>a+x.close,0)/n;
  for(let i=n;i<c.length;i++) e=c[i].close*k+e*(1-k);
  return e;
}

function bollinger(c,n=20,m=2){
  if(c.length<n) return null;
  const a=c.slice(-n).map(x=>x.close);
  const mean=a.reduce((x,y)=>x+y,0)/n;
  const sd=Math.sqrt(a.reduce((x,y)=>x+(y-mean)**2,0)/n);
  return {mid:mean,upper:mean+m*sd,lower:mean-m*sd};
}

function breakoutQuality(m5,m15,h1,s5,s15,side){
  const c=s5.candle;
  const atr5=atr(m5,14)||Math.max(c.high-c.low,0.1);
  const bb=bollinger(m5,20,2);
  const e20=ema(m5,20), e50=ema(m5,50);
  const body=Math.abs(c.close-c.open);
  const range=Math.max(c.high-c.low,0.0001);
  const bodyRatio=body/range;
  let score=50;
  const reasons=[];

  if(bodyRatio>=0.55){score+=15; reasons.push("Strong M5 candle body");}
  else if(bodyRatio>=0.35){score+=7; reasons.push("Moderate M5 body");}
  else {score-=8; reasons.push("Weak breakout candle body");}

  if(side==="BUY" && c.close>c.open || side==="SELL" && c.close<c.open){
    score+=8; reasons.push("Breakout candle agrees with direction");
  }else{
    score-=8; reasons.push("Breakout candle has opposing body");
  }

  if(side==="BUY" && e20&&e50&&e20>e50 || side==="SELL" && e20&&e50&&e20<e50){
    score+=10; reasons.push("M5 EMA20/50 alignment");
  }else if(e20&&e50){
    score-=5; reasons.push("M5 EMA20/50 not aligned");
  }

  if(bb){
    if(side==="BUY" && c.close>=bb.upper){score+=8; reasons.push("Upper Bollinger breakout");}
    if(side==="SELL" && c.close<=bb.lower){score+=8; reasons.push("Lower Bollinger breakout");}
  }

  if((side==="BUY"&&s15.direction==="BULLISH")||(side==="SELL"&&s15.direction==="BEARISH")){
    score+=9; reasons.push("M15 structure aligned");
  }else if((side==="BUY"&&s15.direction==="BEARISH")||(side==="SELL"&&s15.direction==="BULLISH")){
    score-=6; reasons.push("M15 structure opposed");
  }

  if((side==="BUY"&&h1.direction==="BULLISH")||(side==="SELL"&&h1.direction==="BEARISH")){
    score+=5; reasons.push("H1 context aligned");
  }

  if(range>atr5*1.8){score-=8; reasons.push("Breakout candle unusually extended");}
  else if(range>=atr5*0.7){score+=5; reasons.push("Breakout range has usable expansion");}

  score=Math.max(0,Math.min(100,Math.round(score)));
  return {score,grade:score>=80?"HIGH":score>=70?"GOOD":score>=CFG.minScore?"POTENTIAL":"WEAK",atr:Number(atr5.toFixed(2)),bodyRatio:Number(bodyRatio.toFixed(2)),bollinger:bb,ema20:e20,ema50:e50,reasons};
}

function buildTrade(m5,m15,s5,side,quality){
  const ep=s5.candle.close;
  const a=quality.atr||Math.abs(s5.candle.high-s5.candle.low)||1;
  const recent=m5.slice(-5);
  const rawSL=side==="BUY"
    ? Math.min(s5.candle.low,...recent.map(x=>x.low))-Math.max(0.10,a*0.12)
    : Math.max(s5.candle.high,...recent.map(x=>x.high))+Math.max(0.10,a*0.12);
  const risk=Math.abs(ep-rawSL);

  const p5=pivots(m5,CFG.pivot,CFG.pivot), p15=pivots(m15,CFG.pivot,CFG.pivot);
  const levels=side==="BUY"
    ? [...p5.highs,...p15.highs].filter(x=>x.price>ep).sort((a,b)=>a.price-b.price)
    : [...p5.lows,...p15.lows].filter(x=>x.price<ep).sort((a,b)=>b.price-a.price);

  const targets=levels.filter(x=>Math.abs(x.price-ep)>=risk*CFG.minRR);
  const t1=targets[0]?.price ?? (side==="BUY"?ep+risk*CFG.minRR:ep-risk*CFG.minRR);
  const t2=targets[1]?.price ?? null;
  const t3=targets[2]?.price ?? null;
  const rr=Math.abs(t1-ep)/risk;

  return {
    status:quality.score>=CFG.minScore?"ENTRY_READY":"WAIT",
    side,price:ep,level:s5.level?.price||null,
    sl:Number(rawSL.toFixed(2)),tp1:Number(t1.toFixed(2)),tp2:t2?Number(t2.toFixed(2)):null,tp3:t3?Number(t3.toFixed(2)):null,
    rr:Number(rr.toFixed(2)),risk:Number(risk.toFixed(2)),
    breakoutCandle:s5.candle.time,confirmationCandle:s5.candle.time,
    execution:"BREAKOUT_CLOSE — NO RETEST"
  };
}

async function notify(entry,quality){
  const key=`${entry.side}|${entry.breakoutCandle}|${entry.level}`;
  const lock=CFG.notifiedPrefix+key.replace(/[^A-Za-z0-9_.:-]/g,"_");

  try{
    const existing=await redis.get(lock);
    if(existing){
      return {attempted:false,sent:false,status:"ALREADY_NOTIFIED",signalKey:key};
    }

    const r=await sendPushToAll({
      title:`XAUUSD ${entry.side} BREAKOUT`,
      body:`M5 breakout • Entry ${entry.price.toFixed(2)} • SL ${entry.sl.toFixed(2)} • TP1 ${entry.tp1.toFixed(2)} • ${quality.grade} ${quality.score}/100`,
      tag:`xau-breakout-${key}`,
      url:"/"
    });

    const sent=Number(r.sent||0)>0;
    if(sent){
      await redis.set(lock,"1",{ex:86400});
    }

    return {
      attempted:true,
      sent,
      status:sent?"PUSH_SENT":"NO_SUBSCRIPTIONS",
      signalKey:key,
      details:r
    };
  }catch(e){
    return {attempted:true,sent:false,status:"PUSH_ERROR",error:e.message,signalKey:key};
  }
}

export default async function handler(req,res){
  try{
    if(!TD_KEY) return res.status(500).json({ok:false,error:"Missing TWELVEDATA_API_KEY"});

    const source=String(req.query?.source||req.headers?.["x-signal-source"]||"dashboard");
    const isBackground=/github|cron|background/i.test(source);
    const session=marketSession();

    // Background calls MUST fetch a fresh M5 dataset. Dashboard calls may use Redis cache.
    const [m5raw,h1raw]=await Promise.all([
      td("5min",CFG.outputM5,"xau:td:m5",CFG.m5CacheTTL,isBackground),
      td("1h",CFG.outputH1,"xau:td:h1",CFG.h1CacheTTL,false)
    ]);

    const m5=closedRows(m5raw,5);
    const m15=closedRows(aggregateM5ToM15(m5),15);
    const h1=closedRows(h1raw,60);
    if(m5.length<80||m15.length<20||h1.length<20) throw new Error("Insufficient closed market data");

    const price=m5.at(-1).close;
    const currentS5=structure(m5);
    const s15=structure(m15), sr=combinedSR(m5,m15,price);
    const h1s=structure(h1), h1r=h1Range(h1);

    let entry={status:"WAIT_BREAKOUT",price:null,level:null,sl:null,tp1:null,tp2:null,tp3:null,rr:null};
    let breakout=null;
    let quality={score:0,grade:"WAIT",reasons:[]};
    let decision={action:"WAIT",reason:"Waiting for a fresh closed M5 breakout of confirmed structure."};
    let push={attempted:false,sent:false,status:"NO_NEW_SETUP"};
    let detectedCandidate=null;

    // IMPORTANT: scan the latest 4 CLOSED M5 candles.
    // This prevents a signal from being missed if GitHub Actions starts a few minutes late.
    if(session.status==="OPEN"){
      const maxLookback=4;
      const first=Math.max(80,m5.length-maxLookback);

      for(let idx=m5.length-1;idx>=first;idx--){
        const candidateRows=m5.slice(0,idx+1);
        if(candidateRows.length<80) continue;

        const cs5=structure(candidateRows);
        if(!["BOS_UP","BOS_DOWN","CHOCH_UP","CHOCH_DOWN"].includes(cs5.event)) continue;

        const side=cs5.side;
        const candidateM15=closedRows(aggregateM5ToM15(candidateRows),15);
        if(candidateM15.length<20) continue;

        const candidateQuality=breakoutQuality(candidateRows,candidateM15,h1s,cs5,structure(candidateM15),side);
        const candidateEntry=buildTrade(candidateRows,candidateM15,cs5,side,candidateQuality);

        if(candidateQuality.score>=CFG.minScore){
          detectedCandidate={idx,side,cs5,candidateM15,candidateQuality,candidateEntry};
          break;
        }

        // Keep the newest lower-quality breakout as informational context.
        if(!detectedCandidate && idx===m5.length-1){
          detectedCandidate={idx,side,cs5,candidateM15,candidateQuality,candidateEntry};
        }
      }
    }

    if(detectedCandidate){
      const {side,cs5,candidateM15,candidateQuality,candidateEntry}=detectedCandidate;
      quality=candidateQuality;
      entry=candidateEntry;
      breakout={
        confirmed:true,side,price:cs5.level.price,
        sourceTimeframe:"M5",structureEvent:cs5.event,
        level:{price:cs5.level.price,type:side==="BUY"?"SWING_HIGH":"SWING_LOW"},
        candle:{time:cs5.candle.time},
        distanceFromCurrent:price-cs5.level.price,
        backgroundLookbackCandles:4
      };

      if(quality.score>=CFG.minScore){
        decision={action:"ENTRY_READY",reason:`Fresh M5 ${cs5.event} breakout. No retest required. ${quality.grade} setup ${quality.score}/100.`};
        push=await notify(entry,quality);
      }else{
        entry.status="WAIT_QUALITY";
        decision={action:"WAIT",reason:`M5 breakout detected but setup quality is ${quality.score}/100, below ${CFG.minScore}/100.`};
      }
    }else if(session.status!=="OPEN"){
      decision={action:"WAIT",reason:`Market closed — ${session.reason}.`};
    }

    const signal=entry.status==="ENTRY_READY"
      ? {signal:entry.side,direction:entry.side,signalKey:push.signalKey||`${entry.side}|${entry.breakoutCandle}|${entry.level}`,reason:decision.reason}
      : {signal:"WAIT",direction:"NEUTRAL",signalKey:null,reason:decision.reason};

    const h1Context={
      direction:h1s.direction,hold:"CONTEXT_ONLY",role:"ANALYSIS_ONLY",structureEvent:h1s.event,
      lastSwingHigh:h1r.high,lastSwingLow:h1r.low,
      alignment:currentS5.direction===h1s.direction&&s15.direction===h1s.direction?"ALIGNED":currentS5.direction===h1s.direction||s15.direction===h1s.direction?"MIXED":"OPPOSED"
    };

    return res.status(200).json({
      ok:true,engine:"XAUUSD-SCALP-PRO-M5-BACKGROUND-V2",source,isBackground,
      timestamp:new Date().toISOString(),marketStatus:session.status,marketReason:session.reason,price,scalpOnly:true,
      candles:m5.slice(-60).map(x=>({time:x.time,datetime:x.time,open:x.open,high:x.high,low:x.low,close:x.close,volume:x.volume})),
      m15:{structure:{direction:s15.direction,event:s15.event,level:s15.level,candle:s15.candle}},
      m5:{structure:{direction:currentS5.direction,event:currentS5.event,level:currentS5.level,candle:currentS5.candle}},
      scalpSR:sr,h1Range:{high:h1r.high,low:h1r.low,reference:"Latest confirmed H1 swing context"},h1Context,
      breakout,tradeDecision:decision,entry,signal,quality,
      data:{m5Candles:m5.length,m15Candles:m15.length,h1Candles:h1.length},
      background:{enabled:true,source,scanClosedM5Candles:4,freshM5Fetch:isBackground,duplicateProtection:"Redis 24h"},
      rules:{
        primary:"M5 breakout execution",supportResistance:"Confirmed M5/M15 swing structure",
        breakout:"Fresh closed M5 BOS/CHOCH",entry:"Breakout candle close — NO RETEST REQUIRED",
        minimumScore:CFG.minScore,minimumRR:CFG.minRR,h1:"Context only; never blocks M5 scalp"
      },
      push
    });
  }catch(e){
    console.error(e);
    const msg=String(e?.message||e||"Unknown error");
    const status=/Twelve Data HTTP 429|rate.?limit|too many requests/i.test(msg) ? 503 : 500;
    return res.status(status).json({ok:false,error:msg,hint:status===503?"Twelve Data rate limit; cached data may be used after a successful fetch.":undefined});
  }
}
