/*
 * Independent experimental scalp models for manual review.
 * These rules are deliberately isolated from the production V18 signal decision.
 * They do not authorize trades or push notifications.
 */
const round = value => Number.isFinite(value) ? Number(value.toFixed(2)) : null;
const last = (arr, n = 1) => arr[arr.length - n];
const range = (candles, key) => candles.length ? Math.max(...candles.map(c => c[key])) : null;
const lowRange = (candles, key) => candles.length ? Math.min(...candles.map(c => c[key])) : null;

function atr(candles, period = 14) {
  if (!Array.isArray(candles) || candles.length < 3) return null;
  const data = candles.slice(-Math.min(period + 1, candles.length));
  const tr = [];
  for (let i = 0; i < data.length; i++) {
    const c = data[i], prev = data[i - 1];
    tr.push(Math.max(c.high - c.low, Math.abs(c.high - (prev?.close ?? c.close)), Math.abs(c.low - (prev?.close ?? c.close))));
  }
  return tr.reduce((a, b) => a + b, 0) / tr.length;
}
function zone(low, high) {
  if (!Number.isFinite(low) || !Number.isFinite(high)) return null;
  return { low: round(Math.min(low, high)), high: round(Math.max(low, high)) };
}
function empty(id, name, reason) {
  return { id, name, state: "WAIT", direction: "NEUTRAL", setupFound: false, entryZone: null, invalidation: null, target: null, trigger: null, candleTime: null, zone: null, reason };
}
function pivots(candles, left = 2, right = 2) {
  const out = [];
  for (let i = left; i < candles.length - right; i++) {
    const c = candles[i];
    const hi = candles.slice(i - left, i + right + 1).every((x, j) => j === left || c.high > x.high);
    const lo = candles.slice(i - left, i + right + 1).every((x, j) => j === left || c.low < x.low);
    if (hi) out.push({ index: i, type: "HIGH", price: c.high, time: c.time });
    if (lo) out.push({ index: i, type: "LOW", price: c.low, time: c.time });
  }
  return out;
}

function liquiditySweep(m5, price, atr5) {
  const model = empty("A", "Liquidity Sweep", "Tiada sweep sah pada candle tertutup terkini.");
  if (m5.length < 15) return model;
  const start = Math.max(10, m5.length - 4);
  for (let i = m5.length - 1; i >= start; i--) {
    const c = m5[i];
    const prior = m5.slice(Math.max(0, i - 10), i);
    if (prior.length < 8) continue;
    const priorHigh = range(prior, "high"), priorLow = lowRange(prior, "low");
    let direction = null, level = null, extreme = null;
    if (c.low < priorLow && c.close > priorLow) { direction = "BUY"; level = priorLow; extreme = c.low; }
    else if (c.high > priorHigh && c.close < priorHigh) { direction = "SELL"; level = priorHigh; extreme = c.high; }
    if (!direction) continue;
    const buffer = Math.max((atr5 || 0) * 0.12, 0.15);
    const entryZone = zone(Math.min(c.open, c.close), Math.max(c.open, c.close));
    const targetCandidates = direction === "BUY"
      ? pivots(m5.slice(0, i), 2, 2).filter(p => p.type === "HIGH" && p.price > c.close).map(p => p.price).sort((a,b)=>a-b)
      : pivots(m5.slice(0, i), 2, 2).filter(p => p.type === "LOW" && p.price < c.close).map(p => p.price).sort((a,b)=>b-a);
    return {
      ...model, state: "EARLY_SETUP", direction, setupFound: true,
      entryZone, invalidation: round(direction === "BUY" ? extreme - buffer : extreme + buffer),
      target: targetCandidates.length ? round(targetCandidates[0]) : null,
      trigger: "Sweep melepasi swing dan candle tutup kembali ke dalam julat",
      candleTime: c.time || null, zone: { type: "sweep", ...entryZone },
      reason: `Liquidity ${direction === "BUY" ? "di bawah swing low" : "di atas swing high"} disapu; close kembali melepasi paras ${round(level)}. Semak sama ada harga masih menghormati zon.`
    };
  }
  const piv = pivots(m5, 2, 2).slice(-8);
  const nearby = piv.filter(p => atr5 && Math.abs(price - p.price) <= atr5 * 0.45).sort((a,b)=>Math.abs(price-a.price)-Math.abs(price-b.price))[0];
  if (nearby) return { ...model, state: "WATCH_ZONE", direction: nearby.type === "LOW" ? "BUY" : "SELL", zone: { type: "swing", low: round(nearby.price - (atr5||0)*0.08), high: round(nearby.price + (atr5||0)*0.08) }, reason: `Harga menghampiri swing ${nearby.type.toLowerCase()} ${round(nearby.price)}; belum ada sweep yang disahkan.` };
  return model;
}

