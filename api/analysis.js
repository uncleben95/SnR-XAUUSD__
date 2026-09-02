export default async function handler(req, res) {
  try {
    const API_KEY = process.env.TWELVE_DATA_API_KEY;

    if (!API_KEY) {
      return res.status(500).json({
        error: "TWELVE_DATA_API_KEY belum diset"
      });
    }

    const url =
      `https://api.twelvedata.com/time_series` +
      `?symbol=XAU/USD` +
      `&interval=5min` +
      `&outputsize=3000` +
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

    if (candles.length < 300) {
      return res.status(422).json({
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
          values[i] -
          values[i - 1];

        if (change > 0) {
          gain += change;
        }

        if (change < 0) {
          loss -= change;
        }
      }

      if (loss === 0) {
        return 100;
      }

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
      if (values.length < 35) {
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
          lines.push(
            e12 - e26
          );
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
        bullish:
          line > signal,
        bearish:
          line < signal
      };
    }

    function adx(data, period = 14) {
      if (
        data.length <
        period * 2 + 2
      ) {
        return null;
      }

      const trs = [];
      const plusDM = [];
      const minusDM = [];

      for (
        let i = 1;
        i < data.length;
        i++
      ) {
        const h =
          data[i].high;

        const l =
          data[i].low;

        const ph =
          data[i - 1].high;

        const pl =
          data[i - 1].low;

        const pc =
          data[i - 1].close;

        trs.push(
          Math.max(
            h - l,
            Math.abs(h - pc),
            Math.abs(l - pc)
          )
        );

        const up =
          h - ph;

        const down =
          pl - l;

        plusDM.push(
          up > down && up > 0
            ? up
            : 0
        );

        minusDM.push(
          down > up && down > 0
            ? down
            : 0
        );
      }

      const tr =
        avg(
          trs.slice(-period)
        );

      const plus =
        avg(
          plusDM.slice(-period)
        );

      const minus =
        avg(
          minusDM.slice(-period)
        );

      if (!tr) {
        return null;
      }

      const plusDI =
        100 * plus / tr;

      const minusDI =
        100 * minus / tr;

      const value =
        100 *
        Math.abs(
          plusDI - minusDI
        ) /
        (plusDI + minusDI || 1);

      return {
        value,
        plusDI,
        minusDI,
        bullish:
          plusDI > minusDI,
        bearish:
          minusDI > plusDI
      };
    }

    function aggregate(data, minutes) {
      const buckets = {};

      data.forEach(c => {
        const time =
          new Date(c.time).getTime();

        const size =
          minutes *
          60 *
          1000;

        const key =
          Math.floor(
            time / size
          ) * size;

        if (!buckets[key]) {
          buckets[key] = {
            time:
              new Date(
                key
              ).toISOString(),

            open:
              c.open,

            high:
              c.high,

            low:
              c.low,

            close:
              c.close,

            volume:
              c.volume
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
      });

      return Object.keys(buckets)
        .sort(
          (a, b) =>
            Number(a) -
            Number(b)
        )
        .map(
          k => buckets[k]
        );
    }

    // =====================================================
    // STRUCTURE
    // =====================================================

    function structure(
      data,
      lookback = 30
    ) {
      if (
        data.length <
        lookback + 5
      ) {
        return {
          high: null,
          low: null,
          previousHigh: null,
          previousLow: null,
          bullish: false,
          bearish: false
        };
      }

      const current =
        data.slice(-lookback);

      const previous =
        data.slice(
          -lookback * 2,
          -lookback
        );

      const high =
        highest(
          current.map(
            c => c.high
          )
        );

      const low =
        lowest(
          current.map(
            c => c.low
          )
        );

      const previousHigh =
        highest(
          previous.map(
            c => c.high
          )
        );

      const previousLow =
        lowest(
          previous.map(
            c => c.low
          )
        );

      const last =
        data.at(-1);

      return {
        high,
        low,
        previousHigh,
        previousLow,

        bullish:
          high >
            previousHigh &&
          last.close >
            previousHigh,

        bearish:
          low <
            previousLow &&
          last.close <
            previousLow
      };
    }

    function detectBOS(
      data,
      lookback = 20
    ) {
      if (
        data.length <
        lookback + 3
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

      const previousHigh =
        highest(
          previous.map(
            c => c.high
          )
        );

      const previousLow =
        lowest(
          previous.map(
            c => c.low
          )
        );

      return {
        bullish:
          last.close >
          previousHigh,

        bearish:
          last.close <
          previousLow
      };
    }

    function detectCHOCH(
      data,
      lookback = 25
    ) {
      if (
        data.length <
        lookback * 2 + 5
      ) {
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
        highest(
          recent.map(
            c => c.high
          )
        );

      const recentLow =
        lowest(
          recent.map(
            c => c.low
          )
        );

      const oldHigh =
        highest(
          old.map(
            c => c.high
          )
        );

      const oldLow =
        lowest(
          old.map(
            c => c.low
          )
        );

      const last =
        data.at(-1);

      return {
        bullish:
          recentHigh >
            oldHigh &&
          last.close >
            oldHigh,

        bearish:
          recentLow <
            oldLow &&
          last.close <
            oldLow
      };
    }

    // =====================================================
    // TIMEFRAMES
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
      m5.map(
        c => c.close
      );

    const c15 =
      m15.map(
        c => c.close
      );

    const c1 =
      h1.map(
        c => c.close
      );

    const price =
      c5.at(-1);

    // =====================================================
    // INDICATORS
    // =====================================================

    const h1EMA50 =
      ema(c1, 50);

    const h1EMA200 =
      ema(c1, 200);

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

    const m5EMA20 =
      ema(c5, 20);

    const m5EMA50 =
      ema(c5, 50);

    const m5RSI =
      rsi(c5);

    const m5ATR =
      atr(m5);

    // =====================================================
    // H1 BIAS
    // =====================================================

    const h1Bull =
      h1EMA200 !== null &&
      h1EMA50 !== null &&
      price > h1EMA200 &&
      h1EMA50 > h1EMA200;

    const h1Bear =
      h1EMA200 !== null &&
      h1EMA50 !== null &&
      price < h1EMA200 &&
      h1EMA50 < h1EMA200;

    // =====================================================
    // M15
    // =====================================================

    const m15Bull =
      m15EMA20 !== null &&
      m15EMA50 !== null &&
      m15EMA20 >
        m15EMA50;

    const m15Bear =
      m15EMA20 !== null &&
      m15EMA50 !== null &&
      m15EMA20 <
        m15EMA50;

    const m15MomentumBull =
      m15RSI !== null &&
      m15RSI >= 50 &&
      m15RSI <= 70;

    const m15MomentumBear =
      m15RSI !== null &&
      m15RSI >= 30 &&
      m15RSI < 50;

    // =====================================================
    // STRUCTURE
    // =====================================================

    const h1Structure =
      structure(
        h1,
        25
      );

    const m15Structure =
      structure(
        m15,
        30
      );

    const m5Structure =
      structure(
        m5,
        36
      );

    const m15BOS =
      detectBOS(
        m15,
        20
      );

    const m5BOS =
      detectBOS(
        m5,
        20
      );

    const m15CHOCH =
      detectCHOCH(
        m15,
        20
      );

    const m5CHOCH =
      detectCHOCH(
        m5,
        25
      );

    // =====================================================
    // M5
    // =====================================================

    const last5 =
      m5.at(-1);

    const prev5 =
      m5.at(-2);

    const m5Bull =
      m5EMA20 !== null &&
      m5EMA50 !== null &&
      m5EMA20 >
        m5EMA50;

    const m5Bear =
      m5EMA20 !== null &&
      m5EMA50 !== null &&
      m5EMA20 <
        m5EMA50;

    // =====================================================
    // LIQUIDITY
    // =====================================================

    const recentHigh =
      highest(
        m5
          .slice(-48)
          .map(
            c => c.high
          )
      );

    const recentLow =
      lowest(
        m5
          .slice(-48)
          .map(
            c => c.low
          )
      );

    const asianCandles =
      m5.filter(c => {
        const d =
          new Date(c.time);

        const hour =
          d.getUTCHours();

        return (
          hour >= 0 &&
          hour < 8
        );
      });

    const asianHigh =
      asianCandles.length
        ? highest(
            asianCandles.map(
              c => c.high
            )
          )
        : recentHigh;

    const asianLow =
      asianCandles.length
        ? lowest(
            asianCandles.map(
              c => c.low
            )
          )
        : recentLow;

    // =====================================================
    // SWEEP DETECTION
    // =====================================================

    const previousCandles =
      m5.slice(-11, -1);

    const priorHigh =
      highest(
        previousCandles.map(
          c => c.high
        )
      );

    const priorLow =
      lowest(
        previousCandles.map(
          c => c.low
        )
      );

    const range =
      last5.high -
      last5.low;

    const body =
      Math.abs(
        last5.close -
        last5.open
      );

    const upperWick =
      last5.high -
      Math.max(
        last5.open,
        last5.close
      );

    const lowerWick =
      Math.min(
        last5.open,
        last5.close
      ) -
      last5.low;

    const bearishSweep =
      (
        last5.high >
          priorHigh ||
        last5.high >
          asianHigh
      ) &&
      last5.close <
        priorHigh &&
      upperWick >
        body * 1.15;

    const bullishSweep =
      (
        last5.low <
          priorLow ||
        last5.low <
          asianLow
      ) &&
      last5.close >
        priorLow &&
      lowerWick >
        body * 1.15;

    // =====================================================
    // DISPLACEMENT
    // =====================================================

    const averageRange =
      avg(
        m5
          .slice(-21, -1)
          .map(
            c =>
              c.high -
              c.low
          )
      ) || range;

    const bullishDisplacement =
      last5.close >
        last5.open &&
      range >
        averageRange * 1.25 &&
      body /
        (range || 1) >
        0.55;

    const bearishDisplacement =
      last5.close <
        last5.open &&
      range >
        averageRange * 1.25 &&
      body /
        (range || 1) >
        0.55;

    // =====================================================
    // SUPPORT / RESISTANCE
    // =====================================================

    const support =
      lowest(
        m15
          .slice(-30)
          .map(
            c => c.low
          )
      );

    const resistance =
      highest(
        m15
          .slice(-30)
          .map(
            c => c.high
          )
      );

    const majorSupport =
      lowest(
        m15
          .slice(-80)
          .map(
            c => c.low
          )
      );

    const majorResistance =
      highest(
        m15
          .slice(-80)
          .map(
            c => c.high
          )
      );

    // =====================================================
    // ROOM TO RUN
    // =====================================================

    const atrValue =
      m15ATR ||
      m5ATR ||
      1;

    const distanceToSupport =
      price -
      support;

    const distanceToResistance =
      resistance -
      price;

    const distanceToMajorSupport =
      price -
      majorSupport;

    const distanceToMajorResistance =
      majorResistance -
      price;

    const sellRoom =
      distanceToSupport >=
      atrValue * 1.50;

    const buyRoom =
      distanceToResistance >=
      atrValue * 1.50;

    const sellExcellentRoom =
      distanceToMajorSupport >=
      atrValue * 2.50;

    const buyExcellentRoom =
      distanceToMajorResistance >=
      atrValue * 2.50;

    // =====================================================
    // VWAP
    // =====================================================

    const vwapData =
      m5.slice(-288);

    let pv = 0;
    let volume = 0;

    vwapData.forEach(c => {
      const typical =
        (
          c.high +
          c.low +
          c.close
        ) / 3;

      const v =
        c.volume || 1;

      pv +=
        typical * v;

      volume += v;
    });

    const vwap =
      volume
        ? pv / volume
        : price;

    const aboveVWAP =
      price > vwap;

    const belowVWAP =
      price < vwap;

    // =====================================================
    // REVERSAL
    // =====================================================

    const bullishReversal =
      (
        m15CHOCH.bullish ||
        m5CHOCH.bullish
      ) &&
      (
        bullishSweep ||
        bullishDisplacement
      ) &&
      (
        m5BOS.bullish ||
        bullishDisplacement
      ) &&
      aboveVWAP;

    const bearishReversal =
      (
        m15CHOCH.bearish ||
        m5CHOCH.bearish
      ) &&
      (
        bearishSweep ||
        bearishDisplacement
      ) &&
      (
        m5BOS.bearish ||
        bearishDisplacement
      ) &&
      belowVWAP;

    // =====================================================
    // MANIPULATION
    // =====================================================

    const bullishManipulation =
      bullishSweep &&
      !m5BOS.bullish;

    const bearishManipulation =
      bearishSweep &&
      !m5BOS.bearish;

    // =====================================================
    // SCALPING ENGINE
    //
    // IMPORTANT:
    // H1 IS NOT REQUIRED
    //
    // M15 = CONFIRMATION
    // M5  = TRIGGER
    // =====================================================

    const m15ConfirmBuy =
      m15Bull &&
      m15MomentumBull &&
      (
        m15BOS.bullish ||
        m15Structure.bullish
      );

    const m15ConfirmSell =
      m15Bear &&
      m15MomentumBear &&
      (
        m15BOS.bearish ||
        m15Structure.bearish
      );

    const m5TriggerBuy =
      m5Bull &&
      (
        m5BOS.bullish ||
        bullishDisplacement
      ) &&
      !bearishManipulation;

    const m5TriggerSell =
      m5Bear &&
      (
        m5BOS.bearish ||
        bearishDisplacement
      ) &&
      !bullishManipulation;

    // =====================================================
    // SCALP ROOM FILTER
    // =====================================================

    const scalpBuy =
      m15ConfirmBuy &&
      m5TriggerBuy &&
      buyRoom;

    const scalpSell =
      m15ConfirmSell &&
      m5TriggerSell &&
      sellRoom;

    let scalpSignal =
      "WAIT";

    if (
      scalpBuy &&
      !scalpSell
    ) {
      scalpSignal =
        "BUY";
    }

    if (
      scalpSell &&
      !scalpBuy
    ) {
      scalpSignal =
        "SELL";
    }

    // =====================================================
    // SCALP MODE
    // =====================================================

    let scalpMode =
      "WAIT";

    if (
      scalpSignal === "BUY"
    ) {
      if (h1Bull) {
        scalpMode =
          "SCALP + H1 ALIGNED";
      } else if (h1Bear) {
        scalpMode =
          "SCALP COUNTER H1";
      } else {
        scalpMode =
          "SCALP H1 NEUTRAL";
      }
    }

    if (
      scalpSignal === "SELL"
    ) {
      if (h1Bear) {
        scalpMode =
          "SCALP + H1 ALIGNED";
      } else if (h1Bull) {
        scalpMode =
          "SCALP COUNTER H1";
      } else {
        scalpMode =
          "SCALP H1 NEUTRAL";
      }
    }

    // =====================================================
    // CONTINUATION
    // =====================================================

    const bullishContinuation =
      h1Bull &&
      m15Bull &&
      (
        m15BOS.bullish ||
        m5BOS.bullish ||
        bullishDisplacement
      ) &&
      m15MomentumBull &&
      !bearishManipulation;

    const bearishContinuation =
      h1Bear &&
      m15Bear &&
      (
        m15BOS.bearish ||
        m5BOS.bearish ||
        bearishDisplacement
      ) &&
      m15MomentumBear &&
      !bullishManipulation;

    // =====================================================
    // SCORE
    // =====================================================

    let buyScore = 0;
    let sellScore = 0;

    if (h1Bull)
      buyScore += 20;

    if (h1Bear)
      sellScore += 20;

    if (m15Bull)
      buyScore += 15;

    if (m15Bear)
      sellScore += 15;

    if (m15Structure.bullish)
      buyScore += 10;

    if (m15Structure.bearish)
      sellScore += 10;

    if (m15BOS.bullish)
      buyScore += 8;

    if (m15BOS.bearish)
      sellScore += 8;

    if (m15MomentumBull)
      buyScore += 7;

    if (m15MomentumBear)
      sellScore += 7;

    if (m15MACD?.bullish)
      buyScore += 5;

    if (m15MACD?.bearish)
      sellScore += 5;

    if (m15ADX?.value >= 20) {
      if (m15ADX.bullish)
        buyScore += 5;

      if (m15ADX.bearish)
        sellScore += 5;
    }

    if (m5Bull)
      buyScore += 5;

    if (m5Bear)
      sellScore += 5;

    if (aboveVWAP)
      buyScore += 5;

    if (belowVWAP)
      sellScore += 5;

    if (bullishDisplacement)
      buyScore += 5;

    if (bearishDisplacement)
      sellScore += 5;

    // ROOM FILTER

    if (!buyRoom)
      buyScore -= 20;

    if (!sellRoom)
      sellScore -= 20;

    if (buyExcellentRoom)
      buyScore += 5;

    if (sellExcellentRoom)
      sellScore += 5;

    // MANIPULATION PENALTY

    if (bullishManipulation)
      buyScore -= 20;

    if (bearishManipulation)
      sellScore -= 20;

    buyScore =
      clamp(
        buyScore,
        0,
        100
      );

    sellScore =
      clamp(
        sellScore,
        0,
        100
      );

    // =====================================================
    // REGIME
    // =====================================================

    let regime =
      "UNCLEAR";

    let regimeDirection =
      "NEUTRAL";

    let regimeConfidence =
      0;

    // MANIPULATION

    if (bearishManipulation) {
      regime =
        "MANIPULATION";

      regimeDirection =
        "BEARISH";

      regimeConfidence =
        clamp(
          70 +
          (bearishSweep ? 10 : 0) +
          (bearishDisplacement ? 10 : 0),
          0,
          95
        );
    }

    else if (
      bullishManipulation
    ) {
      regime =
        "MANIPULATION";

      regimeDirection =
        "BULLISH";

      regimeConfidence =
        clamp(
          70 +
          (bullishSweep ? 10 : 0) +
          (bullishDisplacement ? 10 : 0),
          0,
          95
        );
    }

    // REVERSAL

    if (
      regime === "UNCLEAR" &&
      bearishReversal
    ) {
      regime =
        "REVERSAL";

      regimeDirection =
        "BEARISH";

      regimeConfidence =
        clamp(
          75 +
          (m15CHOCH.bearish ? 8 : 0) +
          (m5BOS.bearish ? 7 : 0),
          0,
          95
        );
    }

    if (
      regime === "UNCLEAR" &&
      bullishReversal
    ) {
      regime =
        "REVERSAL";

      regimeDirection =
        "BULLISH";

      regimeConfidence =
        clamp(
          75 +
          (m15CHOCH.bullish ? 8 : 0) +
          (m5BOS.bullish ? 7 : 0),
          0,
          95
        );
    }

    // CONTINUATION

    if (
      regime === "UNCLEAR" &&
      bearishContinuation
    ) {
      regime =
        "CONTINUATION";

      regimeDirection =
        "BEARISH";

      regimeConfidence =
        clamp(
          sellScore,
          0,
          95
        );
    }

    if (
      regime === "UNCLEAR" &&
      bullishContinuation
    ) {
      regime =
        "CONTINUATION";

      regimeDirection =
        "BULLISH";

      regimeConfidence =
        clamp(
          buyScore,
          0,
          95
        );
    }

    // =====================================================
    // FINAL MAIN SIGNAL
    // =====================================================

    let signal =
      "WAIT";

    let reason =
      "No clear setup";

    let score =
      Math.max(
        buyScore,
        sellScore
      );

    // CONTINUATION BUY

    if (
      regime ===
        "CONTINUATION" &&
      regimeDirection ===
        "BULLISH" &&
      buyScore >= 70 &&
      buyRoom
    ) {
      signal =
        "BUY";

      reason =
        "Bullish continuation with room to run";
    }

    // CONTINUATION SELL

    if (
      regime ===
        "CONTINUATION" &&
      regimeDirection ===
        "BEARISH" &&
      sellScore >= 70 &&
      sellRoom
    ) {
      signal =
        "SELL";

      reason =
        "Bearish continuation with room to run";
    }

    // REVERSAL BUY

    if (
      regime ===
        "REVERSAL" &&
      regimeDirection ===
        "BULLISH" &&
      buyScore >= 65 &&
      buyRoom
    ) {
      signal =
        "BUY";

      reason =
        "Confirmed bullish reversal";
    }

    // REVERSAL SELL

    if (
      regime ===
        "REVERSAL" &&
      regimeDirection ===
        "BEARISH" &&
      sellScore >= 65 &&
      sellRoom
    ) {
      signal =
        "SELL";

      reason =
        "Confirmed bearish reversal";
    }

    // MANIPULATION

    if (
      regime ===
      "MANIPULATION"
    ) {
      signal =
        "WAIT";

      reason =
        regimeDirection ===
        "BEARISH"
          ? "Bearish liquidity manipulation detected - wait for confirmation"
          : "Bullish liquidity manipulation detected - wait for confirmation";
    }

    // NO ROOM

    if (
      signal === "BUY" &&
      !buyRoom
    ) {
      signal =
        "WAIT";

      reason =
        "BUY rejected: insufficient room before resistance";
    }

    if (
      signal === "SELL" &&
      !sellRoom
    ) {
      signal =
        "WAIT";

      reason =
        "SELL rejected: insufficient room before support";
    }

    // =====================================================
    // TRADE PLAN
    // =====================================================

    let trade = {
      entry: null,
      entryLow: null,
      entryHigh: null,
      sl: null,
      tp1: null,
      tp2: null,
      tp3: null,
      risk: null,
      rr: null
    };

    if (
      signal !== "WAIT" &&
      m5ATR > 0
    ) {
      const entry =
        price;

      // BUY

      if (
        signal === "BUY"
      ) {
        const sl =
          Math.min(
            support -
              atrValue * 0.30,

            entry -
              m5ATR * 1.30
          );

        const risk =
          entry - sl;

        const tp1 =
          Math.max(
            resistance,

            entry +
              risk * 1.5
          );

        const tp2 =
          Math.max(
            majorResistance,

            entry +
              risk * 2.5
          );

        const tp3 =
          entry +
          Math.max(
            risk * 4,
            atrValue * 4.5
          );

        trade = {
          entry,

          entryLow:
            entry -
            m5ATR * 0.20,

          entryHigh:
            entry +
            m5ATR * 0.20,

          sl,
          tp1,
          tp2,
          tp3,

          risk,

          rr:
            Number(
              (
                (tp3 - entry) /
                risk
              ).toFixed(2)
            )
        };
      }

      // SELL

      if (
        signal === "SELL"
      ) {
        const sl =
          Math.max(
            resistance +
              atrValue * 0.30,

            entry +
              m5ATR * 1.30
          );

        const risk =
          sl - entry;

        const tp1 =
          Math.min(
            support,

            entry -
              risk * 1.5
          );

        const tp2 =
          Math.min(
            majorSupport,

            entry -
              risk * 2.5
          );

        const tp3 =
          entry -
          Math.max(
            risk * 4,
            atrValue * 4.5
          );

        trade = {
          entry,

          entryLow:
            entry -
            m5ATR * 0.20,

          entryHigh:
            entry +
            m5ATR * 0.20,

          sl,
          tp1,
          tp2,
          tp3,

          risk,

          rr:
            Number(
              (
                (entry - tp3) /
                risk
              ).toFixed(2)
            )
        };
      }
    }

    // =====================================================
    // SCALP TRADE PLAN
    // =====================================================

    let scalpTrade = {
      entry: null,
      entryLow: null,
      entryHigh: null,
      sl: null,
      tp1: null,
      tp2: null,
      tp3: null,
      risk: null,
      rr: null
    };

    if (
      scalpSignal !== "WAIT" &&
      m5ATR > 0
    ) {
      const entry =
        price;

      // ===================================================
      // SCALP BUY
      // ===================================================

      if (
        scalpSignal === "BUY"
      ) {
        const sl =
          Math.min(
            support -
              m5ATR * 0.20,

            entry -
              m5ATR * 1.10
          );

        const risk =
          entry - sl;

        const tp1 =
          entry +
          risk * 1.20;

        const tp2 =
          entry +
          risk * 2.00;

        const tp3 =
          entry +
          risk * 3.00;

        scalpTrade = {
          entry,

          entryLow:
            entry -
            m5ATR * 0.15,

          entryHigh:
            entry +
            m5ATR * 0.15,

          sl,
          tp1,
          tp2,
          tp3,

          risk,

          rr:
            Number(
              (
                (tp3 - entry) /
                risk
              ).toFixed(2)
            )
        };
      }

      // ===================================================
      // SCALP SELL
      // ===================================================

      if (
        scalpSignal === "SELL"
      ) {
        const sl =
          Math.max(
            resistance +
              m5ATR * 0.20,

            entry +
              m5ATR * 1.10
          );

        const risk =
          sl - entry;

        const tp1 =
          entry -
          risk * 1.20;

        const tp2 =
          entry -
          risk * 2.00;

        const tp3 =
          entry -
          risk * 3.00;

        scalpTrade = {
          entry,

          entryLow:
            entry -
            m5ATR * 0.15,

          entryHigh:
            entry +
            m5ATR * 0.15,

          sl,
          tp1,
          tp2,
          tp3,

          risk,

          rr:
            Number(
              (
                (entry - tp3) /
                risk
              ).toFixed(2)
            )
        };
      }
    }

    // =====================================================
    // SCALP SCORE
    // =====================================================

    let scalpBuyScore = 0;
    let scalpSellScore = 0;

    if (m15Bull)
      scalpBuyScore += 25;

    if (m15Bear)
      scalpSellScore += 25;

    if (m15MomentumBull)
      scalpBuyScore += 20;

    if (m15MomentumBear)
      scalpSellScore += 20;

    if (m15BOS.bullish)
      scalpBuyScore += 20;

    if (m15BOS.bearish)
      scalpSellScore += 20;

    if (m15Structure.bullish)
      scalpBuyScore += 10;

    if (m15Structure.bearish)
      scalpSellScore += 10;

    if (m5Bull)
      scalpBuyScore += 10;

    if (m5Bear)
      scalpSellScore += 10;

    if (m5BOS.bullish)
      scalpBuyScore += 10;

    if (m5BOS.bearish)
      scalpSellScore += 10;

    if (bullishDisplacement)
      scalpBuyScore += 5;

    if (bearishDisplacement)
      scalpSellScore += 5;

    if (!buyRoom)
      scalpBuyScore -= 20;

    if (!sellRoom)
      scalpSellScore -= 20;

    if (bullishManipulation)
      scalpBuyScore -= 20;

    if (bearishManipulation)
      scalpSellScore -= 20;

    scalpBuyScore =
      clamp(
        scalpBuyScore,
        0,
        100
      );

    scalpSellScore =
      clamp(
        scalpSellScore,
        0,
        100
      );

    const scalpScore =
      scalpSignal === "BUY"
        ? scalpBuyScore
        : scalpSignal === "SELL"
          ? scalpSellScore
          : Math.max(
              scalpBuyScore,
              scalpSellScore
            );

    // =====================================================
    // SCALP REASON
    // =====================================================

    let scalpReason =
      "Waiting for M15 confirmation + M5 trigger";

    if (
      scalpSignal === "BUY"
    ) {
      scalpReason =
        h1Bear
          ? "M15 BUY confirmation + M5 BUY trigger — counter H1, scalp only"
          : h1Bull
            ? "M15 BUY confirmation + M5 BUY trigger — aligned with H1"
            : "M15 BUY confirmation + M5 BUY trigger";
    }

    if (
      scalpSignal === "SELL"
    ) {
      scalpReason =
        h1Bull
          ? "M15 SELL confirmation + M5 SELL trigger — counter H1, scalp only"
          : h1Bear
            ? "M15 SELL confirmation + M5 SELL trigger — aligned with H1"
            : "M15 SELL confirmation + M5 SELL trigger";
    }

    // =====================================================
    // RESPONSE
    // =====================================================

    return res.status(200).json({

      symbol:
        "XAU/USD",

      price,

      timestamp:
        new Date().toISOString(),

      // ===================================================
      // MAIN SIGNAL
      // ===================================================

      signal,

      score,

      // ===================================================
      // SCALP SIGNAL
      // ===================================================

      scalp: {

        signal:
          scalpSignal,

        score:
          scalpScore,

        buy:
          scalpBuy,

        sell:
          scalpSell,

        mode:
          scalpMode,

        reason:
          scalpReason,

        h1Required:
          false,

        h1: {
          direction:
            h1Bull
              ? "BUY"
              : h1Bear
                ? "SELL"
                : "WAIT",

          aligned:
            scalpSignal === "BUY"
              ? h1Bull
              : scalpSignal === "SELL"
                ? h1Bear
                : false,

          counter:
            scalpSignal === "BUY"
              ? h1Bear
              : scalpSignal === "SELL"
                ? h1Bull
                : false
        },

        m15Confirmation: {

          buy:
            m15ConfirmBuy,

          sell:
            m15ConfirmSell,

          direction:
            m15ConfirmBuy
              ? "BUY"
              : m15ConfirmSell
                ? "SELL"
                : "WAIT"
        },

        m5Trigger: {

          buy:
            m5TriggerBuy,

          sell:
            m5TriggerSell,

          direction:
            m5TriggerBuy
              ? "BUY"
              : m5TriggerSell
                ? "SELL"
                : "WAIT"
        },

        room: {

          buy:
            buyRoom,

          sell:
            sellRoom
        },

        trade:
          scalpTrade
      },

      // ===================================================
      // TREND
      // ===================================================

      trend: {

        h1:
          h1Bull
            ? "BULLISH"
            : h1Bear
              ? "BEARISH"
              : "NEUTRAL",

        m15:
          m15Bull
            ? "BULLISH"
            : m15Bear
              ? "BEARISH"
              : "NEUTRAL",

        m5:
          m5Bull
            ? "BULLISH"
            : m5Bear
              ? "BEARISH"
              : "NEUTRAL"
      },

      // ===================================================
      // MARKET REGIME
      // ===================================================

      marketRegime: {

        type:
          regime,

        direction:
          regimeDirection,

        confidence:
          regimeConfidence,

        reason,

        continuation: {

          bullish:
            bullishContinuation,

          bearish:
            bearishContinuation
        },

        reversal: {

          bullish:
            bullishReversal,

          bearish:
            bearishReversal
        },

        manipulation: {

          bullish:
            bullishManipulation,

          bearish:
            bearishManipulation
        }
      },

      // ===================================================
      // SCORES
      // ===================================================

      scores: {

        buy:
          buyScore,

        sell:
          sellScore,

        scalpBuy:
          scalpBuyScore,

        scalpSell:
          scalpSellScore
      },

      // ===================================================
      // INDICATORS
      // ===================================================

      indicators: {

        h1: {

          ema50:
            h1EMA50,

          ema200:
            h1EMA200
        },

        m15: {

          ema20:
            m15EMA20,

          ema50:
            m15EMA50,

          rsi:
            m15RSI,

          macd:
            m15MACD,

          adx:
            m15ADX,

          atr:
            m15ATR
        },

        m5: {

          ema20:
            m5EMA20,

          ema50:
            m5EMA50,

          rsi:
            m5RSI,

          atr:
            m5ATR
        }
      },

      // ===================================================
      // LEVELS
      // ===================================================

      levels: {

        support,

        resistance,

        majorSupport,

        majorResistance,

        asianHigh,

        asianLow,

        vwap
      },

      // ===================================================
      // LIQUIDITY
      // ===================================================

      liquidity: {

        recentHigh,

        recentLow,

        bullishSweep,

        bearishSweep
      },

      // ===================================================
      // STRUCTURE
      // ===================================================

      structure: {

        h1:
          h1Structure,

        m15:
          m15Structure,

        m5:
          m5Structure,

        bos: {

          m15:
            m15BOS,

          m5:
            m5BOS
        },

        choch: {

          m15:
            m15CHOCH,

          m5:
            m5CHOCH
        }
      },

      // ===================================================
      // ROOM TO RUN
      // ===================================================

      roomToRun: {

        buy: {

          valid:
            buyRoom,

          excellent:
            buyExcellentRoom,

          distanceToResistance,

          distanceToMajorResistance
        },

        sell: {

          valid:
            sellRoom,

          excellent:
            sellExcellentRoom,

          distanceToSupport,

          distanceToMajorSupport
        }
      },

      // ===================================================
      // PRICE ACTION
      // ===================================================

      priceAction: {

        bullishDisplacement,

        bearishDisplacement,

        aboveVWAP,

        belowVWAP
      },

      // ===================================================
      // MAIN TRADE
      // ===================================================

      trade
    });

  } catch (error) {

    console.error(error);

    return res.status(500).json({

      error:
        "Analysis engine error",

      message:
        error.message
    });
  }
}
