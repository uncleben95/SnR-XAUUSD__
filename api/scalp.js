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

    // Existing S/R only. A signal requires a CLOSED candle to cross that level.
    const buy15=breakout(m15,resistance,"BUY");
    const sell15=breakout(m15,support,"SELL");
    const buy5=breakout(m5,resistance,"BUY");
    const sell5=breakout(m5,support,"SELL");
    const buy=buy15||buy5;
    const sell=sell15||sell5;

    let direction="WAIT", breakoutEvent=null;
    if(buy && !sell){direction="BUY";breakoutEvent=buy}
    else if(sell && !buy){direction="SELL";breakoutEvent=sell}

    // M5 is the execution confirmation. M15 gives higher-timeframe scalp structure.
    const m5Confirmed = direction==="BUY" ? (m5s.direction==="BULLISH" || !!buy5) : direction==="SELL" ? (m5s.direction==="BEARISH" || !!sell5) : false;
    if(direction!=="WAIT" && !m5Confirmed){direction="WAIT";breakoutEvent=null}

    const signalKey=breakoutEvent?`XAUUSD|SCALP_BREAKOUT|${breakoutEvent.side}|${breakoutEvent.level.price}|${breakoutEvent.candle.time}`:null;
    const h1Ctx=h1Context(h1);
    const result={
      ok:true,engine:"XAUUSD-SCALP-M5-M15-BREAKOUT",timestamp:new Date().toISOString(),marketStatus:"OPEN",price,scalpOnly:true,
      m15:{structure:m15s},m5:{structure:m5s},
      scalpSR:{support,resistance},
      breakout:breakoutEvent?{confirmed:true,side:breakoutEvent.side,level:breakoutEvent.level,candle:breakoutEvent.candle}:null,
      signal:{signal:direction,direction:direction==="WAIT"?"NEUTRAL":direction,signalKey,reason:direction==="WAIT"?"WAIT — no confirmed breakout of existing M5/M15 S/R.":`${direction} — closed candle confirmed breakout of existing ${breakoutEvent.level.type} at ${breakoutEvent.level.price.toFixed(2)}.`},
      h1Context:h1Ctx,
      rules:{primary:"M5 + M15 scalp",supportResistance:"Nearest existing M5/M15 confirmed swing",breakout:"Closed candle only",h1:"Context/hold only; never blocks scalp"}
    };

    // Push ONLY once for a NEW confirmed breakout.
    if(signalKey){
      const lockKey=`xau:scalp:v3:push:${signalKey}`;
      const already=await rget(lockKey);
      if(already){result.push={attempted:true,status:"ALREADY_NOTIFIED",signalKey}}
      else{
        const delivery=await sendPushToAll({title:`${direction==="BUY"?"🟢":"🔴"} XAU/USD ${direction} SCALP`,body:`${direction} breakout ${breakoutEvent.level.price.toFixed(2)} • M5/M15 confirmed`,tag:signalKey,url:"/"});
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