function fvgRetracement(m5, price, atr5) {
  const model = empty("B", "FVG Retracement", "Tiada FVG tiga-candle terkini yang dikenal pasti.");
  if (m5.length < 8) return model;
  const from = Math.max(2, m5.length - 24);
  for (let i = m5.length - 1; i >= from; i--) {
    const a = m5[i - 2], impulse = m5[i - 1], c = m5[i];
    let direction, low, high;
    if (a.high < c.low && impulse.close > impulse.open) { direction = "BUY"; low = a.high; high = c.low; }
    else if (a.low > c.high && impulse.close < impulse.open) { direction = "SELL"; low = c.high; high = a.low; }
    else continue;
    const width = high - low;
    if (width <= 0 || (atr5 && width > atr5 * 1.5)) continue;
    const later = m5.slice(i + 1);
    const touched = later.some(x => x.low <= high && x.high >= low);
    const filled = direction === "BUY" ? later.some(x => x.low <= low) : later.some(x => x.high >= high);
    const distance = price < low ? low - price : price > high ? price - high : 0;
    const near = atr5 != null && distance <= atr5 * 0.65;
    const invalid = filled || (direction === "BUY" ? price < low - (atr5 || 0) * 0.2 : price > high + (atr5 || 0) * 0.2);
    const target = direction === "BUY"
      ? pivots(m5.slice(0, i + 1), 2, 2).filter(p => p.type === "HIGH" && p.price > high).map(p => p.price).sort((x,y)=>x-y)[0]
      : pivots(m5.slice(0, i + 1), 2, 2).filter(p => p.type === "LOW" && p.price < low).map(p => p.price).sort((x,y)=>y-x)[0];
    return {
      ...model,
      state: invalid ? "INVALID_ZONE" : near ? "EARLY_SETUP" : touched ? "WATCH_RETEST" : "FVG_FOUND",
      direction, setupFound: !invalid && near,
      entryZone: zone(low, high),
      invalidation: round(direction === "BUY" ? low - Math.max((atr5 || 0) * 0.15, 0.15) : high + Math.max((atr5 || 0) * 0.15, 0.15)),
      target: Number.isFinite(target) ? round(target) : null,
      trigger: "Displacement membentuk jurang antara high/low candle 1 dan 3",
      candleTime: c.time || null, zone: { type: "fvg", ...zone(low, high) },
      reason: `${filled ? "Zon sudah penuh/invalid. " : ""}FVG ${direction} ${round(low)}–${round(high)}; jarak harga ${round(distance)}; ${touched ? "pernah disentuh" : "belum disentuh semula"}.`
    };
  }
  return model;
}

function trendPullback(m5, m15, price, m15Structure, atr5) {
  const model = empty("C", "Trend Pullback", "Tiada trend M15 dan pullback M5 yang cukup jelas.");
  if (m5.length < 15 || m15.length < 10) return model;
  const bullish = Boolean(m15Structure?.bullish);
  const bearish = Boolean(m15Structure?.bearish);
  let direction = bullish ? "BUY" : bearish ? "SELL" : "NEUTRAL";
  if (direction === "NEUTRAL") {
    const m15Delta = last(m15).close - m15[Math.max(0, m15.length - 6)].close;
    direction = m15Delta > 0 ? "BUY" : m15Delta < 0 ? "SELL" : "NEUTRAL";
  }
  if (direction === "NEUTRAL") return model;
  const last5 = m5.slice(-5), prev5 = m5.slice(-10, -5);
  const impulse = last(prev5).close - prev5[0].open;
  const pullback = last(last5).close - last5[0].open;
  const alignedPullback = direction === "BUY" ? impulse > 0 && pullback < 0 : impulse < 0 && pullback > 0;
  const resumed = direction === "BUY" ? last(last5).close > last(last5, 2).high : last(last5).close < last(last5, 2).low;
  const z = zone(lowRange(last5, "low"), range(last5, "high"));
  const invalidation = direction === "BUY" ? lowRange(last5, "low") - Math.max((atr5 || 0) * 0.15, 0.15) : range(last5, "high") + Math.max((atr5 || 0) * 0.15, 0.15);
  const targets = direction === "BUY"
    ? pivots(m15, 2, 2).filter(p => p.type === "HIGH" && p.price > price).map(p => p.price).sort((a,b)=>a-b)
    : pivots(m15, 2, 2).filter(p => p.type === "LOW" && p.price < price).map(p => p.price).sort((a,b)=>b-a);
  return {
    ...model, state: alignedPullback ? (resumed ? "EARLY_SETUP" : "WATCH_PULLBACK") : "TREND_CONTEXT",
    direction, setupFound: alignedPullback,
    entryZone: alignedPullback ? z : null,
    invalidation: alignedPullback ? round(invalidation) : null,
    target: targets.length ? round(targets[0]) : null,
    trigger: alignedPullback ? "Pullback M5 bertentangan sementara dengan arah struktur M15" : null,
    candleTime: last(m5).time || null,
    zone: alignedPullback ? { type: "pullback", ...z } : null,
    reason: alignedPullback ? `Trend ${direction} dengan retracement M5 dikesan${resumed ? " dan candle mula menyambung semula" : "; tunggu reaksi lanjut"}.` : `Konteks trend ${direction}; pullback yang memenuhi peraturan belum dikesan.`
  };
}


