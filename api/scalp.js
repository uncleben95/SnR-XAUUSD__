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

    const EARLY_M15_MIN = 35;
    const ENTRY_M15_MIN = 50;

    const EARLY_M5_MIN = 50;
    const ENTRY_M5_MIN = 60;

    // =====================================================
    // FETCH M5
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
        error: "Data candle tidak mencukupi",
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

    function aggregate(data, minutes) {
      const buckets = {};
      const size = minutes * 60 * 1000;

      for (const c of data) {
        const timestamp =
          new Date(c.time).getTime();

        const key =
          Math.floor(timestamp / size) * size;

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
      }

      return Object.keys(buckets)
        .sort((a, b) => Number(a) - Number(b))
        .map(k => buckets[k]);
    }

    // =====================================================
    // MARKET STRUCTURE
    // =====================================================

    function structure(data, lookback = 20) {
      if (data.length < lookback * 2) {
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
        previousHigh,
        previousLow,

        bullish:
          last.close > previousHigh,

        bearish:
          last.close < previousLow
      };
    }

    function bos(data, lookback = 10) {
      if (data.length < lookback + 2) {
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
        highest(previous.map(c => c.high));

      const low =
        lowest(previous.map(c => c.low));

      return {
        bullish: last.close > high,
        bearish: last.close < low
      };
    }

    function choch(data, lookback = 8) {
      if (data.length < lookback * 2 + 2) {
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
        highest(recent.map(c => c.high));

      const recentLow =
        lowest(recent.map(c => c.low));

      const previousHigh =
        highest(previous.map(c => c.high));

      const previousLow =
        lowest(previous.map(c => c.low));

      return {
        bullish:
          recentHigh > previousHigh &&
          recent.at(-1).close > previousHigh,

        bearish:
          recentLow < previousLow &&
          recent.at(-1).close < previousLow
      };
    }

    // =====================================================
    // CANDLE MOMENTUM
    // =====================================================

    function momentum(data) {
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
        Math.abs(c.close - c.open);

      const bodyRatio =
        body / range;

      const bullish =
        c.close > c.open &&
        bodyRatio >= 0.45 &&
        c.close >=
          c.low + range * 0.65;

      const bearish =
        c.close < c.open &&
        bodyRatio >= 0.45 &&
        c.close <=
          c.low + range * 0.35;

      return {
        bullish,
        bearish,
        strength: Math.round(bodyRatio * 100)
      };
    }

    // =====================================================
    // LIQUIDITY SWEEP
    // =====================================================

    function liquiditySweep(data, lookback = 12) {
      if (data.length < lookback + 2) {
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
        highest(previous.map(c => c.high));

      const low =
        lowest(previous.map(c => c.low));

      return {
        // sweep sell-side liquidity
        bullish:
          current.low < low &&
          current.close > low,

        // sweep buy-side liquidity
        bearish:
          current.high > high &&
          current.close < high
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
    // H1 CONTEXT ONLY
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
      structure(m15, 20);

    const m15BOS =
      bos(m15, 12);

    const m15CHOCH =
      choch(m15, 10);

    const m15Sweep =
      liquiditySweep(m15, 12);

    const m15Momentum =
      momentum(m15);

    // =====================================================
    // M15 SCORING
    // =====================================================

    let m15Buy = 0;
    let m15Sell = 0;

    const m15BuyReasons = [];
    const m15SellReasons = [];

    // EMA 20/50
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

    // Price vs EMA20
    if (m15EMA20 !== null) {
      if (price > m15EMA20) {
        m15Buy += 10;
        m15BuyReasons.push(
          "Price above M15 EMA20"
        );
      }

      if (price < m15EMA20) {
        m15Sell += 10;
        m15SellReasons.push(
          "Price below M15 EMA20"
        );
      }
    }

    // RSI
    if (m15RSI !== null) {
      if (
        m15RSI >= 50 &&
        m15RSI <= 72
      ) {
        m15Buy += 10;
        m15BuyReasons.push(
          "M15 RSI bullish zone"
        );
      }

      if (
        m15RSI >= 28 &&
        m15RSI < 50
      ) {
        m15Sell += 10;
        m15SellReasons.push(
          "M15 RSI bearish zone"
        );
      }
    }

    // MACD
    if (m15MACD?.bullish) {
      m15Buy += 15;
      m15BuyReasons.push(
        "M15 MACD bullish"
      );
    }

    if (m15MACD?.bearish) {
      m15Sell += 15;
      m15SellReasons.push(
        "M15 MACD bearish"
      );
    }

    // Structure
    if (m15Structure.bullish) {
      m15Buy += 15;
      m15BuyReasons.push(
        "M15 bullish structure"
      );
    }

    if (m15Structure.bearish) {
      m15Sell += 15;
      m15SellReasons.push(
        "M15 bearish structure"
      );
    }

    // BOS
    if (m15BOS.bullish) {
      m15Buy += 15;
      m15BuyReasons.push(
        "M15 bullish BOS"
      );
    }

    if (m15BOS.bearish) {
      m15Sell += 15;
      m15SellReasons.push(
        "M15 bearish BOS"
      );
    }

    // CHOCH
    if (m15CHOCH.bullish) {
      m15Buy += 10;
      m15BuyReasons.push(
        "M15 bullish CHOCH"
      );
    }

    if (m15CHOCH.bearish) {
      m15Sell += 10;
      m15SellReasons.push(
        "M15 bearish CHOCH"
      );
    }

    // Liquidity
    if (m15Sweep.bullish) {
      m15Buy += 10;
      m15BuyReasons.push(
        "M15 sell-side liquidity sweep"
      );
    }

    if (m15Sweep.bearish) {
      m15Sell += 10;
      m15SellReasons.push(
        "M15 buy-side liquidity sweep"
      );
    }

    // Momentum
    if (m15Momentum.bullish) {
      m15Buy += 5;
      m15BuyReasons.push(
        "M15 bullish momentum"
      );
    }

    if (m15Momentum.bearish) {
      m15Sell += 5;
      m15SellReasons.push(
        "M15 bearish momentum"
      );
    }

    m15Buy =
      clamp(m15Buy, 0, 100);

    m15Sell =
      clamp(m15Sell, 0, 100);

    // =====================================================
    // M15 DIRECTION
    // =====================================================

    let m15Direction = "MIXED";

    if (
      m15Buy >= EARLY_M15_MIN &&
      m15Buy > m15Sell + 5
    ) {
      m15Direction = "BUY";
    }

    if (
      m15Sell >= EARLY_M15_MIN &&
      m15Sell > m15Buy + 5
    ) {
      m15Direction = "SELL";
    }

    if (
      Math.abs(m15Buy - m15Sell) <= 5
    ) {
      m15Direction = "MIXED";
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
      structure(m5, 24);

    const m5BOS =
      bos(m5, 10);

    const m5CHOCH =
      choch(m5, 8);

    const m5Sweep =
      liquiditySweep(m5, 10);

    const m5Momentum =
      momentum(m5);

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
      if (m5EMA9 > m5EMA20) {
        m5Buy += 15;
        m5BuyReasons.push(
          "M5 EMA9 > EMA20"
        );
      }

      if (m5EMA9 < m5EMA20) {
        m5Sell += 15;
        m5SellReasons.push(
          "M5 EMA9 < EMA20"
        );
      }
    }

    // EMA 20/50
    if (
      m5EMA20 !== null &&
      m5EMA50 !== null
    ) {
      if (m5EMA20 > m5EMA50) {
        m5Buy += 15;
        m5BuyReasons.push(
          "M5 EMA20 > EMA50"
        );
      }

      if (m5EMA20 < m5EMA50) {
        m5Sell += 15;
        m5SellReasons.push(
          "M5 EMA20 < EMA50"
        );
      }
    }

    // RSI
    if (m5RSI !== null) {
      if (
        m5RSI >= 50 &&
        m5RSI <= 75
      ) {
        m5Buy += 10;
        m5BuyReasons.push(
          "M5 RSI bullish"
        );
      }

      if (
        m5RSI >= 25 &&
        m5RSI < 50
      ) {
        m5Sell += 10;
        m5SellReasons.push(
          "M5 RSI bearish"
        );
      }
    }

    // MACD
    if (m5MACD?.bullish) {
      m5Buy += 15;
      m5BuyReasons.push(
        "M5 MACD bullish"
      );
    }

    if (m5MACD?.bearish) {
      m5Sell += 15;
      m5SellReasons.push(
        "M5 MACD bearish"
      );
    }

    // Structure
    if (m5Structure.bullish) {
      m5Buy += 10;
      m5BuyReasons.push(
        "M5 bullish structure"
      );
    }

    if (m5Structure.bearish) {
      m5Sell += 10;
      m5SellReasons.push(
        "M5 bearish structure"
      );
    }

    // BOS
    if (m5BOS.bullish) {
      m5Buy += 15;
      m5BuyReasons.push(
        "M5 bullish BOS"
      );
    }

    if (m5BOS.bearish) {
      m5Sell += 15;
      m5SellReasons.push(
        "M5 bearish BOS"
      );
    }

    // CHOCH
    if (m5CHOCH.bullish) {
      m5Buy += 10;
      m5BuyReasons.push(
        "M5 bullish CHOCH"
      );
    }

    if (m5CHOCH.bearish) {
      m5Sell += 10;
      m5SellReasons.push(
        "M5 bearish CHOCH"
      );
    }

    // Liquidity
    if (m5Sweep.bullish) {
      m5Buy += 10;
      m5BuyReasons.push(
        "M5 sell-side liquidity sweep"
      );
    }

    if (m5Sweep.bearish) {
      m5Sell += 10;
      m5SellReasons.push(
        "M5 buy-side liquidity sweep"
      );
    }

    // Momentum
    if (m5Momentum.bullish) {
      m5Buy += 10;
      m5BuyReasons.push(
        "M5 bullish candle momentum"
      );
    }

    if (m5Momentum.bearish) {
      m5Sell += 10;
      m5SellReasons.push(
        "M5 bearish candle momentum"
      );
    }

    m5Buy =
      clamp(m5Buy, 0, 100);

    m5Sell =
      clamp(m5Sell, 0, 100);

    // =====================================================
    // M5 TRIGGER
    // =====================================================

    let m5Trigger = "WAIT";

    if (
      m5Buy >= EARLY_M5_MIN &&
      m5Buy > m5Sell + 5
    ) {
      m5Trigger = "BUY";
    }

    if (
      m5Sell >= EARLY_M5_MIN &&
      m5Sell > m5Buy + 5
    ) {
      m5Trigger = "SELL";
    }

    // =====================================================
    // FINAL SCALP ENGINE
    // =====================================================

    let status = "WAIT";
    let signal = "WAIT";
    let score = 0;

    const reasons = [];

    // -----------------------------------------------------
    // ENTRY BUY
    // -----------------------------------------------------

    if (
      m15Direction === "BUY" &&
      m15Buy >= ENTRY_M15_MIN &&
      m5Trigger === "BUY" &&
      m5Buy >= ENTRY_M5_MIN
    ) {
      status = "ENTRY";
      signal = "BUY";

      score =
        Math.round(
          (m15Buy + m5Buy) / 2
        );

      reasons.push(
        "M15 bullish direction"
      );

      reasons.push(
        "M5 bullish trigger"
      );
    }

    // -----------------------------------------------------
    // ENTRY SELL
    // -----------------------------------------------------

    if (
      m15Direction === "SELL" &&
      m15Sell >= ENTRY_M15_MIN &&
      m5Trigger === "SELL" &&
      m5Sell >= ENTRY_M5_MIN
    ) {
      status = "ENTRY";
      signal = "SELL";

      score =
        Math.round(
          (m15Sell + m5Sell) / 2
        );

      reasons.push(
        "M15 bearish direction"
      );

      reasons.push(
        "M5 bearish trigger"
      );
    }

    // =====================================================
    // EARLY BUY
    // =====================================================

    if (
      status === "WAIT" &&
      m5Trigger === "BUY" &&
      m5Buy >= EARLY_M5_MIN &&
      m15Buy >= EARLY_M15_MIN &&
      m15Buy > m15Sell
    ) {
      status = "EARLY";
      signal = "BUY";

      score =
        Math.round(
          (m15Buy + m5Buy) / 2
        );

      reasons.push(
        "M15 developing bullish setup"
      );

      reasons.push(
        "M5 bullish trigger"
      );
    }

    // =====================================================
    // EARLY SELL
    // =====================================================

    if (
      status === "WAIT" &&
      m5Trigger === "SELL" &&
      m5Sell >= EARLY_M5_MIN &&
      m15Sell >= EARLY_M15_MIN &&
      m15Sell > m15Buy
    ) {
      status = "EARLY";
      signal = "SELL";

      score =
        Math.round(
          (m15Sell + m5Sell) / 2
        );

      reasons.push(
        "M15 developing bearish setup"
      );

      reasons.push(
        "M5 bearish trigger"
      );
    }

    // =====================================================
    // M5-ONLY OPPORTUNITY
    // =====================================================

    if (
      status === "WAIT" &&
      m5Trigger === "BUY" &&
      m5Buy >= 55
    ) {
      status = "M5_ONLY";
      signal = "BUY";

      score = m5Buy;

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
      m5Sell >= 55
    ) {
      status = "M5_ONLY";
      signal = "SELL";

      score = m5Sell;

      reasons.push(
        "M5 bearish opportunity"
      );

      reasons.push(
        "M15 not confirmed"
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
    }

    if (
      signal === "SELL" &&
      h1Direction === "SELL"
    ) {
      context = "WITH_H1";
    }

    if (
      signal === "BUY" &&
      h1Direction === "SELL"
    ) {
      context = "COUNTER_H1";
    }

    if (
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

    // Only calculate proper plan for ENTRY
    if (
      status === "ENTRY" &&
      m5ATR !== null
    ) {
      entry = price;

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
      }

      if (signal === "SELL") {
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

      symbol: "XAU/USD",

      mode: "SCALP",

      price,

      status,

      signal,

      score,

      context,

      reasons,

      h1: {
        direction: h1Direction,
        context
      },

      m15: {
        direction: m15Direction,

        buyScore: m15Buy,
        sellScore: m15Sell,

        ema20: m15EMA20,
        ema50: m15EMA50,

        rsi: m15RSI,

        macd: m15MACD,

        atr: m15ATR,

        bos: m15BOS,

        choch: m15CHOCH,

        sweep: m15Sweep,

        momentum: m15Momentum,

        structure: m15Structure,

        buyReasons: m15BuyReasons,
        sellReasons: m15SellReasons
      },

      m5: {
        trigger: m5Trigger,

        buyScore: m5Buy,
        sellScore: m5Sell,

        ema9: m5EMA9,
        ema20: m5EMA20,
        ema50: m5EMA50,

        rsi: m5RSI,

        macd: m5MACD,

        atr: m5ATR,

        bos: m5BOS,

        choch: m5CHOCH,

        sweep: m5Sweep,

        momentum: m5Momentum,

        structure: m5Structure,

        buyReasons: m5BuyReasons,
        sellReasons: m5SellReasons
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
      "SCALP V2 ERROR:",
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
