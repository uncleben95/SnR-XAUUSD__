import { sendPushToAll, redis } from "./push-lib.js";
import { buildScalpModels } from "./scalp-models.js";
import { shouldNotifyEntryEvent } from "./push-state.js";
import { isH1DirectionAllowed, isMarketDataStale, isTradePlanValid } from "./signal-policy.js";

export default async function handler(req, res) {
  const API_KEY = process.env.TWELVE_DATA_API_KEY;

  if (!API_KEY) {
    return res.status(500).json({
      ok: false,
      error: "TWELVE_DATA_API_KEY is not configured"
    });
  }

  const CFG = {
    symbol: "XAU/USD",

    // One M5 request supplies all three timeframes. 3,000 M5 bars
    // are needed to build enough closed H1 bars for EMA200 / S-R logic.
    m5Size: 3000,
    m15Size: 500, // retained for response/config compatibility; not fetched
    h1Size: 300,  // retained for response/config compatibility; not fetched

    /*
     * ==========================================================
     * CANDLE CACHE
     * ==========================================================
     *
     * M5  = 5 min
     * M15 = 15 min
     * H1  = 1 hour
     *
     * Ini bermaksud refresh dashboard tidak semestinya
     * menyebabkan Twelve Data dipanggil semula.
     */

    m5CacheTTL: 5 * 60_000,
    m15CacheTTL: 30 * 60_000,
    h1CacheTTL: 60 * 60_000,

    /*
     * LIVE PRICE
     *
     * Live prices remain faster.
     */

    priceTTL: 4 * 60_000,

    minM5: 250,
    minM15: 100,
    minH1: 210,

    /*
     * H1 SUPPORT / RESISTANCE
     */

    srLookback: 80,
    srSwingStrength: 2,
    srMaxLevels: 12,
    srATRMultiplier: 0.50,
    srMinDistance: 2.0,
    srGroupingATR: 0.20,
    srGroupingMin: 1.5,
    srMajorLookback: 80,
    srIncludeExtreme: true,
    srMinTargetR: 1.50,

    reversalZoneMultiplier: 1.0,

    // S/R is context + target selection. It NEVER blocks a valid M5 scalp.
    minTargetR: 1.50,
    requireValidSRTarget: false,

    /* MARKET REGIME */
    regimeERLookbackM5: 20,
    regimeERLookbackM15: 20,
    regimeERLookbackH1: 20,
    regimeATRBaselineBars: 40,
    regimeTrendER: 0.35,
    regimeRangeER: 0.20,
    regimeHighVolRatio: 1.35,
    regimeLowVolRatio: 0.70,

    /*
     * ROADBLOCK
     *
     * M15/M5 are used to identify roadblocks
     * antara entry dan H1 target.
     */

    roadblockLookbackM15: 80,
    roadblockLookbackM5: 80,

    roadblockSwingStrength: 2,

    roadblockGroupATRMultiplier: 0.20,
    roadblockMinGroupDistance: 1.5,

    roadblockMaxLevels: 8,

    /*
     * TRADE LOCK
     */

    tradeLockTTL: 21600,

    pushLockTTL: 86400 * 7,
    pushEntrySignals: true,
    pushChochEvents: true,
    pushBreakoutEvents: true,

    /*
     * REDIS
     */

    redisCacheTTL: 86400 * 7,

    redisKeys: {
      m5: "xau_scalp_cache_m5",
      m15: "xau_scalp_cache_m15",
      h1: "xau_scalp_cache_h1",
      price: "xau_scalp_cache_price"
    }
  };

  /*
   * ============================================================
   * LOCAL MEMORY CACHE
   * ============================================================
   */

  globalThis.__XAU_SCALP_CACHE__ ??= {
    candles: {},
    price: null,
    priceAt: 0,

    dataSource: {
      m5: "NONE",
      m15: "NONE",
      h1: "NONE",
      price: "NONE"
    },

    cacheAt: {
      m5: 0,
      m15: 0,
      h1: 0,
      price: 0
    }
  };

  const C = globalThis.__XAU_SCALP_CACHE__;

  const now = Date.now();

  const cronSecret = process.env.XAU_CRON_SECRET;
  const suppliedCronSecret = req.headers["x-xau-cron-secret"];
  const backgroundPushRequestAuthorized =
    req.query?.source === "github-actions" &&
    Boolean(cronSecret) &&
    suppliedCronSecret === cronSecret;

  /*
   * ============================================================
   * HELPERS
   * ============================================================
   */

  const avg = a =>
    a.length
      ? a.reduce((x, y) => x + y, 0) / a.length
      : null;

  const clamp = (n, a, b) =>
    Math.max(a, Math.min(b, n));

  function trueRanges(data) {
    if (!Array.isArray(data) || data.length < 2) return [];
    const tr = [];
    for (let i = 1; i < data.length; i++) {
      const c = data[i];
      const pc = data[i - 1].close;
      tr.push(Math.max(
        c.high - c.low,
        Math.abs(c.high - pc),
        Math.abs(c.low - pc)
      ));
    }
    return tr.filter(Number.isFinite);
  }

  function atrBaseline(data, period = 14, baselineBars = 40) {
    const tr = trueRanges(data);
    if (tr.length < period + 5) return null;
    const atrValues = [];
    for (let i = period; i <= tr.length; i++) {
      const value = avg(tr.slice(i - period, i));
      if (Number.isFinite(value)) atrValues.push(value);
    }
    if (!atrValues.length) return null;
    const sample = atrValues.slice(-baselineBars);
    return avg(sample);
  }

  function efficiencyRatio(data, lookback = 20) {
    if (!Array.isArray(data) || data.length < lookback + 1) return null;
    const src = data.slice(-(lookback + 1));
    const net = Math.abs(src.at(-1).close - src[0].close);
    let noise = 0;
    for (let i = 1; i < src.length; i++) {
      noise += Math.abs(src[i].close - src[i - 1].close);
    }
    if (noise <= 0) return 0;
    return clamp(net / noise, 0, 1);
  }

  function volatilityState(currentATR, baselineATR) {
    if (!Number.isFinite(currentATR) || !Number.isFinite(baselineATR) || baselineATR <= 0) {
      return { ratio: null, state: "UNKNOWN" };
    }
    const ratio = currentATR / baselineATR;
    const state = ratio >= CFG.regimeHighVolRatio
      ? "HIGH"
      : ratio <= CFG.regimeLowVolRatio
        ? "LOW"
        : "NORMAL";
    return { ratio: Number(ratio.toFixed(3)), state };
  }

  function regimeSnapshot(data, currentATR, erLookback) {
    const er = efficiencyRatio(data, erLookback);
    const baselineATR = atrBaseline(data, 14, CFG.regimeATRBaselineBars);
    const volatility = volatilityState(currentATR, baselineATR);
    return {
      efficiencyRatio: er == null ? null : Number(er.toFixed(3)),
      atr: currentATR == null ? null : Number(currentATR.toFixed(4)),
      baselineATR: baselineATR == null ? null : Number(baselineATR.toFixed(4)),
      ratio: volatility.ratio,
      state: volatility.state
    };
  }

  function candleTimestampMs(value) {
    if (value == null || value === "") return NaN;
    const normalized = String(value).trim().replace(" ", "T");
    const hasTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(normalized);
    return Date.parse(hasTimezone ? normalized : `${normalized}Z`);
  }

  function detectMarketStatus(m5, m15, h1, livePrice, livePriceSavedAt = Date.now()) {
    const nowDate = new Date();
    // XAUUSD generally trades Sunday 18:00 through Friday 17:00 New York
    // time, with a daily 17:00-18:00 ET rollover break Mon-Thu. Use the
    // exchange session's local clock so DST is handled by Intl automatically.
    const nyParts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23"
    }).formatToParts(nowDate);
    const ny = Object.fromEntries(nyParts.map(part => [part.type, part.value]));
    const nyWeekday = ny.weekday;
    const nyMinuteOfDay = Number(ny.hour) * 60 + Number(ny.minute);
    const weekend = nyWeekday === "Sat" ||
      (nyWeekday === "Sun" && nyMinuteOfDay < 18 * 60) ||
      (nyWeekday === "Fri" && nyMinuteOfDay >= 17 * 60);
    const dailyRollover = ["Mon", "Tue", "Wed", "Thu"].includes(nyWeekday) &&
      nyMinuteOfDay >= 17 * 60 && nyMinuteOfDay < 18 * 60;
    const scheduledClosed = weekend || dailyRollover;

    const latest = m5?.at(-1);
    const latestTime = candleTimestampMs(latest?.time);
    const latestAgeMin = Number.isFinite(latestTime)
      ? Math.max(0, (Date.now() - latestTime) / 60000)
      : null;

    const latestM15 = m15?.at(-1);
    const latestH1 = h1?.at(-1);
    const m15Time = candleTimestampMs(latestM15?.time);
    const h1Time = candleTimestampMs(latestH1?.time);
    const m15AgeMin = Number.isFinite(m15Time) ? Math.max(0, (Date.now() - m15Time) / 60000) : null;
    const h1AgeMin = Number.isFinite(h1Time) ? Math.max(0, (Date.now() - h1Time) / 60000) : null;

    const sample = (m5 || []).slice(-20);
    const ranges = sample.map(c => c.high - c.low).filter(Number.isFinite);
    const avgRange = avg(ranges) || 0;
    const opens = sample.map(c => c.open).filter(Number.isFinite);
    const openSpan = opens.length ? Math.max(...opens) - Math.min(...opens) : null;
    const repeatedOpenFeed =
      sample.length >= 12 &&
      openSpan != null &&
      openSpan <= Math.max(0.05, avgRange * 0.35);

    const closeValues = sample.map(c => c.close).filter(Number.isFinite);
    const uniqueCloseRatio = closeValues.length
      ? new Set(closeValues.map(v => v.toFixed(4))).size / closeValues.length
      : 1;
    const syntheticFlatFeed =
      sample.length >= 12 &&
      repeatedOpenFeed &&
      uniqueCloseRatio < 0.75;

    // Twelve Data timestamps identify candle OPEN time, not close time.
    // If the newest closed M5 candle is over 10 minutes old by open-time,
    // at least one expected M5 update is missing/late; block actionable signals.
    const staleM5 = latestAgeMin == null || latestAgeMin > 10;
    const staleM15 = m15AgeMin == null || m15AgeMin > 45;
    const staleH1 = h1AgeMin == null || h1AgeMin > 120;
    const priceAgeMin = Number.isFinite(Number(livePriceSavedAt))
      ? Math.max(0, (Date.now() - Number(livePriceSavedAt)) / 60000)
      : Infinity;
    const stalePrice = !Number.isFinite(Number(livePrice)) || Number(livePrice) <= 0 || priceAgeMin > 10;
    const staleCandle = staleM5 || staleM15 || staleH1;
    const closed = scheduledClosed || syntheticFlatFeed || staleCandle || stalePrice;
    const reasons = [];
    if (weekend) reasons.push("WEEKEND_MARKET_CLOSED");
    else if (dailyRollover) reasons.push("DAILY_ROLLOVER_CLOSED");
    if (syntheticFlatFeed) reasons.push("FLAT_OR_SYNTHETIC_CANDLE_FEED");
    if (staleM5) reasons.push("LATEST_M5_CANDLE_STALE");
    if (staleM15) reasons.push("LATEST_M15_CANDLE_STALE");
    if (staleH1) reasons.push("LATEST_H1_CANDLE_STALE");
    if (stalePrice) reasons.push("LIVE_PRICE_STALE_OR_UNAVAILABLE");

    return {
      open: !closed,
      allowNewSignal: !closed,
      allowPush: !closed,
      reason: closed ? reasons[0] || "MARKET_CLOSED" : "MARKET_OPEN",
      reasons,
      latestCandle: latest?.time || null,
      latestCandleAgeMinutes: latestAgeMin == null ? null : Number(latestAgeMin.toFixed(1)),
      livePriceAgeMinutes: Number.isFinite(priceAgeMin) ? Number(priceAgeMin.toFixed(1)) : null,
      timeframeCandleAgeMinutes: {
        m5: latestAgeMin == null ? null : Number(latestAgeMin.toFixed(1)),
        m15: m15AgeMin == null ? null : Number(m15AgeMin.toFixed(1)),
        h1: h1AgeMin == null ? null : Number(h1AgeMin.toFixed(1))
      },
      syntheticFlatFeed
    };
  }

  function getCandleTTL(key) {
    if (key === "m5") {
      return CFG.m5CacheTTL;
    }

    if (key === "m15") {
      return CFG.m15CacheTTL;
    }

    if (key === "h1") {
      return CFG.h1CacheTTL;
    }

    return 60_000;
  }

  /*
   * ============================================================
   * REDIS
   * ============================================================
   */

  async function redisGet(key) {
    try {
      return await redis.get(key);
    } catch (e) {
      console.error(
        `Redis GET error [${key}]:`,
        e?.message || e
      );

      return null;
    }
  }

  async function redisSet(key, value, ttl) {
    try {
      await redis.set(
        key,
        JSON.stringify(value),
        {
          ex: ttl
        }
      );

      return true;
    } catch (e) {
      console.error(
        `Redis SET error [${key}]:`,
        e?.message || e
      );

      return false;
    }
  }

  function parseRedisValue(value) {
    if (value == null) {
      return null;
    }

    if (typeof value === "object") {
      return value;
    }

    if (typeof value === "string") {
      try {
        return JSON.parse(value);
      } catch {
        return null;
      }
    }

    return null;
  }

  /*
   * ============================================================
   * TECHNICAL INDICATORS
   * ============================================================
   */

  function ema(v, p) {
    if (v.length < p) {
      return null;
    }

    const k = 2 / (p + 1);

    let e = avg(v.slice(0, p));

    for (let i = p; i < v.length; i++) {
      e =
        v[i] * k +
        e * (1 - k);
    }

    return e;
  }

  function rsi(v, p = 14) {
    if (v.length < p + 1) {
      return null;
    }

    let gains = 0;
    let losses = 0;

    for (
      let i = v.length - p;
      i < v.length;
      i++
    ) {
      const d = v[i] - v[i - 1];

      if (d > 0) {
        gains += d;
      } else {
        losses -= d;
      }
    }

    if (losses === 0) {
      return 100;
    }

    const rs =
      (gains / p) /
      (losses / p);

    return 100 - 100 / (1 + rs);
  }

  function atr(d, p = 14) {
    if (d.length < p + 1) {
      return null;
    }

    const tr = [];

    for (let i = 1; i < d.length; i++) {
      const c = d[i];
      const pc = d[i - 1].close;

      tr.push(
        Math.max(
          c.high - c.low,
          Math.abs(c.high - pc),
          Math.abs(c.low - pc)
        )
      );
    }

    return avg(tr.slice(-p));
  }

  function macd(v) {
    if (v.length < 35) {
      return null;
    }

    const e12 = ema(v, 12);
    const e26 = ema(v, 26);

    if (e12 == null || e26 == null) {
      return null;
    }

    const line = e12 - e26;

    const lines = [];

    for (let i = 26; i <= v.length; i++) {
      const a = ema(v.slice(0, i), 12);
      const b = ema(v.slice(0, i), 26);

      if (a != null && b != null) {
        lines.push(a - b);
      }
    }

    const signal = ema(lines, 9);

    if (signal == null) {
      return null;
    }

    return {
      line,
      signal,
      histogram: line - signal,
      bullish: line > signal,
      bearish: line < signal
    };
  }

  function structure(d, lookback = 20) {
    if (d.length < lookback * 2) {
      return {
        bullish: false,
        bearish: false,
        high: null,
        low: null,
        previousHigh: null,
        previousLow: null
      };
    }

    const r = d.slice(-lookback);

    const p = d.slice(
      -lookback * 2,
      -lookback
    );

    const last = d.at(-1);

    const high = Math.max(
      ...r.map(x => x.high)
    );

    const low = Math.min(
      ...r.map(x => x.low)
    );

    const previousHigh = Math.max(
      ...p.map(x => x.high)
    );

    const previousLow = Math.min(
      ...p.map(x => x.low)
    );

    return {
      bullish:
        last.close > previousHigh,

      bearish:
        last.close < previousLow,

      high,
      low,
      previousHigh,
      previousLow
    };
  }

  function bos(d, lookback = 10) {
    if (d.length < lookback + 2) {
      return {
        bullish: false,
        bearish: false
      };
    }

    const last = d.at(-1);

    const p = d.slice(
      -lookback - 1,
      -1
    );

    return {
      bullish:
        last.close >
        Math.max(...p.map(x => x.high)),

      bearish:
        last.close <
        Math.min(...p.map(x => x.low))
    };
  }

  // Detect a fresh BOS on the newest CLOSED candle (false -> true).
  // The regular bos() helper is a state check; this helper emits one event.
  function bosEvent(d, lookback = 10) {
    const stateAt = endIndex => {
      if (endIndex < lookback) return { bullish: false, bearish: false };
      const last = d[endIndex];
      const prior = d.slice(endIndex - lookback, endIndex);
      if (!last || prior.length !== lookback) return { bullish: false, bearish: false };
      return {
        bullish: last.close > Math.max(...prior.map(x => x.high)),
        bearish: last.close < Math.min(...prior.map(x => x.low))
      };
    };
    if (d.length < lookback + 2) {
      return { bullish: false, bearish: false, candle: d.at(-1) || null };
    }
    const i = d.length - 1;
    const current = stateAt(i);
    const previous = stateAt(i - 1);
    return {
      bullish: current.bullish && !previous.bullish,
      bearish: current.bearish && !previous.bearish,
      candle: d[i],
      previous: d[i - 1]
    };
  }

  function choch(d, lookback = 8) {
    if (d.length < lookback * 2 + 2) {
      return {
        bullish: false,
        bearish: false
      };
    }

    const r = d.slice(-lookback);

    const p = d.slice(
      -lookback * 2,
      -lookback
    );

    const last = d.at(-1);

    const rh = Math.max(
      ...r.map(x => x.high)
    );

    const rl = Math.min(
      ...r.map(x => x.low)
    );

    const ph = Math.max(
      ...p.map(x => x.high)
    );

    const pl = Math.min(
      ...p.map(x => x.low)
    );

    return {
      bullish:
        rh > ph &&
        last.close > ph,

      bearish:
        rl < pl &&
        last.close < pl
    };
  }

  /*
   * ============================================================
   * NEW CHOCH EVENT DETECTOR
   * ============================================================
   *
   * The existing choch() tells us whether the current structure
   * is in a CHOCH state. For push notifications we need an EVENT:
   * the state must change from false -> true on the newest CLOSED
   * candle. This prevents the same CHOCH from being pushed again
   * on every cron run while the condition remains true.
   */

  function chochEvent(d, lookback = 8) {
    if (d.length < lookback * 2 + 3) {
      return {
        bullish: false,
        bearish: false,
        candle: d.at(-1) || null,
        previous: d.at(-2) || null
      };
    }

    const stateAt = endIndex => {
      if (endIndex < lookback * 2) {
        return {
          bullish: false,
          bearish: false
        };
      }

      const r = d.slice(
        endIndex - lookback + 1,
        endIndex + 1
      );

      const p = d.slice(
        endIndex - lookback * 2 + 1,
        endIndex - lookback + 1
      );

      const last = d[endIndex];

      if (!last || r.length !== lookback || p.length !== lookback) {
        return {
          bullish: false,
          bearish: false
        };
      }

      const rh = Math.max(...r.map(x => x.high));
      const rl = Math.min(...r.map(x => x.low));
      const ph = Math.max(...p.map(x => x.high));
      const pl = Math.min(...p.map(x => x.low));

      return {
        bullish:
          rh > ph &&
          last.close > ph,

        bearish:
          rl < pl &&
          last.close < pl
      };
    };

    const currentIndex = d.length - 1;
    const previousIndex = d.length - 2;

    const current = stateAt(currentIndex);
    const previous = stateAt(previousIndex);

    const candle = d[currentIndex];

    return {
      bullish:
        current.bullish &&
        !previous.bullish,

      bearish:
        current.bearish &&
        !previous.bearish,

      candle,
      previous: d[previousIndex],

      currentState: current,
      previousState: previous
    };
  }

  function sweep(d, lookback = 10) {
    if (d.length < lookback + 2) {
      return {
        bullish: false,
        bearish: false
      };
    }

    const c = d.at(-1);

    const p = d.slice(
      -lookback - 1,
      -1
    );

    const h = Math.max(
      ...p.map(x => x.high)
    );

    const l = Math.min(
      ...p.map(x => x.low)
    );

    return {
      bullish:
        c.low < l &&
        c.close > l,

      bearish:
        c.high > h &&
        c.close < h
    };
  }

  function momentum(d) {
    const c = d.at(-1);

    if (!c) {
      return {
        bullish: false,
        bearish: false,
        strength: 0
      };
    }

    const range =
      c.high - c.low ||
      1e-9;

    const ratio =
      Math.abs(c.close - c.open) /
      range;

    return {
      bullish:
        c.close > c.open &&
        ratio >= 0.45,

      bearish:
        c.close < c.open &&
        ratio >= 0.45,

      strength:
        Math.round(ratio * 100)
    };
  }

  /*
   * ============================================================
   * MULTI-TIMEFRAME SUPPORT / RESISTANCE
   * ============================================================
   *
   * Design:
   * - confirmed pivots only (closed candles)
   * - nearby pivots are clustered into zones
   * - H1 extremes are marked as MAJOR_EXTREME, not treated as
   *   ordinary swings
   * - strength is a confidence score, not just raw touch count
   * - S/R informs context, target selection and hold management
   * - S/R NEVER blocks a valid M5 scalp trigger
   */

  function buildSRLevels(data, price, atrValue, timeframe, options = {}) {
    const lookback = options.lookback || CFG.srMajorLookback;
    const swingStrength = options.swingStrength || CFG.srSwingStrength;
    const includeExtreme = options.includeExtreme ?? false;
    const source = data.slice(-lookback);

    if (source.length < swingStrength * 2 + 5) {
      return [];
    }

    const raw = [];
    const pushPivot = (index, type, levelPrice, kind = "SWING") => {
      raw.push({
        price: levelPrice,
        type,
        kind,
        index,
        time: source[index]?.time || null
      });
    };

    for (let i = swingStrength; i < source.length - swingStrength; i++) {
      const c = source[i];
      let isHigh = true;
      let isLow = true;

      for (let j = 1; j <= swingStrength; j++) {
        if (c.high <= source[i - j].high || c.high <= source[i + j].high) isHigh = false;
        if (c.low >= source[i - j].low || c.low >= source[i + j].low) isLow = false;
      }

      if (isHigh) pushPivot(i, "RESISTANCE", c.high);
      if (isLow) pushPivot(i, "SUPPORT", c.low);
    }

    if (includeExtreme) {
      const hi = Math.max(...source.map(x => x.high));
      const lo = Math.min(...source.map(x => x.low));
      pushPivot(source.findIndex(x => x.high === hi), "RESISTANCE", hi, "MAJOR_EXTREME");
      pushPivot(source.findIndex(x => x.low === lo), "SUPPORT", lo, "MAJOR_EXTREME");
    }

    const groupingDistance = Math.max(
      (atrValue || 5) * CFG.srGroupingATR,
      CFG.srGroupingMin
    );

    const grouped = [];

    for (const level of raw) {
      let group = grouped.find(x =>
        x.type === level.type &&
        Math.abs(x.price - level.price) <= groupingDistance
      );

      if (!group) {
        group = {
          type: level.type,
          price: level.price,
          prices: [],
          pivots: [],
          touches: 0,
          major: false
        };
        grouped.push(group);
      }

      group.prices.push(level.price);
      group.pivots.push(level);
      group.touches += 1;
      group.major = group.major || level.kind === "MAJOR_EXTREME";
      group.price = group.prices.reduce((a, b) => a + b, 0) / group.prices.length;
    }

    const maxIndex = source.length - 1;

    return grouped.map(group => {
      const latestIndex = Math.max(...group.pivots.map(x => x.index));
      const ageBars = Math.max(0, maxIndex - latestIndex);
      const recency = 1 / (1 + ageBars / 12);
      const touchScore = Math.min(40, group.touches * 10);
      const majorBonus = group.major ? 20 : 0;
      const distance = price == null ? null : Math.abs(group.price - price);
      const proximity = distance == null ? 0 : Math.max(0, 20 * (1 - distance / Math.max((atrValue || 10) * 8, 1)));
      const score = Math.round(clamp(touchScore + recency * 20 + majorBonus + proximity, 0, 100));

      return {
        price: Number(group.price.toFixed(2)),
        type: group.type,
        kind: group.major ? "MAJOR_EXTREME" : "CONFIRMED_SWING",
        major: group.major,
        touches: group.touches,
        strength: Math.max(1, Math.min(5, Math.ceil(score / 20))),
        score,
        ageBars,
        timeframe,
        lastTouch: source[latestIndex]?.time || null
      };
    });
  }

  // Independent S/R breakout monitor. It does not promote a breakout to an entry signal.
  function detectSRBreakout(candles, levels, livePrice, dataUsable = true) {
    const none = { state: dataUsable ? "NO_BREAKOUT" : "DATA_UNAVAILABLE", direction: "WAIT", level: null, price: livePrice ?? null, candleTime: null, timeframe: "M5", message: dataUsable ? "No confirmed S/R cross on the latest closed M5 candle" : "Breakout was not evaluated because candle data is unreliable" };
    if (!dataUsable || !Array.isArray(candles) || candles.length < 3 || !Array.isArray(levels) || !levels.length) return none;

    // Defensive validation: only use timestamped, fully closed M5 candles, in chronological order.
    const recent = candles
      .filter(candle => {
        const timeMs = candleTimestampMs(candle?.time);
        return Number.isFinite(timeMs) && timeMs + 5 * 60_000 <= Date.now() && Number.isFinite(Number(candle?.close));
      })
      .sort((a, b) => candleTimestampMs(a.time) - candleTimestampMs(b.time))
      .slice(-2);
    if (recent.length < 2) return none;

    const candidates = [];
    for (const level of levels) {
      const levelPrice = Number(level?.price);
      if (!Number.isFinite(levelPrice)) continue;
      for (let i = 1; i < recent.length; i++) {
        const prev = Number(recent[i - 1]?.close);
        const curr = Number(recent[i]?.close);
        if (!Number.isFinite(prev) || !Number.isFinite(curr)) continue;
        const candleTime = recent[i]?.time || null;
        const timeMs = candleTimestampMs(candleTime);
        if (level.type === "RESISTANCE" && prev <= levelPrice && curr > levelPrice) {
          candidates.push({ state: "BREAKOUT_DETECTED", direction: "BUY", level: levelPrice, price: Number(livePrice ?? curr), candleTime, _candleTimeMs: timeMs, timeframe: "M5", message: `M5 close crossed resistance ${levelPrice.toFixed(2)}` });
        }
        if (level.type === "SUPPORT" && prev >= levelPrice && curr < levelPrice) {
          candidates.push({ state: "BREAKOUT_DETECTED", direction: "SELL", level: levelPrice, price: Number(livePrice ?? curr), candleTime, _candleTimeMs: timeMs, timeframe: "M5", message: `M5 close crossed support ${levelPrice.toFixed(2)}` });
        }
      }
    }
    if (!candidates.length) return none;
    // Select by event time, not by level-loop order. Never turn this into ENTRY READY here.
    candidates.sort((a, b) => a._candleTimeMs - b._candleTimeMs);
    const latest = candidates[candidates.length - 1];
    const { _candleTimeMs, ...result } = latest;
    return result;
  }

  function findH1SupportResistance(data, price, h1ATR) {
    const levels = buildSRLevels(
      data,
      price,
      h1ATR,
      "H1",
      {
        lookback: CFG.srLookback,
        swingStrength: CFG.srSwingStrength,
        includeExtreme: CFG.srIncludeExtreme
      }
    );

    // Only treat a level as an entry-quality zone when it has meaningful
    // evidence. A nearby one-off swing is still returned in `levels` for
    // context, but it must not qualify as the strong S/R entry zone.
    const isStrongZone = level =>
      Number(level.score) >= 50 &&
      Number(level.strength) >= 3 &&
      (Number(level.touches) >= 2 || level.major === true);

    const supports = levels
      .filter(x => x.type === "SUPPORT" && x.price < price && isStrongZone(x))
      .sort((a, b) => b.price - a.price);

    const resistances = levels
      .filter(x => x.type === "RESISTANCE" && x.price > price && isStrongZone(x))
      .sort((a, b) => a.price - b.price);

    // Keep entry-quality zones separate from display levels. The dashboard
    // should still show the nearest detected S/R even when it is not strong
    // enough to authorize an entry.
    const strongSupport = supports[0] || null;
    const strongResistance = resistances[0] || null;
    const displaySupports = levels
      .filter(x => x.type === "SUPPORT" && x.price < price)
      .sort((a, b) => b.price - a.price);
    const displayResistances = levels
      .filter(x => x.type === "RESISTANCE" && x.price > price)
      .sort((a, b) => a.price - b.price);
    const support = displaySupports[0] || null;
    const resistance = displayResistances[0] || null;
    const supportDistance = support ? price - support.price : null;
    const resistanceDistance = resistance ? resistance.price - price : null;
    const strongSupportDistance = strongSupport ? price - strongSupport.price : null;
    const strongResistanceDistance = strongResistance ? strongResistance.price - price : null;

    const threshold = Math.max(
      (h1ATR || 10) * CFG.srATRMultiplier,
      CFG.srMinDistance
    );
    const reversalThreshold = threshold * CFG.reversalZoneMultiplier;

    // Entry filters intentionally use only strong zones; display distances
    // above may refer to ordinary levels and must not relax the entry filter.
    const nearSupport = strongSupportDistance != null && strongSupportDistance <= threshold;
    const nearResistance = strongResistanceDistance != null && strongResistanceDistance <= threshold;
    const atSupport = strongSupportDistance != null && strongSupportDistance <= threshold * 0.35;
    const atResistance = strongResistanceDistance != null && strongResistanceDistance <= threshold * 0.35;
    const reversalAtSupport = strongSupportDistance != null && strongSupportDistance <= reversalThreshold;
    const reversalAtResistance = strongResistanceDistance != null && strongResistanceDistance <= reversalThreshold;

    let position = "BETWEEN S/R";
    let zone = "NEUTRAL";
    if (atSupport) { position = "AT SUPPORT"; zone = "SUPPORT"; }
    else if (atResistance) { position = "AT RESISTANCE"; zone = "RESISTANCE"; }
    else if (nearSupport && nearResistance) { position = "BETWEEN S/R"; zone = "TIGHT RANGE"; }
    else if (nearSupport) { position = "NEAR SUPPORT"; zone = "SUPPORT"; }
    else if (nearResistance) { position = "NEAR RESISTANCE"; zone = "RESISTANCE"; }

    let signalContext = "NO S/R WARNING";
    if (nearSupport && nearResistance) signalContext = "TIGHT S/R RANGE";
    else if (nearResistance) signalContext = "RESISTANCE NEARBY";
    else if (nearSupport) signalContext = "SUPPORT NEARBY";

    return {
      support,
      resistance,
      strongSupport,
      strongResistance,
      strongSupportDistance: strongSupportDistance != null ? Number(strongSupportDistance.toFixed(2)) : null,
      strongResistanceDistance: strongResistanceDistance != null ? Number(strongResistanceDistance.toFixed(2)) : null,
      levels: levels
        .sort((a, b) => Math.abs(a.price - price) - Math.abs(b.price - price))
        .slice(0, CFG.srMaxLevels),
      supportDistance: supportDistance != null ? Number(supportDistance.toFixed(2)) : null,
      resistanceDistance: resistanceDistance != null ? Number(resistanceDistance.toFixed(2)) : null,
      supportDistancePct: supportDistance != null ? Number((supportDistance / price * 100).toFixed(3)) : null,
      resistanceDistancePct: resistanceDistance != null ? Number((resistanceDistance / price * 100).toFixed(3)) : null,
      threshold: Number(threshold.toFixed(2)),
      reversalThreshold: Number(reversalThreshold.toFixed(2)),
      position,
      zone,
      nearSupport,
      nearResistance,
      atSupport,
      atResistance,
      reversalAtSupport,
      reversalAtResistance,
      signalContext
    };
  }

  function findDirectionalTargets(data, price, direction, timeframe, atrValue, lookback = 80) {
    const levels = buildSRLevels(data, price, atrValue, timeframe, {
      lookback,
      swingStrength: CFG.roadblockSwingStrength,
      includeExtreme: timeframe === "H1"
    });

    return levels
      .filter(level =>
        direction === "BUY"
          ? level.type === "RESISTANCE" && level.price > price
          : level.type === "SUPPORT" && level.price < price
      )
      .sort((a, b) => Math.abs(a.price - price) - Math.abs(b.price - price));
  }

  /*
   * ============================================================
   * M15 / M5 ROADBLOCK DETECTION
   * ============================================================
   *
   * Roadblock = short timeframe support/resistance yang berada
   * di antara current entry dan H1 target.
   *
   * Ia TIDAK block signal.
   */

  function findRoadblocks(
    data,
    price,
    target,
    targetType,
    timeframe,
    atrValue
  ) {
    const lookback =
      timeframe === "M15"
        ? CFG.roadblockLookbackM15
        : CFG.roadblockLookbackM5;

    const source =
      data.slice(-lookback);

    if (
      !source.length ||
      target == null ||
      price == null
    ) {
      return {
        timeframe,
        target,
        targetType,
        roadblocks: [],
        nearest: null,
        count: 0,
        hasRoadblock: false,
        status: "NONE"
      };
    }

    const levels = [];

    const strength =
      CFG.roadblockSwingStrength;

    /*
     * Swing highs = resistance
     */

    for (
      let i = strength;
      i < source.length - strength;
      i++
    ) {
      const c = source[i];

      let isHigh = true;

      for (
        let j = 1;
        j <= strength;
        j++
      ) {
        if (
          c.high <= source[i - j].high ||
          c.high <= source[i + j].high
        ) {
          isHigh = false;
          break;
        }
      }

      if (isHigh) {
        levels.push({
          price: c.high,
          type: "RESISTANCE",
          index: i
        });
      }
    }

    /*
     * Swing lows = support
     */

    for (
      let i = strength;
      i < source.length - strength;
      i++
    ) {
      const c = source[i];

      let isLow = true;

      for (
        let j = 1;
        j <= strength;
        j++
      ) {
        if (
          c.low >= source[i - j].low ||
          c.low >= source[i + j].low
        ) {
          isLow = false;
          break;
        }
      }

      if (isLow) {
        levels.push({
          price: c.low,
          type: "SUPPORT",
          index: i
        });
      }
    }

    /*
     * Grouping
     */

    const grouped = [];

    const groupingDistance =
      Math.max(
        (atrValue || 5) *
          CFG.roadblockGroupATRMultiplier,
        CFG.roadblockMinGroupDistance
      );

    for (const level of levels) {
      const existing =
        grouped.find(
          x =>
            x.type === level.type &&
            Math.abs(
              x.price - level.price
            ) <= groupingDistance
        );

      if (existing) {
        existing.prices.push(
          level.price
        );

        existing.touches += 1;

        existing.price =
          existing.prices.reduce(
            (a, b) => a + b,
            0
          ) /
          existing.prices.length;
      } else {
        grouped.push({
          type: level.type,
          price: level.price,
          prices: [level.price],
          touches: 1
        });
      }
    }

    /*
     * BUY:
     *
     * Roadblock mestilah resistance
     * after price but before the H1 target.
     *
     * SELL:
     *
     * Roadblock mestilah support
     * after price but before the H1 target.
     */

    const isBuy =
      targetType === "BUY TARGET" ||
      targetType === "H1 RESISTANCE";

    const isSell =
      targetType === "SELL TARGET" ||
      targetType === "H1 SUPPORT";

    let candidates = [];

    if (isBuy) {
      candidates =
        grouped.filter(
          x =>
            x.type === "RESISTANCE" &&
            x.price > price &&
            x.price < target
        );
    }

    if (isSell) {
      candidates =
        grouped.filter(
          x =>
            x.type === "SUPPORT" &&
            x.price < price &&
            x.price > target
        );
    }

    /*
     * Buang level terlalu dekat dengan current price.
     *
     * Ini elakkan noise kecil dianggap roadblock.
     */

    const minimumDistance =
      Math.max(
        (atrValue || 5) * 0.15,
        0.8
      );

    candidates =
      candidates.filter(
        x =>
          Math.abs(
            x.price - price
          ) >= minimumDistance
      );

    /*
     * Sort ikut jarak dari current price.
     */

    candidates.sort(
      (a, b) =>
        Math.abs(a.price - price) -
        Math.abs(b.price - price)
    );

    const roadblocks =
      candidates
        .slice(
          0,
          CFG.roadblockMaxLevels
        )
        .map(x => {
          const distance =
            Math.abs(
              x.price - price
            );

          const targetDistance =
            Math.abs(
              target - price
            );

          const percentage =
            targetDistance > 0
              ? (
                  distance /
                  targetDistance *
                  100
                )
              : 0;

          return {
            price:
              Number(
                x.price.toFixed(2)
              ),

            type:
              x.type,

            strength:
              x.touches,

            distance:
              Number(
                distance.toFixed(2)
              ),

            targetProgressPct:
              Number(
                percentage.toFixed(1)
              )
          };
        });

    const nearest =
      roadblocks[0] || null;

    return {
      timeframe,

      target:
        Number(
          target.toFixed(2)
        ),

      targetType,

      roadblocks,

      nearest,

      count:
        roadblocks.length,

      hasRoadblock:
        roadblocks.length > 0,

      status:
        roadblocks.length
          ? "ROADBLOCK"
          : "CLEAR"
    };
  }

  /*
   * ============================================================
   * TWELVE DATA CANDLE CACHE + LOCAL TIMEFRAME AGGREGATION
   * ============================================================
   */

  function filterClosedCandles(data, interval) {
    if (!Array.isArray(data) || !data.length) {
      return [];
    }

    const intervalMs =
      interval === "5min"
        ? 5 * 60_000
        : interval === "15min"
          ? 15 * 60_000
          : 60 * 60_000;

    return data.filter(candle => {
      const candleStart = candleTimestampMs(candle.time);

      // Missing/invalid timestamps cannot be safely classified as closed candles.
      if (!Number.isFinite(candleStart)) {
        return false;
      }

      return candleStart + intervalMs <= Date.now();
    });
  }

  // Build fully closed M15/H1 candles from consecutive, closed M5 candles.
  // A bucket is discarded if any expected M5 candle is missing.
  function aggregateFromM5(m5Data, intervalMinutes) {
    const barsPerBucket = intervalMinutes / 5;
    const bucketMs = intervalMinutes * 60_000;
    const fiveMinutesMs = 5 * 60_000;
    const buckets = new Map();

    for (const candle of (m5Data || [])) {
      const timeMs = candleTimestampMs(candle.time);
      if (!Number.isFinite(timeMs)) continue;
      const bucketStart = Math.floor(timeMs / bucketMs) * bucketMs;
      if (!buckets.has(bucketStart)) buckets.set(bucketStart, []);
      buckets.get(bucketStart).push({ ...candle, _timeMs: timeMs });
    }

    const result = [];
    for (const [bucketStart, items] of buckets.entries()) {
      if (items.length !== barsPerBucket) continue;
      items.sort((a, b) => a._timeMs - b._timeMs);
      let complete = true;
      for (let i = 0; i < barsPerBucket; i++) {
        if (items[i]._timeMs !== bucketStart + i * fiveMinutesMs) {
          complete = false;
          break;
        }
      }
      if (!complete || bucketStart + bucketMs > Date.now()) continue;

      result.push({
        time: new Date(bucketStart).toISOString().slice(0, 19).replace('T', ' '),
        open: items[0].open,
        high: Math.max(...items.map(x => x.high)),
        low: Math.min(...items.map(x => x.low)),
        close: items[items.length - 1].close,
        volume: items.reduce((sum, x) => sum + (Number(x.volume) || 0), 0)
      });
    }

    return result.sort((a, b) => candleTimestampMs(a.time) - candleTimestampMs(b.time));
  }

  async function series(
    interval,
    outputsize,
    key
  ) {
    const localCache =
      C.candles[key];

    const candleTTL =
      getCandleTTL(key);

    // A cache can be recently written but still contain an old market candle.
    // For M5, force a provider refresh when the latest CLOSED candle is older
    // than 7 minutes. Cooldown prevents dashboard polling from hammering API.
    const cachedLatest = Array.isArray(localCache?.data) && localCache.data.length
      ? localCache.data[localCache.data.length - 1]
      : null;
    const cachedLatestMs = cachedLatest?.time ? Date.parse(`${cachedLatest.time}${/Z$|[+-]\d\d:\d\d$/.test(cachedLatest.time) ? '' : 'Z'}`) : NaN;
    const cachedCandleAgeMs = Number.isFinite(cachedLatestMs) ? Date.now() - cachedLatestMs : Infinity;
    const staleM5Cache = key === 'm5' && cachedCandleAgeMs > 7 * 60 * 1000;
    const lastForcedRefresh = Number(C.lastForcedM5RefreshAt || 0);
    const forceProviderRefresh = staleM5Cache && (Date.now() - lastForcedRefresh > 60 * 1000);
    if (forceProviderRefresh) C.lastForcedM5RefreshAt = Date.now();

    /*
     * ----------------------------------------------------------
     * 1. LOCAL CACHE
     * ----------------------------------------------------------
     */

    if (
      !forceProviderRefresh &&
      localCache &&
      now - localCache.at <
        candleTTL
    ) {
      C.dataSource[key] =
        "LOCAL_CACHE";

      return localCache.data;
    }

    /*
     * ----------------------------------------------------------
     * 2. SHARED REDIS CACHE
     * ----------------------------------------------------------
     * Check shared cache before calling Twelve Data. This prevents
     * separate Vercel instances (dashboard + GitHub Actions) from
     * independently fetching the same still-fresh candle series.
     */

    const redisRaw = await redisGet(CFG.redisKeys[key]);
    const sharedCache = parseRedisValue(redisRaw);
    const sharedSavedAt = Number(sharedCache?.savedAt);

    if (
      !forceProviderRefresh &&
      Array.isArray(sharedCache?.data) &&
      sharedCache.data.length &&
      Number.isFinite(sharedSavedAt) &&
      now - sharedSavedAt >= 0 &&
      now - sharedSavedAt < candleTTL
    ) {
      const sharedClosedData = filterClosedCandles(
        sharedCache.data,
        interval
      );
      const minRequired = {
        "5min": CFG.minM5,
        "15min": CFG.minM15,
        "1h": CFG.minH1
      }[interval];

      if (sharedClosedData.length >= minRequired) {
        C.candles[key] = {
          at: sharedSavedAt,
          data: sharedClosedData
        };
        C.dataSource[key] = "REDIS_CACHE";
        C.cacheAt[key] = sharedSavedAt;
        return sharedClosedData;
      }
    }

    /*
     * ----------------------------------------------------------
     * 3. TWELVE DATA
     * ----------------------------------------------------------
     */

    try {
      const controller =
        new AbortController();

      const timeout =
        setTimeout(
          () =>
            controller.abort(),
          10_000
        );

      const url =
        `https://api.twelvedata.com/time_series` +
        `?symbol=${encodeURIComponent(
          CFG.symbol
        )}` +
        `&interval=${interval}` +
        `&outputsize=${outputsize}` +
        `&timezone=UTC` +
        `&apikey=${API_KEY}`;

      const r =
        await fetch(
          url,
          {
            signal:
              controller.signal
          }
        );

      clearTimeout(timeout);

      const j =
        await r.json();

      if (
        !r.ok ||
        j.status === "error"
      ) {
        throw new Error(
          j.message ||
            `Twelve Data ${interval} error`
        );
      }

      const data =
        (j.values || [])
          .reverse()
          .map(x => ({
            time: x.datetime,
            open: +x.open,
            high: +x.high,
            low: +x.low,
            close: +x.close,
            volume:
              +x.volume || 0
          }))
          .filter(x =>
            [
              x.open,
              x.high,
              x.low,
              x.close
            ].every(
              Number.isFinite
            )
          );

      /*
       * IMPORTANT:
       *
       * CHOCH notifications must be based on CLOSED candles only.
       * Twelve Data is requested in UTC above so candle timestamps
       * can be compared safely with server time.
       */

      const closedData =
        filterClosedCandles(
          data,
          interval
        );

      data.length = 0;
      data.push(...closedData);

      const minRequired =
        {
          "5min":
            CFG.minM5,

          "15min":
            CFG.minM15,

          "1h":
            CFG.minH1
        }[interval];

      if (
        data.length <
        minRequired
      ) {
        throw new Error(
          `Data ${interval} tak cukup: ${data.length}`
        );
      }

      const savedAt =
        Date.now();

      C.candles[key] = {
        at: savedAt,
        data
      };

      C.dataSource[key] =
        "TWELVE_DATA";

      C.cacheAt[key] =
        savedAt;

      /*
       * Redis persistent cache
       */

      await redisSet(
        CFG.redisKeys[key],
        {
          savedAt,
          interval,
          outputsize,
          data
        },
        CFG.redisCacheTTL
      );

      return data;

    } catch (apiError) {
      console.error(
        `Twelve Data ${interval} failed:`,
        apiError?.message ||
          apiError
      );

      /*
       * --------------------------------------------------------
       * 3. REDIS FALLBACK
       * --------------------------------------------------------
       */

      const redisRaw =
        await redisGet(
          CFG.redisKeys[key]
        );

      const redisCache =
        parseRedisValue(
          redisRaw
        );

      if (
        redisCache?.data &&
        Array.isArray(
          redisCache.data
        ) &&
        redisCache.data.length
      ) {
        const closedRedisData =
          filterClosedCandles(
            redisCache.data,
            interval
          );

        const minRequired =
          {
            "5min":
              CFG.minM5,

            "15min":
              CFG.minM15,

            "1h":
              CFG.minH1
          }[interval];

        if (
          closedRedisData.length >=
          minRequired
        ) {
          const cachedSavedAt = Number(redisCache.savedAt);
          C.candles[key] = {
            // Missing cache metadata must not make an old cache look freshly written.
            at: Number.isFinite(cachedSavedAt) && cachedSavedAt > 0 ? cachedSavedAt : 0,
            data: closedRedisData
          };

          C.dataSource[key] =
            "REDIS_CACHE";

          C.cacheAt[key] =
            Number.isFinite(cachedSavedAt) && cachedSavedAt > 0 ? cachedSavedAt : 0;

          return closedRedisData;
        }
      }

      /*
       * --------------------------------------------------------
       * 4. STALE LOCAL
       * --------------------------------------------------------
       */

      if (
        localCache?.data &&
        Array.isArray(
          localCache.data
        ) &&
        localCache.data.length
      ) {
        C.dataSource[key] =
          "STALE_LOCAL_CACHE";

        return filterClosedCandles(
          localCache.data,
          interval
        );
      }

      throw new Error(
        `${interval}: Twelve Data gagal dan cache terakhir tidak tersedia. ` +
        `${apiError?.message || ""}`
      );
    }
  }

  /*
   * ============================================================
   * LIVE PRICE
   * ============================================================
   */

  async function getLivePrice() {
    /*
     * LOCAL PRICE CACHE
     */

    if (
      C.price != null &&
      now - C.priceAt <
        CFG.priceTTL
    ) {
      C.dataSource.price =
        "LOCAL_CACHE";

      return {
        price: C.price,
        savedAt: C.priceAt,
        source: "LOCAL_CACHE"
      };
    }

    /*
     * SHARED REDIS PRICE CACHE
     *
     * Check Redis before the provider request so concurrent Vercel
     * instances can reuse the same price during the configured TTL.
     */

    const redisRaw = await redisGet(CFG.redisKeys.price);
    const sharedPrice = parseRedisValue(redisRaw);
    const sharedPriceValue = Number(sharedPrice?.price);
    const sharedPriceSavedAt = Number(sharedPrice?.savedAt);

    if (
      Number.isFinite(sharedPriceValue) &&
      Number.isFinite(sharedPriceSavedAt) &&
      now - sharedPriceSavedAt >= 0 &&
      now - sharedPriceSavedAt < CFG.priceTTL
    ) {
      C.price = sharedPriceValue;
      C.priceAt = sharedPriceSavedAt;
      C.dataSource.price = "REDIS_CACHE";
      C.cacheAt.price = sharedPriceSavedAt;

      return {
        price: sharedPriceValue,
        savedAt: sharedPriceSavedAt,
        source: "REDIS_CACHE"
      };
    }

    /*
     * TWELVE DATA PRICE
     */

    try {
      const controller =
        new AbortController();

      const timeout =
        setTimeout(
          () =>
            controller.abort(),
          10_000
        );

      const pr =
        await fetch(
          `https://api.twelvedata.com/price` +
          `?symbol=${encodeURIComponent(
            CFG.symbol
          )}` +
          `&apikey=${API_KEY}`,
          {
            signal:
              controller.signal
          }
        );

      clearTimeout(timeout);

      const pj =
        await pr.json();

      const p =
        Number(
          pj?.price
        );

      if (
        !pr.ok ||
        pj.status === "error" ||
        !Number.isFinite(p) ||
        p <= 0
      ) {
        throw new Error(
          pj.message ||
            "Live price error"
        );
      }

      const savedAt =
        Date.now();

      C.price = p;
      C.priceAt = savedAt;

      C.dataSource.price =
        "TWELVE_DATA";

      C.cacheAt.price =
        savedAt;

      await redisSet(
        CFG.redisKeys.price,
        {
          price: p,
          savedAt
        },
        CFG.redisCacheTTL
      );

      return {
        price: p,
        savedAt,
        source: "TWELVE_DATA"
      };

    } catch (priceError) {
      console.error(
        "Twelve Data price failed:",
        priceError?.message ||
          priceError
      );

      /*
       * REDIS
       */

      const redisRaw =
        await redisGet(
          CFG.redisKeys.price
        );

      const redisPrice =
        parseRedisValue(
          redisRaw
        );

      const cachedPrice =
        Number(
          redisPrice?.price
        );

      if (
        Number.isFinite(
          cachedPrice
        )
      ) {
        const cachedPriceSavedAt = Number(redisPrice?.savedAt);
        const validCachedPriceTime = Number.isFinite(cachedPriceSavedAt) && cachedPriceSavedAt > 0
          ? cachedPriceSavedAt
          : 0;

        C.price = cachedPrice;
        C.priceAt = validCachedPriceTime;
        C.dataSource.price = "REDIS_CACHE";
        C.cacheAt.price = validCachedPriceTime;

        return {
          price: cachedPrice,
          // 0 deliberately makes the market-data guard reject an undated cache.
          savedAt: validCachedPriceTime,
          source: "REDIS_CACHE"
        };
      }

      /*
       * STALE LOCAL
       */

      if (
        Number.isFinite(
          C.price
        )
      ) {
        C.dataSource.price =
          "STALE_LOCAL_CACHE";

        return {
          price:
            C.price,

          savedAt:
            C.priceAt,

          source:
            "STALE_LOCAL_CACHE"
        };
      }

      throw new Error(
        `Live price gagal dan cache price tidak tersedia. ` +
        `${priceError?.message || ""}`
      );
    }
  }

  /*
   * ============================================================
   * FIXED TRADE PLAN
   * ============================================================
   */

  async function getLockedTradePlan(
    signalKey
  ) {
    if (!signalKey) {
      return null;
    }

    try {
      const key =
        `xau_trade_plan:${signalKey}`;

      const raw =
        await redis.get(key);

      if (!raw) {
        return null;
      }

      if (typeof raw === "string") {
        return JSON.parse(raw);
      }

      return raw;

    } catch (e) {
      console.error(
        "Trade plan read error:",
        e
      );

      return null;
    }
  }

  async function saveLockedTradePlan(
    signalKey,
    plan
  ) {
    if (!signalKey || !plan) {
      return;
    }

    try {
      await redis.set(
        `xau_trade_plan:${signalKey}`,
        JSON.stringify(plan),
        {
          ex:
            CFG.tradeLockTTL
        }
      );

    } catch (e) {
      console.error(
        "Trade plan save error:",
        e
      );
    }
  }

  /*
   * ============================================================
   * MAIN
   * ============================================================
   */

  let m5;
  let m15;
  let h1;

  let livePrice;
  let candlePrice;

  let priceSource = "NONE";

  try {
    /*
     * ==========================================================
     * LOAD CANDLES
     * ==========================================================
     *
     * Setiap timeframe ada cache sendiri.
     */

    // Only ONE Twelve Data time_series call: fetch M5, then derive M15/H1 locally.
    // Shared Redis cache prevents dashboard and GitHub Actions from duplicating the fetch.
    m5 = await series(
      "5min",
      CFG.m5Size,
      "m5"
    );

    m15 = aggregateFromM5(m5, 15);
    h1 = aggregateFromM5(m5, 60);

    if (m15.length < CFG.minM15 || h1.length < CFG.minH1) {
      throw new Error(
        `M5 history tidak cukup untuk aggregate timeframe: M15=${m15.length}, H1=${h1.length}; ` +
        `perlu M15>=${CFG.minM15}, H1>=${CFG.minH1}.`
      );
    }

    const aggregateSavedAt = C.cacheAt.m5 || Date.now();
    C.dataSource.m15 = "SYNTHETIC_FROM_M5";
    C.dataSource.h1 = "SYNTHETIC_FROM_M5";
    C.cacheAt.m15 = aggregateSavedAt;
    C.cacheAt.h1 = aggregateSavedAt;

    /*
     * ==========================================================
     * LIVE PRICE
     * ==========================================================
     */

    const priceResult =
      await getLivePrice();

    livePrice =
      priceResult.price;

    priceSource =
      priceResult.source;

    candlePrice =
      m5.at(-1).close;

    const marketStatus = detectMarketStatus(
      m5,
      m15,
      h1,
      livePrice,
      priceResult.savedAt
    );

    const pushAllowed =
      backgroundPushRequestAuthorized &&
      marketStatus.allowPush;

    /*
     * ==========================================================
     * H1
     * ==========================================================
     */

    const c1 =
      h1.map(
        x => x.close
      );

    const h1EMA50 =
      ema(c1, 50);

    const h1EMA200 =
      ema(c1, 200);

    const h1EMA20 =
      ema(c1, 20);

    const h1RSI =
      rsi(c1);

    const h1MACD =
      macd(c1);

    const h1ATR =
      atr(h1);

    const h1Struct =
      structure(
        h1,
        20
      );

    let h1Direction =
      "WAIT";

    if (
      h1EMA50 != null &&
      h1EMA200 != null
    ) {
      if (
        livePrice >
          h1EMA200 &&
        h1EMA50 >
          h1EMA200
      ) {
        h1Direction =
          "BUY";

      } else if (
        livePrice <
          h1EMA200 &&
        h1EMA50 <
          h1EMA200
      ) {
        h1Direction =
          "SELL";
      }
    }

    // Display-only directional scores. These do not feed or modify the scalp engine.
    // Weighted heuristic: EMA alignment (20), price vs EMA200 (20), price vs EMA50 (15),
    // H1 structure (20), RSI momentum (10), and MACD momentum (15).
    let h1BuyScore = 0;
    let h1SellScore = 0;
    if (h1EMA50 != null && h1EMA200 != null) {
      if (h1EMA50 > h1EMA200) h1BuyScore += 20;
      else if (h1EMA50 < h1EMA200) h1SellScore += 20;
    }
    if (livePrice != null && h1EMA200 != null) {
      if (livePrice > h1EMA200) h1BuyScore += 20;
      else if (livePrice < h1EMA200) h1SellScore += 20;
    }
    if (livePrice != null && h1EMA50 != null) {
      if (livePrice > h1EMA50) h1BuyScore += 15;
      else if (livePrice < h1EMA50) h1SellScore += 15;
    }
    if (h1Struct?.bullish) h1BuyScore += 20;
    else if (h1Struct?.bearish) h1SellScore += 20;
    if (h1RSI != null) {
      if (h1RSI >= 55) h1BuyScore += 10;
      else if (h1RSI <= 45) h1SellScore += 10;
    }
    if (h1MACD?.bullish) h1BuyScore += 15;
    else if (h1MACD?.bearish) h1SellScore += 15;

    /*
     * H1 S/R
     *
     * S/R levels berasal daripada H1 candle.
     * Tetapi jarak / position menggunakan LIVE PRICE.
     */

    const h1SupportResistance =
      findH1SupportResistance(
        h1,
        livePrice,
        h1ATR
      );

    const breakoutWatch = detectSRBreakout(
      m5,
      h1SupportResistance.levels,
      livePrice,
      Boolean(marketStatus.allowNewSignal)
    );

    /*
     * ==========================================================
     * M15
     * ==========================================================
     */

    const c15 =
      m15.map(
        x => x.close
      );

    const m15EMA20 =
      ema(c15, 20);

    const m15EMA50 =
      ema(c15, 50);

    const m15RSI =
      rsi(c15);

    const m15MACD =
      macd(c15);

    const m15ATR =
      atr(m15);

    const m15Struct =
      structure(
        m15,
        20
      );

    const m15BOS =
      bos(
        m15,
        12
      );

    const m15BOSEvent = bosEvent(m15, 12);

    const m15CHOCH =
      choch(
        m15,
        10
      );

    const m15CHOCHEvent =
      chochEvent(
        m15,
        10
      );

    const m15Sweep =
      sweep(
        m15,
        12
      );

    const m15Mom =
      momentum(m15);

    let m15Buy = 0;
    let m15Sell = 0;

    const rb = [];
    const rs = [];

    if (
      m15EMA20 != null &&
      m15EMA50 != null
    ) {
      if (
        m15EMA20 >
        m15EMA50
      ) {
        m15Buy += 20;
        rb.push(
          "EMA20 > EMA50"
        );
      }

      if (
        m15EMA20 <
        m15EMA50
      ) {
        m15Sell += 20;
        rs.push(
          "EMA20 < EMA50"
        );
      }
    }

    if (
      m15EMA20 != null
    ) {
      if (
        livePrice >
        m15EMA20
      ) {
        m15Buy += 10;
        rb.push(
          "Price > EMA20"
        );
      }

      if (
        livePrice <
        m15EMA20
      ) {
        m15Sell += 10;
        rs.push(
          "Price < EMA20"
        );
      }
    }

    if (
      m15RSI != null
    ) {
      if (
        m15RSI >= 50 &&
        m15RSI <= 72
      ) {
        m15Buy += 10;
        rb.push(
          "RSI bullish"
        );
      }

      if (
        m15RSI >= 28 &&
        m15RSI < 50
      ) {
        m15Sell += 10;
        rs.push(
          "RSI bearish"
        );
      }
    }

    if (m15MACD?.bullish) {
      m15Buy += 15;
      rb.push(
        "MACD bullish"
      );
    }

    if (m15MACD?.bearish) {
      m15Sell += 15;
      rs.push(
        "MACD bearish"
      );
    }

    if (m15Struct.bullish) {
      m15Buy += 15;
      rb.push(
        "Structure bullish"
      );
    }

    if (m15Struct.bearish) {
      m15Sell += 15;
      rs.push(
        "Structure bearish"
      );
    }

    if (m15BOS.bullish) {
      m15Buy += 15;
      rb.push(
        "BOS bullish"
      );
    }

    if (m15BOS.bearish) {
      m15Sell += 15;
      rs.push(
        "BOS bearish"
      );
    }

    if (m15CHOCH.bullish) {
      m15Buy += 10;
      rb.push(
        "CHOCH bullish"
      );
    }

    if (m15CHOCH.bearish) {
      m15Sell += 10;
      rs.push(
        "CHOCH bearish"
      );
    }

    if (m15Sweep.bullish) {
      m15Buy += 10;
      rb.push(
        "Sell-side sweep"
      );
    }

    if (m15Sweep.bearish) {
      m15Sell += 10;
      rs.push(
        "Buy-side sweep"
      );
    }

    if (m15Mom.bullish) {
      m15Buy += 5;
      rb.push(
        "Momentum bullish"
      );
    }

    if (m15Mom.bearish) {
      m15Sell += 5;
      rs.push(
        "Momentum bearish"
      );
    }

    m15Buy =
      clamp(
        m15Buy,
        0,
        100
      );

    m15Sell =
      clamp(
        m15Sell,
        0,
        100
      );

    const m15BuyConfirmed =
      m15Buy >= 55 &&
      m15Buy >=
        m15Sell + 15;

    const m15SellConfirmed =
      m15Sell >= 55 &&
      m15Sell >=
        m15Buy + 15;

    const m15Confirmation =
      m15BuyConfirmed
        ? "BUY"
        : m15SellConfirmed
          ? "SELL"
          : "WAIT";

    /*
     * ==========================================================
     * M5
     * ==========================================================
     */

    const c5 =
      m5.map(
        x => x.close
      );

    const m5EMA9 =
      ema(c5, 9);

    const m5EMA20 =
      ema(c5, 20);

    const m5EMA50 =
      ema(c5, 50);

    const m5RSI =
      rsi(c5);

    const m5MACD =
      macd(c5);

    const m5ATR =
      atr(m5);

    const regimeM5 = regimeSnapshot(
      m5,
      m5ATR,
      CFG.regimeERLookbackM5
    );
    const regimeM15 = regimeSnapshot(
      m15,
      m15ATR,
      CFG.regimeERLookbackM15
    );
    const regimeH1 = regimeSnapshot(
      h1,
      h1ATR,
      CFG.regimeERLookbackH1
    );

    const regimeStructure =
      (regimeM15.efficiencyRatio ?? 0) >= CFG.regimeTrendER
        ? "TRENDING"
        : (regimeM15.efficiencyRatio ?? 0) <= CFG.regimeRangeER
          ? "RANGING"
          : "TRANSITION";

    const volatilityStates = [regimeM5.state, regimeM15.state].filter(x => x !== "UNKNOWN");
    const compositeVolatility =
      volatilityStates.includes("HIGH")
        ? "HIGH"
        : volatilityStates.includes("LOW") && volatilityStates.every(x => x === "LOW")
          ? "LOW"
          : "NORMAL";

    const marketRegime = {
      structure: regimeStructure,
      direction: h1Direction,
      volatility: {
        m5: regimeM5,
        m15: regimeM15,
        h1: regimeH1,
        composite: compositeVolatility
      },
      efficiencyRatio: {
        m5: regimeM5.efficiencyRatio,
        m15: regimeM15.efficiencyRatio,
        h1: regimeH1.efficiencyRatio
      },
      driver: "M15_ER + M5/M15_ATR_REGIME",
      role: "CONTEXT_AND_RISK",
      blocksScalpEntry: false
    };

    const regimeRiskMultiplier =
      compositeVolatility === "HIGH" ? 1.15
        : compositeVolatility === "LOW" ? 0.90
          : 1.00;

    /*
     * ==========================================================
     * M5
     * ==========================================================
     */
    const m5Struct = structure(
      m5,
      24
    );

    const m5BOS =
      bos(
        m5,
        10
      );

    const m5BOSEvent = bosEvent(m5, 10);

    const m5CHOCH =
      choch(
        m5,
        8
      );

    const m5CHOCHEvent =
      chochEvent(
        m5,
        8
      );

    const m5Sweep =
      sweep(
        m5,
        10
      );

    // Independent experimental models for manual dashboard review only.
    // These do not change the V18 production signal or push authorization.
    const experimentalModels = buildScalpModels({
      m5,
      m15,
      price: livePrice,
      m15Structure: m15Struct,
      m5ATR
    });

    // Stale/synthetic candle feeds must never produce actionable model candidates.
    // Keep the main production signal and push path governed by marketStatus too.
    if (marketStatus.reasons?.some(reason =>
      reason.endsWith("_CANDLE_STALE") ||
      reason === "FLAT_OR_SYNTHETIC_CANDLE_FEED"
    )) {
      for (const model of Object.values(experimentalModels.models || {})) {
        model.state = "DATA_STALE";
        model.setupFound = false;
        model.entryZone = null;
        model.invalidation = null;
        model.target = null;
        model.rr = null;
        model.validation = { valid: false, reason: "The M5 candle is stale or the feed appears synthetic." };
      }
      experimentalModels.dataQuality = {
        valid: false,
        reason: marketStatus.reasons.join(", "),
        latestM5Candle: marketStatus.latestCandle,
        latestM5CandleAgeMinutes: marketStatus.latestCandleAgeMinutes
      };
    } else {
      experimentalModels.dataQuality = {
        valid: true,
        latestM5Candle: marketStatus.latestCandle,
        latestM5CandleAgeMinutes: marketStatus.latestCandleAgeMinutes
      };
    }

    const m5Mom =
      momentum(m5);

    let m5Buy = 0;
    let m5Sell = 0;

    const r5b = [];
    const r5s = [];

    if (
      m5EMA20 != null &&
      m5EMA50 != null
    ) {
      if (
        m5EMA20 >
        m5EMA50
      ) {
        m5Buy += 20;
        r5b.push(
          "EMA20 > EMA50"
        );
      }

      if (
        m5EMA20 <
        m5EMA50
      ) {
        m5Sell += 20;
        r5s.push(
          "EMA20 < EMA50"
        );
      }
    }

    if (m5EMA9 != null) {
      if (
        livePrice >
        m5EMA9
      ) {
        m5Buy += 8;
        r5b.push(
          "Price > EMA9"
        );
      }

      if (
        livePrice <
        m5EMA9
      ) {
        m5Sell += 8;
        r5s.push(
          "Price < EMA9"
        );
      }
    }

    if (m5RSI != null) {
      if (
        m5RSI >= 50 &&
        m5RSI < 75
      ) {
        m5Buy += 10;
        r5b.push(
          "RSI bullish"
        );
      }

      if (
        m5RSI > 25 &&
        m5RSI < 50
      ) {
        m5Sell += 10;
        r5s.push(
          "RSI bearish"
        );
      }
    }

    if (m5MACD?.bullish) {
      m5Buy += 10;
      r5b.push(
        "MACD bullish"
      );
    }

    if (m5MACD?.bearish) {
      m5Sell += 10;
      r5s.push(
        "MACD bearish"
      );
    }

    if (m5Struct.bullish) {
      m5Buy += 12;
      r5b.push(
        "Structure bullish"
      );
    }

    if (m5Struct.bearish) {
      m5Sell += 12;
      r5s.push(
        "Structure bearish"
      );
    }

    if (m5BOS.bullish) {
      m5Buy += 15;
      r5b.push(
        "BOS bullish"
      );
    }

    if (m5BOS.bearish) {
      m5Sell += 15;
      r5s.push(
        "BOS bearish"
      );
    }

    if (m5CHOCH.bullish) {
      m5Buy += 12;
      r5b.push(
        "CHOCH bullish"
      );
    }

    if (m5CHOCH.bearish) {
      m5Sell += 12;
      r5s.push(
        "CHOCH bearish"
      );
    }

    if (m5Sweep.bullish) {
      m5Buy += 8;
      r5b.push(
        "Sell-side sweep"
      );
    }

    if (m5Sweep.bearish) {
      m5Sell += 8;
      r5s.push(
        "Buy-side sweep"
      );
    }

    if (m5Mom.bullish) {
      m5Buy += 5;
      r5b.push(
        "Momentum bullish"
      );
    }

    if (m5Mom.bearish) {
      m5Sell += 5;
      r5s.push(
        "Momentum bearish"
      );
    }

    m5Buy =
      clamp(
        m5Buy,
        0,
        100
      );

    m5Sell =
      clamp(
        m5Sell,
        0,
        100
      );

    const m5BuyTriggered =
      m5Buy >= 50 &&
      m5Buy >=
        m5Sell + 8;

    const m5SellTriggered =
      m5Sell >= 50 &&
      m5Sell >=
        m5Buy + 8;

    const m5Trigger =
      m5BuyTriggered
        ? "BUY"
        : m5SellTriggered
          ? "SELL"
          : "WAIT";

    /*
     * ==========================================================
     * ALIGNMENT
     * ==========================================================
     */

    const rawBuyAlignment =
      m15BuyConfirmed &&
      m5BuyTriggered;

    const rawSellAlignment =
      m15SellConfirmed &&
      m5SellTriggered;

    /*
     * ==========================================================
     * H1 DIRECTION / REVERSAL CONTEXT
     * ==========================================================
     */

    // S/R proximity is context and target information. It is not a mandatory
    // entry condition when H1 is neutral or agrees with M15+M5.

    const srBuyContext =
      h1SupportResistance.nearResistance
        ? "BUY_NEAR_RESISTANCE_CONTEXT"
        : h1SupportResistance.nearSupport
          ? "BUY_NEAR_SUPPORT_CONTEXT"
          : "NEUTRAL";

    const srSellContext =
      h1SupportResistance.nearSupport
        ? "SELL_NEAR_SUPPORT_CONTEXT"
        : h1SupportResistance.nearResistance
          ? "SELL_NEAR_RESISTANCE_CONTEXT"
          : "NEUTRAL";

    /*
     * ==========================================================
     * REVERSAL / CONTINUATION
     * ==========================================================
     */

    let buySetupType =
      "NONE";

    let sellSetupType =
      "NONE";

    const buyContinuation =
      rawBuyAlignment &&
      h1Direction ===
        "BUY";

    const sellContinuation =
      rawSellAlignment &&
      h1Direction ===
        "SELL";

    const buyReversal =
      rawBuyAlignment &&
      h1SupportResistance
        .reversalAtSupport &&
      h1Direction !==
        "BUY";

    const sellReversal =
      rawSellAlignment &&
      h1SupportResistance
        .reversalAtResistance &&
      h1Direction !==
        "SELL";

    // H1 is a hold/context filter, not a mandatory S/R-touch requirement.
    // Allow aligned M15+M5 signals when H1 is neutral or agrees; if H1 is
    // explicitly opposite, require a reversal at the corresponding strong zone.
    const buyH1Allowed = isH1DirectionAllowed("BUY", h1Direction, buyReversal);
    const sellH1Allowed = isH1DirectionAllowed("SELL", h1Direction, sellReversal);
    // Preserve response field names for dashboard compatibility; these now
    // describe H1 directional permission, not distance to an S/R zone.
    const srBuyAllowed = buyH1Allowed;
    const srSellAllowed = sellH1Allowed;

    if (buyContinuation) {
      buySetupType =
        "CONTINUATION";
    } else if (buyReversal) {
      buySetupType =
        "REVERSAL";
    } else if (rawBuyAlignment && h1Direction === "WAIT") {
      buySetupType = "H1_NEUTRAL_ALIGNMENT";
    } else if (rawBuyAlignment) {
      buySetupType = "COUNTER-TREND";
    }

    if (sellContinuation) {
      sellSetupType =
        "CONTINUATION";
    } else if (sellReversal) {
      sellSetupType =
        "REVERSAL";
    } else if (rawSellAlignment && h1Direction === "WAIT") {
      sellSetupType = "H1_NEUTRAL_ALIGNMENT";
    } else if (rawSellAlignment) {
      sellSetupType = "COUNTER-TREND";
    }

    /*
     * ==========================================================
     * H1 TARGET
     * ==========================================================
     */

    let targetSR = null;
    let targetSRType = null;
    let targetSRDistance = null;

    if (
      rawBuyAlignment &&
      h1SupportResistance
        .resistance
    ) {
      targetSR =
        h1SupportResistance
          .resistance.price;

      targetSRType =
        "H1 RESISTANCE";

      targetSRDistance =
        Number(
          (
            targetSR -
            livePrice
          ).toFixed(2)
        );
    }

    if (
      rawSellAlignment &&
      h1SupportResistance
        .support
    ) {
      targetSR =
        h1SupportResistance
          .support.price;

      targetSRType =
        "H1 SUPPORT";

      targetSRDistance =
        Number(
          (
            livePrice -
            targetSR
          ).toFixed(2)
        );
    }

    // Preserve the nearest H1 level in the trade direction before trade-plan
    // selection may replace targetSR with a nearer M5/M15 target.
    const h1ContextTargetSR = targetSR;

    /*
     * ==========================================================
     * ROADBLOCKS
     * ==========================================================
     */

    const buyM15Roadblocks =
      targetSR != null &&
      rawBuyAlignment
        ? findRoadblocks(
            m15,
            livePrice,
            targetSR,
            "BUY TARGET",
            "M15",
            m15ATR
          )
        : {
            timeframe: "M15",
            target: targetSR,
            targetType: "BUY TARGET",
            roadblocks: [],
            nearest: null,
            count: 0,
            hasRoadblock: false,
            status: "NONE"
          };

    const buyM5Roadblocks =
      targetSR != null &&
      rawBuyAlignment
        ? findRoadblocks(
            m5,
            livePrice,
            targetSR,
            "BUY TARGET",
            "M5",
            m5ATR
          )
        : {
            timeframe: "M5",
            target: targetSR,
            targetType: "BUY TARGET",
            roadblocks: [],
            nearest: null,
            count: 0,
            hasRoadblock: false,
            status: "NONE"
          };

    const sellM15Roadblocks =
      targetSR != null &&
      rawSellAlignment
        ? findRoadblocks(
            m15,
            livePrice,
            targetSR,
            "SELL TARGET",
            "M15",
            m15ATR
          )
        : {
            timeframe: "M15",
            target: targetSR,
            targetType: "SELL TARGET",
            roadblocks: [],
            nearest: null,
            count: 0,
            hasRoadblock: false,
            status: "NONE"
          };

    const sellM5Roadblocks =
      targetSR != null &&
      rawSellAlignment
        ? findRoadblocks(
            m5,
            livePrice,
            targetSR,
            "SELL TARGET",
            "M5",
            m5ATR
          )
        : {
            timeframe: "M5",
            target: targetSR,
            targetType: "SELL TARGET",
            roadblocks: [],
            nearest: null,
            count: 0,
            hasRoadblock: false,
            status: "NONE"
          };

    /*
     * Gabungkan roadblock ikut signal
     */

    const activeRoadblocks =
      rawBuyAlignment
        ? [
            ...buyM5Roadblocks.roadblocks.map(
              x => ({
                ...x,
                timeframe: "M5"
              })
            ),

            ...buyM15Roadblocks.roadblocks.map(
              x => ({
                ...x,
                timeframe: "M15"
              })
            )
          ]
        : rawSellAlignment
          ? [
              ...sellM5Roadblocks.roadblocks.map(
                x => ({
                  ...x,
                  timeframe: "M5"
                })
              ),

              ...sellM15Roadblocks.roadblocks.map(
                x => ({
                  ...x,
                  timeframe: "M15"
                })
              )
            ]
          : [];

    activeRoadblocks.sort(
      (a, b) =>
        a.distance - b.distance
    );

    const directionalM5Targets = rawBuyAlignment
      ? findDirectionalTargets(m5, livePrice, "BUY", "M5", m5ATR, CFG.roadblockLookbackM5)
      : rawSellAlignment
        ? findDirectionalTargets(m5, livePrice, "SELL", "M5", m5ATR, CFG.roadblockLookbackM5)
        : [];

    const directionalM15Targets = rawBuyAlignment
      ? findDirectionalTargets(m15, livePrice, "BUY", "M15", m15ATR, CFG.roadblockLookbackM15)
      : rawSellAlignment
        ? findDirectionalTargets(m15, livePrice, "SELL", "M15", m15ATR, CFG.roadblockLookbackM15)
        : [];

    const directionalH1Targets = rawBuyAlignment
      ? findDirectionalTargets(h1, livePrice, "BUY", "H1", h1ATR, CFG.srLookback)
      : rawSellAlignment
        ? findDirectionalTargets(h1, livePrice, "SELL", "H1", h1ATR, CFG.srLookback)
        : [];

    const nearestRoadblock =
      activeRoadblocks[0] ||
      null;

    /*
     * ==========================================================
     * FINAL SIGNAL
     * ==========================================================
     */

    function buildPhase2LiveSetup(m5Candles, m15Candles, h1Candles, quote, atrValue) {
      const out = {
        engine: "PHASE2_SMC_LIVE_V2",
        state: "WAIT",
        signal: "WAIT",
        reason: "No complete H1-context / M15 Sweep -> CHOCH -> BOS -> FVG / M5 retracement setup on closed candles.",
        setup: null
      };
      if (!Array.isArray(m5Candles) || !Array.isArray(m15Candles) || !Array.isArray(h1Candles) ||
          m5Candles.length < 40 || m15Candles.length < 30 || h1Candles.length < 12 || !Number.isFinite(Number(quote))) {
        return { ...out, reason: "Insufficient closed M5/M15/H1 candles or live price." };
      }
      // aggregateFromM5() returns only fully closed M15/H1 buckets. The latest M5
      // candle is filtered by closedCandles() upstream; still require its timestamp to be old enough.
      const m5 = m5Candles.slice(-120), m15 = m15Candles.slice(-100), h1 = h1Candles.slice(-24);
      const last5 = m5.at(-1), last15 = m15.at(-1), lastH1 = h1.at(-1);
      const timeMs = c => candleTimestampMs(c?.time);
      if (!Number.isFinite(timeMs(last5)) || Date.now() - timeMs(last5) < 4 * 60_000 ||
          !Number.isFinite(timeMs(last15)) || !Number.isFinite(timeMs(lastH1))) {
        return { ...out, reason: "Latest candle timestamps are invalid or latest M5 candle may still be open." };
      }
      const utcHour = new Date(timeMs(last15) + 15 * 60_000).getUTCHours();
      if (!((utcHour >= 7 && utcHour < 11) || (utcHour >= 13 && utcHour < 17))) {
        return { ...out, reason: `Outside configured UTC sessions (07:00-11:00, 13:00-17:00); latest M15 close hour=${utcHour}.` };
      }
      const atr = Number.isFinite(atrValue) && atrValue > 0 ? atrValue : Math.max(last5.high - last5.low, 0.5);
      const buffer = Math.max(0.15, atr * 0.15), price = Number(Number(quote).toFixed(2));
      const h1Window = h1.slice(-8, -1); // closed H1 bars preceding the latest closed H1 bar
      const h1PriorHigh = h1Window.length ? Math.max(...h1Window.map(x => x.high)) : NaN;
      const h1PriorLow = h1Window.length ? Math.min(...h1Window.map(x => x.low)) : NaN;
      const h1SweepBuy = Number.isFinite(h1PriorLow) && lastH1.low < h1PriorLow && lastH1.close > h1PriorLow;
      const h1SweepSell = Number.isFinite(h1PriorHigh) && lastH1.high > h1PriorHigh && lastH1.close < h1PriorHigh;
      const h1RecentBuy = h1SweepBuy || h1.slice(-4).some((c, idx, arr) => {
        const globalIndex = h1.length - arr.length + idx;
        if (globalIndex < 8) return false;
        const prior = h1.slice(globalIndex - 8, globalIndex);
        const lo = Math.min(...prior.map(x => x.low));
        return c.low < lo && c.close > lo;
      });
      const h1RecentSell = h1SweepSell || h1.slice(-4).some((c, idx, arr) => {
        const globalIndex = h1.length - arr.length + idx;
        if (globalIndex < 8) return false;
        const prior = h1.slice(globalIndex - 8, globalIndex);
        const hi = Math.max(...prior.map(x => x.high));
        return c.high > hi && c.close < hi;
      });

      // Search recent completed M15 candles for the newest valid setup sequence.
      const first = Math.max(12, m15.length - 36);
      for (let i = m15.length - 1; i >= first; i--) {
        const sweep = m15[i];
        const prior = m15.slice(Math.max(0, i - 12), i);
        if (prior.length < 12) continue;
        const priorHigh = Math.max(...prior.map(x => x.high));
        const priorLow = Math.min(...prior.map(x => x.low));
        const sides = [];
        if (sweep.low < priorLow && sweep.close > priorLow && h1RecentBuy) sides.push({ direction: "BUY", extreme: sweep.low, chochLevel: Math.max(...m15.slice(Math.max(0, i - 5), i).map(x => x.high)) });
        if (sweep.high > priorHigh && sweep.close < priorHigh && h1RecentSell) sides.push({ direction: "SELL", extreme: sweep.high, chochLevel: Math.min(...m15.slice(Math.max(0, i - 5), i).map(x => x.low)) });
        for (const side of sides) {
          const buy = side.direction === "BUY";
          let chochIndex = -1;
          for (let j = i + 1; j <= Math.min(i + 16, m15.length - 3); j++) {
            if (buy ? m15[j].close > side.chochLevel : m15[j].close < side.chochLevel) { chochIndex = j; break; }
          }
          if (chochIndex < 0) continue;
          let bosIndex = -1;
          for (let k = chochIndex + 1; k <= Math.min(chochIndex + 4, m15.length - 1); k++) {
            // Match backtest: break the prior five-bar structure, excluding current bar.
            const local = m15.slice(Math.max(0, k - 5), k);
            if (local.length < 5) continue;
            const level = buy ? Math.max(...local.map(x => x.high)) : Math.min(...local.map(x => x.low));
            if (buy ? m15[k].close > level : m15[k].close < level) { bosIndex = k; break; }
          }
          if (bosIndex < 0) continue;
          // Match backtest FVG filters; FVG may form on the BOS candle itself.
          for (let f = bosIndex; f <= Math.min(bosIndex + 4, m15.length - 1); f++) {
            const a = m15[f - 2], impulse = m15[f - 1], c = m15[f];
            if (!a || !impulse || !c) continue;
            let zoneLow, zoneHigh, validFvg = false;
            if (buy && a.high < c.low && (c.low - a.high) >= 0.20 && impulse.close > impulse.open &&
                Math.abs(impulse.close - impulse.open) >= (impulse.high - impulse.low) * 0.55) {
              zoneLow = a.high; zoneHigh = c.low; validFvg = true;
            }
            if (!buy && a.low > c.high && (a.low - c.high) >= 0.20 && impulse.close < impulse.open &&
                Math.abs(impulse.close - impulse.open) >= (impulse.high - impulse.low) * 0.55) {
              zoneLow = c.high; zoneHigh = a.low; validFvg = true;
            }
            if (!validFvg || !(zoneHigh > zoneLow) || zoneHigh - zoneLow > atr * 1.5) continue;
            // Match backtest premium/discount filter using prior 40 M15 bars.
            const rangeBars = m15.slice(Math.max(0, f - 40), f);
            if (rangeBars.length < 40) continue;
            const rangeHigh = Math.max(...rangeBars.map(x => x.high));
            const rangeLow = Math.min(...rangeBars.map(x => x.low));
            const rangeMid = (rangeHigh + rangeLow) / 2;
            const zoneMid = (zoneLow + zoneHigh) / 2;
            if ((buy && zoneMid >= rangeMid) || (!buy && zoneMid <= rangeMid)) continue;
            if (m15.slice(f + 1).some(x => buy ? x.low < zoneLow : x.high > zoneHigh)) continue;
            const fvgAge = m15.length - 1 - f;
            if (fvgAge < 1 || fvgAge > 8) continue;
            const lastM5 = m5.at(-1);
            const touched = lastM5.low <= zoneHigh && lastM5.high >= zoneLow;
            if (!touched || !(price >= zoneLow - buffer && price <= zoneHigh + buffer)) continue;
            const stopLoss = Number((buy ? side.extreme - buffer : side.extreme + buffer).toFixed(2));
            const risk = Math.abs(price - stopLoss);
            if (!(risk > 0) || (buy ? stopLoss >= price : stopLoss <= price)) continue;
            const target = Number((buy ? price + risk * 1.5 : price - risk * 1.5).toFixed(2));
            return {
              engine: "PHASE2_SMC_LIVE_V2", state: "ENTRY_READY", signal: side.direction,
              reason: `Confirmed ${side.direction}: H1 liquidity-sweep context, M15 sweep -> CHOCH -> BOS -> FVG, and closed-M5 retracement confirmation.`,
              setup: { direction: side.direction, h1Context: buy ? "H1_SWEEP_LOW" : "H1_SWEEP_HIGH",
                sweepTime: sweep.time, chochTime: m15[chochIndex].time, bosTime: m15[bosIndex].time,
                fvgTime: c.time, entryZone: { low: Number(zoneLow.toFixed(2)), high: Number(zoneHigh.toFixed(2)) },
                entry: price, stopLoss, target, risk, rr: 1.5, signalCandle: lastM5.time,
                setupTimeframe: "M15", confirmationTimeframe: "M5", contextTimeframe: "H1", sessionUTC: utcHour }
            };
          }
        }
      }
      return { ...out, reason: "No complete H1 sweep context + M15 Sweep/CHOCH/BOS/FVG sequence with a confirmed M5 retest." };
    }
    const phase2LiveSignal = buildPhase2LiveSetup(m5, m15, h1, livePrice, m5ATR);

    let signal =
      "WAIT";

    let status =
      "WAIT";

    let execution =
      "WAIT";

    let setupType =
      "NO ALIGNMENT";

    let score =
      Math.round(
        Math.max(
          m15Buy,
          m15Sell,
          m5Buy,
          m5Sell
        )
      );

    let reasons = [];

    /*
     * BUY
     */

    if (
      rawBuyAlignment &&
      buyH1Allowed
    ) {
      signal =
        "BUY";

      status =
        "ENTRY";

      execution =
        "READY";

      setupType =
        buySetupType;

      score =
        Math.round(
          (
            m15Buy +
            m5Buy
          ) / 2
        );

      reasons = [
        "M15 BUY confirmed",
        "M5 BUY trigger confirmed",
        "M15 + M5 aligned",
        `SETUP: ${buySetupType}`,
        `H1 S/R: ${h1SupportResistance.position}`,

        h1SupportResistance
          .reversalAtSupport
          ? "Price located at/near H1 support"
          : "H1 support/resistance location valid"
      ];

      if (targetSR != null) {
        reasons.push(
          `${targetSRType} target ${targetSR}`
        );
      }

      /*
       * Roadblock warning sahaja.
       */

      if (nearestRoadblock) {
        reasons.push(
          `ROADBLOCK ${nearestRoadblock.timeframe} ${nearestRoadblock.price}`
        );
      }
    }

    /*
     * SELL
     */

    else if (
      rawSellAlignment &&
      sellH1Allowed
    ) {
      signal =
        "SELL";

      status =
        "ENTRY";

      execution =
        "READY";

      setupType =
        sellSetupType;

      score =
        Math.round(
          (
            m15Sell +
            m5Sell
          ) / 2
        );

      reasons = [
        "M15 SELL confirmed",
        "M5 SELL trigger confirmed",
        "M15 + M5 aligned",
        `SETUP: ${sellSetupType}`,
        `H1 S/R: ${h1SupportResistance.position}`,

        h1SupportResistance
          .reversalAtResistance
          ? "Price located at/near H1 resistance"
          : "H1 support/resistance location valid"
      ];

      if (targetSR != null) {
        reasons.push(
          `${targetSRType} target ${targetSR}`
        );
      }

      if (nearestRoadblock) {
        reasons.push(
          `ROADBLOCK ${nearestRoadblock.timeframe} ${nearestRoadblock.price}`
        );
      }
    }

    /* H1 opposition blocks an aligned setup unless a strong-zone reversal is confirmed. */

    if (signal === "BUY" && h1SupportResistance.nearResistance) {
      reasons.push("H1 resistance nearby — manage TP/hold, not an entry block");
    }

    if (signal === "SELL" && h1SupportResistance.nearSupport) {
      reasons.push("H1 support nearby — manage TP/hold, not an entry block");
    }

    /*
     * WAIT diagnostics only.
     * Keep these branches separate from the BUY/SELL success path so a
     * valid signal's reasons cannot be accidentally overwritten by an
     * `else if` attached to the H1 support warning above.
     */
    if (signal === "WAIT") {
      if (m15BuyConfirmed && m5SellTriggered) {
        reasons = ["Timeframe conflict: M15 BUY but M5 SELL"];
      } else if (m15SellConfirmed && m5BuyTriggered) {
        reasons = ["Timeframe conflict: M15 SELL but M5 BUY"];
      } else {
        reasons = [];
        if (!m15SellConfirmed && !m15BuyConfirmed) {
          reasons.push("M15 has not confirmed the BUY/SELL direction");
        }
        if (!m5SellTriggered && !m5BuyTriggered) {
          reasons.push("M5 has not confirmed the entry trigger");
        }
        if (m15SellConfirmed && !m5SellTriggered) {
          reasons.push("M15 SELL confirmed; waiting for the M5 SELL trigger");
        }
        if (m5SellTriggered && !m15SellConfirmed) {
          reasons.push("M5 SELL trigger detected; waiting for M15 SELL confirmation");
        }
        if (m15BuyConfirmed && !m5BuyTriggered) {
          reasons.push("M15 BUY confirmed; waiting for the M5 BUY trigger");
        }
        if (m5BuyTriggered && !m15BuyConfirmed) {
          reasons.push("M5 BUY trigger detected; waiting for M15 BUY confirmation");
        }
        if (rawSellAlignment && !sellH1Allowed) {
          reasons.push("SELL alignment conflicts with H1 BUY bias; a confirmed reversal at strong H1 resistance is required");
        }
        if (rawBuyAlignment && !buyH1Allowed) {
          reasons.push("BUY alignment conflicts with H1 SELL bias; a confirmed reversal at strong H1 support is required");
        }
        if (!reasons.length) reasons.push("Entry conditions are incomplete; check the score and timeframe status");
      }
    }

    // Phase 2 SMC is the sole authorizer for live BUY/SELL entries.
    if (phase2LiveSignal.signal === "BUY" && buyH1Allowed) {
      signal = "BUY"; status = "ENTRY"; execution = "READY"; setupType = "PHASE2_SMC_SWEEP_CHOCH_BOS_FVG_RETRACE"; score = 90;
      reasons = [phase2LiveSignal.reason, `H1 context: ${h1Direction}`, `FVG zone ${phase2LiveSignal.setup.entryZone.low}-${phase2LiveSignal.setup.entryZone.high}`, "Stop uses sweep extreme; targets use 1.5R/2.5R/3.5R"];
    } else if (phase2LiveSignal.signal === "SELL" && sellH1Allowed) {
      signal = "SELL"; status = "ENTRY"; execution = "READY"; setupType = "PHASE2_SMC_SWEEP_CHOCH_BOS_FVG_RETRACE"; score = 90;
      reasons = [phase2LiveSignal.reason, `H1 context: ${h1Direction}`, `FVG zone ${phase2LiveSignal.setup.entryZone.low}-${phase2LiveSignal.setup.entryZone.high}`, "Stop uses sweep extreme; targets use 1.5R/2.5R/3.5R"];
    } else {
      signal = "WAIT"; status = "WAIT"; execution = "WAIT"; setupType = phase2LiveSignal.signal !== "WAIT" ? "PHASE2_BLOCKED_BY_H1_CONTEXT" : "PHASE2_SETUP_INCOMPLETE"; score = 0;
      reasons = [phase2LiveSignal.signal !== "WAIT" ? `${phase2LiveSignal.signal} SMC sequence detected but blocked by H1 context.` : phase2LiveSignal.reason];
    }

    /*
     * MARKET CLOSED GUARD
     * Never emit a new scalp entry or background event from
     * weekend/stale/synthetic candle data. Existing H1 context
     * is still returned for inspection, but it is not tradable.
     */
    if (signal === "WAIT" && breakoutWatch.state === "BREAKOUT_DETECTED") {
      reasons.unshift(`${breakoutWatch.direction} M5 breakout detected at ${Number(breakoutWatch.level).toFixed(2)}; entry confirmation is still required`);
    }

    if (!marketStatus.allowNewSignal) {
      signal = "WAIT";
      score = 0;
      const dataQualityBlocked = marketStatus.reasons?.some(reason =>
        reason.endsWith("_CANDLE_STALE") ||
        reason === "FLAT_OR_SYNTHETIC_CANDLE_FEED" ||
        reason === "LIVE_PRICE_STALE_OR_UNAVAILABLE"
      );
      // Do not label stale/malformed feed as an actual market closure.
      status = dataQualityBlocked ? "DATA_STALE" : "MARKET_CLOSED";
      execution = dataQualityBlocked ? "DATA_STALE" : "MARKET_CLOSED";
      setupType = dataQualityBlocked ? "DATA_STALE" : "MARKET_CLOSED";
      reasons = [
        dataQualityBlocked ? "Candle data is stale or the feed is not tradable" : "Market closed",
        ...marketStatus.reasons
      ];
    }

    /*
     * ==========================================================
     * H1 HOLD
     * ==========================================================
     */

    // Human-readable stage is separate from the production BUY/SELL signal.
    // A detected breakout/setup never bypasses the existing confirmation guard.
    let signalStage = { state: "WAIT", direction: "WAIT", message: "No sufficiently aligned setup to monitor yet" };
    if (signal === "BUY" || signal === "SELL") {
      signalStage = { state: "ENTRY_READY", direction: signal, message: `${signal} ENTRY READY — engine confirmation is complete; review the trade plan before acting` };
    } else if (!marketStatus.allowNewSignal) {
      signalStage = { state: "DATA_BLOCKED", direction: "WAIT", message: "Entry blocked because data or market conditions are not tradable" };
    } else if (m15BuyConfirmed && m5SellTriggered || m15SellConfirmed && m5BuyTriggered) {
      signalStage = { state: "TIMEFRAME_CONFLICT", direction: "WAIT", message: "M15 and M5 conflict; waiting for alignment" };
    } else if (breakoutWatch.state === "BREAKOUT_DETECTED") {
      signalStage = { state: `${breakoutWatch.direction}_SETUP`, direction: breakoutWatch.direction, message: `${breakoutWatch.direction} SETUP — breakout detected; entry confirmation is incomplete` };
    } else if (m15SellConfirmed || m5SellTriggered) {
      signalStage = { state: "SELL_SETUP", direction: "SELL", message: "SELL SETUP — partial confirmation available; waiting for complete entry conditions" };
    } else if (m15BuyConfirmed || m5BuyTriggered) {
      signalStage = { state: "BUY_SETUP", direction: "BUY", message: "BUY SETUP — partial confirmation available; waiting for complete entry conditions" };
    }

    const holdBias =
      h1Direction === "BUY"
        ? "BUY"
        : h1Direction === "SELL"
          ? "SELL"
          : "NEUTRAL";

    const holdPermission =
      signal === "BUY" &&
      h1Direction === "BUY"

        ? "HOLD BUY"

        : signal === "SELL" &&
          h1Direction === "SELL"

          ? "HOLD SELL"

          : signal !== "WAIT"

            ? "SCALP ONLY"

            : "NO HOLD";

    const context =
      (
        signal === "BUY" &&
        h1Direction === "BUY"
      ) ||
      (
        signal === "SELL" &&
        h1Direction === "SELL"
      )

        ? "WITH_H1"

        : signal === "WAIT"

          ? "NEUTRAL"

          : "COUNTER_H1";

    /*
     * ==========================================================
     * SIGNAL KEY
     * ==========================================================
     */

    const signalCandle =
      m5.at(-1)?.time ||
      new Date().toISOString();

    let signalKey =
      signal !== "WAIT"
        ? `XAUUSD|PHASE2|${signal}|${signalCandle}`
        : null;

    /*
     * ==========================================================
     * FIXED TRADE PLAN
     * ==========================================================
     */

    let entry = null;
    let stopLoss = null;
    let tp1 = null;
    let tp2 = null;
    let tp3 = null;
    let rr = null;

    let tradePlanLocked =
      false;

    let tradePlanSource =
      "NONE";

    let risk = null;

    let targetSRValid =
      false;

    let targetMeta =
      null;

    /*
     * Existing locked plan
     */

    if (signalKey) {
      const locked =
        await getLockedTradePlan(
          signalKey
        );

      if (locked) {
        entry =
          locked.entry;

        stopLoss =
          locked.stopLoss;

        tp1 =
          locked.tp1;

        tp2 =
          locked.tp2;

        tp3 =
          locked.tp3;

        rr =
          locked.rr;

        risk =
          locked.risk ??
          null;

        targetSR =
          locked.targetSR ??
          targetSR;

        targetSRType =
          locked.targetSRType ??
          targetSRType;

        targetSRDistance =
          locked.targetSRDistance ??
          targetSRDistance;

        targetSRValid =
          locked.targetSRValid ??
          false;

        targetMeta =
          locked.targetMeta ??
          null;

        tradePlanLocked =
          true;

        tradePlanSource =
          "REDIS_LOCK";
      }
    }

    /*
     * ==========================================================
     * VALIDATE TARGET
     * ==========================================================
     */

    let candidateEntry =
      Number(
        livePrice.toFixed(2)
      );

    let candidateRisk =
      m5ATR != null
        ? Math.max(
            m5ATR * 1.25 * regimeRiskMultiplier,
            0.8
          )
        : null;

    if (
      candidateRisk != null &&
      targetSR != null
    ) {
      if (signal === "BUY") {
        targetSRValid =
          (
            targetSR -
            candidateEntry
          ) >=
          candidateRisk *
            CFG.minTargetR;
      }

      if (signal === "SELL") {
        targetSRValid =
          (
            candidateEntry -
            targetSR
          ) >=
          candidateRisk *
            CFG.minTargetR;
      }
    }

    /*
     * S/R never blocks a valid scalp.
     * Target quality is handled inside the trade-plan selector.
     */

    /*
     * ==========================================================
     * CREATE FIXED PLAN
     * ==========================================================
     */

    if (
      status === "ENTRY" &&
      execution === "READY" &&
      m5ATR != null &&
      signalKey &&
      !tradePlanLocked &&
      !(phase2LiveSignal.setup && phase2LiveSignal.signal === signal)
    ) {
      entry = candidateEntry;

      /*
       * Structure-aware stop:
       * use the latest closed M5 candle extreme plus an ATR buffer.
       * This is more meaningful for a scalp than a fixed ATR-only SL.
       */
      const triggerCandle = m5.at(-1);
      const slBuffer = Math.max(
        0.10,
        m5ATR * (compositeVolatility === "HIGH" ? 0.20 : compositeVolatility === "LOW" ? 0.12 : 0.15)
      );

      if (signal === "BUY") {
        stopLoss = Number(
          (Math.min(triggerCandle?.low ?? entry - m5ATR, entry - 0.8) - slBuffer).toFixed(2)
        );
      } else {
        stopLoss = Number(
          (Math.max(triggerCandle?.high ?? entry + m5ATR, entry + 0.8) + slBuffer).toFixed(2)
        );
      }

      risk = Math.abs(entry - stopLoss);

      const minR = CFG.minTargetR;
      // Small rounding buffers keep the displayed TP1 at or above the
      // configured minimum R after prices are rounded to two decimals.
      const fallbackR =
        regimeStructure === "TRENDING"
          ? [Math.max(1.6, CFG.minTargetR), 3.0, 5.0]
          : regimeStructure === "RANGING"
            ? [Math.max(1.6, CFG.minTargetR), 2.25, 3.0]
            : [Math.max(1.6, CFG.minTargetR), 2.5, 4.0];

      const targetPool = [
        ...directionalM5Targets.map(x => ({ ...x, source: "M5_S/R" })),
        ...directionalM15Targets.map(x => ({ ...x, source: "M15_S/R" })),
        ...directionalH1Targets.map(x => ({ ...x, source: "H1_S/R" }))
      ]
        .filter(x => Number.isFinite(x.price))
        .sort((a, b) => {
          const da = Math.abs(a.price - entry);
          const db = Math.abs(b.price - entry);
          return da - db;
        });

      const dedupedTargets = [];
      for (const candidate of targetPool) {
        const duplicate = dedupedTargets.find(x => Math.abs(x.price - candidate.price) <= Math.max(0.5, m5ATR * 0.12));
        if (!duplicate) dedupedTargets.push(candidate);
        else if ((candidate.score || 0) > (duplicate.score || 0)) Object.assign(duplicate, candidate);
      }

      const targetForR = (level) =>
        level ? Math.abs(level.price - entry) / risk : 0;

      const validTargets = dedupedTargets.filter(level => targetForR(level) >= minR);

      const pickTarget = (minRequiredR, afterPrice = null) => {
        return validTargets.find(level => {
          const r = targetForR(level);
          const after = afterPrice == null
            ? true
            : signal === "BUY"
              ? level.price > afterPrice + Math.max(0.5, m5ATR * 0.12)
              : level.price < afterPrice - Math.max(0.5, m5ATR * 0.12);
          return r >= minRequiredR && after;
        }) || null;
      };

      const tp1Level = pickTarget(minR);
      const tp1R = tp1Level ? targetForR(tp1Level) : fallbackR[0];
      const tp1Price = tp1Level
        ? tp1Level.price
        : signal === "BUY"
          ? entry + risk * fallbackR[0]
          : entry - risk * fallbackR[0];

      const tp2Level = pickTarget(Math.max(2.5, tp1R + 0.5), tp1Price);
      const tp2Price = tp2Level
        ? tp2Level.price
        : signal === "BUY"
          ? entry + risk * fallbackR[1]
          : entry - risk * fallbackR[1];

      const tp3Level = pickTarget(Math.max(4.0, targetForR(tp2Level) + 0.5), tp2Price);
      const tp3Price = tp3Level
        ? tp3Level.price
        : signal === "BUY"
          ? entry + risk * fallbackR[2]
          : entry - risk * fallbackR[2];

      tp1 = Number(tp1Price.toFixed(2));
      tp2 = Number(tp2Price.toFixed(2));
      tp3 = Number(tp3Price.toFixed(2));

      /*
       * Keep targets strictly monotonic. A higher-timeframe level
       * can never make TP2/TP3 go backwards through TP1.
       */
      if (signal === "BUY") {
        tp2 = Math.max(tp2, Number((tp1 + risk * 0.25).toFixed(2)));
        tp3 = Math.max(tp3, Number((tp2 + risk * 0.25).toFixed(2)));
      } else {
        tp2 = Math.min(tp2, Number((tp1 - risk * 0.25).toFixed(2)));
        tp3 = Math.min(tp3, Number((tp2 - risk * 0.25).toFixed(2)));
      }

      const tp1ActualR = Math.abs(tp1 - entry) / risk;
      const tp2ActualR = Math.abs(tp2 - entry) / risk;
      const tp3ActualR = Math.abs(tp3 - entry) / risk;

      rr = `1 : ${tp1ActualR.toFixed(2)} / ${tp2ActualR.toFixed(2)} / ${tp3ActualR.toFixed(2)}`;

      const primaryTarget = tp1Level || null;
      if (primaryTarget) {
        targetSR = primaryTarget.price;
        targetSRType = primaryTarget.source;
        targetSRDistance = Number(Math.abs(primaryTarget.price - entry).toFixed(2));
        targetSRValid = tp1ActualR >= minR;
      } else {
        targetSR = tp1;
        targetSRType = "R-MULTIPLE FALLBACK";
        targetSRDistance = Number(Math.abs(tp1 - entry).toFixed(2));
        targetSRValid = true;
      }

      targetMeta = {
        tp1: tp1Level,
        tp2: tp2Level,
        tp3: tp3Level
      };

      const newPlan = {
        entry,
        stopLoss,
        tp1,
        tp2,
        tp3,
        rr,
        risk,
        signal,
        signalKey,
        signalCandle,
        setupType,
        targetSR,
        targetSRType,
        targetSRDistance,
        targetSRValid,
        targetMeta,
        createdAt: new Date().toISOString(),
        planVersion: "SR-V3-REGIME-FINAL"
      };

      await saveLockedTradePlan(signalKey, newPlan);
      tradePlanLocked = true;
      tradePlanSource = "NEW_REDIS_LOCK";
    }

    // Apply Phase 2's sweep-extreme stop and R-multiple targets. Preserve an existing locked plan for this candle.
    if (signal !== "WAIT" && phase2LiveSignal.setup && phase2LiveSignal.signal === signal && !tradePlanLocked) {
      entry = Number(livePrice.toFixed(2)); stopLoss = phase2LiveSignal.setup.stopLoss; risk = Math.abs(entry - stopLoss);
      if (risk > 0) {
        tp1 = Number((signal === "BUY" ? entry + risk * 1.5 : entry - risk * 1.5).toFixed(2));
        tp2 = Number((signal === "BUY" ? entry + risk * 2.5 : entry - risk * 2.5).toFixed(2));
        tp3 = Number((signal === "BUY" ? entry + risk * 3.5 : entry - risk * 3.5).toFixed(2));
        rr = "1 : 1.50 / 2.50 / 3.50"; targetSR = tp1; targetSRType = "PHASE2_SMC_R_MULTIPLE";
        targetSRDistance = Number(Math.abs(tp1 - entry).toFixed(2)); targetSRValid = true;
        targetMeta = { method: "PHASE2_SMC_SWEEP_EXTREME", rr: [1.5, 2.5, 3.5], fvg: phase2LiveSignal.setup.entryZone };
        await saveLockedTradePlan(signalKey, { entry, stopLoss, tp1, tp2, tp3, rr, risk, signal, signalKey, signalCandle, setupType,
          targetSR, targetSRType, targetSRDistance, targetSRValid, targetMeta, createdAt: new Date().toISOString(), planVersion: "PHASE2-SMC-LIVE-V1" });
        tradePlanLocked = true; tradePlanSource = "PHASE2_SMC";
      }
    }

    // Never expose or notify ENTRY READY when its fixed plan is missing,
    // malformed, on the wrong side, or below the minimum reward/risk.
    const crossesH1Obstacle = h1ContextTargetSR != null && Number.isFinite(Number(h1ContextTargetSR)) &&
      (signal === "BUY"
        ? Number(tp1) > Number(h1ContextTargetSR) + 0.02
        : signal === "SELL"
          ? Number(tp1) < Number(h1ContextTargetSR) - 0.02
          : false);

    if (signal !== "WAIT" && (!isTradePlanValid({
      signal, entry, stopLoss, tp1, tp2, tp3, minR: CFG.minTargetR
    }) || crossesH1Obstacle)) {
      if (signalKey) {
        try { await redis.del(`xau_trade_plan:${signalKey}`); } catch {}
      }
      signal = "WAIT";
      status = "WAIT";
      execution = "WAIT";
      setupType = "INVALID TRADE PLAN";
      signalKey = null;
      entry = null;
      stopLoss = null;
      tp1 = null;
      tp2 = null;
      tp3 = null;
      rr = null;
      risk = null;
      targetSRValid = false;
      targetMeta = null;
      tradePlanLocked = false;
      tradePlanSource = "NONE";
      reasons = [...reasons, crossesH1Obstacle
        ? "Entry blocked: the minimum-R target would cross the nearest H1 support/resistance obstacle"
        : "Entry blocked: a complete, correctly oriented trade plan meeting minimum R:R is unavailable"];
    }

    /*
     * ==========================================================
     * BACKGROUND PUSH ENGINE
     * ==========================================================
     * Push is only allowed during an authenticated background run.
     * Dashboard/API reads never trigger notifications.
     *
     * 1) CHOCH: true event only (false -> true on newest closed candle)
     * 2) ENTRY: BUY/SELL only when the final execution state is READY
     * 3) Redis locks prevent duplicate delivery across cron retries
     */

    let chochPushSent = false;
    let chochPushSkipped = false;
    let entryPushSent = false;
    let entryPushSkipped = false;
    let breakoutPushSent = false;
    let breakoutPushSkipped = false;
    let chochPushEvents = [];
    let bosPushSent = false;
    let bosPushSkipped = false;
    let bosPushEvents = [];
    let entryPushEvents = [];
    let breakoutPushEvents = [];

    async function notifyPushOnce(kind, eventKey, payload, eventMeta = {}) {
      const lockKey = `xau_push_notification|${kind}|${eventKey}`;
      const claimKey = `${lockKey}|claim`;

      try {
        const alreadyNotified = await redis.get(lockKey);
        if (alreadyNotified) {
          return { status: "ALREADY_NOTIFIED", lockKey, sent: 0, total: 0 };
        }

        // Claim the event before sending. NX avoids duplicate delivery when
        // dashboard/cron requests hit separate Vercel instances concurrently.
        const claim = await redis.set(claimKey, "1", { ex: 90, nx: true });
        if (!claim) {
          return { status: "EVENT_IN_PROGRESS", lockKey, sent: 0, total: 0 };
        }

        try {
          const delivery = await sendPushToAll(payload);
          const sent = Number(delivery?.sent || 0);

          if (sent > 0) {
            await redis.set(lockKey, "1", { ex: CFG.pushLockTTL });
          }

          return {
            status: sent > 0 ? "SENT" : "NO_SUBSCRIBERS_OR_NOT_SENT",
            lockKey,
            sent,
            removed: Number(delivery?.removed || 0),
            total: Number(delivery?.total || 0),
            ...eventMeta
          };
        } finally {
          // The long-lived lock is only written after successful delivery;
          // remove the short claim so a failed send can be retried safely.
          await redis.del(claimKey);
        }
      } catch (error) {
        return {
          status: "ERROR",
          lockKey,
          sent: 0,
          error: error?.message || String(error),
          ...eventMeta
        };
      }
    }

    if (pushAllowed && CFG.pushChochEvents) {
      async function notifyChochEvent(timeframe, direction, event) {
        if (!event?.candle || (!event.bullish && !event.bearish)) return;

        const candleTime = event.candle.time;
        const eventKey = `XAUUSD|${timeframe}|CHOCH|${direction}|${candleTime}`;
        const contextKey = `xau_smc_last_choch|${timeframe}`;
        // Keep the latest directional CHOCH so a later same-direction BOS
        // can be highlighted even when it arrives on a separate cron run.
        await redis.set(contextKey, JSON.stringify({ direction, candleTime, eventKey }), { ex: 86400 * 3 });
        const emoji = direction === "BULLISH" ? "🟢" : "🔴";
        const price = Number(event.candle.close).toFixed(2);

        const result = await notifyPushOnce(
          "CHOCH",
          eventKey,
          {
            title: `${emoji} XAU/USD ${timeframe} CHOCH`,
            body: [
              `${direction} CHOCH terbentuk`,
              `Close ${price}`,
              `Candle ${candleTime}`,
              `M15 ${m15CHOCHEvent.bullish ? "BULLISH CHOCH" : m15CHOCHEvent.bearish ? "BEARISH CHOCH" : "—"}`,
              `M5 ${m5CHOCHEvent.bullish ? "BULLISH CHOCH" : m5CHOCHEvent.bearish ? "BEARISH CHOCH" : "—"}`
            ].join(" • "),
            tag: eventKey,
            url: "/"
          },
          { timeframe, direction, candle: candleTime, key: eventKey }
        );

        if (result.status === "SENT") chochPushSent = true;
        if (result.status === "ALREADY_NOTIFIED") chochPushSkipped = true;
        chochPushEvents.push(result);
      }

      // IMPORTANT: use the actual event detector, not the persistent CHOCH state.
      if (m15CHOCHEvent.bullish) await notifyChochEvent("M15", "BULLISH", m15CHOCHEvent);
      if (m15CHOCHEvent.bearish) await notifyChochEvent("M15", "BEARISH", m15CHOCHEvent);
      if (m5CHOCHEvent.bullish) await notifyChochEvent("M5", "BULLISH", m5CHOCHEvent);
      if (m5CHOCHEvent.bearish) await notifyChochEvent("M5", "BEARISH", m5CHOCHEvent);
    }

    // Highlight a fresh BOS only when a same-direction CHOCH was seen first.
    // CHOCH context is persisted in Redis across scheduled invocations.
    if (pushAllowed) {
      async function notifyBosAfterChoch(timeframe, direction, event) {
        if (!event?.candle || (!event.bullish && !event.bearish)) return;
        const contextKey = `xau_smc_last_choch|${timeframe}`;
        let context = null;
        try { context = JSON.parse(await redis.get(contextKey) || "null"); } catch {}
        if (!context || context.direction !== direction) return;
        const bosTime = String(event.candle.time || "");
        const chochTime = String(context.candleTime || "");
        if (!bosTime || !chochTime || bosTime <= chochTime) return;

        const eventKey = `XAUUSD|${timeframe}|BOS_AFTER_CHOCH|${direction}|${bosTime}`;
        const emoji = direction === "BULLISH" ? "🚨🟢" : "🚨🔴";
        const close = Number(event.candle.close);
        const result = await notifyPushOnce(
          "BOS_AFTER_CHOCH",
          eventKey,
          {
            title: `${emoji} XAU/USD ${timeframe} BOS ${direction}`,
            body: [
              `BOS searah CHOCH ${direction} telah disahkan`,
              `Close ${Number.isFinite(close) ? close.toFixed(2) : "—"}`,
              `CHOCH terdahulu ${chochTime}`,
              `BOS ${bosTime}`,
              `PERHATIAN: bersedia pantau FVG dan retracement; ini belum signal ENTRY`
            ].join(" • "),
            tag: `xau-bos-after-choch|${eventKey}`,
            url: "/"
          },
          { timeframe, direction, choch: chochTime, bos: bosTime, key: eventKey }
        );
        if (result.status === "SENT") bosPushSent = true;
        if (result.status === "ALREADY_NOTIFIED") bosPushSkipped = true;
        bosPushEvents.push(result);
      }

      if (m15BOSEvent.bullish) await notifyBosAfterChoch("M15", "BULLISH", m15BOSEvent);
      if (m15BOSEvent.bearish) await notifyBosAfterChoch("M15", "BEARISH", m15BOSEvent);
      if (m5BOSEvent.bullish) await notifyBosAfterChoch("M5", "BULLISH", m5BOSEvent);
      if (m5BOSEvent.bearish) await notifyBosAfterChoch("M5", "BEARISH", m5BOSEvent);
    }

    // Notify a newly detected M5 S/R breakout. The event key includes the
    // closed candle and level, so the 5-minute cron cannot spam the same event.
    if (
      pushAllowed &&
      CFG.pushBreakoutEvents &&
      breakoutWatch?.state === "BREAKOUT_DETECTED" &&
      breakoutWatch?.direction &&
      breakoutWatch?.candleTime
    ) {
      const direction = String(breakoutWatch.direction).toUpperCase();
      const level = Number(breakoutWatch.level);
      const price = Number(breakoutWatch.price ?? livePrice);
      const eventKey = `XAUUSD|M5|BREAKOUT|${direction}|${breakoutWatch.candleTime}|${Number.isFinite(level) ? level.toFixed(2) : "NA"}`;
      const emoji = direction === "BUY" ? "🟢" : "🔴";
      const result = await notifyPushOnce(
        "BREAKOUT",
        eventKey,
        {
          title: `${emoji} XAU/USD ${direction} BREAKOUT`,
          body: [
            `M5 S/R breakout detected`,
            `Level ${Number.isFinite(level) ? level.toFixed(2) : "—"}`,
            `Price ${Number.isFinite(price) ? price.toFixed(2) : "—"}`,
            `Candle ${breakoutWatch.candleTime}`,
            `Not necessarily ENTRY READY`
          ].join(" • "),
          tag: `xau-breakout|${eventKey}`,
          url: "/"
        },
        { direction, level: Number.isFinite(level) ? level : null, candle: breakoutWatch.candleTime, key: eventKey }
      );
      if (result.status === "SENT") breakoutPushSent = true;
      if (result.status === "ALREADY_NOTIFIED") breakoutPushSkipped = true;
      breakoutPushEvents.push(result);
    }

    if (
      pushAllowed &&
      CFG.pushEntrySignals &&
      signal !== "WAIT" &&
      status === "ENTRY" &&
      execution === "READY" &&
      signalKey
    ) {
      const signalStateKey = "xau_signal_push_state";
      const previousSignal = await redis.get(signalStateKey);

      if (shouldNotifyEntryEvent(previousSignal, signalKey)) {
        const entryResult = await notifyPushOnce(
        "ENTRY",
        signalKey,
        {
          title: signal === "BUY" ? "🟢 XAU/USD BUY" : "🔴 XAU/USD SELL",
          body: [
            `${signal} ENTRY READY`,
            `Entry ${entry?.toFixed?.(2) ?? entry ?? "—"}`,
            `SL ${stopLoss?.toFixed?.(2) ?? stopLoss ?? "—"}`,
            `TP1 ${tp1?.toFixed?.(2) ?? tp1 ?? "—"}`,
            `M5 ${signalCandle}`
          ].join(" • "),
          tag: `xau-entry|${signalKey}`,
          url: "/"
        },
        { signal, signalKey, candle: signalCandle }
      );

        if (entryResult.status === "SENT") {
          entryPushSent = true;
          await redis.set(signalStateKey, signalKey, { ex: CFG.pushLockTTL });
        }
        if (entryResult.status === "ALREADY_NOTIFIED") {
          entryPushSkipped = true;
          await redis.set(signalStateKey, signalKey, { ex: CFG.pushLockTTL });
        }
        entryPushEvents.push(entryResult);
      } else {
        entryPushSkipped = true;
        entryPushEvents.push({
          status: "SAME_SIGNAL_STATE",
          signal,
          signalKey
        });
      }
    } else if (pushAllowed) {
      // Record WAIT so a later BUY/SELL transition can notify again.
      await redis.set("xau_signal_push_state", signal, { ex: CFG.pushLockTTL });
    }

    const pushSent = chochPushSent || bosPushSent || entryPushSent || breakoutPushSent;
    const pushSkipped = chochPushSkipped || bosPushSkipped || entryPushSkipped || breakoutPushSkipped;
    /*
     * ==========================================================
     * DATA SOURCE STATUS
     * ==========================================================
     */

    const sourceValues = [
      C.dataSource.m5,
      C.dataSource.m15,
      C.dataSource.h1,
      priceSource
    ];

    const usingCache =
      sourceValues.some(
        x =>
          x === "REDIS_CACHE" ||
          x === "STALE_LOCAL_CACHE" ||
          x === "LOCAL_CACHE"
      );

    const usingLive =
      sourceValues.some(
        x =>
          x === "TWELVE_DATA"
      );

    // A cache is a transport/source choice, not proof that the data is stale.
    // detectMarketStatus already evaluates actual candle and price timestamps.
    const stale = isMarketDataStale(marketStatus.reasons);

    const cacheAges = {
      m5:
        C.cacheAt.m5
          ? Math.round(
              (
                Date.now() -
                C.cacheAt.m5
              ) / 1000
            )
          : null,

      m15:
        C.cacheAt.m15
          ? Math.round(
              (
                Date.now() -
                C.cacheAt.m15
              ) / 1000
            )
          : null,

      h1:
        C.cacheAt.h1
          ? Math.round(
              (
                Date.now() -
                C.cacheAt.h1
              ) / 1000
            )
          : null,

      price:
        C.cacheAt.price
          ? Math.round(
              (
                Date.now() -
                C.cacheAt.price
              ) / 1000
            )
          : null
    };

    let overallDataSource = usingCache
      ? "CACHE"
      : usingLive
        ? "LIVE"
        : "UNKNOWN";

    /*
     * ==========================================================
     * RESPONSE
     * ==========================================================
     */

    return res.status(200).json({
      ok: true,

      version:
        "PHASE2-SMC-LIVE-V2",

      architecture:
        "ONE-M5-TWELVE-DATA-CALL + LOCAL-M15-H1-AGGREGATION + SWEEP-CHOCH-BOS-FVG-RETRACE-SIGNAL + H1-CONTEXT-GUARD + SWEEP-EXTREME-SL + R-MULTIPLE-TP + MARKET-CLOSED-GUARD + AUTHENTICATED-BACKGROUND-PUSH + EVENT-DEDUPE + REDIS-CACHE + LIVE-PRICE",

      marketStatus,
      marketRegime,
      phase2LiveSignal,
      experimentalModels,

      symbol:
        CFG.symbol,

      price:
        livePrice,

      candlePrice,

      /*
       * ========================================================
       * DATA SOURCE
       * ========================================================
       */

      dataSource:
        overallDataSource,

      stale,

      cache: {
        enabled: true,

        storage:
          "REDIS + LOCAL",

        candleTTLSeconds: {
          m5:
            CFG.m5CacheTTL /
            1000,

          m15:
            CFG.m15CacheTTL /
            1000,

          h1:
            CFG.h1CacheTTL /
            1000
        },

        priceTTLSeconds:
          CFG.priceTTL /
          1000,

        redisTTLSeconds:
          CFG.redisCacheTTL,

        sources: {
          m5:
            C.dataSource.m5,

          m15:
            C.dataSource.m15,

          h1:
            C.dataSource.h1,

          price:
            priceSource
        },

        ageSeconds:
          cacheAges
      },

      livePrice: {
        price:
          livePrice,

        source:
          priceSource,

        ageSeconds:
          cacheAges.price
      },

      candles:
        m5.slice(-60),

      // Dedicated visual chart feed: closed M15 candles; does not alter M5 signal logic.
      m15ChartCandles:
        m15.slice(-240),

      status,
      signal,
      signalStage,

      signalType:
        signal === "WAIT"
          ? "NONE"
          : setupType,

      setupType,

      execution,

      score,

      context,

      reasons,

      signalKey,

      signalCandle,

      push: {
        authorized: pushAllowed,
        mode: "ENTRY_CHOCH_AND_BREAKOUT_EVENTS",
        attempted: chochPushEvents.length > 0 || entryPushEvents.length > 0 || breakoutPushEvents.length > 0,
        sent: pushSent,
        skipped: pushSkipped,
        chochEvents: chochPushEvents,
        bosEvents: bosPushEvents,
        entryEvents: entryPushEvents,
        breakoutEvents: breakoutPushEvents
      },

      choch: {
        notificationTrigger:
          "NEW_CHOCH_EVENT_ON_LATEST_CLOSED_CANDLE",

        m15: {
          bullish:
            Boolean(m15CHOCHEvent.bullish),

          bearish:
            Boolean(m15CHOCHEvent.bearish),

          candle:
            m15CHOCHEvent.candle?.time || null
        },

        m5: {
          bullish:
            Boolean(m5CHOCHEvent.bullish),

          bearish:
            Boolean(m5CHOCHEvent.bearish),

          candle:
            m5CHOCHEvent.candle?.time || null
        }
      },

      /*
       * ========================================================
       * H1
       * ========================================================
       */

      h1: {
        direction:
          h1Direction,

        // Informational score only; separate from signal/entry authorization.
        buyScore:
          h1BuyScore,

        sellScore:
          h1SellScore,

        ema20:
          h1EMA20,

        rsi:
          h1RSI,

        macd:
          h1MACD,

        ema50:
          h1EMA50,

        ema200:
          h1EMA200,

        atr:
          h1ATR,

        regime: regimeH1,

        holdBias,

        holdPermission,

        structure:
          h1Struct,

        supportResistance:
          h1SupportResistance,

        srFilter: {
          buyAllowed:
            srBuyAllowed,

          sellAllowed:
            srSellAllowed,

          buyContext:
            srBuyContext,

          sellContext:
            srSellContext,

          buyBlocked:
            !srBuyAllowed,

          sellBlocked:
            !srSellAllowed,

          role:
            "CONTEXT_ONLY",

          blocksScalpEntry:
            false
        }
      },

      /*
       * ========================================================
       * M15
       * ========================================================
       */

      m15: {
        direction:
          m15Confirmation,

        confirmation:
          m15Confirmation,

        buyScore:
          m15Buy,

        sellScore:
          m15Sell,

        buyConfirmed:
          m15BuyConfirmed,

        sellConfirmed:
          m15SellConfirmed,

        ema20:
          m15EMA20,

        ema50:
          m15EMA50,

        rsi:
          m15RSI,

        macd:
          m15MACD,

        atr:
          m15ATR,

        regime: regimeM15,

        bos:
          m15BOS,

        choch:
          m15CHOCH,

        chochEvent:
          m15CHOCHEvent,

        sweep:
          m15Sweep,

        momentum:
          m15Mom,

        structure:
          m15Struct,

        buyReasons:
          rb,

        sellReasons:
          rs
      },

      /*
       * ========================================================
       * M5
       * ========================================================
       */

      m5: {
        trigger:
          m5Trigger,

        confirmation:
          m5Trigger,

        buyScore:
          m5Buy,

        sellScore:
          m5Sell,

        buyTriggered:
          m5BuyTriggered,

        sellTriggered:
          m5SellTriggered,

        ema9:
          m5EMA9,

        ema20:
          m5EMA20,

        ema50:
          m5EMA50,

        rsi:
          m5RSI,

        macd:
          m5MACD,

        atr:
          m5ATR,

        regime: regimeM5,

        bos:
          m5BOS,

        choch:
          m5CHOCH,

        chochEvent:
          m5CHOCHEvent,

        sweep:
          m5Sweep,

        momentum:
          m5Mom,

        structure:
          m5Struct,

        buyReasons:
          r5b,

        sellReasons:
          r5s
      },

      /*
       * ========================================================
       * SETUP ANALYSIS
       * ========================================================
       */

      setupAnalysis: {
        buy: {
          aligned:
            rawBuyAlignment,

          continuation:
            buyContinuation,

          reversal:
            buyReversal,

          type:
            buySetupType,

          location:
            h1SupportResistance
              .position,

          h1Bias:
            h1Direction,

          targetSR:
            rawBuyAlignment
              ? h1SupportResistance
                  .resistance
              : null
        },

        sell: {
          aligned:
            rawSellAlignment,

          continuation:
            sellContinuation,

          reversal:
            sellReversal,

          type:
            sellSetupType,

          location:
            h1SupportResistance
              .position,

          h1Bias:
            h1Direction,

          targetSR:
            rawSellAlignment
              ? h1SupportResistance
                  .support
              : null
        }
      },

      /*
       * ========================================================
       * ROADBLOCK ANALYSIS
       * ========================================================
       */

      roadblocks: {
        active:
          activeRoadblocks,

        nearest:
          nearestRoadblock,

        count:
          activeRoadblocks.length,

        hasRoadblock:
          activeRoadblocks.length > 0,

        buy: {
          m5:
            buyM5Roadblocks,

          m15:
            buyM15Roadblocks
        },

        sell: {
          m5:
            sellM5Roadblocks,

          m15:
            sellM15Roadblocks
        }
      },

      /*
       * ========================================================
       * TRADE PLAN
       * ========================================================
       */

      tradePlan: {
        entry,

        stopLoss,

        tp1,

        tp2,

        tp3,

        rr,

        risk,

        locked:
          tradePlanLocked,

        source:
          tradePlanSource,

        fixed:
          Boolean(
            signalKey &&
            entry != null
          ),

        targetSR,

        targetSRType,

        targetSRDistance,

        targetSRValid,

        targetMode:
          targetSRType === "R-MULTIPLE FALLBACK"
            ? "R-MULTIPLE_FALLBACK"
            : "MULTI_TIMEFRAME_SR",

        targetMeta,

        targetHierarchy: {
          m5: directionalM5Targets.slice(0, 5),
          m15: directionalM15Targets.slice(0, 5),
          h1: directionalH1Targets.slice(0, 5)
        }
      },

      /*
       * ========================================================
       * S/R ANALYSIS
       * ========================================================
       */

      breakoutWatch,

      srAnalysis: {
        timeframe:
          "H1",

        currentPrice:
          livePrice,

        support:
          h1SupportResistance
            .support,

        resistance:
          h1SupportResistance
            .resistance,

        position:
          h1SupportResistance
            .position,

        zone:
          h1SupportResistance
            .zone,

        supportDistance:
          h1SupportResistance
            .supportDistance,

        resistanceDistance:
          h1SupportResistance
            .resistanceDistance,

        threshold:
          h1SupportResistance
            .threshold,

        reversalThreshold:
          h1SupportResistance
            .reversalThreshold,

        nearSupport:
          h1SupportResistance
            .nearSupport,

        nearResistance:
          h1SupportResistance
            .nearResistance,

        atSupport:
          h1SupportResistance
            .atSupport,

        atResistance:
          h1SupportResistance
            .atResistance,

        reversalAtSupport:
          h1SupportResistance
            .reversalAtSupport,

        reversalAtResistance:
          h1SupportResistance
            .reversalAtResistance,

        signalContext:
          h1SupportResistance
            .signalContext,

        buyAllowed:
          srBuyAllowed,

        sellAllowed:
          srSellAllowed,

        buyContext:
          srBuyContext,

        sellContext:
          srSellContext,

        scalpTarget:
          targetSR,

        scalpTargetType:
          targetSRType,

        scalpTargetDistance:
          targetSRDistance,

        scalpTargetValid:
          targetSRValid,

        role:
          "CONTEXT_AND_TARGET",

        blocksScalpEntry:
          false,

        targetHierarchy: {
          m5: directionalM5Targets.slice(0, 5),
          m15: directionalM15Targets.slice(0, 5),
          h1: directionalH1Targets.slice(0, 5)
        }
      },

      /*
       * ========================================================
       * DATA
       * ========================================================
       */

      data: {
        m5Candles:
          m5.length,

        m15Candles:
          m15.length,

        h1Candles:
          h1.length
      },

      timestamp:
        new Date().toISOString()
    });

  } catch (e) {
    console.error(
      "SCALP API ERROR",
      e
    );

    return res.status(502).json({
      ok: false,

      error:
        e.message ||
        "SCALP API ERROR",

      dataSource:
        "NONE",

      stale:
        false,

      cache: {
        enabled:
          true,

        message:
          "Twelve Data gagal dan cache yang diperlukan tidak tersedia."
      }
    });
  }
}
