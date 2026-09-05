export default async function handler(req, res) {
  try {
    const API_KEY = process.env.TWELVE_DATA_API_KEY;

    if (!API_KEY) {
      return res.status(500).json({
        error: "TWELVE_DATA_API_KEY belum diset"
      });
    }

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

      let value = avg(values.slice(0, period));

      for (let i = period; i < values.length; i++) {
        value =
          values[i] * k +
          value * (1 - k);
      }

      return value;
    }

    function rsi(values, period = 14) {
      if (values.length < period + 1) return null;

      let gain = 0;
      let loss = 0;

      for (
        let i = values.length - period;
        i < values.length;
        i++
      ) {
        const change =
          values[i] - values[i - 1];

        if (change > 0) gain += change;
        if (change < 0) loss -= change;
      }

      if (loss === 0) return 100;

      const rs =
        (gain / period) /
        (loss / period);

      return 100 - 100 / (1 + rs);
    }

    function atr(data, period = 14) {
      if (data.length < period + 1) return null;

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

      return avg(trs.slice(-period));
    }

    function macd(values) {
      if (values.length < 40) return null;

      const lines = [];

      for (let i = 26; i <= values.length; i++) {
        const slice = values.slice(0, i);

        const e12 = ema(slice, 12);
        const e26 = ema(slice, 26);

        if (e12 !== null && e26 !== null) {
          lines.push(e12 - e26);
        }
      }

      const line = lines.at(-1);
      const signal = ema(lines, 9);

      if (line === undefined || signal === null) {
        return null;
      }

      return {
        line,
        signal,
        bullish: line > signal,
        bearish: line < signal
      };
    }

    function adx(data, period = 14) {
      if (data.length < period * 2 + 2) {
        return null;
      }

      const trs = [];
      const plusDM = [];
      const minusDM = [];

      for (let i = 1; i < data.length; i++) {
        const h = data[i].high;
        const l = data[i].low;

        const ph = data[i - 1].high;
        const pl = data[i - 1].low;
        const pc = data[i - 1].close;

        trs.push(
          Math.max(
            h - l,
            Math.abs(h - pc),
            Math.abs(l - pc)
          )
        );

        const up = h - ph;
        const down = pl - l;

        plusDM.push(
          up > down && up > 0 ? up : 0
        );

        minusDM.push(
          down > up && down > 0 ? down : 0
        );
      }

      const tr = avg(trs.slice(-period));
      const plus = avg(plusDM.slice(-period));
      const minus = avg(minusDM.slice(-period));

      if (!tr) return null;

      const plusDI = 100 * plus / tr;
      const minusDI = 100 * minus / tr;

      const value =
        100 *
        Math.abs(plusDI - minusDI) /
        (plusDI + minusDI || 1);

      return {
        value,
        plusDI,
        minusDI,
        bullish: plusDI > minusDI,
        bearish: minusDI > plusDI
      };
    }

    function aggregate(data, minutes) {
      const buckets = {};
      const size = minutes * 60 * 1000;

      data.forEach(c => {
        const time = new Date(c.time).getTime();

        const key =
          Math.floor(time / size) * size;

        if (!buckets[key]) {
          buckets[key] = {
            time: new Date(key).toISOString(),
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

          buckets[key].close = c.close;
          buckets[key].volume += c.volume;
        }
      });

      return Object.keys(buckets)
        .sort((a, b) => Number(a) - Number(b))
        .map(k => buckets[k]);
    }

    // =====================================================
    // STRUCTURE
    // =====================================================

    function structure(data, lookback = 20) {
      if (data.length < lookback * 2) {
        return {
          bullish: false,
          bearish: false,
          high: null,
          low: null
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
        highest(recent.map(c => c.high));

      const low =
        lowest(recent.map(c => c.low));

      const previousHigh =
        highest(previous.map(c => c.high));

      const previousLow =
        lowest(previous.map(c => c.low));

      const last =
        data.at(-1);

      return {
        high,
        low,

        bullish:
          high > previousHigh &&
          last.close > previousHigh,

        bearish:
          low < previousLow &&
          last.close < previousLow
      };
    }

    function detectBOS(data, lookback = 12) {
      if (data.length < lookback + 2) {
        return {
          bullish: false,
          bearish: false
        };
      }

      const last = data.at(-1);

      const previous =
        data.slice(-lookback - 1, -1);

      const high =
        highest(previous.map(c => c.high));

      const low =
        lowest(previous.map(c => c.low));

      return {
        bullish: last.close > high,
        bearish: last.close < low
      };
    }

    function detectCHOCH(data, lookback = 10) {
      if (data.length < lookback * 2 + 2) {
        return {
          bullish: false,
          bearish: false
        };
      }

      const recent =
        data.slice(-lookback);

      const old =
        data.slice(
          -lookback * 2,
          -lookback
        );

      const recentHigh =
        highest(recent.map(c => c.high));

      const recentLow =
        lowest(recent.map(c => c.low));

      const oldHigh =
        highest(old.map(c => c.high));

      const oldLow =
        lowest(old.map(c => c.low));

      const last =
        data.at(-1);

      return {
        bullish:
          recentHigh > oldHigh &&
          last.close > oldHigh,

        bearish:
          recentLow < oldLow &&
          last.close < oldLow
      };
    }

    // =====================================================
    // CANDLE PATTERN
    // =====================================================

    function candleMomentum(data) {
      const a = data.at(-1);
      const b = data.at(-2);

      if (!a || !b) {
        return {
          bullish: false,
          bearish: false
        };
      }

      const body =
        Math.abs(a.close - a.open);

      const range =
        a.high - a.low || 1;

      const bullishBody =
        a.close > a.open &&
        body / range >= 0.45;

      const bearishBody =
        a.close < a.open &&
        body / range >= 0.45;

      return {
        bullish: bullishBody,
        bearish: bearishBody
      };
    }

    // =====================================================
    // DATA
    // =====================================================

    const m5 = candles;
    const m15 = aggregate(candles, 15);
    const h1 = aggregate(candles, 60);

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

    const h1Bull =
      h1EMA50 !== null &&
      h1EMA200 !== null &&
      price > h1EMA200 &&
      h1EMA50 > h1EMA200;

    const h1Bear =
      h1EMA50 !== null &&
      h1EMA200 !== null &&
      price < h1EMA200 &&
      h1EMA50 < h1EMA200;

    const h1Direction =
      h1Bull
        ? "BUY"
        : h1Bear
          ? "SELL"
          : "WAIT";

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

    const m15ADX =
      adx(m15);

    const m15ATR =
      atr(m15);

    const m15Structure =
      structure(m15, 20);

    const m15BOS =
      detectBOS(m15, 12);

    const m15CHOCH =
      detectCHOCH(m15, 10);

    // =====================================================
    // M15 SCORE
    // =====================================================

    let m15BuyScore = 0;
    let m15SellScore = 0;

    // EMA
    if (
      m15EMA20 !== null &&
      m15EMA50 !== null
    ) {
      if (m15EMA20 > m15EMA50) {
        m15BuyScore += 20;
      }

      if (m15EMA20 < m15EMA50) {
        m15SellScore += 20;
      }
    }

    // RSI
    if (m15RSI !== null) {
      if (
        m15RSI >= 50 &&
        m15RSI <= 72
      ) {
        m15BuyScore += 15;
      }

      if (
        m15RSI >= 28 &&
        m15RSI < 50
      ) {
        m15SellScore += 15;
      }
    }

    // MACD
    if (m15MACD) {
      if (m15MACD.bullish) {
        m15BuyScore += 15;
      }

      if (m15MACD.bearish) {
        m15SellScore += 15;
      }
    }

    // ADX
    if (
      m15ADX &&
      m15ADX.value >= 15
    ) {
      if (m15ADX.bullish) {
        m15BuyScore += 10;
      }

      if (m15ADX.bearish) {
        m15SellScore += 10;
      }
    }

    // Structure
    if (m15Structure.bullish) {
      m15BuyScore += 15;
    }

    if (m15Structure.bearish) {
      m15SellScore += 15;
    }

    // BOS
    if (m15BOS.bullish) {
      m15BuyScore += 15;
    }

    if (m15BOS.bearish) {
      m15SellScore += 15;
    }

    // CHOCH
    if (m15CHOCH.bullish) {
      m15BuyScore += 10;
    }

    if (m15CHOCH.bearish) {
      m15SellScore += 10;
    }

    m15BuyScore =
      clamp(m15BuyScore, 0, 100);

    m15SellScore =
      clamp(m15SellScore, 0, 100);

    // =====================================================
    // M15 BIAS
    // =====================================================

    let m15Bias = "WAIT";

    if (
      m15BuyScore >= 50 &&
      m15BuyScore > m15SellScore
    ) {
      m15Bias = "BUY";
    }

    if (
      m15SellScore >= 50 &&
      m15SellScore > m15BuyScore
    ) {
      m15Bias = "SELL";
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

    const m5ADX =
      adx(m5);

    const m5ATR =
      atr(m5);

    const m5Structure =
      structure(m5, 24);

    const m5BOS =
      detectBOS(m5, 10);

    const m5CHOCH =
      detectCHOCH(m5, 8);

    const m5Momentum =
      candleMomentum(m5);

    // =====================================================
    // M5 SCORE
    // =====================================================

    let m5BuyScore = 0;
    let m5SellScore = 0;

    // EMA 9/20
    if (
      m5EMA9 !== null &&
      m5EMA20 !== null
    ) {
      if (m5EMA9 > m5EMA20) {
        m5BuyScore += 15;
      }

      if (m5EMA9 < m5EMA20) {
        m5SellScore += 15;
      }
    }

    // EMA 20/50
    if (
      m5EMA20 !== null &&
      m5EMA50 !== null
    ) {
      if (m5EMA20 > m5EMA50) {
        m5BuyScore += 15;
      }

      if (m5EMA20 < m5EMA50) {
        m5SellScore += 15;
      }
    }

    // RSI
    if (m5RSI !== null) {
      if (
        m5RSI >= 50 &&
        m5RSI <= 75
      ) {
        m5BuyScore += 15;
      }

      if (
        m5RSI >= 25 &&
        m5RSI < 50
      ) {
        m5SellScore += 15;
      }
    }

    // MACD
    if (m5MACD) {
      if (m5MACD.bullish) {
        m5BuyScore += 15;
      }

      if (m5MACD.bearish) {
        m5SellScore += 15;
      }
    }

    // ADX
    if (
      m5ADX &&
      m5ADX.value >= 12
    ) {
      if (m5ADX.bullish) {
        m5BuyScore += 10;
      }

      if (m5ADX.bearish) {
        m5SellScore += 10;
      }
    }

    // Structure
    if (m5Structure.bullish) {
      m5BuyScore += 10;
    }

    if (m5Structure.bearish) {
      m5SellScore += 10;
    }

    // BOS
    if (m5BOS.bullish) {
      m5BuyScore += 15;
    }

    if (m5BOS.bearish) {
      m5SellScore += 15;
    }

    // CHOCH
    if (m5CHOCH.bullish) {
      m5BuyScore += 10;
    }

    if (m5CHOCH.bearish) {
      m5SellScore += 10;
    }

    // Candle momentum
    if (m5Momentum.bullish) {
      m5BuyScore += 5;
    }

    if (m5Momentum.bearish) {
      m5SellScore += 5;
    }

    m5BuyScore =
      clamp(m5BuyScore, 0, 100);

    m5SellScore =
      clamp(m5SellScore, 0, 100);

    // =====================================================
    // M5 TRIGGER
    // =====================================================

    let m5Trigger = "WAIT";

    if (
      m5BuyScore >= 55 &&
      m5BuyScore > m5SellScore
    ) {
      m5Trigger = "BUY";
    }

    if (
      m5SellScore >= 55 &&
      m5SellScore > m5BuyScore
    ) {
      m5Trigger = "SELL";
    }

    // =====================================================
    // FINAL SCALP SIGNAL
    //
    // M15 + M5
    // H1 DOES NOT BLOCK ENTRY
    // =====================================================

    let signal = "WAIT";
    let signalType = "NONE";

    let score = 0;

    if (
      m15Bias === "BUY" &&
      m5Trigger === "BUY"
    ) {
      signal = "BUY";
      signalType = "SCALP";
      score =
        Math.round(
          (m15BuyScore + m5BuyScore) / 2
        );
    }

    if (
      m15Bias === "SELL" &&
      m5Trigger === "SELL"
    ) {
      signal = "SELL";
      signalType = "SCALP";
      score =
        Math.round(
          (m15SellScore + m5SellScore) / 2
        );
    }

    // =====================================================
    // EARLY OPPORTUNITY
    // =====================================================

    let opportunity = "NONE";

    if (
      m15BuyScore >= 50 &&
      m15BuyScore > m15SellScore
    ) {
      opportunity = "BUY";
    }

    if (
      m15SellScore >= 50 &&
      m15SellScore > m15BuyScore
    ) {
      opportunity = "SELL";
    }

    // =====================================================
    // H1 CONTEXT
    // =====================================================

    let context = "NEUTRAL";

    if (
      signal === "BUY" &&
      h1Direction === "BUY"
    ) {
      context = "WITH H1";
    }

    if (
      signal === "SELL" &&
      h1Direction === "SELL"
    ) {
      context = "WITH H1";
    }

    if (
      signal === "BUY" &&
      h1Direction === "SELL"
    ) {
      context = "COUNTER H1";
    }

    if (
      signal === "SELL" &&
      h1Direction === "BUY"
    ) {
      context = "COUNTER H1";
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
      signal !== "WAIT" &&
      m5ATR !== null
    ) {
      entry = price;

      const structureLow =
        lowest(
          m5.slice(-12).map(c => c.low)
        );

      const structureHigh =
        highest(
          m5.slice(-12).map(c => c.high)
        );

      if (signal === "BUY") {
        const atrSL =
          entry - m5ATR * 1.2;

        stopLoss =
          Math.min(
            atrSL,
            structureLow - m5ATR * 0.15
          );

        const risk =
          entry - stopLoss;

        tp1 =
          entry + risk * 1.5;

        tp2 =
          entry + risk * 2.5;

        rr = 2.5;
      }

      if (signal === "SELL") {
        const atrSL =
          entry + m5ATR * 1.2;

        stopLoss =
          Math.max(
            atrSL,
            structureHigh + m5ATR * 0.15
          );

        const risk =
          stopLoss - entry;

        tp1 =
          entry - risk * 1.5;

        tp2 =
          entry - risk * 2.5;

        rr = 2.5;
      }
    }

    // =====================================================
    // RESPONSE
    // =====================================================

    return res.status(200).json({
      ok: true,

      symbol: "XAU/USD",

      price,

      mode: "SCALP",

      signal,
      signalType,

      score,

      opportunity,

      context,

      h1: {
        direction: h1Direction,
        bull: h1Bull,
        bear: h1Bear
      },

      m15: {
        bias: m15Bias,

        buyScore: m15BuyScore,
        sellScore: m15SellScore,

        ema20: m15EMA20,
        ema50: m15EMA50,

        rsi: m15RSI,

        macd: m15MACD,

        adx: m15ADX,

        atr: m15ATR,

        bos: m15BOS,

        choch: m15CHOCH,

        structure: m15Structure
      },

      m5: {
        trigger: m5Trigger,

        buyScore: m5BuyScore,
        sellScore: m5SellScore,

        ema9: m5EMA9,
        ema20: m5EMA20,
        ema50: m5EMA50,

        rsi: m5RSI,

        macd: m5MACD,

        adx: m5ADX,

        atr: m5ATR,

        bos: m5BOS,

        choch: m5CHOCH,

        structure: m5Structure,

        momentum: m5Momentum
      },

      tradePlan: {
        entry,
        stopLoss,
        tp1,
        tp2,
        rr
      },

      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error(error);

    return res.status(500).json({
      error: error.message || "SCALP ENGINE ERROR"
    });
  }
}
