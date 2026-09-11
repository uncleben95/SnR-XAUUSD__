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
    srLookback: 80,
    srSwingStrength: 2,
    srMaxLevels: 12,

    // Jarak maksimum untuk dianggap dekat S/R
    srATRMultiplier: 0.50,

    // Minimum absolute distance XAU
    srMinDistance: 2.0
  };

  globalThis.__XAU_REPAIR_CACHE__ ??= {
    candles: {},
    price: null,
    priceAt: 0
  };

  const C = globalThis.__XAU_REPAIR_CACHE__;
  const now = Date.now();

  const avg = a =>
    a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;

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

    if (e12 == null || e26 == null) return null;

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

    const previousHigh = Math.max(...p.map(x => x.high));
    const previousLow = Math.min(...p.map(x => x.low));

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
      bullish: last.close > Math.max(...p.map(x => x.high)),
      bearish: last.close < Math.min(...p.map(x => x.low))
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
    const p = d.slice(-lookback * 2, -lookback);
    const last = d.at(-1);

    const rh = Math.max(...r.map(x => x.high));
    const rl = Math.min(...r.map(x => x.low));

    const ph = Math.max(...p.map(x => x.high));
    const pl = Math.min(...p.map(x => x.low));

    return {
      bullish: rh > ph && last.close > ph,
      bearish: rl < pl && last.close < pl
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
      bullish: c.low < l && c.close > l,
      bearish: c.high > h && c.close < h
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

    const range = c.high - c.low || 1e-9;
    const ratio = Math.abs(c.close - c.open) / range;

    return {
      bullish: c.close > c.open && ratio >= 0.45,
      bearish: c.close < c.open && ratio >= 0.45,
      strength: Math.round(ratio * 100)
    };
  }

  /*
   * ============================================================
   * H1 SUPPORT / RESISTANCE ENGINE
   * ============================================================
   */

  function findH1SupportResistance(data, price, h1ATR) {
    const source = data.slice(-CFG.srLookback);

    if (source.length < 20) {
      return {
        support: null,
        resistance: null,
        levels: [],
        supportDistance: null,
        resistanceDistance: null,
        supportDistancePct: null,
        resistanceDistancePct: null,
        threshold: null,
        position: "UNKNOWN",
        zone: "UNKNOWN",
        nearSupport: false,
        nearResistance: false,
        atSupport: false,
        atResistance: false,
        signalContext: "NO S/R DATA"
      };
    }

    const levels = [];

    // Swing highs
    for (
      let i = CFG.srSwingStrength;
      i < source.length - CFG.srSwingStrength;
      i++
    ) {
      const c = source[i];

      let isHigh = true;

      for (
        let j = 1;
        j <= CFG.srSwingStrength;
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

    // Swing lows
    for (
      let i = CFG.srSwingStrength;
      i < source.length - CFG.srSwingStrength;
      i++
    ) {
      const c = source[i];

      let isLow = true;

      for (
        let j = 1;
        j <= CFG.srSwingStrength;
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
     * Tambah high/low structure sebagai fallback.
     */
    levels.push({
      price: Math.max(...source.map(x => x.high)),
      type: "RESISTANCE",
      index: source.length - 1
    });

    levels.push({
      price: Math.min(...source.map(x => x.low)),
      type: "SUPPORT",
      index: source.length - 1
    });

    /*
     * Group level yang terlalu dekat.
     */
    const grouped = [];

    const groupingDistance = Math.max(
      (h1ATR || 10) * 0.20,
      1.5
    );

    for (const level of levels) {
      const existing = grouped.find(
        x =>
          x.type === level.type &&
          Math.abs(x.price - level.price) <= groupingDistance
      );

      if (existing) {
        existing.prices.push(level.price);
        existing.touches += 1;
        existing.price =
          existing.prices.reduce((a, b) => a + b, 0) /
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

    const supports = grouped
      .filter(x => x.type === "SUPPORT" && x.price < price)
      .sort((a, b) => b.price - a.price);

    const resistances = grouped
      .filter(x => x.type === "RESISTANCE" && x.price > price)
      .sort((a, b) => a.price - b.price);

    const support = supports[0] || null;
    const resistance = resistances[0] || null;

    const supportDistance =
      support ? price - support.price : null;

    const resistanceDistance =
      resistance ? resistance.price - price : null;

    const threshold = Math.max(
      (h1ATR || 10) * CFG.srATRMultiplier,
      CFG.srMinDistance
    );

    const nearSupport =
      supportDistance != null &&
      supportDistance <= threshold;

    const nearResistance =
      resistanceDistance != null &&
      resistanceDistance <= threshold;

    const atSupport =
      supportDistance != null &&
      supportDistance <= threshold * 0.35;

    const atResistance =
      resistanceDistance != null &&
      resistanceDistance <= threshold * 0.35;

    let position = "BETWEEN S/R";
    let zone = "NEUTRAL";

    if (atSupport) {
      position = "AT SUPPORT";
      zone = "SUPPORT";
    } else if (atResistance) {
      position = "AT RESISTANCE";
      zone = "RESISTANCE";
    } else if (nearSupport && nearResistance) {
      position = "BETWEEN S/R";
      zone = "TIGHT RANGE";
    } else if (nearSupport) {
      position = "NEAR SUPPORT";
      zone = "SUPPORT";
    } else if (nearResistance) {
      position = "NEAR RESISTANCE";
      zone = "RESISTANCE";
    }

    let signalContext = "NO S/R WARNING";

    if (nearResistance) {
      signalContext = "RESISTANCE NEARBY";
    }

    if (nearSupport) {
      signalContext = "SUPPORT NEARBY";
    }

    if (nearSupport && nearResistance) {
      signalContext = "TIGHT S/R RANGE";
    }

    return {
      support: support
        ? {
            price: Number(support.price.toFixed(2)),
            strength: support.touches
          }
        : null,

      resistance: resistance
        ? {
            price: Number(resistance.price.toFixed(2)),
            strength: resistance.touches
          }
        : null,

      levels: grouped
        .sort((a, b) => Math.abs(a.price - price) - Math.abs(b.price - price))
        .slice(0, CFG.srMaxLevels)
        .map(x => ({
          price: Number(x.price.toFixed(2)),
          type: x.type,
          strength: x.touches
        })),

      supportDistance:
        supportDistance != null
          ? Number(supportDistance.toFixed(2))
          : null,

      resistanceDistance:
        resistanceDistance != null
          ? Number(resistanceDistance.toFixed(2))
          : null,

      supportDistancePct:
        supportDistance != null
          ? Number((supportDistance / price * 100).toFixed(3))
          : null,

      resistanceDistancePct:
        resistanceDistance != null
          ? Number((resistanceDistance / price * 100).toFixed(3))
          : null,

      threshold: Number(threshold.toFixed(2)),

      position,
      zone,

      nearSupport,
      nearResistance,

      atSupport,
      atResistance,

      signalContext
    };
  }

  async function series(interval, outputsize, key) {
    const cache = C.candles[key];

    if (cache && now - cache.at < CFG.cacheTTL) {
      return cache.data;
    }

    const url =
      `https://api.twelvedata.com/time_series` +
      `?symbol=${encodeURIComponent(CFG.symbol)}` +
      `&interval=${interval}` +
      `&outputsize=${outputsize}` +
      `&apikey=${API_KEY}`;

    const r = await fetch(url);
    const j = await r.json();

    if (!r.ok || j.status === "error") {
      throw new Error(
        j.message || `Twelve Data ${interval} error`
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
          [x.open, x.high, x.low, x.close]
            .every(Number.isFinite)
        );

    const minRequired = {
      "5min": CFG.minM5,
      "15min": CFG.minM15,
      "1h": CFG.minH1
    }[interval];

    if (data.length < minRequired) {
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

  let m5, m15, h1, livePrice, candlePrice;

  try {
    /*
     * ============================================================
     * LOAD MARKET DATA
     * ============================================================
     */

    [m5, m15, h1] = await Promise.all([
      series("5min", CFG.m5Size, "m5"),
      series("15min", CFG.m15Size, "m15"),
      series("1h", CFG.h1Size, "h1")
    ]);

    candlePrice = m5.at(-1).close;

    if (
      C.price != null &&
      now - C.priceAt < CFG.priceTTL
    ) {
      livePrice = C.price;
    } else {
      const pr = await fetch(
        `https://api.twelvedata.com/price` +
        `?symbol=${encodeURIComponent(CFG.symbol)}` +
        `&apikey=${API_KEY}`
      );

      const pj = await pr.json();
      const p = Number(pj?.price);

      if (
        !pr.ok ||
        pj.status === "error" ||
        !Number.isFinite(p)
      ) {
        throw new Error(
          pj.message || "Live price error"
        );
      }

      livePrice = p;
      C.price = p;
      C.priceAt = Date.now();
    }

    /*
     * ============================================================
     * H1
     * ============================================================
     */

    const c5 = m5.map(x => x.close);
    const c15 = m15.map(x => x.close);
    const c1 = h1.map(x => x.close);

    const h1EMA50 = ema(c1, 50);
    const h1EMA200 = ema(c1, 200);
    const h1ATR = atr(h1);

    const h1Struct = structure(h1, 20);

    let h1Direction = "WAIT";

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
     * H1 SUPPORT / RESISTANCE
     * ============================================================
     */

    const h1SupportResistance =
      findH1SupportResistance(
        h1,
        livePrice,
        h1ATR
      );

    /*
     * ============================================================
     * M15
     * ============================================================
     */

    const m15EMA20 = ema(c15, 20);
    const m15EMA50 = ema(c15, 50);
    const m15RSI = rsi(c15);
    const m15MACD = macd(c15);
    const m15ATR = atr(m15);

    const m15Struct = structure(m15, 20);
    const m15BOS = bos(m15, 12);
    const m15CHOCH = choch(m15, 10);
    const m15Sweep = sweep(m15, 12);
    const m15Mom = momentum(m15);

    let m15Buy = 0;
    let m15Sell = 0;

    const rb = [];
    const rs = [];

    if (
      m15EMA20 != null &&
      m15EMA50 != null
    ) {
      if (m15EMA20 > m15EMA50) {
        m15Buy += 20;
        rb.push("EMA20 > EMA50");
      }

      if (m15EMA20 < m15EMA50) {
        m15Sell += 20;
        rs.push("EMA20 < EMA50");
      }
    }

    if (m15EMA20 != null) {
      if (livePrice > m15EMA20) {
        m15Buy += 10;
        rb.push("Price > EMA20");
      }

      if (livePrice < m15EMA20) {
        m15Sell += 10;
        rs.push("Price < EMA20");
      }
    }

    if (m15RSI != null) {
      if (m15RSI >= 50 && m15RSI <= 72) {
        m15Buy += 10;
        rb.push("RSI bullish");
      }

      if (m15RSI >= 28 && m15RSI < 50) {
        m15Sell += 10;
        rs.push("RSI bearish");
      }
    }

    if (m15MACD?.bullish) {
      m15Buy += 15;
      rb.push("MACD bullish");
    }

    if (m15MACD?.bearish) {
      m15Sell += 15;
      rs.push("MACD bearish");
    }

    if (m15Struct.bullish) {
      m15Buy += 15;
      rb.push("Structure bullish");
    }

    if (m15Struct.bearish) {
      m15Sell += 15;
      rs.push("Structure bearish");
    }

    if (m15BOS.bullish) {
      m15Buy += 15;
      rb.push("BOS bullish");
    }

    if (m15BOS.bearish) {
      m15Sell += 15;
      rs.push("BOS bearish");
    }

    if (m15CHOCH.bullish) {
      m15Buy += 10;
      rb.push("CHOCH bullish");
    }

    if (m15CHOCH.bearish) {
      m15Sell += 10;
      rs.push("CHOCH bearish");
    }

    if (m15Sweep.bullish) {
      m15Buy += 10;
      rb.push("Sell-side sweep");
    }

    if (m15Sweep.bearish) {
      m15Sell += 10;
      rs.push("Buy-side sweep");
    }

    if (m15Mom.bullish) {
      m15Buy += 5;
      rb.push("Momentum bullish");
    }

    if (m15Mom.bearish) {
      m15Sell += 5;
      rs.push("Momentum bearish");
    }

    m15Buy = clamp(m15Buy, 0, 100);
    m15Sell = clamp(m15Sell, 0, 100);

    const m15BuyConfirmed =
      m15Buy >= 55 &&
      m15Buy >= m15Sell + 15;

    const m15SellConfirmed =
      m15Sell >= 55 &&
      m15Sell >= m15Buy + 15;

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

    const m5EMA9 = ema(c5, 9);
    const m5EMA20 = ema(c5, 20);
    const m5EMA50 = ema(c5, 50);
    const m5RSI = rsi(c5);
    const m5MACD = macd(c5);
    const m5ATR = atr(m5);

    const m5Struct = structure(m5, 24);
    const m5BOS = bos(m5, 10);
    const m5CHOCH = choch(m5, 8);
    const m5Sweep = sweep(m5, 10);
    const m5Mom = momentum(m5);

    let m5Buy = 0;
    let m5Sell = 0;

    const r5b = [];
    const r5s = [];

    if (
      m5EMA20 != null &&
      m5EMA50 != null
    ) {
      if (m5EMA20 > m5EMA50) {
        m5Buy += 20;
        r5b.push("EMA20 > EMA50");
      }

      if (m5EMA20 < m5EMA50) {
        m5Sell += 20;
        r5s.push("EMA20 < EMA50");
      }
    }

    if (m5EMA9 != null) {
      if (livePrice > m5EMA9) {
        m5Buy += 8;
        r5b.push("Price > EMA9");
      }

      if (livePrice < m5EMA9) {
        m5Sell += 8;
        r5s.push("Price < EMA9");
      }
    }

    if (m5RSI != null) {
      if (m5RSI >= 50 && m5RSI < 75) {
        m5Buy += 10;
        r5b.push("RSI bullish");
      }

      if (m5RSI > 25 && m5RSI < 50) {
        m5Sell += 10;
        r5s.push("RSI bearish");
      }
    }

    if (m5MACD?.bullish) {
      m5Buy += 10;
      r5b.push("MACD bullish");
    }

    if (m5MACD?.bearish) {
      m5Sell += 10;
      r5s.push("MACD bearish");
    }

    if (m5Struct.bullish) {
      m5Buy += 12;
      r5b.push("Structure bullish");
    }

    if (m5Struct.bearish) {
      m5Sell += 12;
      r5s.push("Structure bearish");
    }

    if (m5BOS.bullish) {
      m5Buy += 15;
      r5b.push("BOS bullish");
    }

    if (m5BOS.bearish) {
      m5Sell += 15;
      r5s.push("BOS bearish");
    }

    if (m5CHOCH.bullish) {
      m5Buy += 12;
      r5b.push("CHOCH bullish");
    }

    if (m5CHOCH.bearish) {
      m5Sell += 12;
      r5s.push("CHOCH bearish");
    }

    if (m5Sweep.bullish) {
      m5Buy += 8;
      r5b.push("Sell-side sweep");
    }

    if (m5Sweep.bearish) {
      m5Sell += 8;
      r5s.push("Buy-side sweep");
    }

    if (m5Mom.bullish) {
      m5Buy += 5;
      r5b.push("Momentum bullish");
    }

    if (m5Mom.bearish) {
      m5Sell += 5;
      r5s.push("Momentum bearish");
    }

    m5Buy = clamp(m5Buy, 0, 100);
    m5Sell = clamp(m5Sell, 0, 100);

    const m5BuyTriggered =
      m5Buy >= 50 &&
      m5Buy >= m5Sell + 8;

    const m5SellTriggered =
      m5Sell >= 50 &&
      m5Sell >= m5Buy + 8;

    const m5Trigger =
      m5BuyTriggered
        ? "BUY"
        : m5SellTriggered
          ? "SELL"
          : "WAIT";

    /*
     * ============================================================
     * RAW M15 + M5 ALIGNMENT
     * ============================================================
     */

    const rawBuyAlignment =
      m15BuyConfirmed &&
      m5BuyTriggered;

    const rawSellAlignment =
      m15SellConfirmed &&
      m5SellTriggered;

    /*
     * ============================================================
     * S/R ENTRY FILTER
     *
     * BUY:
     * - Jangan BUY terlalu dekat H1 resistance.
     *
     * SELL:
     * - Jangan SELL terlalu dekat H1 support.
     *
     * BUY dekat support = good context.
     * SELL dekat resistance = good context.
     * ============================================================
     */

    let srBuyAllowed = true;
    let srSellAllowed = true;

    let srBuyContext = "NEUTRAL";
    let srSellContext = "NEUTRAL";

    if (h1SupportResistance.nearResistance) {
      srBuyAllowed = false;
      srBuyContext = "BLOCKED_NEAR_RESISTANCE";
    }

    if (h1SupportResistance.nearSupport) {
      srSellAllowed = false;
      srSellContext = "BLOCKED_NEAR_SUPPORT";
    }

    if (h1SupportResistance.nearSupport) {
      srBuyContext = "BUY_NEAR_SUPPORT";
    }

    if (h1SupportResistance.nearResistance) {
      srSellContext = "SELL_NEAR_RESISTANCE";
    }

    /*
     * ============================================================
     * FINAL SIGNAL
     * ============================================================
     */

    let signal = "WAIT";
    let status = "WAIT";
    let execution = "WAIT";
    let setupType = "NO ALIGNMENT";

    let score = Math.round(
      Math.max(
        m15Buy,
        m15Sell,
        m5Buy,
        m5Sell
      )
    );

    let reasons = [];

    if (rawBuyAlignment) {
      if (srBuyAllowed) {
        signal = "BUY";
        status = "ENTRY";
        execution = "READY";
        setupType = "M15+M5 ALIGNMENT + H1 S/R";
        score = Math.round(
          (m15Buy + m5Buy) / 2
        );

        reasons = [
          "M15 BUY confirmed",
          "M5 BUY trigger confirmed",
          "M15 + M5 aligned",
          `H1 S/R: ${h1SupportResistance.position}`,
          h1SupportResistance.nearSupport
            ? "BUY near H1 support"
            : "H1 resistance clear"
        ];
      } else {
        reasons = [
          "M15 BUY confirmed",
          "M5 BUY trigger confirmed",
          "BUY BLOCKED",
          "Too close to H1 resistance",
          `Resistance ${h1SupportResistance.resistance?.price ?? "N/A"}`
        ];
      }
    } else if (rawSellAlignment) {
      if (srSellAllowed) {
        signal = "SELL";
        status = "ENTRY";
        execution = "READY";
        setupType = "M15+M5 ALIGNMENT + H1 S/R";
        score = Math.round(
          (m15Sell + m5Sell) / 2
        );

        reasons = [
          "M15 SELL confirmed",
          "M5 SELL trigger confirmed",
          "M15 + M5 aligned",
          `H1 S/R: ${h1SupportResistance.position}`,
          h1SupportResistance.nearResistance
            ? "SELL near H1 resistance"
            : "H1 support clear"
        ];
      } else {
        reasons = [
          "M15 SELL confirmed",
          "M5 SELL trigger confirmed",
          "SELL BLOCKED",
          "Too close to H1 support",
          `Support ${h1SupportResistance.support?.price ?? "N/A"}`
        ];
      }
    } else if (
      m15BuyConfirmed &&
      m5SellTriggered
    ) {
      reasons = [
        "M15 BUY vs M5 SELL — conflicting"
      ];
    } else if (
      m15SellConfirmed &&
      m5BuyTriggered
    ) {
      reasons = [
        "M15 SELL vs M5 BUY — conflicting"
      ];
    } else if (
      m15BuyConfirmed ||
      m15SellConfirmed ||
      m5BuyTriggered ||
      m5SellTriggered
    ) {
      reasons = [
        "Waiting for timeframe alignment"
      ];
    } else {
      reasons = [
        "M15 + M5 not aligned"
      ];
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

      const risk = Math.max(
        m5ATR * 1.25,
        0.8
      );

      if (signal === "BUY") {
        stopLoss = entry - risk;
        tp1 = entry + risk * 1.5;
        tp2 = entry + risk * 2.5;
        tp3 = entry + risk * 4;
      } else {
        stopLoss = entry + risk;
        tp1 = entry - risk * 1.5;
        tp2 = entry - risk * 2.5;
        tp3 = entry - risk * 4;
      }

      rr = "1 : 1.5 / 2.5 / 4.0";
    }

    /*
     * ============================================================
     * PUSH NOTIFICATION
     * ============================================================
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
          await redis.get(lockKey);

        if (
          alreadyNotified !== signalKey
        ) {
          const title =
            signal === "BUY"
              ? "🟢 XAU/USD BUY ENTRY"
              : "🔴 XAU/USD SELL ENTRY";

          const srText =
            signal === "BUY"
              ? h1SupportResistance.nearSupport
                ? `H1 SUPPORT ${h1SupportResistance.support?.price}`
                : "H1 RESISTANCE CLEAR"
              : h1SupportResistance.nearResistance
                ? `H1 RESISTANCE ${h1SupportResistance.resistance?.price}`
                : "H1 SUPPORT CLEAR";

          const body = [
            `${signal} • Score ${score}/100`,
            `Entry ${entry?.toFixed(2)}`,
            `SL ${stopLoss?.toFixed(2)}`,
            `TP1 ${tp1?.toFixed(2)}`,
            `TP2 ${tp2?.toFixed(2)}`,
            `TP3 ${tp3?.toFixed(2)}`,
            `${setupType}`,
            `${srText}`,
            `${holdPermission}`
          ].join(" • ");

          const delivery =
            await sendPushToAll({
              title,
              body,
              tag: signalKey,
              url: "/"
            });

          if (delivery.sent > 0) {
            await redis.set(
              lockKey,
              signalKey,
              { ex: 21600 }
            );
          }
        }
      } catch (pushError) {
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
        source: "TWELVE_DATA_PRICE",
        ageSeconds: Math.round(
          (Date.now() - C.priceAt) / 1000
        )
      },

      candles: m5.slice(-60),

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
        direction: h1Direction,

        ema50: h1EMA50,
        ema200: h1EMA200,
        atr: h1ATR,

        holdBias,
        holdPermission,

        structure: h1Struct,

        /*
         * MAIN H1 S/R
         */
        supportResistance:
          h1SupportResistance,

        /*
         * S/R FILTER
         */
        srFilter: {
          buyAllowed: srBuyAllowed,
          sellAllowed: srSellAllowed,

          buyContext: srBuyContext,
          sellContext: srSellContext,

          buyBlocked:
            !srBuyAllowed,

          sellBlocked:
            !srSellAllowed
        }
      },

      /*
       * M15
       */
      m15: {
        direction: m15Confirmation,
        confirmation: m15Confirmation,

        buyScore: m15Buy,
        sellScore: m15Sell,

        buyConfirmed:
          m15BuyConfirmed,

        sellConfirmed:
          m15SellConfirmed,

        ema20: m15EMA20,
        ema50: m15EMA50,

        rsi: m15RSI,
        macd: m15MACD,
        atr: m15ATR,

        bos: m15BOS,
        choch: m15CHOCH,
        sweep: m15Sweep,
        momentum: m15Mom,

        structure: m15Struct,

        buyReasons: rb,
        sellReasons: rs
      },

      /*
       * M5
       */
      m5: {
        trigger: m5Trigger,
        confirmation: m5Trigger,

        buyScore: m5Buy,
        sellScore: m5Sell,

        buyTriggered:
          m5BuyTriggered,

        sellTriggered:
          m5SellTriggered,

        ema9: m5EMA9,
        ema20: m5EMA20,
        ema50: m5EMA50,

        rsi: m5RSI,
        macd: m5MACD,
        atr: m5ATR,

        bos: m5BOS,
        choch: m5CHOCH,
        sweep: m5Sweep,
        momentum: m5Mom,

        structure: m5Struct,

        buyReasons: r5b,
        sellReasons: r5s
      },

      /*
       * FINAL TRADE PLAN
       */
      tradePlan: {
        entry,
        stopLoss,
        tp1,
        tp2,
        tp3,
        rr
      },

      /*
       * S/R SUMMARY
       */
      srAnalysis: {
        timeframe: "H1",

        currentPrice: livePrice,

        support:
          h1SupportResistance.support,

        resistance:
          h1SupportResistance.resistance,

        position:
          h1SupportResistance.position,

        zone:
          h1SupportResistance.zone,

        supportDistance:
          h1SupportResistance.supportDistance,

        resistanceDistance:
          h1SupportResistance.resistanceDistance,

        threshold:
          h1SupportResistance.threshold,

        nearSupport:
          h1SupportResistance.nearSupport,

        nearResistance:
          h1SupportResistance.nearResistance,

        atSupport:
          h1SupportResistance.atSupport,

        atResistance:
          h1SupportResistance.atResistance,

        signalContext:
          h1SupportResistance.signalContext,

        buyAllowed: srBuyAllowed,
        sellAllowed: srSellAllowed,

        buyContext: srBuyContext,
        sellContext: srSellContext
      },

      data: {
        m5Candles: m5.length,
        m15Candles: m15.length,
        h1Candles: h1.length
      },

      timestamp:
        new Date().toISOString()
    });

  } catch (e) {
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
