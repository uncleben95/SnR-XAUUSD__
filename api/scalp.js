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

    cacheTTL: 60_000,
    priceTTL: 15_000,

    minM5: 250,
    minM15: 100,
    minH1: 210,

    // H1 S/R
    snrLookback: 180,
    snrSwingLeft: 3,
    snrSwingRight: 3,
    snrClusterATR: 0.35,
    snrZoneATR: 0.50
  };

  globalThis.__XAU_REPAIR_CACHE__ ??= {
    candles: {},
    price: null,
    priceAt: 0
  };

  const C = globalThis.__XAU_REPAIR_CACHE__;
  const now = Date.now();

  const avg = a =>
    a.length
      ? a.reduce((x, y) => x + y, 0) / a.length
      : null;

  const clamp = (n, a, b) =>
    Math.max(a, Math.min(b, n));

  function ema(v, p) {
    if (v.length < p) return null;

    const k = 2 / (p + 1);
    let e = avg(v.slice(0, p));

    for (let i = p; i < v.length; i++) {
      e = v[i] * k + e * (1 - k);
    }

    return e;
  }

  function rsi(v, p = 14) {
    if (v.length < p + 1) return null;

    let g = 0;
    let l = 0;

    for (let i = v.length - p; i < v.length; i++) {
      const d = v[i] - v[i - 1];

      if (d > 0) g += d;
      else l -= d;
    }

    if (l === 0) return 100;

    const rs = (g / p) / (l / p);

    return 100 - 100 / (1 + rs);
  }

  function atr(d, p = 14) {
    if (d.length < p + 1) return null;

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
    const e12 = ema(v, 12);
    const e26 = ema(v, 26);

    if (!Number.isFinite(e12) || !Number.isFinite(e26)) {
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

    if (signal == null) return null;

    return {
      line,
      signal,
      histogram: line - signal,
      bullish: line > signal,
      bearish: line < signal
    };
  }

  function aggregate(data, minutes) {
    const ms = minutes * 60_000;
    const m = new Map();

    for (const c of data) {
      const t = new Date(c.time).getTime();
      const k = Math.floor(t / ms) * ms;

      if (!m.has(k)) {
        m.set(k, {
          time: new Date(k).toISOString(),
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
          volume: c.volume || 0
        });
      } else {
        const b = m.get(k);

        b.high = Math.max(b.high, c.high);
        b.low = Math.min(b.low, c.low);
        b.close = c.close;
        b.volume += c.volume || 0;
      }
    }

    return [...m.values()].sort(
      (a, b) => new Date(a.time) - new Date(b.time)
    );
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
    const p = d.slice(-lookback * 2, -lookback);
    const last = d.at(-1);

    const high = Math.max(...r.map(x => x.high));
    const low = Math.min(...r.map(x => x.low));

    const previousHigh = Math.max(
      ...p.map(x => x.high)
    );

    const previousLow = Math.min(
      ...p.map(x => x.low)
    );

    return {
      bullish: last.close > previousHigh,
      bearish: last.close < previousLow,
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
    const p = d.slice(-lookback - 1, -1);

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
  }

  function sweep(d, lookback = 10) {
    if (d.length < lookback + 2) {
      return {
        bullish: false,
        bearish: false
      };
    }

    const c = d.at(-1);
    const p = d.slice(-lookback - 1, -1);

    const h = Math.max(...p.map(x => x.high));
    const l = Math.min(...p.map(x => x.low));

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
      c.high - c.low || 1e-9;

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

      strength: Math.round(ratio * 100)
    };
  }

  /*
   * ============================================================
   * H1 SUPPORT / RESISTANCE ENGINE
   * ============================================================
   */

  function findSwingLevels(
    d,
    left = 3,
    right = 3
  ) {
    const supports = [];
    const resistances = [];

    if (d.length < left + right + 5) {
      return {
        supports,
        resistances
      };
    }

    for (
      let i = left;
      i < d.length - right;
      i++
    ) {
      const c = d[i];

      let isLow = true;
      let isHigh = true;

      for (let j = 1; j <= left; j++) {
        if (d[i - j].low <= c.low) {
          isLow = false;
        }

        if (d[i - j].high >= c.high) {
          isHigh = false;
        }
      }

      for (
        let j = 1;
        j <= right;
        j++
      ) {
        if (d[i + j].low < c.low) {
          isLow = false;
        }

        if (d[i + j].high > c.high) {
          isHigh = false;
        }
      }

      if (isLow) {
        supports.push({
          price: c.low,
          time: c.time
        });
      }

      if (isHigh) {
        resistances.push({
          price: c.high,
          time: c.time
        });
      }
    }

    return {
      supports,
      resistances
    };
  }

  function clusterLevels(
    levels,
    tolerance
  ) {
    if (!levels.length) return [];

    const sorted = [...levels].sort(
      (a, b) => a.price - b.price
    );

    const clusters = [];

    for (const level of sorted) {
      let cluster = clusters.find(
        x =>
          Math.abs(
            x.price - level.price
          ) <= tolerance
      );

      if (!cluster) {
        cluster = {
          price: level.price,
          touches: 0,
          lastTime: level.time
        };

        clusters.push(cluster);
      }

      cluster.touches += 1;

      if (
        new Date(level.time) >
        new Date(cluster.lastTime)
      ) {
        cluster.lastTime = level.time;
      }

      cluster.price =
        (cluster.price *
          (cluster.touches - 1) +
          level.price) /
        cluster.touches;
    }

    return clusters;
  }

  function nearestLevel(
    levels,
    price,
    direction
  ) {
    const valid = levels.filter(x =>
      direction === "SUPPORT"
        ? x.price < price
        : x.price > price
    );

    if (!valid.length) return null;

    valid.sort((a, b) =>
      direction === "SUPPORT"
        ? b.price - a.price
        : a.price - b.price
    );

    return valid[0];
  }

  function calculateH1SNR(
    h1,
    price
  ) {
    const data = h1.slice(
      -CFG.snrLookback
    );

    const h1ATR =
      atr(data, 14) || 5;

    const clusterTolerance =
      Math.max(
        h1ATR * CFG.snrClusterATR,
        0.8
      );

    const zoneWidth =
      Math.max(
        h1ATR * CFG.snrZoneATR,
        1.2
      );

    const swings =
      findSwingLevels(
        data,
        CFG.snrSwingLeft,
        CFG.snrSwingRight
      );

    const supports =
      clusterLevels(
        swings.supports,
        clusterTolerance
      );

    const resistances =
      clusterLevels(
        swings.resistances,
        clusterTolerance
      );

    const support =
      nearestLevel(
        supports,
        price,
        "SUPPORT"
      );

    const resistance =
      nearestLevel(
        resistances,
        price,
        "RESISTANCE"
      );

    const supportDistance =
      support
        ? price - support.price
        : null;

    const resistanceDistance =
      resistance
        ? resistance.price - price
        : null;

    const supportZone =
      support
        ? {
            low:
              support.price - zoneWidth,
            high:
              support.price + zoneWidth
          }
        : null;

    const resistanceZone =
      resistance
        ? {
            low:
              resistance.price - zoneWidth,
            high:
              resistance.price + zoneWidth
          }
        : null;

    const nearSupport =
      supportDistance != null &&
      supportDistance <= zoneWidth;

    const nearResistance =
      resistanceDistance != null &&
      resistanceDistance <= zoneWidth;

    let location = "MID_RANGE";
    let bias = "NEUTRAL";
    let quality = "NEUTRAL";

    if (nearSupport && !nearResistance) {
      location = "NEAR_SUPPORT";
      bias = "BUY";
    } else if (
      nearResistance &&
      !nearSupport
    ) {
      location = "NEAR_RESISTANCE";
      bias = "SELL";
    } else if (
      nearSupport &&
      nearResistance
    ) {
      location = "BETWEEN_SNR";
      bias = "NEUTRAL";
    }

    return {
      timeframe: "H1",

      support: support
        ? {
            price: support.price,
            distance: supportDistance,
            touches: support.touches,
            zone: supportZone
          }
        : null,

      resistance: resistance
        ? {
            price: resistance.price,
            distance: resistanceDistance,
            touches: resistance.touches,
            zone: resistanceZone
          }
        : null,

      atr: h1ATR,
      zoneWidth,

      location,
      bias,

      nearSupport,
      nearResistance,

      getEntryAnalysis(signal) {
        if (signal === "BUY") {
          if (nearSupport && !nearResistance) {
            return {
              result: "FAVOURABLE",
              reason:
                "BUY berada dekat H1 Support",
              score: 15
            };
          }

          if (nearResistance) {
            return {
              result: "CAUTION",
              reason:
                "BUY berada dekat H1 Resistance",
              score: -15
            };
          }

          return {
            result: "NEUTRAL",
            reason:
              "BUY berada di tengah H1 range",
            score: 0
          };
        }

        if (signal === "SELL") {
          if (
            nearResistance &&
            !nearSupport
          ) {
            return {
              result: "FAVOURABLE",
              reason:
                "SELL berada dekat H1 Resistance",
              score: 15
            };
          }

          if (nearSupport) {
            return {
              result: "CAUTION",
              reason:
                "SELL berada dekat H1 Support",
              score: -15
            };
          }

          return {
            result: "NEUTRAL",
            reason:
              "SELL berada di tengah H1 range",
            score: 0
          };
        }

        return {
          result: "NEUTRAL",
          reason:
            "Belum ada scalp entry",
          score: 0
        };
      }
    };
  }

  async function series(
    interval,
    outputsize,
    key
  ) {
    const cache = C.candles[key];

    if (
      cache &&
      now - cache.at <
        CFG.cacheTTL
    ) {
      return cache.data;
    }

    const url =
      `https://api.twelvedata.com/time_series` +
      `?symbol=${encodeURIComponent(
        CFG.symbol
      )}` +
      `&interval=${interval}` +
      `&outputsize=${outputsize}` +
      `&apikey=${API_KEY}`;

    const r = await fetch(url);
    const j = await r.json();

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
          volume: +x.volume || 0
        }))
        .filter(x =>
          [
            x.open,
            x.high,
            x.low,
            x.close
          ].every(Number.isFinite)
        );

    const minimum = {
      "5min": CFG.minM5,
      "15min": CFG.minM15,
      "1h": CFG.minH1
    }[interval];

    if (data.length < minimum) {
      throw new Error(
        `Data ${interval} tak cukup: ${data.length}`
      );
    }

    C.candles[key] = {
      at: Date.now(),
      data
    };

    return data;
  }

  let m5;
  let m15;
  let h1;
  let livePrice;
  let candlePrice;

  try {
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

    candlePrice =
      m5.at(-1).close;

    if (
      C.price != null &&
      now - C.priceAt <
        CFG.priceTTL
    ) {
      livePrice = C.price;
    } else {
      const pr =
        await fetch(
          `https://api.twelvedata.com/price` +
          `?symbol=${encodeURIComponent(
            CFG.symbol
          )}` +
          `&apikey=${API_KEY}`
        );

      const pj =
        await pr.json();

      const p =
        Number(pj?.price);

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

      livePrice = p;
      C.price = p;
      C.priceAt = Date.now();
    }

    const c5 =
      m5.map(x => x.close);

    const c15 =
      m15.map(x => x.close);

    const c1 =
      h1.map(x => x.close);

    /*
     * ============================================================
     * H1 BIAS
     * ============================================================
     */

    const h1EMA50 =
      ema(c1, 50);

    const h1EMA200 =
      ema(c1, 200);

    const h1Struct =
      structure(h1, 20);

    let h1Direction =
      "WAIT";

    if (
      h1EMA50 != null &&
      h1EMA200 != null
    ) {
      if (
        livePrice > h1EMA200 &&
        h1EMA50 > h1EMA200
      ) {
        h1Direction = "BUY";
      } else if (
        livePrice < h1EMA200 &&
        h1EMA50 < h1EMA200
      ) {
        h1Direction = "SELL";
      }
    }

    /*
     * ============================================================
     * H1 S/R
     * ============================================================
     */

    const h1SNR =
      calculateH1SNR(
        h1,
        livePrice
      );

    /*
     * ============================================================
     * M15
     * ============================================================
     */

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
      structure(m15, 20);

    const m15BOS =
      bos(m15, 12);

    const m15CHOCH =
      choch(m15, 10);

    const m15Sweep =
      sweep(m15, 12);

    const m15Mom =
      momentum(m15);

    let m15Buy = 0;
    let m15Sell = 0;

    let rb = [];
    let rs = [];

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

    if (m15EMA20 != null) {
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

    if (m15RSI != null) {
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
     * ============================================================
     * M5
     * ============================================================
     */

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
      structure(m5, 24);

    const m5BOS =
      bos(m5, 10);

    const m5CHOCH =
      choch(m5, 8);

    const m5Sweep =
      sweep(m5, 10);

    const m5Mom =
      momentum(m5);

    let m5Buy = 0;
    let m5Sell = 0;

    let r5b = [];
    let r5s = [];

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
     * ============================================================
     * FINAL SCALP SIGNAL
     * ============================================================
     */

    let signal = "WAIT";
    let status = "WAIT";
    let execution = "WAIT";
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

    if (
      m15BuyConfirmed &&
      m5BuyTriggered
    ) {
      signal = "BUY";
      status = "ENTRY";
      execution = "READY";
      setupType =
        "M15+M5 ALIGNMENT";

      score =
        Math.round(
          (m15Buy + m5Buy) / 2
        );

      reasons = [
        "M15 BUY confirmed",
        "M5 BUY trigger confirmed",
        "M15 + M5 aligned"
      ];
    }

    else if (
      m15SellConfirmed &&
      m5SellTriggered
    ) {
      signal = "SELL";
      status = "ENTRY";
      execution = "READY";
      setupType =
        "M15+M5 ALIGNMENT";

      score =
        Math.round(
          (m15Sell + m5Sell) / 2
        );

      reasons = [
        "M15 SELL confirmed",
        "M5 SELL trigger confirmed",
        "M15 + M5 aligned"
      ];
    }

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
     * ============================================================
     * SNR ENTRY ANALYSIS
     * ============================================================
     */

    const snrAnalysis =
      h1SNR.getEntryAnalysis(
        signal
      );

    /*
     * SNR DOES NOT CANCEL THE SIGNAL.
     * It acts as confluence / warning.
     */

    if (
      signal !== "WAIT"
    ) {
      if (
        snrAnalysis.result ===
        "FAVOURABLE"
      ) {
        reasons.push(
          `H1 SNR favourable: ${snrAnalysis.reason}`
        );
      }

      if (
        snrAnalysis.result ===
        "CAUTION"
      ) {
        reasons.push(
          `H1 SNR caution: ${snrAnalysis.reason}`
        );
      }

      if (
        snrAnalysis.result ===
        "NEUTRAL"
      ) {
        reasons.push(
          `H1 SNR neutral: ${snrAnalysis.reason}`
        );
      }
    }

    /*
     * ============================================================
     * H1 HOLD
     * ============================================================
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
     * ============================================================
     * TRADE PLAN
     * ============================================================
     */

    let entry = null;
    let stopLoss = null;
    let tp1 = null;
    let tp2 = null;
    let tp3 = null;
    let rr = null;

    if (
      status === "ENTRY" &&
      m5ATR != null
    ) {
      entry = livePrice;

      const risk =
        Math.max(
          m5ATR * 1.25,
          0.8
        );

      if (signal === "BUY") {
        stopLoss =
          entry - risk;

        tp1 =
          entry + risk * 1.5;

        tp2 =
          entry + risk * 2.5;

        tp3 =
          entry + risk * 4;
      }

      else {
        stopLoss =
          entry + risk;

        tp1 =
          entry - risk * 1.5;

        tp2 =
          entry - risk * 2.5;

        tp3 =
          entry - risk * 4;
      }

      rr =
        "1 : 1.5 / 2.5 / 4.0";
    }

    /*
     * ============================================================
     * PUSH
     * ============================================================
     *
     * One automatic push per direction per M5 candle.
     */

    const signalCandle =
      m5.at(-1)?.time ||
      new Date().toISOString();

    const signalKey =
      signal !== "WAIT"
        ? `XAUUSD|${signal}|${signalCandle}`
        : null;

    if (signalKey) {
      try {
        const lockKey =
          "xau_last_entry_notification";

        const alreadyNotified =
          await redis.get(
            lockKey
          );

        if (
          alreadyNotified !==
          signalKey
        ) {
          const title =
            signal === "BUY"
              ? "🟢 XAU/USD BUY ENTRY"
              : "🔴 XAU/USD SELL ENTRY";

          const supportText =
            h1SNR.support
              ? `S ${h1SNR.support.price.toFixed(
                  2
                )} (${h1SNR.support.distance.toFixed(
                  2
                )})`
              : "S --";

          const resistanceText =
            h1SNR.resistance
              ? `R ${h1SNR.resistance.price.toFixed(
                  2
                )} (${h1SNR.resistance.distance.toFixed(
                  2
                )})`
              : "R --";

          const body = [
            `${signal} • Score ${score}/100`,
            `Entry ${entry?.toFixed(2)}`,
            `SL ${stopLoss?.toFixed(2)}`,
            `TP1 ${tp1?.toFixed(2)}`,
            `TP2 ${tp2?.toFixed(2)}`,
            `TP3 ${tp3?.toFixed(2)}`,
            `${setupType} • ${holdPermission}`,
            `H1 SNR ${snrAnalysis.result}`,
            snrAnalysis.reason,
            `${supportText} • ${resistanceText}`
          ].join(" • ");

          const delivery =
            await sendPushToAll({
              title,
              body,
              tag: signalKey,
              url: "/"
            });

          if (
            delivery.sent > 0
          ) {
            await redis.set(
              lockKey,
              signalKey,
              {
                ex: 21600
              }
            );
          }
        }
      }

      catch (pushError) {
        console.error(
          "Automatic push error:",
          pushError
        );
      }
    }

    /*
     * ============================================================
     * RESPONSE
     * ============================================================
     */

    return res.status(200).json({
      ok: true,

      symbol: CFG.symbol,

      price: livePrice,

      candlePrice,

      livePrice: {
        price: livePrice,
        source:
          "TWELVE_DATA_PRICE",
        ageSeconds:
          Math.round(
            (Date.now() -
              C.priceAt) /
              1000
          )
      },

      candles:
        m5.slice(-60),

      status,
      signal,

      signalType:
        signal === "WAIT"
          ? "NONE"
          : "TREND",

      setupType,
      execution,

      score,
      context,
      reasons,

      signalKey,
      signalCandle,

      /*
       * H1
       */

      h1: {
        direction:
          h1Direction,

        ema50:
          h1EMA50,

        ema200:
          h1EMA200,

        holdBias,

        holdPermission,

        structure:
          h1Struct
      },

      /*
       * H1 S/R
       */

      snr: {
        timeframe: "H1",

        location:
          h1SNR.location,

        bias:
          h1SNR.bias,

        quality:
          snrAnalysis.result,

        reason:
          snrAnalysis.reason,

        support:
          h1SNR.support,

        resistance:
          h1SNR.resistance,

        atr:
          h1SNR.atr,

        zoneWidth:
          h1SNR.zoneWidth,

        nearSupport:
          h1SNR.nearSupport,

        nearResistance:
          h1SNR.nearResistance
      },

      /*
       * M15
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
       * M5
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

      tradePlan: {
        entry,
        stopLoss,
        tp1,
        tp2,
        tp3,
        rr
      },

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
  }

  catch (e) {
    console.error(
      "REPAIRED SCALP ERROR",
      e
    );

    return res.status(502).json({
      ok: false,
      error:
        e.message ||
        "SCALP API ERROR"
    });
  }
}
