// M5/M15 scalping structure engine.
// Closed candles only: no intrabar CHOCH notifications.
// A CHOCH is a close through the previous confirmed swing level.
// S/R is selected from the nearest confirmed swing on the same timeframe
// and then checked against the other timeframe for confluence.

export function closed(candles = []) {
  return candles.filter(c => Number.isFinite(Number(c?.close)) && c?.time != null);
}

export function swings(candles, left = 2, right = 2) {
  const a = closed(candles);
  const out = { highs: [], lows: [] };
  for (let i = left; i < a.length - right; i++) {
    const h = Number(a[i].high), l = Number(a[i].low);
    let hi = true, lo = true;
    for (let j = i-left; j <= i+right; j++) {
      if (j === i) continue;
      hi &&= h > Number(a[j].high);
      lo &&= l < Number(a[j].low);
    }
    if (hi) out.highs.push({ price:h, time:a[i].time, index:i });
    if (lo) out.lows.push({ price:l, time:a[i].time, index:i });
  }
  return out;
}

export function structure(candles) {
  const a = closed(candles);
  if (a.length < 8) return { bias:"NEUTRAL", choch:null, swings:{highs:[],lows:[]} };
  const s = swings(a);
  const last = a[a.length-1];
  const prev = a[a.length-2];
  const prevHigh = s.highs[s.highs.length-1];
  const prevLow = s.lows[s.lows.length-1];

  let choch = null;
  if (prevHigh && Number(prev.close) > Number(prevHigh.price) && Number(prev.open) <= Number(prevHigh.price))
    choch = { type:"BULLISH_CHOCH", price:Number(prev.close), broken:prevHigh };
  if (prevLow && Number(prev.close) < Number(prevLow.price) && Number(prev.open) >= Number(prevLow.price))
    choch = { type:"BEARISH_CHOCH", price:Number(prev.close), broken:prevLow };

  return {
    bias: choch?.type === "BULLISH_CHOCH" ? "BULLISH" :
          choch?.type === "BEARISH_CHOCH" ? "BEARISH" : "NEUTRAL",
    choch,
    lastClosed: last,
    swings:s
  };
}

export function nearestSR(candles, price) {
  const s = swings(candles);
  const p = Number(price);
  const supports = s.lows.filter(x => x.price <= p).sort((a,b) => p-b.price);
  const resistances = s.highs.filter(x => x.price >= p).sort((a,b) => a.price-p);
  return {
    support: supports[0] || null,
    resistance: resistances[0] || null
  };
}
