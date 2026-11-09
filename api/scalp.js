import { sendPushToAll, redis } from "./push-lib.js";

// XAUUSD signal engine: closed H4 EMA crosses + closed H1 confirmed swing breaks.
const SYMBOL = "XAU/USD";
const DURATIONS = { "1h": 60 * 60 * 1000, "4h": 4 * 60 * 60 * 1000 };
const LOCK_SECONDS = 120;
const DEDUPE_SECONDS = 72 * 60 * 60;
const MARKET_CACHE_KEY = "xau_market_data_h1_h4_v1";
const MARKET_LOCK_KEY = "xau_market_data_fetch_lock_v1";
const MARKET_CACHE_SECONDS = 75;
const MARKET_LOCK_SECONDS = 30;

export function parseUtcTime(value) {
  if (typeof value !== "string") return NaN;
  // Twelve Data is explicitly requested in UTC; make its timezone-naive values UTC.
  const normalized = value.includes("T") ? value : value.replace(" ", "T");
  return Date.parse(/[zZ]|[+-]\d\d:\d\d$/.test(normalized) ? normalized : `${normalized}Z`);
}

export function isClosedCandle(candle, interval, nowMs) {
  const start = parseUtcTime(candle.time);
  return Number.isFinite(start) && start + DURATIONS[interval] <= nowMs;
}

export function emaSeries(data, period) {
  if (data.length < period) return [];
  const k = 2 / (period + 1);
  const out = Array(data.length).fill(null);
  let value = data.slice(0, period).reduce((sum, candle) => sum + candle.close, 0) / period;
  out[period - 1] = value;
  for (let i = period; i < data.length; i++) {
    value = data[i].close * k + value * (1 - k);
    out[i] = value;
  }
  return out;
}

export function confirmedPivots(data, confirmationIndex) {
  const highs = [], lows = [];
  // A pivot is usable only after two candles to its right have CLOSED.
  for (let i = 2; i <= confirmationIndex - 2; i++) {
    const c = data[i];
    if (c.high > data[i - 1].high && c.high >= data[i - 2].high && c.high > data[i + 1].high && c.high >= data[i + 2].high) {
      highs.push({ price: c.high, time: c.time, index: i, confirmedIndex: i + 2 });
    }
    if (c.low < data[i - 1].low && c.low <= data[i - 2].low && c.low < data[i + 1].low && c.low <= data[i + 2].low) {
      lows.push({ price: c.low, time: c.time, index: i, confirmedIndex: i + 2 });
    }
  }
  return { highs, lows };
}

function wasHighBrokenBefore(data, pivot, throughIndex) {
  for (let i = pivot.confirmedIndex; i <= throughIndex; i++) if (data[i].close > pivot.price) return true;
  return false;
}
function wasLowBrokenBefore(data, pivot, throughIndex) {
  for (let i = pivot.confirmedIndex; i <= throughIndex; i++) if (data[i].close < pivot.price) return true;
  return false;
}

export function findSwingState(data) {
  const lastIndex = data.length - 1;
  const prevIndex = lastIndex - 1;
  if (prevIndex < 4) return { signals: [], nearestHigh: null, nearestLow: null };

  // For a signal on the latest candle, swings must already have been confirmed
  // before that candle began. This prevents same-candle pivot look-ahead.
  const eligible = confirmedPivots(data, prevIndex);
  const previousClose = data[prevIndex].close;
  const last = data[lastIndex];

  const breakHighs = eligible.highs.filter(p =>
    p.price > previousClose && last.close > p.price && !wasHighBrokenBefore(data, p, prevIndex)
  ).sort((a, b) => a.price - b.price);
  const breakLows = eligible.lows.filter(p =>
    p.price < previousClose && last.close < p.price && !wasLowBrokenBefore(data, p, prevIndex)
  ).sort((a, b) => b.price - a.price);

  const signals = [];
  // If one candle crosses several levels, emit the nearest previously unbroken level.
  if (breakHighs.length) {
    const p = breakHighs[0];
    signals.push({ id: "H1_SWING_HIGH_BUY", direction: "BUY", type: "H1 SWING HIGH BREAK", timeframe: "H1", level: p.price, candleTime: last.time, swingTime: p.time, message: "H1 candle closed ABOVE nearest unbroken confirmed swing high" });
  }
  if (breakLows.length) {
    const p = breakLows[0];
    signals.push({ id: "H1_SWING_LOW_SELL", direction: "SELL", type: "H1 SWING LOW BREAK", timeframe: "H1", level: p.price, candleTime: last.time, swingTime: p.time, message: "H1 candle closed BELOW nearest unbroken confirmed swing low" });
  }

  // Dashboard levels: nearest still-unbroken confirmed levels beyond latest close.
  const displayPivots = confirmedPivots(data, lastIndex);
  const nearestHigh = displayPivots.highs
    .filter(p => p.price > last.close && !wasHighBrokenBefore(data, p, lastIndex))
    .sort((a, b) => a.price - b.price)[0] || null;
  const nearestLow = displayPivots.lows
    .filter(p => p.price < last.close && !wasLowBrokenBefore(data, p, lastIndex))
    .sort((a, b) => b.price - a.price)[0] || null;

  return { signals, nearestHigh, nearestLow };
}