/**
 * Validate geometry before a model is shown as a candidate. This does not
 * prove profitability; it only rejects inverted stops/targets and weak RR.
 */
export function validateModelRisk(model, minRR = 1.2) {
  if (!model || !model.setupFound) return model;
  const entryLow = Number(model.entryZone?.low);
  const entryHigh = Number(model.entryZone?.high);
  const stop = Number(model.invalidation);
  const target = Number(model.target);
  const direction = model.direction;
  const validNumbers = [entryLow, entryHigh, stop, target].every(Number.isFinite) && entryHigh >= entryLow;
  if (!validNumbers) {
    return { ...model, state: "INVALID_RISK_PLAN", setupFound: false, rr: null,
      validation: { valid: false, reason: "Entry zone, invalidation atau target tiada/tidak sah." } };
  }
  const entry = (entryLow + entryHigh) / 2;
  const stopCorrect = direction === "BUY" ? stop < entryLow : direction === "SELL" ? stop > entryHigh : false;
  const targetCorrect = direction === "BUY" ? target > entryHigh : direction === "SELL" ? target < entryLow : false;
  const risk = Math.abs(entry - stop);
  const reward = Math.abs(target - entry);
  const rr = risk > 0 ? reward / risk : null;
  if (!stopCorrect || !targetCorrect || !Number.isFinite(rr) || rr < minRR) {
    const reason = !stopCorrect ? "Invalidation mesti berada di luar entry zone pada arah risiko yang betul."
      : !targetCorrect ? "Target mesti berada di hadapan entry zone mengikut arah setup."
      : !Number.isFinite(rr) ? "Risk/reward tidak boleh dikira."
      : `Risk/reward ${rr.toFixed(2)}R di bawah minimum ${minRR.toFixed(2)}R.`;
    return { ...model, state: "INVALID_RISK_PLAN", setupFound: false, rr: Number.isFinite(rr) ? round(rr) : null,
      validation: { valid: false, minRR, reason } };
  }
  return { ...model, rr: round(rr), validation: { valid: true, minRR, reason: "Geometri entry/SL/target dan minimum RR lulus; bukan jaminan profit." } };
}

function validateModels(models) {
  return Object.fromEntries(Object.entries(models).map(([key, model]) => [key, validateModelRisk(model)]));
}

export function buildScalpModels({ m5 = [], m15 = [], price = null, m15Structure = null, m5ATR = null }) {
  const p = Number(price);
  if (!Array.isArray(m5) || !Array.isArray(m15) || !Number.isFinite(p)) {
    return { mode: "EXPERIMENTAL_MANUAL_REVIEW", backtested: false, models: { A: empty("A", "Liquidity Sweep", "Data tidak mencukupi."), B: empty("B", "FVG Retracement", "Data tidak mencukupi."), C: empty("C", "Trend Pullback", "Data tidak mencukupi.") } };
  }
  const atr5 = Number.isFinite(m5ATR) ? m5ATR : atr(m5);
  return {
    mode: "EXPERIMENTAL_MANUAL_REVIEW",
    backtested: false,
    rulesVersion: "A-B-C-0.1",
    price: round(p),
    models: validateModels({
      A: liquiditySweep(m5, p, atr5),
      B: fvgRetracement(m5, p, atr5),
      C: trendPullback(m5, m15, p, m15Structure, atr5)
    }),
    notice: "Experimental setup candidates only. Not backtested; does not authorize trade execution or push notifications."
  };
}
