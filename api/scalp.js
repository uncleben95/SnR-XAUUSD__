import { sendPushToAll, redis } from "./push-lib.js";

export default async function handler(req, res) {
  const API_KEY = process.env.TWELVE_DATA_API_KEY;
  if (!API_KEY) return res.status(500).json({ ok:false, error:"TWELVE_DATA_API_KEY belum diset" });

  const CFG = {
    symbol:"XAU/USD",
    m5:{interval:"5min", outputsize:500, ttl:300000},
    m15:{interval:"15min", outputsize:300, ttl:900000},
    h1:{interval:"1h", outputsize:200, ttl:3600000},
    priceTTL:15000,
    redisTTL:7200,
    pushTTL:86400,
    prefix:"xau:scalp:v3"
  };

  const now=Date.now();
  const local={};
  const num=v=>Number(v);
  const valid=n=>Number.isFinite(n);

  async function rget(key){try{return await redis.get(key)}catch(e){console.error("Redis GET",key,e?.message);return null}}
  async function rset(key,value,opts={}){try{return await redis.set(key,value,opts)}catch(e){console.error("Redis SET",key,e?.message);return null}}

  function intervalMs(interval){return interval==="5min"?300000:interval==="15min"?900000:3600000}
  function closed(data,interval){
    const ms=intervalMs(interval);
    return data.filter(c=>{
      const t=Date.parse(String(c.time).replace(" ","T")+"Z");
      return !Number.isFinite(t) || t+ms<=Date.now();
    });
  }

  async function series(key,cfg){
    if(local[key] && now-local[key].at<cfg.ttl) return local[key].data;
    const cacheKey=`${CFG.prefix}:candles:${key}`;
    const url=`https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(CFG.symbol)}&interval=${cfg.interval}&outputsize=${cfg.outputsize}&timezone=UTC&apikey=${encodeURIComponent(API_KEY)}`;
    try{
      const controller=new AbortController();
      const timer=setTimeout(()=>controller.abort(),10000);
      const r=await fetch(url,{signal:controller.signal});
      clearTimeout(timer);
      const j=await r.json();
      if(!r.ok || j.status==="error" || !Array.isArray(j.values)) throw new Error(j.message||`Twelve Data ${cfg.interval} error`);
      const data=closed(j.values.reverse().map(x=>({time:x.datetime,open:num(x.open),high:num(x.high),low:num(x.low),close:num(x.close),volume:num(x.volume)||0})).filter(x=>[x.open,x.high,x.low,x.close].every(valid)),cfg.interval);
      if(data.length<50) throw new Error(`${key} data tak cukup: ${data.length}`);
      local[key]={at:Date.now(),data};
      await rset(cacheKey,{savedAt:Date.now(),data},{ex:CFG.redisTTL});
      return data;
    }catch(e){
      console.error(`${key} Twelve Data failed`,e?.message||e);
      const cached=await rget(cacheKey);
      if(cached?.data?.length) return closed(cached.data,cfg.interval);
      throw e;
    }
  }

  async function livePrice(){
    if(local.price && now-local.price.at<CFG.priceTTL) return local.price.value;
    const key=`${CFG.prefix}:price`;
    try{
      const r=await fetch(`https://api.twelvedata.com/price?symbol=${encodeURIComponent(CFG.symbol)}&apikey=${encodeURIComponent(API_KEY)}`);
      const j=await r.json(); const p=num(j.price);
      if(!valid(p)) throw new Error(j.message||"Invalid price");
      local.price={at:Date.now(),value:p};
      await rset(key,p,{ex:60});
      return p;
    }catch(e){const p=num(await rget(key)); if(valid(p)) return p; throw e}
  }

  function swings(data,left=2,right=2){
    const highs=[],lows=[];
    for(let i=left;i<data.length-right;i++){
      let hi=true,lo=true;
      for(let k=1;k<=left;k++){if(data[i].high<=data[i-k].high)hi=false;if(data[i].low>=data[i-k].low)lo=false}
      for(let k=1;k<=right;k++){if(data[i].high<data[i+k].high)hi=false;if(data[i].low>data[i+k].low)lo=false}
      if(hi)highs.push({price:data[i].high,time:data[i].time,index:i,type:"SWING_HIGH"});
      if(lo)lows.push({price:data[i].low,time:data[i].time,index:i,type:"SWING_LOW"});
    }
    return {highs,lows};
  }

  function nearest(data,price){
    const s=swings(data), support=s.lows.filter(x=>x.price<price).sort((a,b)=>b.price-a.price)[0]||null, resistance=s.highs.filter(x=>x.price>price).sort((a,b)=>a.price-b.price)[0]||null;
    return {support,resistance,swings:s};
  }

  function levelRef(level,price){
    if(!level) return null;
    const distance=Math.abs(price-level.price);
    const distancePct=price ? (distance/price)*100 : null;
    return {
      price:level.price, time:level.time, index:level.index, type:level.type,
      distance:Number(distance.toFixed(4)),
      distancePct:Number((distancePct||0).toFixed(4)),
      reference:level.type==="SWING_LOW"?"CONFIRMED_SWING_LOW":"CONFIRMED_SWING_HIGH"
    };
  }

  function structure(data){
    const s=swings(data), last=data.at(-1);
    const ph=s.highs.at(-2), lh=s.highs.at(-1), pl=s.lows.at(-2), ll=s.lows.at(-1);
    if(!last) return {direction:"WAIT",event:null};
    if(lh && last.close>lh.price) return {direction:"BULLISH",event:"BOS_UP",level:lh,candle:last};
    if(ll && last.close<ll.price) return {direction:"BEARISH",event:"BOS_DOWN",level:ll,candle:last};
    if(ph&&lh&&pl&&ll){
      if(lh.price>ph.price && ll.price>pl.price) return {direction:"BULLISH",event:"HH_HL",level:lh,candle:last};
      if(lh.price<ph.price && ll.price<pl.price) return {direction:"BEARISH",event:"LH_LL",level:ll,candle:last};
    }
    return {direction:"RANGE",event:null,candle:last};
  }

  function breakout(data,level,side){
    if(!level || data.length<2) return null;
    const prev=data.at(-2), last=data.at(-1);
    if(side==="BUY" && prev.close<=level.price && last.close>level.price) return {side,level,candle:last};
    if(side==="SELL" && prev.close>=level.price && last.close<level.price) return {side,level,candle:last};
    return null;
  }

  function h1Range(data, lookback=20){
    const sample=data.slice(-lookback);
    if(!sample.length) return {high:null,low:null,lookback:0,from:null,to:null};
    const high=sample.reduce((a,c)=>c.high>a?c.high:a,-Infinity);
    const low=sample.reduce((a,c)=>c.low<a?c.low:a,Infinity);
    return {
      high:Number.isFinite(high)?high:null,
      low:Number.isFinite(low)?low:null,
      lookback:sample.length,
      from:sample[0]?.time||null,
      to:sample.at(-1)?.time||null,
      reference:`LAST_${sample.length}_CLOSED_H1_CANDLES`
    };
  }

  function h1Context(data){
    const s=swings(data,3,3), last=data.at(-1), h=s.highs.at(-1), l=s.lows.at(-1);
    if(!last||!h||!l) return {direction:"RANGE",hold:"CONTEXT_ONLY"};
    if(last.close>h.price) return {direction:"BULLISH",hold:"HOLD_BUY_IF_SCALP_ALIGNS"};
    if(last.close<l.price) return {direction:"BEARISH",hold:"HOLD_SELL_IF_SCALP_ALIGNS"};
    return {direction:"RANGE",hold:"CONTEXT_ONLY"};
  }

  try{
    const [m5,m15,h1,price]=await Promise.all([series("m5",CFG.m5),series("m15",CFG.m15),series("h1",CFG.h1),livePrice()]);
    const sr5=nearest(m5,price), sr15=nearest(m15,price);
    const support=[sr5.support,sr15.support].filter(Boolean).sort((a,b)=>b.price-a.price)[0]||null;
    const resistance=[sr5.resistance,sr15.resistance].filter(Boolean).sort((a,b)=>a.price-b.price)[0]||null;
    const m5s=structure(m5),m15s=structure(m15);
    const supportRef=levelRef(support,price);
    const resistanceRef=levelRef(resistance,price);

    // SCALP FLOW: existing S/R -> closed-candle breakout -> M5 retest -> entry.
    const buy15=breakout(m15,resistance,"BUY");
    const sell15=breakout(m15,support,"SELL");
    const buy5=breakout(m5,resistance,"BUY");
    const sell5=breakout(m5,support,"SELL");

    // Only accept a breakout when a CLOSED candle actually crossed the level.
    // If M5 and M15 both confirm the same side, use the newest confirmation.
    // If they confirm opposite sides at the same time, treat it as ambiguous.
    const breakCandidates=[buy15,sell15,buy5,sell5].filter(Boolean);
    const breakSides=[...new Set(breakCandidates.map(x=>x.side))];
    let rawBreak=null;
    if(breakSides.length===1 && breakCandidates.length){
      rawBreak=breakCandidates.sort((a,b)=>{
        const ta=Date.parse(String(a.candle.time).replace(" ","T")+"Z");
        const tb=Date.parse(String(b.candle.time).replace(" ","T")+"Z");
        return tb-ta;
      })[0];
    }

    // PERSIST THE BREAKOUT STATE so a GitHub Actions/API call after the breakout
    // cannot lose the setup before the next M5 candle performs the retest.
    const PENDING_KEY=`${CFG.prefix}:pending-breakout`;
    const RETEST_MAX_M5_CANDLES=3;
    let pending=await rget(PENDING_KEY);
    if(pending && typeof pending==="string"){ try{ pending=JSON.parse(pending); }catch{ pending=null; } }
    if(pending && pending.status==="COMPLETED") pending=null;

    if(rawBreak){
      const rawTime=String(rawBreak.candle.time);
      const pendingTime=String(pending?.candle?.time||"");
      const samePending=pending && pending.side===rawBreak.side && pendingTime===rawTime && Number(pending.level?.price)===Number(rawBreak.level.price);
      if(!pending || (!samePending && Number(pending.expiresAt||0)<=now)){
        pending={
          status:"PENDING_RETEST",
          side:rawBreak.side,
          level:rawBreak.level,
          candle:rawBreak.candle,
          createdAt:now,
          expiresAt:now+(RETEST_MAX_M5_CANDLES*CFG.m5.ttl)
        };
        await rset(PENDING_KEY,pending,{ex:900});
      }
    }

    // If a pending breakout exists, evaluate ONLY the next 3 CLOSED M5 candles.
    // This survives separate GitHub Actions calls and never searches old history.
    const activePending=(pending && Number(pending.expiresAt||0)>now)?pending:null;
    let direction="WAIT", entryStatus=activePending?"WAIT_RETEST":"WAIT_BREAKOUT", breakoutEvent=activePending||rawBreak, entry=null;
    let reason=activePending
      ? `${activePending.side} breakout confirmed at ${Number(activePending.level.price).toFixed(2)} — WAIT RETEST.`
      : "WAIT — waiting for a confirmed closed-candle breakout of existing M5/M15 support or resistance.";
    let tradeAction=activePending?"WAIT_RETEST":"WAIT";
    let tradeActionReason=activePending
      ? `Wait for price to retest ${activePending.level.type === "SWING_LOW" ? "support" : "resistance"} at ${Number(activePending.level.price).toFixed(2)} and confirm on M5.`
      : "No confirmed breakout yet.";

    if(activePending){
      const breakIndex=m5.findIndex(c=>String(c.time)===String(activePending.candle.time));
      const after=breakIndex>=0 ? m5.slice(breakIndex+1,breakIndex+1+RETEST_MAX_M5_CANDLES) : [];
      const retestCandle=after.find(c=>{
        if(activePending.side==="BUY") return c.low<=Number(activePending.level.price) && c.close>Number(activePending.level.price);
        return c.high>=Number(activePending.level.price) && c.close<Number(activePending.level.price);
      });
      const candlesSeen=after.length;

      if(retestCandle){
        const st=structure(m5);
        const aligned=activePending.side==="BUY" ? st.direction==="BULLISH" : st.direction==="BEARISH";
        if(aligned){
          direction=activePending.side;
          entryStatus="ENTRY_READY";
          tradeAction="ENTRY";
          tradeActionReason=`${activePending.side} retest is confirmed by M5 structure. Entry reference is ${retestCandle.close.toFixed(2)}.`;
          entry=retestCandle.close;
          reason=`${activePending.side} breakout + M5 retest confirmed at ${Number(activePending.level.price).toFixed(2)}.`;
          await rset(PENDING_KEY,{...activePending,status:"COMPLETED",completedAt:now},{ex:300});
        } else {
          tradeAction="WAIT";
          tradeActionReason=`Retest touched the level, but M5 structure is not confirmed. Do not chase the move.`;
          reason=`${activePending.side} breakout retested, but M5 structure is not confirmed yet — WAIT.`;
        }
      } else if(candlesSeen>=RETEST_MAX_M5_CANDLES){
        tradeAction="WAIT";
        tradeActionReason="Retest window expired after 3 M5 candles. Waiting for a new confirmed breakout.";
        reason="Previous breakout expired without a valid M5 retest.";
        await rset(PENDING_KEY,{...activePending,status:"COMPLETED",expiredAt:now},{ex:300});
        breakoutEvent=null;
        entryStatus="WAIT_BREAKOUT";
      }
    }

    const signalKey=(direction!=="WAIT" && activePending && entry)
      ? `XAUUSD|SCALP_ENTRY|${direction}|${activePending.level.price}|${activePending.candle.time}|${entry}`
      : null;
    const h1Ctx=h1Context(h1);
    const h1RangeRef=h1Range(h1,20);
    const result={
      ok:true,engine:"XAUUSD-SCALP-M5-M15-BREAKOUT",timestamp:new Date().toISOString(),marketStatus:"OPEN",price,scalpOnly:true,
      m15:{structure:m15s},m5:{structure:m5s},
      candles:m5.slice(-120),
      candlesM15:m15.slice(-80),
      data:{m5Candles:m5.length,m15Candles:m15.length,h1Candles:h1.length},
      scalpSR:{
        support:supportRef,
        resistance:resistanceRef,
        reference:"Nearest confirmed M5/M15 swing structure"
      },
      breakout:breakoutEvent?{
        confirmed:true,
        side:breakoutEvent.side,
        direction:breakoutEvent.side,
        price:breakoutEvent.level.price,
        level:breakoutEvent.level,
        candle:breakoutEvent.candle,
        distanceFromCurrent:Number((price-breakoutEvent.level.price).toFixed(4)),
        rule:breakoutEvent.side==="BUY"
          ? "CLOSED CANDLE CLOSE > RESISTANCE"
          : "CLOSED CANDLE CLOSE < SUPPORT"
      }:null,
      tradeDecision:{
        action:tradeAction,
        reason:tradeActionReason,
        entryRule:"ENTRY only after closed-candle breakout + M5 retest + M5 structure confirmation",
        holdRule:"HOLD only while the existing scalp remains above/below its invalidation structure; engine does not know your open position",
        standAsideRule:"Stand aside when retest fails, M5 structure disagrees, or there is no confirmed setup"
      },
      entry:{status:entryStatus,price:entry,level:breakoutEvent?.level||null},
      signal:{signal:direction,direction:direction==="WAIT"?"NEUTRAL":direction,signalKey,reason},
      h1Context:h1Ctx,
      h1Range:h1RangeRef,
      rules:{primary:"M5 + M15 scalp",supportResistance:"Nearest existing M5/M15 confirmed swing",breakout:"Closed candle only",entry:"Breakout -> M5 retest -> confirmation",h1:"Context/hold only; never blocks scalp"}
    };

    // Push ONLY once for a NEW confirmed breakout.
    if(signalKey){
      const lockKey=`xau:scalp:v3:push:${signalKey}`;
      const already=await rget(lockKey);
      if(already){result.push={attempted:true,status:"ALREADY_NOTIFIED",signalKey}}
      else{
        const delivery=await sendPushToAll({title:`${direction==="BUY"?"🟢":"🔴"} XAU/USD ${direction} SCALP`,body:`${direction} ENTRY READY • breakout + M5 retest confirmed at ${breakoutEvent.level.price.toFixed(2)}`,tag:signalKey,url:"/"});
        const sent=Number(delivery?.sent||0)>0;
        if(sent) await rset(lockKey,"1",{ex:CFG.pushTTL});
        result.push={attempted:true,status:sent?"PUSH_SENT":"NO_SUBSCRIBERS",delivery,signalKey};
      }
    } else result.push={attempted:false,status:"NO_NEW_CONFIRMED_BREAKOUT"};

    return res.status(200).json(result);
  }catch(e){
    console.error("SCALP ENGINE ERROR",e?.stack||e);
    return res.status(500).json({ok:false,error:e?.message||String(e),engine:"XAUUSD-SCALP-M5-M15-BREAKOUT"});
  }
}
