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
    // CONFIG
    // =====================================================

    const M15_EARLY_SCORE = 40;
    const M15_ENTRY_SCORE = 55;

    const M5_TRIGGER_SCORE = 50;
    const M5_ENTRY_SCORE = 60;

    const M15_EARLY_GAP = 10;
    const M15_ENTRY_GAP = 15;

    // =====================================================
    // FETCH XAUUSD M5
    // =====================================================

    const url =
      `https://api.twelvedata.com/time_series` +
      `?symbol=XAU/USD` +
      `&interval=5min` +
      `&outputsize=1000` +
      `&apikey=${API_KEY}`;

    const response = await fetch(url);
    const data = await response.json();

    if (!response.ok || data.status === "error") {
      return res.status(502).json({
        ok: false,
        error: data.message || "Twelve Data API error"
      });
    }

    const candles = (data.values || [])
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
        error: "Candle tidak mencukupi",
        count: candles.length
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
      arr.length ? Math.max(...arr) : null;

    const lowest = arr =>
      arr.length ? Math.min(...arr) : null;

    const clamp = (n, min, max) =>
      Math.max(min, Math.min(max, n));

    function ema(values, period) {
      if (values.length < period) return null;

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

    function rsi(values, period = 14) {
      if (values.length < period + 1) {
        return null;
      }

      let gain = 0;
      let loss = 0;

      for (
        let i = values.length - period;
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

    function atr(data, period = 14) {
      if (data.length < period + 1) {
        return null;
      }

      const trs = [];

      for (let i = 1; i < data.length; i++) {
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

      return avg(
        trs.slice(-period)
      );
    }

    function macd(values) {
      if (values.length < 40) {
        return null;
      }

      const lines = [];

      for (
        let i = 26;
        i <= values.length;
        i++
      ) {
        const slice =
          values.slice(0, i);

        const e12 =
          ema(slice, 12);

        const e26 =
          ema(slice, 26);

        if (
          e12 !== null &&
          e26 !== null
        ) {
          lines.push(e12 - e26);
        }
      }

      const line =
        lines.at(-1);

      const signal =
        ema(lines, 9);

      if (
        line === undefined ||
        signal === null
      ) {
        return null;
      }

      return {
        line,
        signal,
        bullish: line > signal,
        bearish: line < signal
      };
    }

    function aggregate(data, minutes) {
      const buckets = {};
      const size =
        minutes * 60 * 1000;

      for (const c of data) {
        const timestamp =
          new Date(c.time).getTime();

        const key =
          Math.floor(
            timestamp / size
          ) * size;

        if (!buckets[key]) {
          buckets[key] = {
            time:
              new Date(key).toISOString(),
            open: c.open,
            high: c.high,
            low: c.low,
            close: c.close,
            volume: c.volume
          };
        } else {
          buckets[key].high =
            Math.max(
              buckets[key].high,
              c.high
            );

          buckets[key].low =
            Math.min(
              buckets[key].low,
              c.low
            );

          buckets[key].close =
            c.close;

          buckets[key].volume +=
            c.volume;
        }
      }

      return Object.keys(buckets)
        .sort(
          (a, b) =>
            Number(a) - Number(b)
        )
        .map(k => buckets[k]);
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
          recentHigh >
            previousHigh &&
          last.close >
            previousHigh,

        bearish:
          recentLow <
            previousLow &&
          last.close <
            previousLow
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
    // MOMENTUM
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
          Math.round(ratio * 100)
      };
    }

    // =====================================================
    // DATA
    // =====================================================

    const m5 =
      candles;

    const m15 =
      aggregate(
        candles,
        15
      );

    const h1 =
      aggregate(
        candles,
        60
      );

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
      }

      if (
        price < h1EMA200 &&
        h1EMA50 < h1EMA200
      ) {
        h1Direction = "SELL";
      }
    }

    // =====================================================
    // M15 INDICATORS
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
      structure(
        m15,
        20
      );

    const m15BOS =
      detectBOS(
        m15,
        12
      );

    const m15CHOCH =
      detectCHOCH(
        m15,
        10
      );

    const m15Sweep =
      liquiditySweep(
        m15,
        12
      );

    const m15Momentum =
      candleMomentum(m15);

    // =====================================================
    // M15 SCORING
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

    if (
      m15EMA20 !== null
    ) {
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

    // RSI
    if (
      m15RSI !== null
    ) {
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

    // MACD
    if (
      m15MACD?.bullish
    ) {
      m15Buy += 15;

      m15BuyReasons.push(
        "MACD bullish"
      );
    }

    if (
      m15MACD?.bearish
    ) {
      m15Sell += 15;

      m15SellReasons.push(
        "MACD bearish"
      );
    }

    // Structure
    if (
      m15Structure.bullish
    ) {
      m15Buy += 15;

      m15BuyReasons.push(
        "Bullish structure"
      );
    }

    if (
      m15Structure.bearish
    ) {
      m15Sell += 15;

      m15SellReasons.push(
        "Bearish structure"
      );
    }

    // BOS
    if (
      m15BOS.bullish
    ) {
      m15Buy += 15;

      m15BuyReasons.push(
        "Bullish BOS"
      );
    }

    if (
      m15BOS.bearish
    ) {
      m15Sell += 15;

      m15SellReasons.push(
        "Bearish BOS"
      );
    }

    // CHOCH
    if (
      m15CHOCH.bullish
    ) {
      m15Buy += 10;

      m15BuyReasons.push(
        "Bullish CHOCH"
      );
    }

    if (
      m15CHOCH.bearish
    ) {
      m15Sell += 10;

      m15SellReasons.push(
        "Bearish CHOCH"
      );
    }

    // Liquidity
    if (
      m15Sweep.bullish
    ) {
      m15Buy += 10;

      m15BuyReasons.push(
        "Sell-side liquidity sweep"
      );
    }

    if (
      m15Sweep.bearish
    ) {
      m15Sell += 10;

      m15SellReasons.push(
        "Buy-side liquidity sweep"
      );
    }

    // Momentum
    if (
      m15Momentum.bullish
    ) {
      m15Buy += 5;

      m15BuyReasons.push(
        "Bullish momentum"
      );
    }

    if (
      m15Momentum.bearish
    ) {
      m15Sell += 5;

      m15SellReasons.push(
        "Bearish momentum"
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

    // =====================================================
    // M15 CLASSIFICATION
    // =====================================================

    let m15Direction =
      "MIXED";

    if (
      m15Buy >=
        M15_EARLY_SCORE &&
      m15Buy >=
        m15Sell +
          M15_EARLY_GAP
    ) {
      m15Direction =
        "BUY";
    }

    if (
      m15Sell >=
        M15_EARLY_SCORE &&
      m15Sell >=
        m15Buy +
          M15_EARLY_GAP
    ) {
      m15Direction =
        "SELL";
    }

    // =====================================================
    // M15 REVERSAL DETECTION
    // =====================================================

    let m15Reversal =
      "NONE";

    if (
      m15Sweep.bullish &&
      m15MACD?.bullish &&
      m15RSI !== null &&
      m15RSI >= 45
    ) {
      m15Reversal =
        "BUY";
    }

    if (
      m15Sweep.bearish &&
      m15MACD?.bearish &&
      m15RSI !== null &&
      m15RSI <= 55
    ) {
      m15Reversal =
        "SELL";
    }

    // =====================================================
    // M5 INDICATORS
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
      structure(
        m5,
        24
      );

    const m5BOS =
      detectBOS(
        m5,
        10
      );

    const m5CHOCH =
      detectCHOCH(
        m5,
        8
      );

    const m5Sweep =
      liquiditySweep(
        m5,
        10
      );

    const m5Momentum =
      candleMomentum(m5);

    // =====================================================
    // M5 SCORING
    // =====================================================

    let m5Buy = 0;
    let m5Sell = 0;

    const m5BuyReasons = [];
    const m5SellReasons = [];

    // EMA 9/20
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

    // EMA 20/50
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

    // RSI
    if (
      m5RSI !== null
    ) {
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

    // MACD
    if (
      m5MACD?.bullish
    ) {
      m5Buy += 15;

      m5BuyReasons.push(
        "MACD bullish"
      );
    }

    if (
      m5MACD?.bearish
    ) {
      m5Sell += 15;

      m5SellReasons.push(
        "MACD bearish"
      );
    }

    // Structure
    if (
      m5Structure.bullish
    ) {
      m5Buy += 10;

      m5BuyReasons.push(
        "Bullish structure"
      );
    }

    if (
      m5Structure.bearish
    ) {
      m5Sell += 10;

      m5SellReasons.push(
        "Bearish structure"
      );
    }

    // BOS
    if (
      m5BOS.bullish
    ) {
      m5Buy += 15;

      m5BuyReasons.push(
        "Bullish BOS"
      );
    }

    if (
      m5BOS.bearish
    ) {
      m5Sell += 15;

      m5SellReasons.push(
        "Bearish BOS"
      );
    }

    // CHOCH
    if (
      m5CHOCH.bullish
    ) {
      m5Buy += 10;

      m5BuyReasons.push(
        "Bullish CHOCH"
      );
    }

    if (
      m5CHOCH.bearish
    ) {
      m5Sell += 10;

      m5SellReasons.push(
        "Bearish CHOCH"
      );
    }

    // Liquidity
    if (
      m5Sweep.bullish
    ) {
      m5Buy += 10;

      m5BuyReasons.push(
        "Sell-side liquidity sweep"
      );
    }

    if (
      m5Sweep.bearish
    ) {
      m5Sell += 10;

      m5SellReasons.push(
        "Buy-side liquidity sweep"
      );
    }

    // Momentum
    if (
      m5Momentum.bullish
    ) {
      m5Buy += 10;

      m5BuyReasons.push(
        "Bullish momentum"
      );
    }

    if (
      m5Momentum.bearish
    ) {
      m5Sell += 10;

      m5SellReasons.push(
        "Bearish momentum"
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

    // =====================================================
    // M5 TRIGGER
    // =====================================================

    let m5Trigger =
      "WAIT";

    if (
      m5Buy >=
        M5_TRIGGER_SCORE &&
      m5Buy >
        m5Sell + 5
    ) {
      m5Trigger =
        "BUY";
    }

    if (
      m5Sell >=
        M5_TRIGGER_SCORE &&
      m5Sell >
        m5Buy + 5
    ) {
      m5Trigger =
        "SELL";
    }

    // =====================================================
    // FINAL SIGNAL
    // =====================================================

    let status =
      "WAIT";

    let signal =
      "WAIT";

    let signalType =
      "NONE";

    let score = 0;

    const reasons = [];

    // =====================================================
    // 1. CONFIRMED TREND ENTRY
    // =====================================================

    if (
      m15Direction === "BUY" &&
      m15Buy >=
        M15_ENTRY_SCORE &&
      m15Buy >=
        m15Sell +
          M15_ENTRY_GAP &&
      m5Trigger === "BUY" &&
      m5Buy >=
        M5_ENTRY_SCORE
    ) {
      status =
        "ENTRY";

      signal =
        "BUY";

      signalType =
        "TREND";

      score =
        Math.round(
          (m15Buy + m5Buy) /
            2
        );

      reasons.push(
        "M15 confirmed bullish"
      );

      reasons.push(
        "M5 confirmed bullish"
      );
    }

    if (
      m15Direction === "SELL" &&
      m15Sell >=
        M15_ENTRY_SCORE &&
      m15Sell >=
        m15Buy +
          M15_ENTRY_GAP &&
      m5Trigger === "SELL" &&
      m5Sell >=
        M5_ENTRY_SCORE
    ) {
      status =
        "ENTRY";

      signal =
        "SELL";

      signalType =
        "TREND";

      score =
        Math.round(
          (m15Sell + m5Sell) /
            2
        );

      reasons.push(
        "M15 confirmed bearish"
      );

      reasons.push(
        "M5 confirmed bearish"
      );
    }

    // =====================================================
    // 2. REVERSAL ENTRY
    // =====================================================

    if (
      status === "WAIT" &&
      m15Reversal === "BUY" &&
      m5Trigger === "BUY" &&
      m5Buy >=
        M5_ENTRY_SCORE &&
      (
        m5BOS.bullish ||
        m5CHOCH.bullish
      )
    ) {
      status =
        "ENTRY";

      signal =
        "BUY";

      signalType =
        "REVERSAL";

      score =
        Math.round(
          (m15Buy + m5Buy) /
            2
        );

      reasons.push(
        "M15 bullish reversal setup"
      );

      reasons.push(
        "M5 structure confirmation"
      );
    }

    if (
      status === "WAIT" &&
      m15Reversal === "SELL" &&
      m5Trigger === "SELL" &&
      m5Sell >=
        M5_ENTRY_SCORE &&
      (
        m5BOS.bearish ||
        m5CHOCH.bearish
      )
    ) {
      status =
        "ENTRY";

      signal =
        "SELL";

      signalType =
        "REVERSAL";

      score =
        Math.round(
          (m15Sell + m5Sell) /
            2
        );

      reasons.push(
        "M15 bearish reversal setup"
      );

      reasons.push(
        "M5 structure confirmation"
      );
    }

    // =====================================================
    // 3. EARLY TREND
    // =====================================================

    if (
      status === "WAIT" &&
      m15Direction === "BUY" &&
      m15Buy >=
        M15_EARLY_SCORE &&
      m5Trigger === "BUY"
    ) {
      status =
        "EARLY";

      signal =
        "BUY";

      signalType =
        "TREND";

      score =
        Math.round(
          (m15Buy + m5Buy) /
            2
        );

      reasons.push(
        "M15 developing bullish"
      );

      reasons.push(
        "M5 bullish trigger"
      );
    }

    if (
      status === "WAIT" &&
      m15Direction === "SELL" &&
      m15Sell >=
        M15_EARLY_SCORE &&
      m5Trigger === "SELL"
    ) {
      status =
        "EARLY";

      signal =
        "SELL";

      signalType =
        "TREND";

      score =
        Math.round(
          (m15Sell + m5Sell) /
            2
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
      m5Trigger === "BUY"
    ) {
      status =
        "EARLY";

      signal =
        "BUY";

      signalType =
        "REVERSAL";

      score =
        Math.round(
          (m15Buy + m5Buy) /
            2
        );

      reasons.push(
        "M15 reversal developing"
      );

      reasons.push(
        "M5 bullish trigger"
      );
    }

    if (
      status === "WAIT" &&
      m15Reversal === "SELL" &&
      m5Trigger === "SELL"
    ) {
      status =
        "EARLY";

      signal =
        "SELL";

      signalType =
        "REVERSAL";

      score =
        Math.round(
          (m15Sell + m5Sell) /
            2
        );

      reasons.push(
        "M15 reversal developing"
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
      m5Trigger === "BUY" &&
      m5Buy >=
        M5_TRIGGER_SCORE
    ) {
      status =
        "M5_ONLY";

      signal =
        "BUY";

      signalType =
        "M5";

      score =
        m5Buy;

      reasons.push(
        "M5 bullish opportunity"
      );

      reasons.push(
        "M15 not confirmed"
      );
    }

    if (
      status === "WAIT" &&
      m5Trigger === "SELL" &&
      m5Sell >=
        M5_TRIGGER_SCORE
    ) {
      status =
        "M5_ONLY";

      signal =
        "SELL";

      signalType =
        "M5";

      score =
        m5Sell;

      reasons.push(
        "M5 bearish opportunity"
      );

      reasons.push(
        "M15 not confirmed"
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
      context =
        "WITH_H1";
    }

    if (
      signal === "SELL" &&
      h1Direction === "SELL"
    ) {
      context =
        "WITH_H1";
    }

    if (
      signal === "BUY" &&
      h1Direction === "SELL"
    ) {
      context =
        "COUNTER_H1";
    }

    if (
      signal === "SELL" &&
      h1Direction === "BUY"
    ) {
      context =
        "COUNTER_H1";
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
      status === "ENTRY" &&
      m5ATR !== null
    ) {
      entry =
        price;

      const recentLow =
        lowest(
          m5.slice(-12)
            .map(c => c.low)
        );

      const recentHigh =
        highest(
          m5.slice(-12)
            .map(c => c.high)
        );

      if (
        signal === "BUY"
      ) {
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
      }

      if (
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

      symbol:
        "XAU/USD",

      mode:
        "SCALP",

      price,

      status,

      signal,

      signalType,

      score,

      context,

      reasons,

      h1: {
        direction:
          h1Direction,

        context
      },

      m15: {
        direction:
          m15Direction,

        reversal:
          m15Reversal,

        buyScore:
          m15Buy,

        sellScore:
          m15Sell,

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

        buyScore:
          m5Buy,

        sellScore:
          m5Sell,

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

      timestamp:
        new Date().toISOString()
    });

  } catch (error) {
    console.error(
      "SCALP V3 ERROR:",
      error
    );

    return res.status(500).json({
      ok: false,
      error:
        error.message ||
        "SCALP ENGINE ERROR"
    });
  }
}
