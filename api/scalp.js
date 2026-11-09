import { sendPushToAll, redis } from "./push-lib.js";

// XAUUSD SIGNAL ENGINE
// Closed candles only:
// 1) H4 close crosses EMA20
// 2) H4 close crosses EMA50
// 3) H1 close breaks nearest confirmed swing high / low
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const key = process.env.TWELVE_DATA_API_KEY;
  if (!key) return res.status(500).json({ ok:false, error:"TWELVE_DATA_API_KEY is not configured" });

  const symbol="XAU/USD";
  const cronSecret=process.env.XAU_CRON_SECRET;
  const authorizedPush=req.query?.source==="github-actions" && cronSecret && req.headers["x-xau-cron-secret"]===cronSecret;

  const get=async(url,label)=>{
    const r=await fetch(url,{signal:AbortSignal.timeout(12000)});
    const j=await r.json().catch(()=>({}));
    if(!r.ok||j.status==="error"||j.code) throw new Error(j.message||`${label} request failed`);
    return j;
  };
  const series=async(interval,outputsize)=>{
    const j=await get(`https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}&interval=${interval}&outputsize=${outputsize}&apikey=${key}`,interval);
    return (j.values||[]).reverse().map(x=>({time:x.datetime,open:+x.open,high:+x.high,low:+x.low,close:+x.close}))
      .filter(x=>[x.open,x.high,x.low,x.close].every(Number.isFinite));
  };
  const fmt=n=>Number.isFinite(n)?Number(n.toFixed(2)):null;
  const emaSeries=(data,period)=>{
    if(data.length<period) return [];
    const k=2/(period+1), out=Array(data.length).fill(null);
    let v=data.slice(0,period).reduce((s,x)=>s+x.close,0)/period;
    out[period-1]=v;
    for(let i=period;i<data.length;i++){v=data[i].close*k+v*(1-k);out[i]=v;}
    return out;
  };
  const nearestSwings=(data, lastIndex)=>{
    // confirmed pivot: 2 candles on each side
    const highs=[], lows=[];
    for(let i=2;i<=lastIndex-2;i++){
      const x=data[i];
      if(x.high>data[i-1].high&&x.high>=data[i-2].high&&x.high>data[i+1].high&&x.high>=data[i+2].high) highs.push({price:x.high,time:x.time,index:i});
      if(x.low<data[i-1].low&&x.low<=data[i-2].low&&x.low<data[i+1].low&&x.low<=data[i+2].low) lows.push({price:x.low,time:x.time,index:i});
    }
    return { high:highs.at(-1)||null, low:lows.at(-1)||null };
  };

  try{
    const [h1Raw,h4Raw,pr]=await Promise.all([series("1h",320),series("4h",320),get(`https://api.twelvedata.com/price?symbol=${encodeURIComponent(symbol)}&apikey=${key}`,"price")]);
    if(h1Raw.length<30||h4Raw.length<60) throw new Error("Insufficient H1/H4 candle history");
    // Drop provider's current/in-progress candle.
    const h1=h1Raw.slice(0,-1), h4=h4Raw.slice(0,-1);
    const h1Prev=h1.at(-2), h1Last=h1.at(-1), h4Prev=h4.at(-2), h4Last=h4.at(-1);
    const e20=emaSeries(h4,20), e50=emaSeries(h4,50);
    const signals=[];

    const addCross=(period,arr)=>{
      const prev=arr.at(-2), now=arr.at(-1);
      if(!Number.isFinite(prev)||!Number.isFinite(now)) return;
      if(h4Prev.close<=prev&&h4Last.close>now) signals.push({id:`H4_EMA${period}_BUY`,direction:"BUY",type:`H4 EMA${period} BREAK`,timeframe:"H4",level:now,candleTime:h4Last.time,message:`H4 candle closed ABOVE EMA${period}`});
      if(h4Prev.close>=prev&&h4Last.close<now) signals.push({id:`H4_EMA${period}_SELL`,direction:"SELL",type:`H4 EMA${period} BREAK`,timeframe:"H4",level:now,candleTime:h4Last.time,message:`H4 candle closed BELOW EMA${period}`});
    };
    addCross(20,e20); addCross(50,e50);

    const swings=nearestSwings(h1,h1.length-1);
    if(swings.high&&h1Prev.close<=swings.high.price&&h1Last.close>swings.high.price) signals.push({id:"H1_SWING_HIGH_BUY",direction:"BUY",type:"H1 SWING HIGH BREAK",timeframe:"H1",level:swings.high.price,candleTime:h1Last.time,swingTime:swings.high.time,message:"H1 candle closed ABOVE nearest confirmed swing high"});
    if(swings.low&&h1Prev.close>=swings.low.price&&h1Last.close<swings.low.price) signals.push({id:"H1_SWING_LOW_SELL",direction:"SELL",type:"H1 SWING LOW BREAK",timeframe:"H1",level:swings.low.price,candleTime:h1Last.time,swingTime:swings.low.time,message:"H1 candle closed BELOW nearest confirmed swing low"});

    const livePrice=Number(pr?.price), price=Number.isFinite(livePrice)?livePrice:h1Last.close;
    const signalKey=signals.map(s=>`${s.id}|${s.candleTime}|${fmt(s.level)}`).join(";")||null;
    let push={authorized:Boolean(authorizedPush),sent:false,skipped:false,results:[]};
    if(authorizedPush&&signals.length){
      for(const s of signals){
        const lockKey=`xau_signal:${s.id}:${s.candleTime}:${fmt(s.level)}`;
        const locked=await redis.get(lockKey).catch(()=>null);
        if(locked){push.results.push({signal:s.id,skipped:true,reason:"Duplicate signal already notified"});continue;}
        const delivery=await sendPushToAll({title:`XAU/USD ${s.direction} SIGNAL`,body:`${s.type} · ${s.message} · Level: ${fmt(s.level)} · Close: ${fmt(s.timeframe==="H4"?h4Last.close:h1Last.close)}`,tag:`xau-${s.id}-${s.candleTime}`,url:"/"});
        await redis.set(lockKey,"1",{ex:60*60*72}).catch(()=>{});
        push.results.push({signal:s.id,sent:delivery.sent>0,delivery});
      }
      push.sent=push.results.some(x=>x.sent); push.skipped=push.results.length>0&&push.results.every(x=>x.skipped);
    }

    const primary=signals[0]||null;
    return res.status(200).json({
      ok:true,engine:"XAU_H4_EMA_H1_SWING_V1",symbol,signal:primary?.direction||"WAIT",status:signals.length?"SIGNAL":"MONITORING",execution:signals.length?"ALERT":"WAIT",score:signals.length?100:0,signalKey,
      price:fmt(price),livePrice:{price:fmt(price),source:"Twelve Data"},
      signals, signalSummary:signals.length?signals.map(s=>s.message):["No new closed-candle signal."],
      h4:{time:h4Last.time,close:fmt(h4Last.close),ema20:fmt(e20.at(-1)),ema50:fmt(e50.at(-1)),prevClose:fmt(h4Prev.close)},
      h1:{time:h1Last.time,close:fmt(h1Last.close),prevClose:fmt(h1Prev.close),nearestSwingHigh:swings.high?{price:fmt(swings.high.price),time:swings.high.time}:null,nearestSwingLow:swings.low?{price:fmt(swings.low.price),time:swings.low.time}:null},
      candles:h1.slice(-100),h1ChartCandles:h1.slice(-100),push,timestamp:new Date().toISOString()
    });
  }catch(e){
    console.error("XAU signal engine:",e?.message||e);
    return res.status(502).json({ok:false,error:e?.name==="TimeoutError"?"Twelve Data request timed out":e.message||"Engine error"});
  }
}
