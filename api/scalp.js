import { sendPushToAll, redis } from "./push-lib.js";

export default async function handler(req, res) {
  const API_KEY = process.env.TWELVE_DATA_API_KEY;
  if (!API_KEY) return res.status(500).json({ok:false,error:"TWELVE_DATA_API_KEY belum diset"});

  const CFG = {
    symbol: "XAU/USD",
    m5Size: 1500,
    m15Size: 500,
    h1Size: 300,
    cacheTTL: 60_000,
    priceTTL: 15_000,
    minM5: 250,
    minM15: 100,
    minH1: 210
  };
  globalThis.__XAU_REPAIR_CACHE__ ??= { candles:{}, price:null, priceAt:0 };
  const C = globalThis.__XAU_REPAIR_CACHE__;
  const now = Date.now();

  const avg = a => a.length ? a.reduce((x,y)=>x+y,0)/a.length : null;
  const clamp = (n,a,b)=>Math.max(a,Math.min(b,n));
  function ema(v,p){
    if(v.length<p) return null;
    const k=2/(p+1); let e=avg(v.slice(0,p));
    for(let i=p;i<v.length;i++) e=v[i]*k+e*(1-k);
    return e;
  }
  function rsi(v,p=14){
    if(v.length<p+1)return null; let g=0,l=0;
    for(let i=v.length-p;i<v.length;i++){const d=v[i]-v[i-1];if(d>0)g+=d;else l-=d}
    if(l===0)return 100; const rs=(g/p)/(l/p); return 100-100/(1+rs);
  }
  function atr(d,p=14){
    if(d.length<p+1)return null; const tr=[];
    for(let i=1;i<d.length;i++){const c=d[i],pc=d[i-1].close;tr.push(Math.max(c.high-c.low,Math.abs(c.high-pc),Math.abs(c.low-pc)))}
    return avg(tr.slice(-p));
  }
  function macd(v){
    const line=ema(v,12)-ema(v,26); if(!Number.isFinite(line))return null;
    const lines=[]; for(let i=26;i<=v.length;i++){const e12=ema(v.slice(0,i),12),e26=ema(v.slice(0,i),26);if(e12!=null&&e26!=null)lines.push(e12-e26)}
    const signal=ema(lines,9); if(signal==null)return null;
    return {line,signal,histogram:line-signal,bullish:line>signal,bearish:line<signal};
  }
  function aggregate(data,minutes){
    const ms=minutes*60_000,m=new Map();
    for(const c of data){const t=new Date(c.time).getTime(),k=Math.floor(t/ms)*ms;
      if(!m.has(k))m.set(k,{time:new Date(k).toISOString(),open:c.open,high:c.high,low:c.low,close:c.close,volume:c.volume||0});
      else {const b=m.get(k);b.high=Math.max(b.high,c.high);b.low=Math.min(b.low,c.low);b.close=c.close;b.volume+=(c.volume||0)}
    }
    return [...m.values()].sort((a,b)=>new Date(a.time)-new Date(b.time));
  }
  function structure(d,lookback=20){
    if(d.length<lookback*2)return {bullish:false,bearish:false,high:null,low:null,previousHigh:null,previousLow:null};
    const r=d.slice(-lookback),p=d.slice(-lookback*2,-lookback),last=d.at(-1);
    const high=Math.max(...r.map(x=>x.high)),low=Math.min(...r.map(x=>x.low)),previousHigh=Math.max(...p.map(x=>x.high)),previousLow=Math.min(...p.map(x=>x.low));
    return {bullish:last.close>previousHigh,bearish:last.close<previousLow,high,low,previousHigh,previousLow};
  }
  function bos(d,lookback=10){
    if(d.length<lookback+2)return {bullish:false,bearish:false};
    const last=d.at(-1),p=d.slice(-lookback-1,-1);
    return {bullish:last.close>Math.max(...p.map(x=>x.high)),bearish:last.close<Math.min(...p.map(x=>x.low))};
  }
  function choch(d,lookback=8){
    if(d.length<lookback*2+2)return {bullish:false,bearish:false};
    const r=d.slice(-lookback),p=d.slice(-lookback*2,-lookback),last=d.at(-1);
    const rh=Math.max(...r.map(x=>x.high)),rl=Math.min(...r.map(x=>x.low)),ph=Math.max(...p.map(x=>x.high)),pl=Math.min(...p.map(x=>x.low));
    return {bullish:rh>ph&&last.close>ph,bearish:rl<pl&&last.close<pl};
  }
  function sweep(d,lookback=10){
    if(d.length<lookback+2)return {bullish:false,bearish:false};
    const c=d.at(-1),p=d.slice(-lookback-1,-1),h=Math.max(...p.map(x=>x.high)),l=Math.min(...p.map(x=>x.low));
    return {bullish:c.low<l&&c.close>l,bearish:c.high>h&&c.close<h};
  }
  function momentum(d){
    const c=d.at(-1); if(!c)return {bullish:false,bearish:false,strength:0};
    const range=c.high-c.low||1e-9,ratio=Math.abs(c.close-c.open)/range;
    return {bullish:c.close>c.open&&ratio>=.45,bearish:c.close<c.open&&ratio>=.45,strength:Math.round(ratio*100)};
  }
  async function series(interval,outputsize,key){
    const cache=C.candles[key];
    if(cache && now-cache.at<CFG.cacheTTL)return cache.data;
    const url=`https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(CFG.symbol)}&interval=${interval}&outputsize=${outputsize}&apikey=${API_KEY}`;
    const r=await fetch(url); const j=await r.json();
    if(!r.ok||j.status==="error") throw new Error(j.message||`Twelve Data ${interval} error`);
    const data=(j.values||[]).reverse().map(x=>({time:x.datetime,open:+x.open,high:+x.high,low:+x.low,close:+x.close,volume:+x.volume||0}))
      .filter(x=>[x.open,x.high,x.low,x.close].every(Number.isFinite));
    if(data.length<({5:CFG.minM5,"15":CFG.minM15,60:CFG.minH1}[interval])) throw new Error(`Data ${interval} tak cukup: ${data.length}`);
    C.candles[key]={at:Date.now(),data}; return data;
  }

  let m5,m15,h1,livePrice,candlePrice;
  try {
    [m5,m15,h1]=await Promise.all([
      series("5min",CFG.m5Size,"m5"),
      series("15min",CFG.m15Size,"m15"),
      series("1h",CFG.h1Size,"h1")
    ]);
    candlePrice=m5.at(-1).close;
    if(C.price!=null && now-C.priceAt<CFG.priceTTL) livePrice=C.price;
    else {
      const pr=await fetch(`https://api.twelvedata.com/price?symbol=${encodeURIComponent(CFG.symbol)}&apikey=${API_KEY}`);
      const pj=await pr.json(); const p=Number(pj?.price);
      if(!pr.ok||pj.status==="error"||!Number.isFinite(p))throw new Error(pj.message||"Live price error");
      livePrice=p; C.price=p; C.priceAt=Date.now();
    }

    const c5=m5.map(x=>x.close),c15=m15.map(x=>x.close),c1=h1.map(x=>x.close);
    const h1EMA50=ema(c1,50),h1EMA200=ema(c1,200),h1Struct=structure(h1,20);
    let h1Direction="WAIT";
    if(h1EMA50!=null&&h1EMA200!=null) {
      if(livePrice>h1EMA200&&h1EMA50>h1EMA200)h1Direction="BUY";
      else if(livePrice<h1EMA200&&h1EMA50<h1EMA200)h1Direction="SELL";
    }

    const m15EMA20=ema(c15,20),m15EMA50=ema(c15,50),m15RSI=rsi(c15),m15MACD=macd(c15),m15ATR=atr(m15);
    const m15Struct=structure(m15,20),m15BOS=bos(m15,12),m15CHOCH=choch(m15,10),m15Sweep=sweep(m15,12),m15Mom=momentum(m15);
    let m15Buy=0,m15Sell=0,rb=[],rs=[];
    if(m15EMA20!=null&&m15EMA50!=null){if(m15EMA20>m15EMA50){m15Buy+=20;rb.push("EMA20 > EMA50")}if(m15EMA20<m15EMA50){m15Sell+=20;rs.push("EMA20 < EMA50")}}
    if(m15EMA20!=null){if(livePrice>m15EMA20){m15Buy+=10;rb.push("Price > EMA20")}if(livePrice<m15EMA20){m15Sell+=10;rs.push("Price < EMA20")}}
    if(m15RSI!=null){if(m15RSI>=50&&m15RSI<=72){m15Buy+=10;rb.push("RSI bullish")}if(m15RSI>=28&&m15RSI<50){m15Sell+=10;rs.push("RSI bearish")}}
    if(m15MACD?.bullish){m15Buy+=15;rb.push("MACD bullish")}if(m15MACD?.bearish){m15Sell+=15;rs.push("MACD bearish")}
    if(m15Struct.bullish){m15Buy+=15;rb.push("Structure bullish")}if(m15Struct.bearish){m15Sell+=15;rs.push("Structure bearish")}
    if(m15BOS.bullish){m15Buy+=15;rb.push("BOS bullish")}if(m15BOS.bearish){m15Sell+=15;rs.push("BOS bearish")}
    if(m15CHOCH.bullish){m15Buy+=10;rb.push("CHOCH bullish")}if(m15CHOCH.bearish){m15Sell+=10;rs.push("CHOCH bearish")}
    if(m15Sweep.bullish){m15Buy+=10;rb.push("Sell-side sweep")}if(m15Sweep.bearish){m15Sell+=10;rs.push("Buy-side sweep")}
    if(m15Mom.bullish){m15Buy+=5;rb.push("Momentum bullish")}if(m15Mom.bearish){m15Sell+=5;rs.push("Momentum bearish")}
    m15Buy=clamp(m15Buy,0,100);m15Sell=clamp(m15Sell,0,100);
    const m15BuyConfirmed=m15Buy>=55&&m15Buy>=m15Sell+15,m15SellConfirmed=m15Sell>=55&&m15Sell>=m15Buy+15;
    const m15Confirmation=m15BuyConfirmed?"BUY":m15SellConfirmed?"SELL":"WAIT";

    const m5EMA9=ema(c5,9),m5EMA20=ema(c5,20),m5EMA50=ema(c5,50),m5RSI=rsi(c5),m5MACD=macd(c5),m5ATR=atr(m5);
    const m5Struct=structure(m5,24),m5BOS=bos(m5,10),m5CHOCH=choch(m5,8),m5Sweep=sweep(m5,10),m5Mom=momentum(m5);
    let m5Buy=0,m5Sell=0,r5b=[],r5s=[];
    if(m5EMA20!=null&&m5EMA50!=null){if(m5EMA20>m5EMA50){m5Buy+=20;r5b.push("EMA20 > EMA50")}if(m5EMA20<m5EMA50){m5Sell+=20;r5s.push("EMA20 < EMA50")}}
    if(m5EMA9!=null){if(livePrice>m5EMA9){m5Buy+=8;r5b.push("Price > EMA9")}if(livePrice<m5EMA9){m5Sell+=8;r5s.push("Price < EMA9")}}
    if(m5RSI!=null){if(m5RSI>=50&&m5RSI<75){m5Buy+=10;r5b.push("RSI bullish")}if(m5RSI>25&&m5RSI<50){m5Sell+=10;r5s.push("RSI bearish")}}
    if(m5MACD?.bullish){m5Buy+=10;r5b.push("MACD bullish")}if(m5MACD?.bearish){m5Sell+=10;r5s.push("MACD bearish")}
    if(m5Struct.bullish){m5Buy+=12;r5b.push("Structure bullish")}if(m5Struct.bearish){m5Sell+=12;r5s.push("Structure bearish")}
    if(m5BOS.bullish){m5Buy+=15;r5b.push("BOS bullish")}if(m5BOS.bearish){m5Sell+=15;r5s.push("BOS bearish")}
    if(m5CHOCH.bullish){m5Buy+=12;r5b.push("CHOCH bullish")}if(m5CHOCH.bearish){m5Sell+=12;r5s.push("CHOCH bearish")}
    if(m5Sweep.bullish){m5Buy+=8;r5b.push("Sell-side sweep")}if(m5Sweep.bearish){m5Sell+=8;r5s.push("Buy-side sweep")}
    if(m5Mom.bullish){m5Buy+=5;r5b.push("Momentum bullish")}if(m5Mom.bearish){m5Sell+=5;r5s.push("Momentum bearish")}
    m5Buy=clamp(m5Buy,0,100);m5Sell=clamp(m5Sell,0,100);
    const m5BuyTriggered=m5Buy>=50&&m5Buy>=m5Sell+8,m5SellTriggered=m5Sell>=50&&m5Sell>=m5Buy+8;
    const m5Trigger=m5BuyTriggered?"BUY":m5SellTriggered?"SELL":"WAIT";

    let signal="WAIT",status="WAIT",execution="WAIT",setupType="NO ALIGNMENT",score=Math.round(Math.max(m15Buy,m15Sell,m5Buy,m5Sell)),reasons=[];
    if(m15BuyConfirmed&&m5BuyTriggered){signal="BUY";status="ENTRY";execution="READY";setupType="M15+M5 ALIGNMENT";score=Math.round((m15Buy+m5Buy)/2);reasons=["M15 BUY confirmed","M5 BUY trigger confirmed","M15 + M5 aligned"]}
    else if(m15SellConfirmed&&m5SellTriggered){signal="SELL";status="ENTRY";execution="READY";setupType="M15+M5 ALIGNMENT";score=Math.round((m15Sell+m5Sell)/2);reasons=["M15 SELL confirmed","M5 SELL trigger confirmed","M15 + M5 aligned"]}
    else if(m15BuyConfirmed&&m5SellTriggered)reasons=["M15 BUY vs M5 SELL — conflicting"];
    else if(m15SellConfirmed&&m5BuyTriggered)reasons=["M15 SELL vs M5 BUY — conflicting"];
    else if(m15BuyConfirmed||m15SellConfirmed||m5BuyTriggered||m5SellTriggered)reasons=["Waiting for timeframe alignment"];
    else reasons=["M15 + M5 not aligned"];

    const holdBias=h1Direction==="BUY"?"BUY":h1Direction==="SELL"?"SELL":"NEUTRAL";
    const holdPermission=signal==="BUY"&&h1Direction==="BUY"?"HOLD BUY":signal==="SELL"&&h1Direction==="SELL"?"HOLD SELL":signal!=="WAIT"?"SCALP ONLY":"NO HOLD";
    const context=signal==="BUY"&&h1Direction==="BUY"||signal==="SELL"&&h1Direction==="SELL"?"WITH_H1":signal==="WAIT"?"NEUTRAL":"COUNTER_H1";

    // The trade plan is FIXED for each unique M5 signal candle.
    // Refreshing /api/scalp must NEVER recalculate Entry, SL or TP for
    // an existing signal. A new plan is created only for a new signalKey.
    let entry=null,stopLoss=null,tp1=null,tp2=null,tp3=null,rr=null;
    const signalCandle = m5.at(-1)?.time || new Date().toISOString();
    const signalKey = signal !== "WAIT" ? `XAUUSD|${signal}|${signalCandle}` : null;

    if (signalKey && m5ATR != null) {
      try {
        const planKey = `xau_trade_plan:${signalKey}`;
        const storedPlan = await redis.get(planKey);

        if (storedPlan) {
          const plan = typeof storedPlan === "string" ? JSON.parse(storedPlan) : storedPlan;
          entry=plan.entry; stopLoss=plan.stopLoss;
          tp1=plan.tp1; tp2=plan.tp2; tp3=plan.tp3; rr=plan.rr;
        } else {
          // Create the plan ONCE using the live price at signal creation.
          entry=Number(livePrice);
          const risk=Math.max(m5ATR*1.25,0.8);
          if(signal==="BUY"){
            stopLoss=entry-risk; tp1=entry+risk*1.5;
            tp2=entry+risk*2.5; tp3=entry+risk*4;
          } else {
            stopLoss=entry+risk; tp1=entry-risk*1.5;
            tp2=entry-risk*2.5; tp3=entry-risk*4;
          }
          rr="1 : 1.5 / 2.5 / 4.0";

          await redis.set(planKey, JSON.stringify({
            signal, signalCandle, entry, stopLoss, tp1, tp2, tp3, rr,
            createdAt: new Date().toISOString()
          }), { ex: 86400 });
        }
      } catch (planError) {
        // Do not silently create a different plan on refresh if Redis fails.
        console.error("Trade-plan persistence error:", planError);
      }
    }

    // One automatic push per unique signal candle.
    // The notification uses the SAME persisted Entry/SL/TP values.
    if (signalKey && entry != null) {
      try {
        const lockKey = "xau_last_entry_notification";
        const alreadyNotified = await redis.get(lockKey);

        if (alreadyNotified !== signalKey) {
          const title = signal === "BUY" ? "🟢 XAU/USD BUY ENTRY" : "🔴 XAU/USD SELL ENTRY";
          const body = [
            `${signal} • Score ${score}/100`,
            `Entry ${entry.toFixed(2)}`,
            `SL ${stopLoss.toFixed(2)}`,
            `TP1 ${tp1.toFixed(2)}`,
            `TP2 ${tp2.toFixed(2)}`,
            `TP3 ${tp3.toFixed(2)}`,
            `${setupType} • ${holdPermission}`
          ].join(" • ");

          const delivery = await sendPushToAll({
            title,
            body,
            tag: signalKey,
            url: "/"
          });

          if (delivery.sent > 0) {
            await redis.set(lockKey, signalKey, { ex: 21600 });
          }
        }
      } catch (pushError) {
        // Push failure must never break the market-data API.
        console.error("Automatic push error:", pushError);
      }
    }

    return res.status(200).json({
      ok:true, symbol:CFG.symbol, price:livePrice, candlePrice,
      livePrice:{price:livePrice,source:"TWELVE_DATA_PRICE",ageSeconds:Math.round((Date.now()-C.priceAt)/1000)},
      candles:m5.slice(-60),status,signal,signalType:signal==="WAIT"?"NONE":"TREND",setupType,execution,score,context,reasons,
      signalKey, signalCandle,
      h1:{direction:h1Direction,ema50:h1EMA50,ema200:h1EMA200,holdBias,holdPermission,structure:h1Struct},
      m15:{direction:m15Confirmation,confirmation:m15Confirmation,buyScore:m15Buy,sellScore:m15Sell,buyConfirmed:m15BuyConfirmed,sellConfirmed:m15SellConfirmed,ema20:m15EMA20,ema50:m15EMA50,rsi:m15RSI,macd:m15MACD,atr:m15ATR,bos:m15BOS,choch:m15CHOCH,sweep:m15Sweep,momentum:m15Mom,structure:m15Struct,buyReasons:rb,sellReasons:rs},
      m5:{trigger:m5Trigger,confirmation:m5Trigger,buyScore:m5Buy,sellScore:m5Sell,buyTriggered:m5BuyTriggered,sellTriggered:m5SellTriggered,ema9:m5EMA9,ema20:m5EMA20,ema50:m5EMA50,rsi:m5RSI,macd:m5MACD,atr:m5ATR,bos:m5BOS,choch:m5CHOCH,sweep:m5Sweep,momentum:m5Mom,structure:m5Struct,buyReasons:r5b,sellReasons:r5s},
      tradePlan:{entry,stopLoss,tp1,tp2,tp3,rr},
      data:{m5Candles:m5.length,m15Candles:m15.length,h1Candles:h1.length},
      timestamp:new Date().toISOString()
    });
  } catch(e) {
    console.error("REPAIRED SCALP ERROR",e);
    return res.status(502).json({ok:false,error:e.message||"SCALP API ERROR"});
  }
}
