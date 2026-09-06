export default async function handler(req, res) {
  try {
    const API_KEY = process.env.TWELVE_DATA_API_KEY;

    if (!API_KEY) {
      return res.status(500).json({
        ok: false,
        error: "TWELVE_DATA_API_KEY belum diset"
      });
    }

    // =====================================================
    // V8 EFFICIENT SCALP ENGINE
    // =====================================================

    const CONFIG = {
      symbol: "XAU/USD",

      // M15
      M15_CONFIRM_SCORE: 55,
      M15_CONFIRM_GAP: 15,
      M15_DEVELOPING_SCORE: 45,
      M15_DEVELOPING_GAP: 10,

      // M5
      M5_TRIGGER_SCORE: 55,
      M5_TRIGGER_GAP: 5,

      // M5 ONLY
      M5_ONLY_SCORE: 50,
      M5_ONLY_GAP: 10,

      // Data
      M5_CANDLES: 350,
      H1_CANDLES: 250
    };

    // =====================================================
    // FETCH HELPER
    // =====================================================

    async function fetchTimeSeries(interval, outputsize) {
      const url =
        `https://api.twelvedata.com/time_series` +
        `?symbol=${encodeURIComponent(CONFIG.symbol)}` +
        `&interval=${interval}` +
        `&outputsize=${outputsize}` +
        `&apikey=${API_KEY}`;

      const response = await fetch(url);
      const data = await response.json();

      if (!response.ok || data.status === "error") {
        throw new Error(
          data.message ||
          `Twelve Data ${interval} API error`
        );
      }

      return (data.values || [])
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
    }

    // =====================================================
    // FETCH DATA
    //
    // M5  = execution
    // H1  = context
    // M15 = aggregate from M5
    // =====================================================

    const [m5, h1] = await Promise.all([
      fetchTimeSeries(
        "5min",
        CONFIG.M5_CANDLES
      ),

      fetchTimeSeries(
        "1h",
        CONFIG.H1_CANDLES
      )
    ]);

    if (m5.length < 250) {
      return res.status(422).json({
        ok: false,
        error: "M5 candle tidak mencukupi",
        count: m5.length
      });
    }

    if (h1.length < 200) {
      return res.status(422).json({
        ok: false,
        error: "H1 candle tidak mencukupi",
        count: h1.length
      });
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
      if (
        !Array.isArray(values) ||
        values.length < period
      ) {
        return null;
      }

      const k = 2 / (period + 1);

      let value =
        avg(values.slice(0, period));

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
    // RSI
    // =====================================================

    function rsi(values, period = 14) {
      if (
        !Array.isArray(values) ||
        values.length < period + 1
      ) {
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

      if (loss === 0) {
        return 100;
      }

      const avgGain =
        gain / period;

      const avgLoss =
        loss / period;

      const rs =
        avgGain / avgLoss;

      return 100 - 100 / (1 + rs);
    }

    // =====================================================
    // ATR
    // =====================================================

    function atr(data, period = 14) {
      if (
        !Array.isArray(data) ||
        data.length < period + 1
      ) {
        return null;
      }

      const trs = [];

      for (
        let i = 1;
        i < data.length;
        i++
      ) {
        const high = data[i].high;
        const low = data[i].low;
        const previousClose =
          data[i - 1].close;

        trs.push(
          Math.max(
            high - low,
            Math.abs(high - previousClose),
            Math.abs(low - previousClose)
          )
        );
      }

      return avg(
        trs.slice(-period)
      );
    }

    // =====================================================
    // MACD
    //
    // Optimized:
    // EMA series calculated once instead
    // of recalculating EMA repeatedly.
    // =====================================================

    function emaSeries(values, period) {
      if (
        !Array.isArray(values) ||
        values.length < period
      ) {
        return [];
      }

      const k =
        2 / (period + 1);

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

    function macd(values) {
      if (values.length < 40) {
        return null;
      }

      const fast =
        emaSeries(values, 12);

      const slow =
        emaSeries(values, 26);

      const macdLine = [];

      for (
        let i = 0;
        i < values.length;
        i++
      ) {
        if (
          fast[i] !== null &&
          slow[i] !== null
        ) {
          macdLine.push(
            fast[i] - slow[i]
          );
        }
      }

      if (macdLine.length < 9) {
        return null;
      }

      const signal =
        ema(
          macdLine,
          9
        );

      const line =
        macdLine.at(-1);

      if (
        line === undefined ||
        signal === null
      ) {
        return null;
      }

      return {
        line,
        signal,

        histogram:
          line - signal,

        bullish:
          line > signal,

        bearish:
          line < signal
      };
    }

    // =====================================================
    // AGGREGATE M5 → M15
    // =====================================================

    function aggregate15(data) {
      const buckets = new Map();

      for (const candle of data) {
        const timestamp =
          new Date(candle.time).getTime();

        const size =
          15 * 60 * 1000;

        const key =
          Math.floor(timestamp / size) *
          size;

        if (!buckets.has(key)) {
          buckets.set(key, {
            time:
              new Date(key).toISOString(),

            open:
              candle.open,

            high:
              candle.high,

            low:
              candle.low,

            close:
              candle.close,

            volume:
              candle.volume
          });
        } else {
          const bucket =
            buckets.get(key);

          bucket.high =
            Math.max(
              bucket.high,
              candle.high
            );

          bucket.low =
            Math.min(
              bucket.low,
              candle.low
            );

          bucket.close =
            candle.close;

          bucket.volume +=
            candle.volume;
        }
      }

      return Array
        .from(buckets.values())
        .sort(
          (a, b) =>
            new Date(a.time) -
            new Date(b.time)
        );
    }

    // =====================================================
    // STRUCTURE
    // =====================================================

    function structure(
      data,
      lookback = 20
    ) {
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

      const last =
        data.at(-1);

      return {
        bullish:
          last.close >
          previousHigh,

        bearish:
          last.close <
          previousLow,

        high,
        low,
        previousHigh,
        previousLow
      };
    }

    // =====================================================
    // BOS
    // =====================================================

    function detectBOS(
      data,
      lookback = 10
    ) {
      if (
        data.length <
        lookback + 2
      ) {
        return {
          bullish: false,
          bearish: false
        };
      }

      const last =
        data.at(-1);

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

    function detectCHOCH(
      data,
      lookback = 8
    ) {
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

      const last =
        data.at(-1);

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

    function liquiditySweep(
      data,
      lookback = 10
    ) {
      if (
        data.length <
        lookback + 2
      ) {
        return {
          bullish: false,
          bearish: false
        };
      }

      const current =
        data.at(-1);

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
    // CANDLE MOMENTUM
    // =====================================================

    function candleMomentum(data) {
      const c =
        data.at(-1);

      if (!c) {
        return {
          bullish: false,
          bearish: false,
          strength: 0
        };
      }

      const range =
        c.high - c.low ||
        0.00001;

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
          Math.round(
            ratio * 100
          )
      };
    }

    // =====================================================
    // MANIPULATION
    // =====================================================

    function detectManipulation(
      data,
      lookback = 12
    ) {
      if (
        data.length <
        lookback + 2
      ) {
        return {
          bullish: false,
          bearish: false
        };
      }

      const current =
        data.at(-1);

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
          current.low <
            previousLow &&
          current.close >
            previousLow &&
          lowerWick / range >=
            0.30,

        bearish:
          current.high >
            previousHigh &&
          current.close <
            previousHigh &&
          upperWick / range >=
            0.30
      };
    }

    // =====================================================
    // M5 ACTUAL TRIGGER
    // =====================================================

    function detectM5ActualTrigger({
      price,
      ema9,
      ema20,
      ema50,
      rsiValue,
      macdValue,
      structureValue,
      bosValue,
      chochValue,
      sweepValue,
      manipulationValue,
      momentumValue,
      scoreBuy,
      scoreSell
    }) {
      const buyBase =
        ema9 !== null &&
        ema20 !== null &&
        ema50 !== null &&
        rsiValue !== null &&
        ema9 > ema20 &&
        price > ema20 &&
        rsiValue >= 50;

      const sellBase =
        ema9 !== null &&
        ema20 !== null &&
        ema50 !== null &&
        rsiValue !== null &&
        ema9 < ema20 &&
        price < ema20 &&
        rsiValue < 50;

      const buyMomentum =
        macdValue?.bullish ||
        momentumValue.bullish ||
        bosValue.bullish ||
        chochValue.bullish ||
        sweepValue.bullish ||
        manipulationValue.bullish ||
        structureValue.bullish;

      const sellMomentum =
        macdValue?.bearish ||
        momentumValue.bearish ||
        bosValue.bearish ||
        chochValue.bearish ||
        sweepValue.bearish ||
        manipulationValue.bearish ||
        structureValue.bearish;

      return {
        buy:
          buyBase &&
          buyMomentum &&
          scoreBuy >= CONFIG.M5_ONLY_SCORE &&
          scoreBuy >=
            scoreSell +
            CONFIG.M5_ONLY_GAP,

        sell:
          sellBase &&
          sellMomentum &&
          scoreSell >= CONFIG.M5_ONLY_SCORE &&
          scoreSell >=
            scoreBuy +
            CONFIG.M5_ONLY_GAP,

        buyBase,
        sellBase,
        buyMomentum,
        sellMomentum
      };
    }

    // =====================================================
    // DATASETS
    // =====================================================

    const m15 =
      aggregate15(m5);

    const c5 =
      m5.map(c => c.close);

    const c15 =
      m15.map(c => c.close);

    const c1 =
      h1.map(c => c.close);

    const price =
      c5.at(-1);

    // =====================================================
    // H1 CONTEXT
    //
    // H1 NEVER BLOCKS ENTRY
    // =====================================================

    const h1EMA50 =
      ema(c1, 50);

    const h1EMA200 =
      ema(c1, 200);

    let h1Direction =
      "WAIT";

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
    // M15 ENGINE
    // =====================================================

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

    // =====================================================
    // M15 SCORE
    // =====================================================

    let m15Buy = 0;
    let m15Sell = 0;

    const m15BuyReasons = [];
    const m15SellReasons = [];

    if (
      m15EMA20 !== null &&
      m15EMA50 !== null
    ) {
      if (
        m15EMA20 >
        m15EMA50
      ) {
        m15Buy += 20;
        m15BuyReasons.push(
          "EMA20 > EMA50"
        );
      }

      if (
        m15EMA20 <
        m15EMA50
      ) {
        m15Sell += 20;
        m15SellReasons.push(
          "EMA20 < EMA50"
        );
      }
    }

    if (m15EMA20 !== null) {
      if (
        price >
        m15EMA20
      ) {
        m15Buy += 10;
        m15BuyReasons.push(
          "Price above EMA20"
        );
      }

      if (
        price <
        m15EMA20
      ) {
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

    if (
      m15Manipulation.bullish
    ) {
      m15Buy += 10;
      m15BuyReasons.push(
        "Bullish manipulation rejection"
      );
    }

    if (
      m15Manipulation.bearish
    ) {
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

    m15Buy =
      clamp(m15Buy, 0, 100);

    m15Sell =
      clamp(m15Sell, 0, 100);

    // =====================================================
    // M15 CONFIRMATION
    // =====================================================

    const m15BuyConfirmed =
      m15Buy >=
        CONFIG.M15_CONFIRM_SCORE &&
      m15Buy >=
        m15Sell +
        CONFIG.M15_CONFIRM_GAP;

    const m15SellConfirmed =
      m15Sell >=
        CONFIG.M15_CONFIRM_SCORE &&
      m15Sell >=
        m15Buy +
        CONFIG.M15_CONFIRM_GAP;

    const m15BuyDeveloping =
      m15Buy >=
        CONFIG.M15_DEVELOPING_SCORE &&
      m15Buy >=
        m15Sell +
        CONFIG.M15_DEVELOPING_GAP;

    const m15SellDeveloping =
      m15Sell >=
        CONFIG.M15_DEVELOPING_SCORE &&
      m15Sell >=
        m15Buy +
        CONFIG.M15_DEVELOPING_GAP;

    let m15Confirmation =
      "WAIT";

    if (m15BuyConfirmed) {
      m15Confirmation = "BUY";
    } else if (
      m15SellConfirmed
    ) {
      m15Confirmation = "SELL";
    } else if (
      m15BuyDeveloping
    ) {
      m15Confirmation = "BUY";
    } else if (
      m15SellDeveloping
    ) {
      m15Confirmation = "SELL";
    }

    // =====================================================
    // M15 REVERSAL
    // =====================================================

    let m15Reversal =
      "NONE";

    const m15BullishReversal =
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

    const m15BearishReversal =
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

    if (m15BullishReversal) {
      m15Reversal = "BUY";
    } else if (
      m15BearishReversal
    ) {
      m15Reversal = "SELL";
    }

    // =====================================================
    // M5 ENGINE
    // =====================================================

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

    // =====================================================
    // M5 SCORE
    // =====================================================

    let m5Buy = 0;
    let m5Sell = 0;

    const m5BuyReasons = [];
    const m5SellReasons = [];

    if (
      m5EMA9 !== null &&
      m5EMA20 !== null
    ) {
      if (
        m5EMA9 >
        m5EMA20
      ) {
        m5Buy += 15;
        m5BuyReasons.push(
          "EMA9 > EMA20"
        );
      }

      if (
        m5EMA9 <
        m5EMA20
      ) {
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
      if (
        m5EMA20 >
        m5EMA50
      ) {
        m5Buy += 15;
        m5BuyReasons.push(
          "EMA20 > EMA50"
        );
      }

      if (
        m5EMA20 <
        m5EMA50
      ) {
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

    if (
      m5Manipulation.bullish
    ) {
      m5Buy += 10;
      m5BuyReasons.push(
        "Bullish manipulation rejection"
      );
    }

    if (
      m5Manipulation.bearish
    ) {
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

    m5Buy =
      clamp(m5Buy, 0, 100);

    m5Sell =
      clamp(m5Sell, 0, 100);

    // =====================================================
    // M5 NORMAL TRIGGER
    // =====================================================

    const m5BuyTriggered =
      m5Buy >=
        CONFIG.M5_TRIGGER_SCORE &&
      m5Buy >
        m5Sell +
        CONFIG.M5_TRIGGER_GAP;

    const m5SellTriggered =
      m5Sell >=
        CONFIG.M5_TRIGGER_SCORE &&
      m5Sell >
        m5Buy +
        CONFIG.M5_TRIGGER_GAP;

    let m5Trigger =
      "WAIT";

    if (m5BuyTriggered) {
      m5Trigger = "BUY";
    } else if (
      m5SellTriggered
    ) {
      m5Trigger = "SELL";
    }

    // =====================================================
    // ACTUAL M5 TRIGGER
    // =====================================================

    const m5Actual =
      detectM5ActualTrigger({
        price,

        ema9:
          m5EMA9,

        ema20:
          m5EMA20,

        ema50:
          m5EMA50,

        rsiValue:
          m5RSI,

        macdValue:
          m5MACD,

        structureValue:
          m5Structure,

        bosValue:
          m5BOS,

        chochValue:
          m5CHOCH,

        sweepValue:
          m5Sweep,

        manipulationValue:
          m5Manipulation,

        momentumValue:
          m5Momentum,

        scoreBuy:
          m5Buy,

        scoreSell:
          m5Sell
      });

    // =====================================================
    // FINAL SIGNAL
    // =====================================================

    let status = "WAIT";
    let signal = "WAIT";
    let signalType = "NONE";
    let execution = "WAIT";
    let score = 0;

    const reasons = [];

    // =====================================================
    // 1. M15 CONFIRMED + M5 TRIGGER
    // =====================================================

    if (
      m15BuyConfirmed &&
      m5BuyTriggered
    ) {
      status = "ENTRY";
      signal = "BUY";
      signalType = "TREND";
      execution = "READY";

      score =
        Math.round(
          (m15Buy +
            m5Buy) / 2
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
      execution = "READY";

      score =
        Math.round(
          (m15Sell +
            m5Sell) / 2
        );

      reasons.push(
        "M15 confirmed bearish"
      );

      reasons.push(
        "M5 bearish trigger"
      );
    }

    // =====================================================
    // 2. CONFIRMED REVERSAL
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
      execution = "READY";

      score =
        Math.round(
          (m15Buy +
            m5Buy) / 2
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
      execution = "READY";

      score =
        Math.round(
          (m15Sell +
            m5Sell) / 2
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
    // 3. M15 DEVELOPING + M5
    // =====================================================

    if (
      status === "WAIT" &&
      m15BuyDeveloping &&
      m5BuyTriggered
    ) {
      status = "EARLY";
      signal = "BUY";
      signalType = "TREND";
      execution = "MONITOR";

      score =
        Math.round(
          (m15Buy +
            m5Buy) / 2
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
      execution = "MONITOR";

      score =
        Math.round(
          (m15Sell +
            m5Sell) / 2
        );

      reasons.push(
        "M15 developing bearish"
      );

      reasons.push(
        "M5 bearish trigger"
      );
    }

    // =====================================================
    // 4. EARLY REVERSAL
    // =====================================================

    if (
      status === "WAIT" &&
      m15Reversal === "BUY" &&
      m5BuyTriggered
    ) {
      status = "EARLY";
      signal = "BUY";
      signalType = "REVERSAL";
      execution = "MONITOR";

      score =
        Math.round(
          (m15Buy +
            m5Buy) / 2
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
      execution = "MONITOR";

      score =
        Math.round(
          (m15Sell +
            m5Sell) / 2
        );

      reasons.push(
        "M15 bearish reversal developing"
      );

      reasons.push(
        "M5 bearish trigger"
      );
    }

    // =====================================================
    // 5. M5 ONLY
    // =====================================================

    if (
      status === "WAIT" &&
      m5Actual.buy
    ) {
      status = "M5_ONLY";
      signal = "BUY";
      signalType = "M5";
      execution = "SCALP";

      score =
        m5Buy;

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
      m5Actual.sell
    ) {
      status = "M5_ONLY";
      signal = "SELL";
      signalType = "M5";
      execution = "SCALP";

      score =
        m5Sell;

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
    // CONTEXT
    // =====================================================

    let context =
      "NEUTRAL";

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
      entry =
        price;

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
          entry -
          stopLoss;

        tp1 =
          entry +
          risk * 1.5;

        tp2 =
          entry +
          risk * 2.5;

        rr = 2.5;
      } else if (
        signal === "SELL"
      ) {
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
          stopLoss -
          entry;

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
        "V8-EFFICIENT-SCALP",

      symbol:
        CONFIG.symbol,

      mode:
        "SCALP",

      architecture:
        "M5-DATA + H1-CONTEXT + M15-AGGREGATED",

      price,

      status,

      signal,

      signalType,

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

        m5OnlyBuy:
          m5Actual.buy,

        m5OnlySell:
          m5Actual.sell,

        actualTrigger: {
          buyBase:
            m5Actual.buyBase,

          sellBase:
            m5Actual.sellBase,

          buyMomentum:
            m5Actual.buyMomentum,

          sellMomentum:
            m5Actual.sellMomentum
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
      "SCALP V8 ERROR:",
      error
    );

    return res.status(500).json({
      ok: false,
      error:
        error.message ||
        "SCALP V8 ENGINE ERROR"
    });
  }
}
