const fetchFn = globalThis.fetch;

const XAU_SYMBOL = "XAU/USD";
const TD_BASE = "https://api.twelvedata.com";
const M5_TTL = 5 * 60 * 1000;
const M15_TTL = 15 * 60 * 1000;
const H1_TTL = 60 * 60 * 1000;
const PRICE_TTL = 5 * 60 * 1000;

const redisUrl = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || process.env.UPSTASH_KV_REST_API_URL;
const redisToken = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || process.env.UPSTASH_KV_REST_TOKEN;

async function redisCmd(...parts) {
  if (!redisUrl || !redisToken) return null;
  const r = await fetchFn(redisUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${redisToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(parts)
  });
  if (!r.ok) throw new Error(`Redis HTTP ${r.status}`);
  const j = await r.json();
  return j.result;
}
async function redisGet(key) {
  try { return await redisCmd("GET", key); } catch { return null; }
}
async function redisSet(key, value, mode, ttl) {
  try { return await redisCmd("SET", key, value, mode, String(ttl)); } catch { return null; }
}

function cleanRows(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.map(x => ({
    datetime: x.datetime,
    open: Number(x.open),
    high: Number(x.high),
    low: Number(x.low),
    close: Number(x.close)
  })).filter(x =>
    x.datetime && [x.open,x.high,x.low,x.close].every(Number.isFinite)
  );
}

function intervalMs(tf) {
  return tf === "M5" ? 5*60*1000 : tf === "M15" ? 15*60*1000 : 60*60*1000;
}

function closedOnly(rows, tf) {
  const ms = intervalMs(tf);
  const now = Date.now();
  return rows.filter(x => {
    const t = Date.parse(String(x.datetime).replace(" ","T")+"Z");
    return Number.isFinite(t) && t + ms <= now;
  });
}

async function tdTimeSeries(interval, outputsize) {
  const key = `xau:scalp:v1:${interval}:${outputsize}`;
  const cached = await redisGet(key);
  if (cached) {
    try { return JSON.parse(cached); } catch {}
  }

  const token = process.env.TWELVE_DATA_API_KEY || process.env.TWELVEDATA_API_KEY || process.env.TWELVE_DATA_KEY;
  if (!token) throw new Error("Missing TWELVE_DATA_API_KEY");

  const url = `${TD_BASE}/time_series?symbol=${encodeURIComponent(XAU_SYMBOL)}&interval=${interval}&outputsize=${outputsize}&apikey=${encodeURIComponent(token)}&format=JSON`;
  const r = await fetchFn(url);
  const j = await r.json();
  if (!r.ok || j.status === "error" || !Array.isArray(j.values)) {
    throw new Error(j.message || `Twelve Data ${r.status}`);
  }

  const rows = cleanRows(j.values).reverse();
  await redisSet(key, JSON.stringify(rows), "EX", interval === "5min" ? 300 : interval === "15min" ? 900 : 3600);
  return rows;
}

async function getPrice() {
  const key = "xau:scalp:v1:price";
  const cached = await redisGet(key);
  if (cached) {
    try { return Number(cached); } catch {}
  }
  const token = process.env.TWELVE_DATA_API_KEY || process.env.TWELVEDATA_API_KEY || process.env.TWELVE_DATA_KEY;
  if (!token) return null;
  const url = `${TD_BASE}/price?symbol=${encodeURIComponent(XAU_SYMBOL)}&apikey=${encodeURIComponent(token)}`;
  const r = await fetchFn(url);
  const j = await r.json();
  const p = Number(j.price);
  if (Number.isFinite(p)) await redisSet(key, String(p), "EX", 300);
  return Number.isFinite(p) ? p : null;
}

function pivotSwings(rows, left=2, right=2) {
  const highs=[], lows=[];
  for (let i=left; i<rows.length-right; i++) {
    let hi=true, lo=true;
    for(let k=1;k<=left;k++){ if(rows[i].high <= rows[i-k].high) hi=false; if(rows[i].low >= rows[i-k].low) lo=false; }
    for(let k=1;k<=right;k++){ if(rows[i].high < rows[i+k].high) hi=false; if(rows[i].low > rows[i+k].low) lo=false; }
    if(hi) highs.push({price:rows[i].high,time:rows[i].datetime,index:i,type:"SWING_HIGH"});
    if(lo) lows.push({price:rows[i].low,time:rows[i].datetime,index:i,type:"SWING_LOW"});
  }
  return {highs,lows};
}

function nearestSR(rows, price) {
  const s = pivotSwings(rows);
  const below = s.lows.filter(x=>x.price < price).sort((a,b)=>b.price-a.price)[0] || null;
  const above = s.highs.filter(x=>x.price > price).sort((a,b)=>a.price-b.price)[0] || null;
  return {
    support: below ? {...below, distance: price-below.price} : null,
    resistance: above ? {...above, distance: above.price-price} : null,
    swings:s
  };
}

function confirmedBreakout(rows, level, side) {
  if (!level || rows.length < 2) return null;
  const a=rows[rows.length-2], b=rows[rows.length-1];
  if(side==="BUY" && a.close <= level.price && b.close > level.price)
    return {confirmed:true, side, level, candle:b};
  if(side==="SELL" && a.close >= level.price && b.close < level.price)
    return {confirmed:true, side, level, candle:b};
  return null;
}