function fmt(n) { return Number.isFinite(n) ? Number(n.toFixed(2)) : null; }

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  const key = process.env.TWELVE_DATA_API_KEY;
  if (!key) return res.status(500).json({ ok: false, error: "TWELVE_DATA_API_KEY is not configured" });

  const cronSecret = process.env.XAU_CRON_SECRET;
  const authorizedPush = req.query?.source === "github-actions" && cronSecret && req.headers["x-xau-cron-secret"] === cronSecret;
  const nowMs = Date.now();

  const get = async (url, label) => {
    const response = await fetch(url, { signal: AbortSignal.timeout(12000), cache: "no-store" });
    const json = await response.json().catch(() => ({}));
    if (!response.ok || json.status === "error" || json.code) throw new Error(json.message || `${label} request failed`);
    return json;
  };
  const series = async (interval, outputsize) => {
    const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(SYMBOL)}&interval=${interval}&outputsize=${outputsize}&timezone=UTC&apikey=${key}`;
    const json = await get(url, interval);
    return (json.values || []).slice().reverse().map(x => ({
      time: x.datetime, open: +x.open, high: +x.high, low: +x.low, close: +x.close
    })).filter(x => [x.open, x.high, x.low, x.close].every(Number.isFinite) && isClosedCandle(x, interval, nowMs));
  };

  try {
    // Share one Twelve Data fetch across dashboard visitors and the GitHub Actions
    // cron. Redis is required here: falling back to uncached provider calls could
    // exceed the user's per-minute credit limit during concurrent requests.
    let marketData = await redis.get(MARKET_CACHE_KEY).catch(() => null);
    if (typeof marketData === "string") {
      try { marketData = JSON.parse(marketData); } catch { marketData = null; }
    }

    if (!marketData?.h1?.length || !marketData?.h4?.length) {
      const lockToken = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      let lock = null;
      try {
        lock = await redis.set(MARKET_LOCK_KEY, lockToken, { nx: true, ex: MARKET_LOCK_SECONDS });
      } catch (error) {
        throw new Error(`Market-data cache unavailable (Redis lock): ${error.message}`);
      }

      if (lock !== "OK") {
        // Another invocation is fetching. Wait briefly for its shared result;
        // never launch a second Twelve Data request in parallel.
        for (let attempt = 0; attempt < 52; attempt++) {
          await new Promise(resolve => setTimeout(resolve, 250));
          marketData = await redis.get(MARKET_CACHE_KEY).catch(() => null);
          if (typeof marketData === "string") {
            try { marketData = JSON.parse(marketData); } catch { marketData = null; }
          }
          if (marketData?.h1?.length && marketData?.h4?.length) break;
        }
        if (!marketData?.h1?.length || !marketData?.h4?.length) {
          return res.status(503).json({ ok: false, error: "Market data refresh is already running. Retry shortly; no extra Twelve Data request was made." });
        }
      } else {
        try {
          const [freshH1, freshH4] = await Promise.all([
            series("1h", 320), series("4h", 320)
          ]);
          if (freshH1.length < 30 || freshH4.length < 60) throw new Error("Insufficient fully closed H1/H4 candle history");
          marketData = { h1: freshH1, h4: freshH4, fetchedAt: new Date().toISOString() };
          await redis.set(MARKET_CACHE_KEY, JSON.stringify(marketData), { ex: MARKET_CACHE_SECONDS });
        } finally {
          // Fetch requests have a 12s timeout; the lock itself expires as a safety net.
          await redis.del(MARKET_LOCK_KEY).catch(() => {});
        }
      }
    }

    const h1 = marketData.h1;
    const h4 = marketData.h4;
    if (h1.length < 30 || h4.length < 60) throw new Error("Insufficient fully closed H1/H4 candle history");

    const h1Prev = h1.at(-2), h1Last = h1.at(-1);
    const h4Prev = h4.at(-2), h4Last = h4.at(-1);
    const ema20 = emaSeries(h4, 20), ema50 = emaSeries(h4, 50);
    const signals = [];

    const addEmaCross = (period, values) => {
      const previousEma = values.at(-2), currentEma = values.at(-1);
      if (!Number.isFinite(previousEma) || !Number.isFinite(currentEma)) return;
      if (h4Prev.close <= previousEma && h4Last.close > currentEma) {
        signals.push({ id: `H4_EMA${period}_BUY`, direction: "BUY", type: `H4 EMA${period} BREAK`, timeframe: "H4", level: currentEma, candleTime: h4Last.time, message: `H4 candle closed ABOVE EMA${period}` });
      } else if (h4Prev.close >= previousEma && h4Last.close < currentEma) {
        signals.push({ id: `H4_EMA${period}_SELL`, direction: "SELL", type: `H4 EMA${period} BREAK`, timeframe: "H4", level: currentEma, candleTime: h4Last.time, message: `H4 candle closed BELOW EMA${period}` });
      }
    };
    addEmaCross(20, ema20);
    addEmaCross(50, ema50);

    const swingState = findSwingState(h1);
    signals.push(...swingState.signals);

    // Avoid a separate /price request: use the latest fully closed H1 close.
    const price = h1Last.close;
    const signalKey = signals.map(s => `${s.id}|${s.candleTime}|${fmt(s.level)}`).join(";") || null;
    const push = { authorized: Boolean(authorizedPush), sent: false, skipped: false, results: [] };

    if (authorizedPush && signals.length) {
      for (const signal of signals) {
        const eventKey = `${signal.id}:${signal.candleTime}`;
        const lockKey = `xau_signal_lock:${eventKey}`;
        const doneKey = `xau_signal_done:${eventKey}`;
        let reserved;
        try {
          if (await redis.get(doneKey)) {
            push.results.push({ signal: signal.id, skipped: true, reason: "This event was already delivered" });
            continue;
          }
          reserved = await redis.set(lockKey, "1", { nx: true, ex: LOCK_SECONDS });
        } catch (error) {
          push.results.push({ signal: signal.id, sent: false, reason: `Redis dedupe unavailable: ${error.message}` });
          continue; // Fail closed: do not risk duplicate pushes.
        }
        if (reserved !== "OK") {
          push.results.push({ signal: signal.id, skipped: true, reason: "Duplicate event is already locked or delivered" });
          continue;
        }

        try {
          const close = signal.timeframe === "H4" ? h4Last.close : h1Last.close;
          const delivery = await sendPushToAll({
            title: `XAU/USD ${signal.direction} SIGNAL`,
            body: `${signal.type} · ${signal.message} · Level: ${fmt(signal.level)} · Close: ${fmt(close)}`,
            tag: `xau-${signal.id}-${signal.candleTime}`, url: "/"
          });
          if (delivery.sent > 0) {
            await redis.set(lockKey, "1", { ex: DEDUPE_SECONDS });
            await redis.set(doneKey, "1", { ex: DEDUPE_SECONDS });
            push.results.push({ signal: signal.id, sent: true, delivery });
          } else {
            await redis.del(lockKey);
            push.results.push({ signal: signal.id, sent: false, delivery, reason: "No push subscription accepted the notification; event can retry" });
          }
        } catch (error) {
          await redis.del(lockKey).catch(() => {});
          push.results.push({ signal: signal.id, sent: false, reason: error.message || "Push delivery failed; event can retry" });
        }
      }
      push.sent = push.results.some(x => x.sent);
      push.skipped = push.results.length > 0 && push.results.every(x => x.skipped);
    }

    const primary = signals[0] || null;
    return res.status(200).json({
      ok: true, engine: "XAU_H4_EMA_H1_SWING_V2", symbol: SYMBOL,
      signal: primary?.direction || "WAIT", status: signals.length ? "SIGNAL" : "MONITORING",
      execution: signals.length ? "ALERT" : "WAIT", score: signals.length ? 100 : 0, signalKey,
      price: fmt(price), livePrice: { price: fmt(price), source: "Last closed H1 candle" },
      signals, signalSummary: signals.length ? signals.map(s => s.message) : ["No new closed-candle signal."],
      h4: { time: h4Last.time, close: fmt(h4Last.close), ema20: fmt(ema20.at(-1)), ema50: fmt(ema50.at(-1)), prevClose: fmt(h4Prev.close) },
      h1: {
        time: h1Last.time, close: fmt(h1Last.close), prevClose: fmt(h1Prev.close),
        nearestSwingHigh: swingState.nearestHigh ? { price: fmt(swingState.nearestHigh.price), time: swingState.nearestHigh.time } : null,
        nearestSwingLow: swingState.nearestLow ? { price: fmt(swingState.nearestLow.price), time: swingState.nearestLow.time } : null
      },
      candles: h1.slice(-100), h1ChartCandles: h1.slice(-100), push,
      marketData: { source: "Twelve Data via shared Redis cache", fetchedAt: marketData.fetchedAt, cacheSeconds: MARKET_CACHE_SECONDS },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error("XAU signal engine:", error?.message || error);
    return res.status(502).json({ ok: false, error: error?.name === "TimeoutError" ? "Twelve Data request timed out" : error.message || "Engine error" });
  }
}
