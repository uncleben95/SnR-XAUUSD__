// XAU/USD SCALP PRO
// M5 + M15 primary. H1 = context only.
// Flow: existing confirmed swing S/R -> closed breakout -> M5 retest -> M5 confirmation -> ENTRY READY.

import { sendPushToAll, redis } from "./push-lib.js";

const TD_KEY = process.env.TWELVEDATA_API_KEY || process.env.TWELVE_DATA_API_KEY;
const BASE = "https://api.twelvedata.com/time_series";

const CFG = {
  symbol: "XAU/USD",
  pivot: 2,
  retestBars: 3,
  minRR: 1.5,
  outputM5: 500,
  outputM15: 300,
  outputH1: 200,
  pendingKey: "xau:scalp:v40:pending",
  notifiedPrefix: "xau:scalp:v40:notified:"
};

function utcTime(x){
  return new Date(String(x).replace(" ","T")+"Z").getTime();
}
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
  let event="NONE", level=null;
  const x=c[last];
  if(h1&&x.close>h1.price){event="BOS_UP";direction="BULLISH";level=h1;}
  else if(l1&&x.close<l1.price){event="BOS_DOWN";direction="BEARISH";level=l1;}
  return {direction,event,level,candle:x,pivots:p};
}
function combinedSR(m5,m15,price){
  const a=pivots(m5,CFG.pivot,CFG.pivot), b=pivots(m15,CFG.pivot,CFG.pivot);
  const lows=[...a.lows,...b.lows].filter(x=>x.price<price).sort((x,y)=>price-y.price);
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
    const bucket=Date.UTC(
      d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate(),
      d.getUTCHours(),Math.floor(d.getUTCMinutes()/15)*15,0,0
    );
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
async function td(interval,outputsize,cacheKey,ttlMs){
  const key=cacheKey || `xau:td:${interval}`;
  try{
    const cached=await redis.get(key);
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
      ex:Math.max(60,Math.round((ttlMs||300000)/1000))
    });
  }catch{}

  return rows;
}
async function getPending(){
  try{return await redis.get(CFG.pendingKey);}catch{return null;}
}
async function setPending(v){ await redis.set(CFG.pendingKey,JSON.stringify(v),{ex:1800}); }
async function clearPending(){ try{await redis.del(CFG.pendingKey);}catch{} }
function parsePending(v){ if(!v)return null; if(typeof v==="string")try{return JSON.parse(v);}catch{return null;} return v; }
async function notify(entry){
  const key=`${entry.side}|${entry.breakoutCandle}|${entry.level}|${entry.confirmationCandle}`;
  const lock=CFG.notifiedPrefix+key.replace(/[^A-Za-z0-9_.:-]/g,"_");
  try{
    const got=await redis.set(lock,"1",{nx:true,ex:86400});
    if(got!=="OK") return {attempted:false,sent:false,status:"ALREADY_NOTIFIED",signalKey:key};
    const r=await sendPushToAll({
      title:`XAUUSD ${entry.side} ENTRY READY`,
      body:`${entry.side} • Entry ${entry.price.toFixed(2)} • SL ${entry.sl.toFixed(2)} • TP1 ${entry.tp1.toFixed(2)} • RR ${entry.rr}R`,
      tag:`xau-entry-${key}`,
      url:"/"
    });
    return {attempted:true,sent:Number(r.sent||0)>0,status:Number(r.sent||0)>0?"PUSH_SENT":"NO_SUBSCRIPTIONS",signalKey:key,details:r};
  }catch(e){return {attempted:true,sent:false,status:"PUSH_ERROR",error:e.message,signalKey:key};}
}

