import { sendPushToAll, redis } from "./push-lib.js";

export default async function handler(req, res) {
  const API_KEY = process.env.TWELVE_DATA_API_KEY;

  if (!API_KEY) {
    return res.status(500).json({
      ok: false,
      error: "TWELVE_DATA_API_KEY belum diset"
    });
  }

  const CFG = {
    symbol: "XAU/USD",

    m5Size: 1500,
    m15Size: 500,
    h1Size: 300,

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
    m15CacheTTL: 15 * 60_000,
    h1CacheTTL: 60 * 60_000,

    /*
     * LIVE PRICE
     *
     * Harga semasa kekal lebih cepat.
     */

    priceTTL: 15_000,

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

    /*
     * MARKET REGIME / EFFICIENCY
     *
     * ER = directional efficiency (0..1). Higher = cleaner trend,
     * lower = more chop/range. Regime is context/risk/target guidance;
     * it NEVER blocks a valid M5 scalp trigger by itself.
     */
    erPeriodM5: 20,
    erPeriodM15: 20,
    erPeriodH1: 20,
    volatilityBaselineBars: 60,
    trendERMin: 0.45,
    rangeERMax: 0.25,
    highVolRatio: 1.60,
    lowVolRatio: 0.70,
    regimeScoreTrendBonus: 5,
    regimeScoreRangePenalty: 5,
    regimeScoreHighVolPenalty: 5,
    slAtrBufferNormal: 0.15,
    slAtrBufferHighVol: 0.20,
    slAtrBufferLowVol: 0.12,

    // S/R is context + target selection. It NEVER blocks a valid M5 scalp.
    minTargetR: 1.50,
    requireValidSRTarget: false,

    /*
     * ROADBLOCK
     *
     * M15/M5 digunakan untuk mencari halangan
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
  const backgroundPushAuthorized =
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

  function efficiencyRatio(d, period = 20) {
    if (!Array.isArray(d) || d.length < period + 1) return null;

    const end = d.length - 1;
    const start = end - period;
    const net = Math.abs(d[end].close - d[start].close);
    let volatility = 0;

    for (let i = start + 1; i <= end; i++) {
      volatility += Math.abs(d[i].close - d[i - 1].close);
    }

    if (!Number.isFinite(volatility) || volatility <= 0) return 0;
    return clamp(net / volatility, 0, 1);
  }

  function atrSeries(d, period = 14) {
    if (!Array.isArray(d) || d.length < period + 1) return [];

    const tr = [];
    for (let i = 1; i < d.length; i++) {
      const c = d[i];
      const pc = d[i - 1].close;
      tr.push(Math.max(
        c.high - c.low,
        Math.abs(c.high - pc),
        Math.abs(c.low - pc)
      ));
    }

    const out = [];
    for (let i = period - 1; i < tr.length; i++) {
      out.push(avg(tr.slice(i - period + 1, i + 1)));
    }
    return out;
  }

  function volatilityProfile(d, period = 14, baselineBars = 60) {
    const values = atrSeries(d, period);
    if (!values.length) {
      return { atr: null, baselineATR: null, ratio: null, state: "UNKNOWN" };
    }

    const current = values.at(-1);
    const previous = values.slice(Math.max(0, values.length - baselineBars - 1), -1);
    const baseline = previous.length ? avg(previous) : current;
    const ratio = baseline > 0 ? current / baseline : 1;

    const state =
      ratio >= CFG.highVolRatio ? "HIGH" :
      ratio <= CFG.lowVolRatio ? "LOW" :
      "NORMAL";

    return {
      atr: Number(current.toFixed(4)),
      baselineATR: Number(baseline.toFixed(4)),
      ratio: Number(ratio.toFixed(3)),
      state
    };
  }

  function classifyRegime(er, volatility, direction = "NEUTRAL") {
    let structure = "TRANSITION";
    if (er != null && er >= CFG.trendERMin) structure = "TRENDING";
    else if (er != null && er <= CFG.rangeERMax) structure = "RANGING";

    return {
      structure,
      direction: structure === "TRENDING" ? direction : "NEUTRAL",
      volatility: volatility || "NORMAL",
      label: `${structure}${structure === "TRENDING" && direction !== "NEUTRAL" ? `_${direction}` : ""}_${volatility || "NORMAL"}`
    };
  }

  function buildMarketRegime(m5Data, m15Data, h1Data, m15Direction, h1Direction) {
    const m5ER = efficiencyRatio(m5Data, CFG.erPeriodM5);
    const m15ER = efficiencyRatio(m15Data, CFG.erPeriodM15);
    const h1ER = efficiencyRatio(h1Data, CFG.erPeriodH1);

    const m5Vol = volatilityProfile(m5Data, 14, CFG.volatilityBaselineBars);
    const m15Vol = volatilityProfile(m15Data, 14, CFG.volatilityBaselineBars);
    const h1Vol = volatilityProfile(h1Data, 14, CFG.volatilityBaselineBars);

    const direction =
      m15Direction === "BUY" || m15Direction === "SELL"
        ? m15Direction
        : h1Direction === "BUY" || h1Direction === "SELL"
          ? h1Direction
          : "NEUTRAL";

    const compositeVol =
      m5Vol.state === "HIGH" || m15Vol.state === "HIGH"
        ? "HIGH"
        : m5Vol.state === "LOW" && m15Vol.state === "LOW"
          ? "LOW"
          : "NORMAL";

    const regime = classifyRegime(m15ER, compositeVol, direction);

    return {
      ...regime,
      efficiencyRatio: { m5: m5ER, m15: m15ER, h1: h1ER },
      volatility: { m5: m5Vol, m15: m15Vol, h1: h1Vol, composite: compositeVol },
      driver: "M15_ER + M5/M15_ATR_REGIME",
      role: "CONTEXT_AND_RISK",
      blocksScalpEntry: false
    };
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

    const supports = levels
      .filter(x => x.type === "SUPPORT" && x.price < price)
      .sort((a, b) => b.price - a.price);

    const resistances = levels
      .filter(x => x.type === "RESISTANCE" && x.price > price)
      .sort((a, b) => a.price - b.price);

    const support = supports[0] || null;
    const resistance = resistances[0] || null;
    const supportDistance = support ? price - support.price : null;
    const resistanceDistance = resistance ? resistance.price - price : null;

    const threshold = Math.max(
      (h1ATR || 10) * CFG.srATRMultiplier,
      CFG.srMinDistance
    );
    const reversalThreshold = threshold * CFG.reversalZoneMultiplier;

    const nearSupport = supportDistance != null && supportDistance <= threshold;
    const nearResistance = resistanceDistance != null && resistanceDistance <= threshold;
    const atSupport = supportDistance != null && supportDistance <= threshold * 0.35;
    const atResistance = resistanceDistance != null && resistanceDistance <= threshold * 0.35;
    const reversalAtSupport = supportDistance != null && supportDistance <= reversalThreshold;
    const reversalAtResistance = resistanceDistance != null && resistanceDistance <= reversalThreshold;

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
     * selepas price tetapi sebelum H1 target.
     *
     * SELL:
     *
     * Roadblock mestilah support
     * selepas price tetapi sebelum H1 target.
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
   * TWELVE DATA CANDLE CACHE
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
      const candleStart =
        Date.parse(
          `${String(candle.time).replace(" ", "T")}Z`
        );

      if (!Number.isFinite(candleStart)) {
        return true;
      }

      return candleStart + intervalMs <= Date.now();
    });
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

    /*
     * ----------------------------------------------------------
     * 1. LOCAL CACHE
     * ----------------------------------------------------------
     */

    if (
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
     * 2. TWELVE DATA
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
          C.candles[key] = {
            at:
              redisCache.savedAt ||
              Date.now(),

            data:
              closedRedisData
          };

          C.dataSource[key] =
            "REDIS_CACHE";

          C.cacheAt[key] =
            redisCache.savedAt ||
            Date.now();

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
        !Number.isFinite(p)
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
        C.price =
          cachedPrice;

        C.priceAt =
          redisPrice.savedAt ||
          Date.now();

        C.dataSource.price =
          "REDIS_CACHE";

        C.cacheAt.price =
          redisPrice.savedAt ||
          Date.now();

        return {
          price:
            cachedPrice,

          savedAt:
            redisPrice.savedAt ||
            Date.now(),

          source:
            "REDIS_CACHE"
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

    [
      m5,
      m15,
      h1
    ] = await Promise.all([
      series(
        "5min",
        CFG.m5Size,
        "m5"
      ),

      series(
        "15min",
        CFG.m15Size,
        "m15"
      ),

      series(
        "1h",
        CFG.h1Size,
        "h1"
      )
    ]);

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

    const m5Struct =
      structure(
        m5,
        24
      );

    const m5BOS =
      bos(
        m5,
        10
      );

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
     * MARKET REGIME
     * ==========================================================
     */

    const marketRegime = buildMarketRegime(
      m5,
      m15,
      h1,
      m15Confirmation,
      h1Direction
    );

    const regimeScoreAdjustment = (direction) => {
      let adjustment = 0;
      const notes = [];

      if (marketRegime.structure === "TRENDING") {
        if (marketRegime.direction === direction) {
          adjustment += CFG.regimeScoreTrendBonus;
          notes.push(`REGIME trending ${direction} +${CFG.regimeScoreTrendBonus}`);
        } else if (marketRegime.direction !== "NEUTRAL") {
          adjustment -= CFG.regimeScoreTrendBonus;
          notes.push(`REGIME trend opposes ${direction} -${CFG.regimeScoreTrendBonus}`);
        }
      } else if (marketRegime.structure === "RANGING") {
        adjustment -= CFG.regimeScoreRangePenalty;
        notes.push(`REGIME range -${CFG.regimeScoreRangePenalty}`);
      }

      if (marketRegime.volatility === "HIGH") {
        adjustment -= CFG.regimeScoreHighVolPenalty;
        notes.push(`HIGH volatility -${CFG.regimeScoreHighVolPenalty}`);
      }

      return { adjustment, notes };
    };

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
     * H1 S/R CONTEXT — NEVER AN ENTRY BLOCK
     * ==========================================================
     */

    const srBuyAllowed = true;
    const srSellAllowed = true;

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

    if (buyContinuation) {
      buySetupType =
        "CONTINUATION";
    } else if (buyReversal) {
      buySetupType =
        "REVERSAL";
    } else if (rawBuyAlignment) {
      buySetupType =
        "COUNTER-TREND";
    }

    if (sellContinuation) {
      sellSetupType =
        "CONTINUATION";
    } else if (sellReversal) {
      sellSetupType =
        "REVERSAL";
    } else if (rawSellAlignment) {
      sellSetupType =
        "COUNTER-TREND";
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
      srBuyAllowed
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

      {
        const regimeAdj = regimeScoreAdjustment("BUY");
        score = clamp(score + regimeAdj.adjustment, 0, 100);
        reasons = [
          ...regimeAdj.notes
        ];
      }

      reasons = [
        ...reasons,
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
      srSellAllowed
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

      {
        const regimeAdj = regimeScoreAdjustment("SELL");
        score = clamp(score + regimeAdj.adjustment, 0, 100);
        reasons = [
          ...regimeAdj.notes
        ];
      }

      reasons = [
        ...reasons,
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

    /*
     * H1 S/R is context only. It never creates a WAIT/BLOCKED state.
     */

    if (signal === "BUY" && h1SupportResistance.nearResistance) {
      reasons.push("H1 resistance nearby — manage TP/hold, not an entry block");
    }

    if (signal === "SELL" && h1SupportResistance.nearSupport) {
      reasons.push("H1 support nearby — manage TP/hold, not an entry block");
    }

    /*
     * Conflict
     */

    else if (
      m15BuyConfirmed &&
      m5SellTriggered
    ) {
      reasons = [
        "M15 BUY vs M5 SELL — conflicting"
      ];
    }

    else if (
      m15SellConfirmed &&
      m5BuyTriggered
    ) {
      reasons = [
        "M15 SELL vs M5 BUY — conflicting"
      ];
    }

    /*
     * Partial
     */

    else if (
      m15BuyConfirmed ||
      m15SellConfirmed ||
      m5BuyTriggered ||
      m5SellTriggered
    ) {
      reasons = [
        "Waiting for timeframe alignment"
      ];
    }

    else {
      reasons = [
        "M15 + M5 not aligned"
      ];
    }

    /*
     * ==========================================================
     * H1 HOLD
     * ==========================================================
     */

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

    const signalKey =
      signal !== "WAIT"
        ? `XAUUSD|SRV2|${signal}|${signalCandle}`
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
            m5ATR * 1.25,
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
      !tradePlanLocked
    ) {
      entry = candidateEntry;

      /*
       * Structure-aware stop:
       * use the latest closed M5 candle extreme plus an ATR buffer.
       * This is more meaningful for a scalp than a fixed ATR-only SL.
       */
      const triggerCandle = m5.at(-1);
      const slBufferFactor =
        marketRegime.volatility === "HIGH"
          ? CFG.slAtrBufferHighVol
          : marketRegime.volatility === "LOW"
            ? CFG.slAtrBufferLowVol
            : CFG.slAtrBufferNormal;
      const slBuffer = Math.max(0.10, m5ATR * slBufferFactor);

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
      const fallbackR =
        marketRegime.structure === "TRENDING"
          ? [1.5, 3.0, 5.0]
          : marketRegime.structure === "RANGING"
            ? [1.5, 2.25, 3.0]
            : [1.5, 2.5, 4.0];

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

      const tp2MinR =
        marketRegime.structure === "TRENDING" ? 3.0 :
        marketRegime.structure === "RANGING" ? 2.25 :
        2.5;
      const tp3MinR =
        marketRegime.structure === "TRENDING" ? 5.0 :
        marketRegime.structure === "RANGING" ? 3.0 :
        4.0;

      const tp2Level = pickTarget(Math.max(tp2MinR, tp1R + 0.5), tp1Price);
      const tp2Price = tp2Level
        ? tp2Level.price
        : signal === "BUY"
          ? entry + risk * fallbackR[1]
          : entry - risk * fallbackR[1];

      const tp3Level = pickTarget(Math.max(tp3MinR, targetForR(tp2Level) + 0.5), tp2Price);
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
        planVersion: "SR-V3-MULTI-TF-REGIME"
      };

      await saveLockedTradePlan(signalKey, newPlan);
      tradePlanLocked = true;
      tradePlanSource = "NEW_REDIS_LOCK";
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
    let chochPushEvents = [];
    let entryPushEvents = [];

    async function notifyPushOnce(kind, eventKey, payload, eventMeta = {}) {
      const lockKey = `xau_push_notification|${kind}|${eventKey}`;

      try {
        const alreadyNotified = await redis.get(lockKey);

        if (alreadyNotified) {
          return {
            status: "ALREADY_NOTIFIED",
            lockKey,
            sent: 0,
            total: 0
          };
        }

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

    if (backgroundPushAuthorized && CFG.pushChochEvents) {
      async function notifyChochEvent(timeframe, direction, event) {
        if (!event?.candle || (!event.bullish && !event.bearish)) return;

        const candleTime = event.candle.time;
        const eventKey = `XAUUSD|${timeframe}|CHOCH|${direction}|${candleTime}`;
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

    if (
      backgroundPushAuthorized &&
      CFG.pushEntrySignals &&
      signal !== "WAIT" &&
      status === "ENTRY" &&
      execution === "READY" &&
      signalKey
    ) {
      const signalStateKey = "xau_signal_push_state";
      const previousSignal = await redis.get(signalStateKey);

      if (previousSignal !== signal) {
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
          await redis.set(signalStateKey, signal, { ex: CFG.pushLockTTL });
        }
        if (entryResult.status === "ALREADY_NOTIFIED") {
          entryPushSkipped = true;
          await redis.set(signalStateKey, signal, { ex: CFG.pushLockTTL });
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
    } else if (backgroundPushAuthorized) {
      // Record WAIT so a later BUY/SELL transition can notify again.
      await redis.set("xau_signal_push_state", signal, { ex: CFG.pushLockTTL });
    }

    const pushSent = chochPushSent || entryPushSent;
    const pushSkipped = chochPushSkipped || entryPushSkipped;
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

    const stale =
      sourceValues.some(
        x =>
          x === "REDIS_CACHE" ||
          x === "STALE_LOCAL_CACHE"
      );

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

    let overallDataSource =
      "LIVE";

    if (stale) {
      overallDataSource =
        "CACHE";
    } else if (usingLive) {
      overallDataSource =
        "LIVE";
    } else if (usingCache) {
      overallDataSource =
        "CACHE";
    }

    /*
     * ==========================================================
     * RESPONSE
     * ==========================================================
     */

    return res.status(200).json({
      ok: true,

      version:
        "V18-SCALP-SR-V3-REGIME",

      architecture:
        "M15+M5-ALIGNED-SIGNAL + H1-HOLD + MULTI-TF-SR-TARGET + M15/M5-ROADBLOCK + MARKET-REGIME-ER + VOLATILITY-AWARE-SL-TP + STRUCTURE-SL-TP + AUTHENTICATED-BACKGROUND-PUSH + EVENT-DEDUPE + TIMEFRAME-CACHE + LIVE-PRICE",

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

      status,
      signal,

      signalType:
        signal === "WAIT"
          ? "NONE"
          : setupType,

      setupType,

      execution,

      score,

      marketRegime,

      context,

      reasons,

      signalKey,

      signalCandle,

      push: {
        authorized: backgroundPushAuthorized,
        mode: "ENTRY_AND_CHOCH_EVENT",
        attempted: chochPushEvents.length > 0 || entryPushEvents.length > 0,
        sent: pushSent,
        skipped: pushSkipped,
        chochEvents: chochPushEvents,
        entryEvents: entryPushEvents
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

        ema50:
          h1EMA50,

        ema200:
          h1EMA200,

        atr:
          h1ATR,

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
