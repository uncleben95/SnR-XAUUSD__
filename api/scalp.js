export default async function handler(req, res) {
  try {
    const API_KEY = process.env.TWELVE_DATA_API_KEY;

    if (!API_KEY) {
      return res.status(500).json({
        ok: false,
        error: "TWELVE_DATA_API_KEY belum diset"
      });
    }

    const CFG = {
      symbol: "XAU/USD",
      candles: 2500,

      // 1 Twelve Data request / 60s
      cacheTTL: 60 * 1000,

      // M15
      M15_CONFIRM_SCORE: 55,
      M15_CONFIRM_GAP: 15,
      M15_DEVELOPING_SCORE: 45,
      M15_DEVELOPING_GAP: 10,

      // M5
      M5_TRIGGER_SCORE: 50,
      M5_TRIGGER_GAP: 8,

      // M5 standalone scalp
      M5_ONLY_SCORE: 55,
      M5_ONLY_GAP: 12
    };

    // =====================================================
    // CACHE
    // =====================================================

    globalThis.__XAU_SCALP_CACHE__ ??= {
      data: null,
      fetchedAt: 0
    };

    const cache = globalThis.__XAU_SCALP_CACHE__;
    const now = Date.now();

    let candles;

    if (
      cache.data &&
      now - cache.fetchedAt < CFG.cacheTTL
    ) {
      candles = cache.data;
    } else {

      const url =
        `https://api.twelvedata.com/time_series` +
        `?symbol=${encodeURIComponent(CFG.symbol)}` +
        `&interval=5min` +
        `&outputsize=${CFG.candles}` +
        `&apikey=${API_KEY}`;

      const response = await fetch(url);
      const data = await response.json();

      if (
        !response.ok ||
        data.status === "error"
      ) {
        if (cache.data) {
          candles = cache.data;
        } else {
          return res.status(502).json({
            ok: false,
            error:
              data.message ||
              "Twelve Data API error"
          });
        }
      } else {

        candles =
          (data.values || [])
            .reverse()
            .map(c => ({
              time: c.datetime,
              open: Number(c.open),
              high: Number(c.high),
              low: Number(c.low),
              close: Number(c.close),
              volume: Number(c.volume) || 1
            }))
            .filter(c =>
              Number.isFinite(c.open) &&
              Number.isFinite(c.high) &&
              Number.isFinite(c.low) &&
              Number.isFinite(c.close)
            );

        if (candles.length < 250) {
          return res.status(422).json({
            ok: false,
            error: "Candle M5 tidak mencukupi",
            count: candles.length
          });
        }

        cache.data = candles;
        cache.fetchedAt = now;
      }
    }

    // =====================================================
    // HELPERS
    // =====================================================

    const avg = arr =>
      arr.length
        ? arr.reduce((a, b) => a + b, 0) / arr.length
        : null;

    const highest = arr =>
      arr.length
        ? Math.max(...arr)
        : null;

    const lowest = arr =>
      arr.length
        ? Math.min(...arr)
        : null;

    const clamp = (n, min, max) =>
      Math.max(min, Math.min(max, n));

    // =====================================================
    // EMA
    // =====================================================

    function ema(values, period) {
      if (values.length < period) return null;

      const k = 2 / (period + 1);

      let value = avg(
        values.slice(0, period)
      );

      for (
        let i = period;
        i < values.length;
        i++
      ) {
        value =
          values[i] * k +
          value * (1 - k);
      }

      return value;
    }

    // =====================================================
    // EMA SERIES
    // =====================================================

    function emaSeries(values, period) {
      if (values.length < period) return [];

      const k = 2 / (period + 1);

      let current =
        avg(values.slice(0, period));

      const result =
        Array(period - 1).fill(null);

      result.push(current);

      for (
        let i = period;
        i < values.length;
        i++
      ) {
        current =
          values[i] * k +
          current * (1 - k);

        result.push(current);
      }

      return result;
    }

    // =====================================================
    // RSI
    // =====================================================

    function rsi(values, period = 14) {
      if (values.length < period + 1) {
        return null;
      }

      let gain = 0;
      let loss = 0;

      const start =
        values.length - period;

      for (
        let i = start;
        i < values.length;
        i++
      ) {
        const change =
          values[i] - values[i - 1];

        if (change > 0) {
          gain += change;
        } else if (change < 0) {
          loss -= change;
        }
      }

      if (loss === 0) return 100;

      const rs =
        (gain / period) /
        (loss / period);

      return 100 - 100 / (1 + rs);
    }

    // =====================================================
    // ATR
    // =====================================================

    function atr(data, period = 14) {
      if (data.length < period + 1) {
        return null;
      }

      const trs = [];

      for (
        let i = 1;
        i < data.length;
        i++
      ) {
        const h = data[i].high;
        const l = data[i].low;
        const pc = data[i - 1].close;

        trs.push(
          Math.max(
            h - l,
            Math.abs(h - pc),
            Math.abs(l - pc)
          )
        );
      }

      return avg(trs.slice(-period));
    }

    // =====================================================
    // MACD
    // =====================================================

    function macd(values) {
      if (values.length < 40) {
        return null;
      }

      const fast =
        emaSeries(values, 12);

      const slow =
        emaSeries(values, 26);

      const lines = [];

      for (
        let i = 0;
        i < values.length;
        i++
      ) {
        if (
          fast[i] !== null &&
          slow[i] !== null
        ) {
          lines.push(
            fast[i] - slow[i]
          );
        }
      }

      if (lines.length < 9) {
        return null;
      }

      const line = lines.at(-1);
      const signal = ema(lines, 9);

      if (signal === null) return null;

      return {
        line,
        signal,
        histogram: line - signal,
        bullish: line > signal,
        bearish: line < signal
      };
    }

    // =====================================================
    // AGGREGATE M5 → M15 / H1
    // =====================================================

    function aggregate(data, minutes) {
      const size =
        minutes * 60 * 1000;

      const buckets = new Map();

      for (const c of data) {

        const timestamp =
          new Date(c.time).getTime();

        const key =
          Math.floor(timestamp / size) * size;

        if (!buckets.has(key)) {

          buckets.set(key, {
            time:
              new Date(key).toISOString(),
            open: c.open,
            high: c.high,
            low: c.low,
            close: c.close,
            volume: c.volume
          });

        } else {

          const b = buckets.get(key);

          b.high =
            Math.max(b.high, c.high);

          b.low =
            Math.min(b.low, c.low);

          b.close = c.close;
          b.volume += c.volume;
        }
      }

      return [
        ...buckets.values()
      ].sort(
        (a, b) =>
          new Date(a.time) -
          new Date(b.time)
      );
    }

    // =====================================================
    // STRUCTURE
    // =====================================================

    function structure(data, lookback = 20) {

      if (
        data.length <
        lookback * 2
      ) {
        return {
          bullish: false,
          bearish: false,
          high: null,
          low: null,
          previousHigh: null,
          previousLow: null
        };
      }

      const recent =
        data.slice(-lookback);

      const previous =
        data.slice(
          -lookback * 2,
          -lookback
        );

      const high =
        highest(
          recent.map(c => c.high)
        );

      const low =
        lowest(
          recent.map(c => c.low)
        );

      const previousHigh =
        highest(
          previous.map(c => c.high)
        );

      const previousLow =
        lowest(
          previous.map(c => c.low)
        );

      const last = data.at(-1);

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

    // =====================================================
    // BOS
    // =====================================================

    function detectBOS(data, lookback = 10) {

      if (
        data.length <
        lookback + 2
      ) {
        return {
          bullish: false,
          bearish: false
        };
      }

      const last = data.at(-1);

      const previous =
        data.slice(
          -lookback - 1,
          -1
        );

      const high =
        highest(
          previous.map(c => c.high)
        );

      const low =
        lowest(
          previous.map(c => c.low)
        );

      return {
        bullish:
          last.close > high,

        bearish:
          last.close < low
      };
    }

    // =====================================================
    // CHOCH
    // =====================================================

    function detectCHOCH(data, lookback = 8) {

      if (
        data.length <
        lookback * 2 + 2
      ) {
        return {
          bullish: false,
          bearish: false
        };
      }

      const recent =
        data.slice(-lookback);

      const previous =
        data.slice(
          -lookback * 2,
          -lookback
        );

      const recentHigh =
        highest(
          recent.map(c => c.high)
        );

      const recentLow =
        lowest(
          recent.map(c => c.low)
        );

      const previousHigh =
        highest(
          previous.map(c => c.high)
        );

      const previousLow =
        lowest(
          previous.map(c => c.low)
        );

      const last = data.at(-1);

      return {
        bullish:
          recentHigh > previousHigh &&
          last.close > previousHigh,

        bearish:
          recentLow < previousLow &&
          last.close < previousLow
      };
    }

    // =====================================================
    // LIQUIDITY SWEEP
    // =====================================================

    function liquiditySweep(data, lookback = 10) {

      if (
        data.length <
        lookback + 2
      ) {
        return {
          bullish: false,
          bearish: false
        };
      }

      const current = data.at(-1);

      const previous =
        data.slice(
          -lookback - 1,
          -1
        );

      const high =
        highest(
          previous.map(c => c.high)
        );

      const low =
        lowest(
          previous.map(c => c.low)
        );

      return {
        bullish:
          current.low < low &&
          current.close > low,

        bearish:
          current.high > high &&
          current.close < high
      };
    }

    // =====================================================
    // MOMENTUM
    // =====================================================

    function candleMomentum(data) {

      const c = data.at(-1);

      if (!c) {
        return {
          bullish: false,
          bearish: false,
          strength: 0
        };
      }

      const range =
        c.high - c.low || 0.00001;

      const body =
        Math.abs(
          c.close - c.open
        );

      const ratio =
        body / range;

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

    // =====================================================
    // MANIPULATION
    // =====================================================

    function detectManipulation(data, lookback = 12) {

      if (
        data.length <
        lookback + 2
      ) {
        return {
          bullish: false,
          bearish: false
        };
      }

      const current = data.at(-1);

      const previous =
        data.slice(
          -lookback - 1,
          -1
        );

      const previousHigh =
        highest(
          previous.map(c => c.high)
        );

      const previousLow =
        lowest(
          previous.map(c => c.low)
        );

      const range =
        current.high -
        current.low ||
        0.00001;

      const upperWick =
        current.high -
        Math.max(
          current.open,
          current.close
        );

      const lowerWick =
        Math.min(
          current.open,
          current.close
        ) -
        current.low;

      return {
        bullish:
          current.low < previousLow &&
          current.close > previousLow &&
          lowerWick / range >= 0.30,

        bearish:
          current.high > previousHigh &&
          current.close < previousHigh &&
          upperWick / range >= 0.30
      };
    }

    // =====================================================
    // TIMEFRAMES
    // =====================================================

    const m5 = candles;
    const m15 = aggregate(candles, 15);
    const h1 = aggregate(candles, 60);

    const c5 = m5.map(c => c.close);
    const c15 = m15.map(c => c.close);
    const c1 = h1.map(c => c.close);

    const price = c5.at(-1);

    // =====================================================
    // H1 CONTEXT
    // =====================================================

    const h1EMA50 = ema(c1, 50);
    const h1EMA200 = ema(c1, 200);

    let h1Direction = "WAIT";

    if (
      h1EMA50 !== null &&
      h1EMA200 !== null
    ) {

      if (
        price > h1EMA200 &&
        h1EMA50 > h1EMA200
      ) {
        h1Direction = "BUY";

      } else if (
        price < h1EMA200 &&
        h1EMA50 < h1EMA200
      ) {
        h1Direction = "SELL";
      }
    }

    // =====================================================
    // M15
    // =====================================================

    const m15EMA20 = ema(c15, 20);
    const m15EMA50 = ema(c15, 50);
    const m15RSI = rsi(c15);
    const m15MACD = macd(c15);
    const m15ATR = atr(m15);

    const m15Structure =
      structure(m15, 20);

    const m15BOS =
      detectBOS(m15, 12);

    const m15CHOCH =
      detectCHOCH(m15, 10);

    const m15Sweep =
      liquiditySweep(m15, 12);

    const m15Manipulation =
      detectManipulation(m15, 12);

    const m15Momentum =
      candleMomentum(m15);

    let m15Buy = 0;
    let m15Sell = 0;

    const m15BuyReasons = [];
    const m15SellReasons = [];

    if (
      m15EMA20 !== null &&
      m15EMA50 !== null
    ) {

      if (m15EMA20 > m15EMA50) {
        m15Buy += 20;
        m15BuyReasons.push(
          "EMA20 > EMA50"
        );
      }

      if (m15EMA20 < m15EMA50) {
        m15Sell += 20;
        m15SellReasons.push(
          "EMA20 < EMA50"
        );
      }
    }

    if (m15EMA20 !== null) {

      if (price > m15EMA20) {
        m15Buy += 10;
        m15BuyReasons.push(
          "Price above EMA20"
        );
      }

      if (price < m15EMA20) {
        m15Sell += 10;
        m15SellReasons.push(
          "Price below EMA20"
        );
      }
    }

    if (m15RSI !== null) {

      if (
        m15RSI >= 50 &&
        m15RSI <= 72
      ) {
        m15Buy += 10;
        m15BuyReasons.push(
          "RSI bullish"
        );
      }

      if (
        m15RSI >= 28 &&
        m15RSI < 50
      ) {
        m15Sell += 10;
        m15SellReasons.push(
          "RSI bearish"
        );
      }
    }

    if (m15MACD?.bullish) {
      m15Buy += 15;
      m15BuyReasons.push(
        "MACD bullish"
      );
    }

    if (m15MACD?.bearish) {
      m15Sell += 15;
      m15SellReasons.push(
        "MACD bearish"
      );
    }

    if (m15Structure.bullish) {
      m15Buy += 15;
      m15BuyReasons.push(
        "Bullish structure"
      );
    }

    if (m15Structure.bearish) {
      m15Sell += 15;
      m15SellReasons.push(
        "Bearish structure"
      );
    }

    if (m15BOS.bullish) {
      m15Buy += 15;
      m15BuyReasons.push(
        "Bullish BOS"
      );
    }

    if (m15BOS.bearish) {
      m15Sell += 15;
      m15SellReasons.push(
        "Bearish BOS"
      );
    }

    if (m15CHOCH.bullish) {
      m15Buy += 10;
      m15BuyReasons.push(
        "Bullish CHOCH"
      );
    }

    if (m15CHOCH.bearish) {
      m15Sell += 10;
      m15SellReasons.push(
        "Bearish CHOCH"
      );
    }

    if (m15Sweep.bullish) {
      m15Buy += 10;
      m15BuyReasons.push(
        "Sell-side liquidity sweep"
      );
    }

    if (m15Sweep.bearish) {
      m15Sell += 10;
      m15SellReasons.push(
        "Buy-side liquidity sweep"
      );
    }

    if (m15Manipulation.bullish) {
      m15Buy += 10;
      m15BuyReasons.push(
        "Bullish manipulation rejection"
      );
    }

    if (m15Manipulation.bearish) {
      m15Sell += 10;
      m15SellReasons.push(
        "Bearish manipulation rejection"
      );
    }

    if (m15Momentum.bullish) {
      m15Buy += 5;
      m15BuyReasons.push(
        "Bullish momentum"
      );
    }

    if (m15Momentum.bearish) {
      m15Sell += 5;
      m15SellReasons.push(
        "Bearish momentum"
      );
    }

    m15Buy = clamp(m15Buy, 0, 100);
    m15Sell = clamp(m15Sell, 0, 100);

    const m15BuyConfirmed =
      m15Buy >= CFG.M15_CONFIRM_SCORE &&
      m15Buy >=
        m15Sell +
        CFG.M15_CONFIRM_GAP;

    const m15SellConfirmed =
      m15Sell >= CFG.M15_CONFIRM_SCORE &&
      m15Sell >=
        m15Buy +
        CFG.M15_CONFIRM_GAP;

    const m15BuyDeveloping =
      m15Buy >= CFG.M15_DEVELOPING_SCORE &&
      m15Buy >=
        m15Sell +
        CFG.M15_DEVELOPING_GAP;

    const m15SellDeveloping =
      m15Sell >= CFG.M15_DEVELOPING_SCORE &&
      m15Sell >=
        m15Buy +
        CFG.M15_DEVELOPING_GAP;

    let m15Confirmation = "WAIT";

    if (m15BuyConfirmed) {
      m15Confirmation = "BUY";
    } else if (m15SellConfirmed) {
      m15Confirmation = "SELL";
    } else if (m15BuyDeveloping) {
      m15Confirmation = "BUY";
    } else if (m15SellDeveloping) {
      m15Confirmation = "SELL";
    }

    // =====================================================
    // M15 REVERSAL
    // =====================================================

    let m15Reversal = "NONE";

    const bullishReversal =
      (
        m15Sweep.bullish ||
        m15Manipulation.bullish
      ) &&
      (
        m15BOS.bullish ||
        m15CHOCH.bullish
      ) &&
      m15MACD?.bullish &&
      m15RSI !== null &&
      m15RSI >= 45;

    const bearishReversal =
      (
        m15Sweep.bearish ||
        m15Manipulation.bearish
      ) &&
      (
        m15BOS.bearish ||
        m15CHOCH.bearish
      ) &&
      m15MACD?.bearish &&
      m15RSI !== null &&
      m15RSI <= 55;

    if (bullishReversal) {
      m15Reversal = "BUY";
    } else if (bearishReversal) {
      m15Reversal = "SELL";
    }

    // =====================================================
    // M5
    // =====================================================

    const m5EMA9 = ema(c5, 9);
    const m5EMA20 = ema(c5, 20);
    const m5EMA50 = ema(c5, 50);
    const m5RSI = rsi(c5);
    const m5MACD = macd(c5);
    const m5ATR = atr(m5);

    const m5Structure =
      structure(m5, 24);

    const m5BOS =
      detectBOS(m5, 10);

    const m5CHOCH =
      detectCHOCH(m5, 8);

    const m5Sweep =
      liquiditySweep(m5, 10);

    const m5Manipulation =
      detectManipulation(m5, 10);

    const m5Momentum =
      candleMomentum(m5);

    let m5Buy = 0;
    let m5Sell = 0;

    const m5BuyReasons = [];
    const m5SellReasons = [];

    if (
      m5EMA9 !== null &&
      m5EMA20 !== null
    ) {

      if (m5EMA9 > m5EMA20) {
        m5Buy += 15;
        m5BuyReasons.push(
          "EMA9 > EMA20"
        );
      }

      if (m5EMA9 < m5EMA20) {
        m5Sell += 15;
        m5SellReasons.push(
          "EMA9 < EMA20"
        );
      }
    }

    if (
      m5EMA20 !== null &&
      m5EMA50 !== null
    ) {

      if (m5EMA20 > m5EMA50) {
        m5Buy += 15;
        m5BuyReasons.push(
          "EMA20 > EMA50"
        );
      }

      if (m5EMA20 < m5EMA50) {
        m5Sell += 15;
        m5SellReasons.push(
          "EMA20 < EMA50"
        );
      }
    }

    if (m5RSI !== null) {

      if (
        m5RSI >= 50 &&
        m5RSI <= 75
      ) {
        m5Buy += 10;
        m5BuyReasons.push(
          "RSI bullish"
        );
      }

      if (
        m5RSI >= 25 &&
        m5RSI < 50
      ) {
        m5Sell += 10;
        m5SellReasons.push(
          "RSI bearish"
        );
      }
    }

    if (m5MACD?.bullish) {
      m5Buy += 15;
      m5BuyReasons.push(
        "MACD bullish"
      );
    }

    if (m5MACD?.bearish) {
      m5Sell += 15;
      m5SellReasons.push(
        "MACD bearish"
      );
    }

    if (m5Structure.bullish) {
      m5Buy += 10;
      m5BuyReasons.push(
        "Bullish structure"
      );
    }

    if (m5Structure.bearish) {
      m5Sell += 10;
      m5SellReasons.push(
        "Bearish structure"
      );
    }

    if (m5BOS.bullish) {
      m5Buy += 15;
      m5BuyReasons.push(
        "Bullish BOS"
      );
    }

    if (m5BOS.bearish) {
      m5Sell += 15;
      m5SellReasons.push(
        "Bearish BOS"
      );
    }

    if (m5CHOCH.bullish) {
      m5Buy += 10;
      m5BuyReasons.push(
        "Bullish CHOCH"
      );
    }

    if (m5CHOCH.bearish) {
      m5Sell += 10;
      m5SellReasons.push(
        "Bearish CHOCH"
      );
    }

    if (m5Sweep.bullish) {
      m5Buy += 10;
      m5BuyReasons.push(
        "Sell-side liquidity sweep"
      );
    }

    if (m5Sweep.bearish) {
      m5Sell += 10;
      m5SellReasons.push(
        "Buy-side liquidity sweep"
      );
    }

    if (m5Manipulation.bullish) {
      m5Buy += 10;
      m5BuyReasons.push(
        "Bullish manipulation rejection"
      );
    }

    if (m5Manipulation.bearish) {
      m5Sell += 10;
      m5SellReasons.push(
        "Bearish manipulation rejection"
      );
    }

    if (m5Momentum.bullish) {
      m5Buy += 10;
      m5BuyReasons.push(
        "Bullish momentum"
      );
    }

    if (m5Momentum.bearish) {
      m5Sell += 10;
      m5SellReasons.push(
        "Bearish momentum"
      );
    }

    m5Buy = clamp(m5Buy, 0, 100);
    m5Sell = clamp(m5Sell, 0, 100);

    // =====================================================
    // M5 BASE
    // =====================================================

    const m5BuyBase =
      m5EMA9 !== null &&
      m5EMA20 !== null &&
      m5EMA50 !== null &&
      m5RSI !== null &&
      m5EMA9 > m5EMA20 &&
      price > m5EMA20 &&
      m5RSI >= 50;

    const m5SellBase =
      m5EMA9 !== null &&
      m5EMA20 !== null &&
      m5EMA50 !== null &&
      m5RSI !== null &&
      m5EMA9 < m5EMA20 &&
      price < m5EMA20 &&
      m5RSI < 50;

    // =====================================================
    // M5 MOMENTUM TRIGGER
    // =====================================================

    const m5BuyMomentum =
      (
        m5MACD?.bullish ||
        m5Momentum.bullish ||
        m5BOS.bullish ||
        m5CHOCH.bullish ||
        m5Sweep.bullish ||
        m5Manipulation.bullish ||
        m5Structure.bullish
      );

    const m5SellMomentum =
      (
        m5MACD?.bearish ||
        m5Momentum.bearish ||
        m5BOS.bearish ||
        m5CHOCH.bearish ||
        m5Sweep.bearish ||
        m5Manipulation.bearish ||
        m5Structure.bearish
      );

    const m5BuyTriggered =
      m5BuyBase &&
      m5BuyMomentum &&
      m5Buy >= CFG.M5_TRIGGER_SCORE &&
      m5Buy >=
        m5Sell +
        CFG.M5_TRIGGER_GAP;

    const m5SellTriggered =
      m5SellBase &&
      m5SellMomentum &&
      m5Sell >= CFG.M5_TRIGGER_SCORE &&
      m5Sell >=
        m5Buy +
        CFG.M5_TRIGGER_GAP;

    let m5Trigger = "WAIT";

    if (m5BuyTriggered) {
      m5Trigger = "BUY";
    } else if (m5SellTriggered) {
      m5Trigger = "SELL";
    }

    // =====================================================
    // M5 ONLY
    // =====================================================

    const m5OnlyBuy =
      m5BuyBase &&
      m5BuyMomentum &&
      m5Buy >= CFG.M5_ONLY_SCORE &&
      m5Buy >=
        m5Sell +
        CFG.M5_ONLY_GAP;

    const m5OnlySell =
      m5SellBase &&
      m5SellMomentum &&
      m5Sell >= CFG.M5_ONLY_SCORE &&
      m5Sell >=
        m5Buy +
        CFG.M5_ONLY_GAP;

    // =====================================================
    // FINAL SIGNAL
    // =====================================================

    let status = "WAIT";
    let signal = "WAIT";
    let signalType = "NONE";
    let setupType = "NONE";
    let execution = "WAIT";
    let score = 0;

    const reasons = [];

    // =====================================================
    // CONTINUATION
    // =====================================================

    if (
      m15BuyConfirmed &&
      m5BuyTriggered
    ) {

      status = "ENTRY";
      signal = "BUY";
      signalType = "TREND";
      setupType = "CONTINUATION";
      execution = "READY";

      score =
        Math.round(
          (m15Buy + m5Buy) / 2
        );

      reasons.push(
        "M15 confirmed bullish"
      );

      reasons.push(
        "M5 bullish trigger"
      );

    } else if (
      m15SellConfirmed &&
      m5SellTriggered
    ) {

      status = "ENTRY";
      signal = "SELL";
      signalType = "TREND";
      setupType = "CONTINUATION";
      execution = "READY";

      score =
        Math.round(
          (m15Sell + m5Sell) / 2
        );

      reasons.push(
        "M15 confirmed bearish"
      );

      reasons.push(
        "M5 bearish trigger"
      );
    }

    // =====================================================
    // REVERSAL
    // =====================================================

    if (
      status === "WAIT" &&
      m15Reversal === "BUY" &&
      m5BuyTriggered &&
      (
        m5BOS.bullish ||
        m5CHOCH.bullish
      )
    ) {

      status = "ENTRY";
      signal = "BUY";
      signalType = "REVERSAL";
      setupType = "REVERSAL";
      execution = "READY";

      score =
        Math.round(
          (m15Buy + m5Buy) / 2
        );

      reasons.push(
        "M15 bullish reversal"
      );

      reasons.push(
        "Liquidity/manipulation rejection confirmed"
      );

      reasons.push(
        "M5 bullish structure confirmation"
      );

    } else if (
      status === "WAIT" &&
      m15Reversal === "SELL" &&
      m5SellTriggered &&
      (
        m5BOS.bearish ||
        m5CHOCH.bearish
      )
    ) {

      status = "ENTRY";
      signal = "SELL";
      signalType = "REVERSAL";
      setupType = "REVERSAL";
      execution = "READY";

      score =
        Math.round(
          (m15Sell + m5Sell) / 2
        );

      reasons.push(
        "M15 bearish reversal"
      );

      reasons.push(
        "Liquidity/manipulation rejection confirmed"
      );

      reasons.push(
        "M5 bearish structure confirmation"
      );
    }

    // =====================================================
    // DEVELOPING
    // =====================================================

    if (
      status === "WAIT" &&
      m15BuyDeveloping &&
      m5BuyTriggered
    ) {

      status = "EARLY";
      signal = "BUY";
      signalType = "TREND";
      setupType = "CONTINUATION";
      execution = "MONITOR";

      score =
        Math.round(
          (m15Buy + m5Buy) / 2
        );

      reasons.push(
        "M15 developing bullish"
      );

      reasons.push(
        "M5 bullish trigger"
      );

    } else if (
      status === "WAIT" &&
      m15SellDeveloping &&
      m5SellTriggered
    ) {

      status = "EARLY";
      signal = "SELL";
      signalType = "TREND";
      setupType = "CONTINUATION";
      execution = "MONITOR";

      score =
        Math.round(
          (m15Sell + m5Sell) / 2
        );

      reasons.push(
        "M15 developing bearish"
      );

      reasons.push(
        "M5 bearish trigger"
      );
    }

    // =====================================================
    // EARLY REVERSAL
    // =====================================================

    if (
      status === "WAIT" &&
      m15Reversal === "BUY" &&
      m5BuyTriggered
    ) {

      status = "EARLY";
      signal = "BUY";
      signalType = "REVERSAL";
      setupType = "REVERSAL";
      execution = "MONITOR";

      score =
        Math.round(
          (m15Buy + m5Buy) / 2
        );

      reasons.push(
        "M15 bullish reversal developing"
      );

      reasons.push(
        "M5 bullish trigger"
      );

    } else if (
      status === "WAIT" &&
      m15Reversal === "SELL" &&
      m5SellTriggered
    ) {

      status = "EARLY";
      signal = "SELL";
      signalType = "REVERSAL";
      setupType = "REVERSAL";
      execution = "MONITOR";

      score =
        Math.round(
          (m15Sell + m5Sell) / 2
        );

      reasons.push(
        "M15 bearish reversal developing"
      );

      reasons.push(
        "M5 bearish trigger"
      );
    }

    // =====================================================
    // MANIPULATION WARNING
    // =====================================================

    if (
      status === "WAIT" &&
      (
        m15Manipulation.bullish ||
        m15Manipulation.bearish
      )
    ) {

      if (
        m15Manipulation.bullish &&
        !m15Manipulation.bearish
      ) {

        signal = "BUY";
        signalType = "MANIPULATION";
        setupType = "MANIPULATION";
        execution = "MONITOR";
        score = m15Buy;

        reasons.push(
          "M15 bullish manipulation detected"
        );

        reasons.push(
          "Waiting M5 confirmation"
        );

      } else if (
        m15Manipulation.bearish &&
        !m15Manipulation.bullish
      ) {

        signal = "SELL";
        signalType = "MANIPULATION";
        setupType = "MANIPULATION";
        execution = "MONITOR";
        score = m15Sell;

        reasons.push(
          "M15 bearish manipulation detected"
        );

        reasons.push(
          "Waiting M5 confirmation"
        );
      }
    }

    // =====================================================
    // M5 ONLY SCALP
    // =====================================================

    if (
      status === "WAIT" &&
      m5OnlyBuy
    ) {

      status = "M5_ONLY";
      signal = "BUY";
      signalType = "M5";
      setupType = "M5_SCALP";
      execution = "SCALP";
      score = m5Buy;

      reasons.push(
        "M5 bullish scalping trigger"
      );

      reasons.push(
        "M5 actual trigger confirmed"
      );

      reasons.push(
        "M15 confirmation not required"
      );

    } else if (
      status === "WAIT" &&
      m5OnlySell
    ) {

      status = "M5_ONLY";
      signal = "SELL";
      signalType = "M5";
      setupType = "M5_SCALP";
      execution = "SCALP";
      score = m5Sell;

      reasons.push(
        "M5 bearish scalping trigger"
      );

      reasons.push(
        "M5 actual trigger confirmed"
      );

      reasons.push(
        "M15 confirmation not required"
      );
    }

    // =====================================================
    // H1 CONTEXT
    // =====================================================

    let context = "NEUTRAL";

    if (
      signal === "BUY" &&
      h1Direction === "BUY"
    ) {
      context = "WITH_H1";

    } else if (
      signal === "SELL" &&
      h1Direction === "SELL"
    ) {
      context = "WITH_H1";

    } else if (
      signal === "BUY" &&
      h1Direction === "SELL"
    ) {
      context = "COUNTER_H1";

    } else if (
      signal === "SELL" &&
      h1Direction === "BUY"
    ) {
      context = "COUNTER_H1";
    }

    // =====================================================
    // TRADE PLAN
    // =====================================================

    let entry = null;
    let stopLoss = null;
    let tp1 = null;
    let tp2 = null;
    let rr = null;

    if (
      (
        status === "ENTRY" ||
        status === "M5_ONLY"
      ) &&
      m5ATR !== null
    ) {

      entry = price;

      const recentLow =
        lowest(
          m5
            .slice(-12)
            .map(c => c.low)
        );

      const recentHigh =
        highest(
          m5
            .slice(-12)
            .map(c => c.high)
        );

      if (signal === "BUY") {

        const atrStop =
          entry -
          m5ATR * 1.2;

        stopLoss =
          Math.min(
            atrStop,
            recentLow -
              m5ATR * 0.15
          );

        const risk =
          entry - stopLoss;

        tp1 =
          entry +
          risk * 1.5;

        tp2 =
          entry +
          risk * 2.5;

        rr = 2.5;

      } else if (signal === "SELL") {

        const atrStop =
          entry +
          m5ATR * 1.2;

        stopLoss =
          Math.max(
            atrStop,
            recentHigh +
              m5ATR * 0.15
          );

        const risk =
          stopLoss - entry;

        tp1 =
          entry -
          risk * 1.5;

        tp2 =
          entry -
          risk * 2.5;

        rr = 2.5;
      }
    }

    // =====================================================
    // RESPONSE
    // =====================================================

    return res.status(200).json({

      ok: true,

      version:
        "V10-SCALP-CONTINUATION-REVERSAL-MANIPULATION",

      symbol:
        CFG.symbol,

      mode:
        "SCALP",

      architecture:
        "ONE-M5-API-CALL",

      apiUsage:
        "1 Twelve Data request max per cache refresh",

      cache: {
        active:
          cache.data !== null,

        ageSeconds:
          Math.round(
            (
              Date.now() -
              cache.fetchedAt
            ) / 1000
          ),

        ttlSeconds:
          CFG.cacheTTL / 1000
      },

      price,

      candles:
        m5.slice(-60),

      status,
      signal,
      signalType,
      setupType,
      execution,
      score,
      context,
      reasons,

      h1: {
        direction:
          h1Direction,

        context,

        ema50:
          h1EMA50,

        ema200:
          h1EMA200
      },

      m15: {

        direction:
          m15Confirmation,

        confirmation:
          m15Confirmation,

        reversal:
          m15Reversal,

        manipulation:
          m15Manipulation,

        buyScore:
          m15Buy,

        sellScore:
          m15Sell,

        buyConfirmed:
          m15BuyConfirmed,

        sellConfirmed:
          m15SellConfirmed,

        buyDeveloping:
          m15BuyDeveloping,

        sellDeveloping:
          m15SellDeveloping,

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

        manipulation:
          m15Manipulation,

        momentum:
          m15Momentum,

        structure:
          m15Structure,

        buyReasons:
          m15BuyReasons,

        sellReasons:
          m15SellReasons
      },

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

        m5OnlyBuy,
        m5OnlySell,

        actualTrigger: {

          buyBase:
            m5BuyBase,

          sellBase:
            m5SellBase,

          buyMomentum:
            m5BuyMomentum,

          sellMomentum:
            m5SellMomentum
        },

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

        manipulation:
          m5Manipulation,

        momentum:
          m5Momentum,

        structure:
          m5Structure,

        buyReasons:
          m5BuyReasons,

        sellReasons:
          m5SellReasons
      },

      tradePlan: {
        entry,
        stopLoss,
        tp1,
        tp2,
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

  } catch (error) {

    console.error(
      "V10 SCALP ERROR:",
      error
    );

    return res.status(500).json({
      ok: false,
      error:
        error.message ||
        "V10 SCALP ENGINE ERROR"
    });
  }
}