export default async function handler(req,res){
  try{
    if(!TD_KEY) return res.status(500).json({ok:false,error:"Missing TWELVEDATA_API_KEY"});
    const session=marketSession();

    // Rate-limit protection:
    // M5 + H1 are fetched from Twelve Data; M15 is aggregated exactly
    // from closed M5 candles. Both provider series are persisted in Redis.
    const [m5raw,h1raw]=await Promise.all([
      td("5min",CFG.outputM5,"xau:td:m5",5*60*1000),
      td("1h",CFG.outputH1,"xau:td:h1",60*60*1000)
    ]);

    const m5=closedRows(m5raw,5);
    const m15=closedRows(aggregateM5ToM15(m5),15);
    const h1=closedRows(h1raw,60);
    if(m5.length<80||m15.length<20||h1.length<20) throw new Error("Insufficient closed market data");

    const price=m5.at(-1).close;
    const s5=structure(m5), s15=structure(m15), sr=combinedSR(m5,m15,price);
    const h1s=structure(h1), h1r=h1Range(h1);
    let pending=parsePending(await getPending());
    let breakout=null, entry={status:"WAIT_BREAKOUT",price:null,level:null,sl:null,tp1:null,tp2:null,tp3:null,rr:null};
    let decision={action:"WAIT",reason:"Waiting for a confirmed closed-candle breakout of existing M5/M15 support or resistance."};
    let push={attempted:false,sent:false,status:"NO_NEW_SETUP"};

    // Create persistent breakout state only during an open XAU/USD session.
    // H1 is context/liquidity only and never blocks the M5/M15 scalp.
    const last=m5.at(-1), prev=m5.at(-2);
    if(session.status==="OPEN" && !pending && prev){
      const buyLevel=sr.resistance, sellLevel=sr.support;
      if(buyLevel && prev.close<=buyLevel.price && last.close>buyLevel.price){
        pending={side:"BUY",level:buyLevel.price,breakoutCandle:last.time,breakoutIndex:m5.length-1,createdAt:Date.now()};
        await setPending(pending);
      } else if(sellLevel && prev.close>=sellLevel.price && last.close<sellLevel.price){
        pending={side:"SELL",level:sellLevel.price,breakoutCandle:last.time,breakoutIndex:m5.length-1,createdAt:Date.now()};
        await setPending(pending);
      }
    }

    if(session.status!=="OPEN" && pending){
      // Do not progress or notify a stale setup while the market is closed.
      decision={action:"WAIT",reason:`Market closed — ${session.reason}.`};
      entry.status="WAIT_BREAKOUT";
      breakout=null;
    }

    if(pending && session.status==="OPEN"){
      const bi=m5.findIndex(x=>x.time===pending.breakoutCandle);
      if(bi<0 || m5.length-1-bi>CFG.retestBars+1){
        await clearPending(); pending=null;
        decision={action:"WAIT",reason:"Breakout retest window expired."};
      }
    }

    if(pending){
      const bi=m5.findIndex(x=>x.time===pending.breakoutCandle);
      breakout={confirmed:true,side:pending.side,price:pending.level,level:{price:pending.level,type:pending.side==="BUY"?"SWING_HIGH":"SWING_LOW"},candle:{time:pending.breakoutCandle},distanceFromCurrent:price-pending.level};
      let retestIndex=-1;
      for(let i=bi+1;i<m5.length && i<=bi+CFG.retestBars;i++){
        const c=m5[i];
        if(pending.side==="BUY" && c.low<=pending.level){retestIndex=i;break;}
        if(pending.side==="SELL" && c.high>=pending.level){retestIndex=i;break;}
      }
      if(retestIndex<0){
        decision={action:"WAIT_RETEST",reason:`Confirmed ${pending.side} breakout. Waiting up to ${CFG.retestBars} M5 candles for retest.`};
        entry.status="WAIT_RETEST";
      } else {
        const ret=m5[retestIndex], conf=m5[retestIndex+1];
        if(!conf){
          decision={action:"WAIT_RETEST",reason:"Retest found; waiting for next closed M5 confirmation candle."};
          entry.status="WAIT_RETEST";
        } else {
          const confirmed=pending.side==="BUY" ? conf.close>ret.high : conf.close<ret.low;
          if(!confirmed){
            decision={action:"WAIT",reason:"Retest occurred but M5 continuation confirmation failed."};
            await clearPending(); pending=null; breakout=null;
          } else {
            const ep=conf.close;
            const sl=pending.side==="BUY" ? Math.min(ret.low,pending.level-0.10) : Math.max(ret.high,pending.level+0.10);
            const risk=Math.abs(ep-sl);
            const pp=pivots(m5,CFG.pivot,CFG.pivot);
            const targets=pending.side==="BUY"
              ? pp.highs.filter(x=>x.index<=retestIndex && x.price>ep+risk*CFG.minRR).sort((a,b)=>a.price-b.price)
              : pp.lows.filter(x=>x.index<=retestIndex && x.price<ep-risk*CFG.minRR).sort((a,b)=>b.price-a.price);
            const t1=targets[0]?.price||null, t2=targets[1]?.price||null, t3=targets[2]?.price||null;
            const rr=t1 ? Math.abs(t1-ep)/risk : null;
            if(rr && rr>=CFG.minRR){
              entry={status:"ENTRY_READY",price:ep,level:pending.level,sl,tp1:t1,tp2:t2,tp3:t3,rr:Number(rr.toFixed(2)),side:pending.side,breakoutCandle:pending.breakoutCandle,retestCandle:ret.time,confirmationCandle:conf.time};
              decision={action:"ENTRY_READY",reason:"Closed breakout + M5 retest + M5 continuation confirmed with minimum 1.5R target."};
              const signalKey=`${pending.side}|${pending.breakoutCandle}|${pending.level}|${conf.time}`;
              push=session.status==="OPEN"
                ? await notify(entry)
                : {attempted:false,sent:false,status:"MARKET_CLOSED",signalKey};
              push.signalKey=signalKey;
              await clearPending();
              breakout={confirmed:true,side:pending.side,price:pending.level,level:{price:pending.level,type:pending.side==="BUY"?"SWING_HIGH":"SWING_LOW"},candle:{time:pending.breakoutCandle},distanceFromCurrent:price-pending.level};
            } else {
              decision={action:"WAIT",reason:"M5 confirmation exists, but the next confirmed target does not provide the required 1.5R."};
              entry={status:"WAIT_RR",price:ep,level:pending.level,sl,rr:rr?Number(rr.toFixed(2)):null,tp1:t1,tp2:t2,tp3:t3};
              await clearPending(); pending=null;
            }
          }
        }
      }
    }

    const signal=entry.status==="ENTRY_READY" ? {signal:entry.side,direction:entry.side,signalKey:push.signalKey||`${entry.side}|${entry.breakoutCandle}|${entry.confirmationCandle}`,reason:decision.reason} : {signal:"WAIT",direction:"NEUTRAL",signalKey:null,reason:decision.reason};
    const h1Context={direction:h1s.direction,hold:"CONTEXT_ONLY",role:"ANALYSIS_ONLY",structureEvent:h1s.event,lastSwingHigh:h1r.high,lastSwingLow:h1r.low,alignment:s5.direction===h1s.direction&&s15.direction===h1s.direction?"ALIGNED":s5.direction===h1s.direction||s15.direction===h1s.direction?"MIXED":"OPPOSED"};
    return res.status(200).json({
      ok:true,engine:"XAUUSD-SCALP-PRO-SR-RETEST",timestamp:new Date().toISOString(),marketStatus:session.status,marketReason:session.reason,price,scalpOnly:true,
      candles:m5.slice(-60).map(x=>({time:x.time,datetime:x.time,open:x.open,high:x.high,low:x.low,close:x.close,volume:x.volume})),
      m15:{structure:{direction:s15.direction,event:s15.event,level:s15.level,candle:s15.candle}},
      m5:{structure:{direction:s5.direction,event:s5.event,level:s5.level,candle:s5.candle}},
      scalpSR:sr,
      h1Range:{high:h1r.high,low:h1r.low,reference:"Latest confirmed H1 swing context"},
      h1Context,
      breakout,
      tradeDecision:decision,
      entry,
      signal,
      data:{m5Candles:m5.length,m15Candles:m15.length,h1Candles:h1.length},
      rules:{primary:"M5 + M15 scalp",supportResistance:"Nearest confirmed M5/M15 swing structure",breakout:"Closed M5 candle through existing S/R",entry:"Breakout -> M5 retest -> M5 continuation",minimumRR:CFG.minRR,h1:"Context only; never blocks scalp"},
      push
    });
  }catch(e){
    console.error(e);
    const msg=String(e?.message||e||"Unknown error");
    const status=/Twelve Data HTTP 429|rate.?limit|too many requests/i.test(msg) ? 503 : 500;
    return res.status(status).json({
      ok:false,
      error:msg,
      hint:status===503 ? "Twelve Data rate limit; cached M5/H1 data will be used after a successful fetch." : undefined
    });
  }
}