function structure(rows) {
  if(rows.length < 8) return {direction:"WAIT", event:null};
  const s=pivotSwings(rows);
  const lastHigh=s.highs[s.highs.length-1];
  const prevHigh=s.highs[s.highs.length-2];
  const lastLow=s.lows[s.lows.length-1];
  const prevLow=s.lows[s.lows.length-2];
  const last=rows[rows.length-1];
  if(lastHigh && prevHigh && last.close > lastHigh.price)
    return {direction:"BULLISH", event:"BOS_UP", swing:lastHigh, candle:last};
  if(lastLow && prevLow && last.close < lastLow.price)
    return {direction:"BEARISH", event:"BOS_DOWN", swing:lastLow, candle:last};
  if(lastHigh && lastLow) {
    if(last.close > lastHigh.price) return {direction:"BULLISH",event:"BREAK_UP",swing:lastHigh,candle:last};
    if(last.close < lastLow.price) return {direction:"BEARISH",event:"BREAK_DOWN",swing:lastLow,candle:last};
  }
  return {direction:"WAIT",event:null};
}

function h1Context(rows, price) {
  const s=pivotSwings(rows,3,3);
  const last=rows[rows.length-1];
  let direction="RANGE";
  if(last && s.highs.length && s.lows.length){
    const h=s.highs[s.highs.length-1].price, l=s.lows[s.lows.length-1].price;
    if(last.close > h) direction="BULLISH";
    else if(last.close < l) direction="BEARISH";
  }
  return {direction, hold: direction==="RANGE" ? "NO" : "CONTEXT_ONLY"};
}

function makeSignal(m5,m15,price,sr5,sr15) {
  const b5=confirmedBreakout(m5,sr5.resistance,"BUY") || confirmedBreakout(m5,sr15.resistance,"BUY");
  const s5=confirmedBreakout(m5,sr5.support,"SELL") || confirmedBreakout(m5,sr15.support,"SELL");
  const b15=confirmedBreakout(m15,sr15.resistance,"BUY");
  const s15=confirmedBreakout(m15,sr15.support,"SELL");

  let direction="WAIT", reason="Waiting for confirmed breakout of an existing M5/M15 swing level.";
  let breakout=null;

  if(b15 || b5) {
    const x=b15 || b5;
    const m5ok=structure(m5).direction==="BULLISH" || !!b5;
    if(m5ok){ direction="BUY"; breakout=x; reason=`Closed candle confirmed breakout above ${Number(x.level.price).toFixed(2)} resistance.`; }
  }
  if(s15 || s5) {
    const x=s15 || s5;
    const m5ok=structure(m5).direction==="BEARISH" || !!s5;
    if(m5ok){ direction="SELL"; breakout=x; reason=`Closed candle confirmed breakout below ${Number(x.level.price).toFixed(2)} support.`; }
  }

  const key=breakout ? `XAUUSD|${breakout.side}|BREAKOUT|${breakout.level.price}|${breakout.candle.datetime}` : null;
  return {direction,reason,breakout,signalKey:key};
}

function sendJson(res,status,data){
  res.status(status).setHeader("Cache-Control","no-store");
  res.status(status).json(data);
}

module.exports = async (req,res) => {
  try {
    const [m5raw,m15raw,h1raw,price] = await Promise.all([
      tdTimeSeries("5min",300),
      tdTimeSeries("15min",200),
      tdTimeSeries("1h",120),
      getPrice()
    ]);

    const m5=closedOnly(m5raw,"M5"), m15=closedOnly(m15raw,"M15"), h1=closedOnly(h1raw,"H1");
    const livePrice=Number.isFinite(price) ? price : (m5.at(-1)?.close ?? null);
    const sr5=nearestSR(m5,livePrice), sr15=nearestSR(m15,livePrice);
    const scalpSR = {
      support: [sr5.support,sr15.support].filter(Boolean).sort((a,b)=>b.price-a.price)[0] || null,
      resistance: [sr5.resistance,sr15.resistance].filter(Boolean).sort((a,b)=>a.price-b.price)[0] || null
    };

    const signal=makeSignal(m5,m15,livePrice,sr5,sr15);
    const h1ctx=h1Context(h1,livePrice);
    const s5=structure(m5), s15=structure(m15);

    const result={
      ok:true,
      engine:"XAUUSD-SCALP-M5-M15-BREAKOUT",
      timestamp:new Date().toISOString(),
      marketStatus:"OPEN",
      price:livePrice,
      scalpOnly:true,
      timeframes:{M5:{structure:s5},M15:{structure:s15}},
      scalpSR,
      breakout:signal.breakout,
      signal:{
        signal:signal.direction,
        direction:signal.direction==="WAIT"?"NEUTRAL":signal.direction,
        reason:signal.reason,
        signalKey:signal.signalKey
      },
      h1Context:h1ctx,
      rules:{
        primary:"M5 + M15 scalp",
        sr:"Nearest existing confirmed swing high/low from M5/M15",
        breakout:"Closed-candle confirmation only",
        h1:"Context/hold only; never blocks scalp signal"
      },
      data:{
        m5Candles:m5.length,m15Candles:m15.length,h1Candles:h1.length,
        lastM5:m5.at(-1)?.datetime || null,lastM15:m15.at(-1)?.datetime || null
      }
    };

    // Optional push: only NEW confirmed breakout signals.
    if(signal.signalKey && redisUrl && redisToken) {
      const lockKey=`xau:scalp:v1:push:${signal.signalKey}`;
      const already=await redisGet(lockKey);
      if(!already){
        await redisSet(lockKey,"1","NX",900);
        result.push={attempted:true,signalKey:signal.signalKey,status:"NEW_BREAKOUT_READY"};
      } else {
        result.push={attempted:true,signalKey:signal.signalKey,status:"ALREADY_NOTIFIED"};
      }
    } else {
      result.push={attempted:false,status:"NO_NEW_CONFIRMED_BREAKOUT"};
    }

    return sendJson(res,200,result);
  } catch(err) {
    return sendJson(res,500,{ok:false,error:err.message,engine:"XAUUSD-SCALP-M5-M15-BREAKOUT"});
  }
};
