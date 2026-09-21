// api/scalp.js
// XAUUSDSNIPER - Cached Multi-Timeframe Scalp Engine
//
// M5  = scalp trigger
// M15 = confirmation
// H1  = context / hold + confirmed swing S/R
//
// IMPORTANT:
// M5 + M15 must align for BUY/SELL.
// Signal calculations use CLOSED candles only.
// H1 never blocks a scalp signal.
// H1 support/resistance comes from confirmed H1 swing highs/lows.
//
// News:
// Google News RSS only.
// News age is now considered to reduce stale-news false alarms.
//
// PUSH:
// api/scalp also sends a Web Push when the M5+M15 scalp state changes.
// H1 does not block the scalp signal. Notifications are sent only while market is open.

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
    m5TTL: 5 * 60 * 1000,
    m15TTL: 15 * 60 * 1000,
    h1TTL: 60 * 60 * 1000,
    priceTTL: 5 * 60 * 1000,
    newsTTL: 15 * 60 * 1000,
    m5OutputSize: 500,
    m15OutputSize: 300,
    h1OutputSize: 200,
    pivotLeft: 2,
    pivotRight: 2,
    atrPeriod: 14,
    emaFast: 9,
    emaSlow: 21,
    emaTrend: 50,
    rsiPeriod: 14,
    highNewsMaxAgeMinutes: 360,
    mediumNewsMaxAgeMinutes: 720,
    newsStaleMaxAgeMinutes: 1440
  };

  const CACHE_PREFIX = "xau:v32";
  const PUSH_STATE_KEY = `${CACHE_PREFIX}:push:last-state`;
  const PUSH_LOCK_KEY = `${CACHE_PREFIX}:push:lock`;

  async function analyzeWithGemini(context) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return {
        enabled: false,
        status: "NO_API_KEY",
        decision: "ENGINE_SIGNAL_ONLY",
        verdict: "Gemini API key belum diset"
      };
    }

    const model = process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

    const prompt = `You are the AI trader and market analyst for an XAU/USD scalping dashboard. You are a SECOND-LAYER analyst, not the primary signal engine.

Rules:
- The technical engine already found a confirmed M5 + M15 aligned ${context.direction} signal.
- Do NOT blindly approve it.
- Independently evaluate whether the CURRENT price is a good entry, whether price should retrace first, or whether the setup should be avoided.
- Analyze H1 context, M15/M5 structure, BOS/CHoCH, support/resistance, supply/demand or broken zones, liquidity, FVG, news risk, entry quality, stop placement, targets and risk/reward.
- Identify the most logical support and resistance levels from the supplied market data. Do not invent prices far away from the supplied data.
- Prefer a retracement into a meaningful zone rather than chasing an extended move.
- H1 disagreement does NOT automatically invalidate a short-term M5/M15 scalp, but it should affect confidence and target selection.
- If data is insufficient or contradictory, choose WAIT rather than fabricate certainty.
- This is analysis, not a guarantee of profit.

Return ONLY valid JSON with these keys:
{
  "decision": "ENTRY_VALID" | "WAIT_RETRACE" | "AVOID",
  "direction": "BUY" | "SELL",
  "confidence": number,
  "summary": string,
  "support": number|null,
  "resistance": number|null,
  "entryZone": {"low": number|null, "high": number|null},
  "stopLoss": number|null,
  "takeProfit1": number|null,
  "takeProfit2": number|null,
  "takeProfit3": number|null,
  "rr": number|null,
  "reasoning": [string, string, string],
  "invalidation": string
}

Market data:\n${JSON.stringify(context)}`;

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.15,
            responseMimeType: "application/json"
          }
        })
      });

      const data = await response.json();
      if (!response.ok) {
        return {
          enabled: true,
          status: "ERROR",
          model,
          decision: "ENGINE_SIGNAL_ONLY",
          verdict: data?.error?.message || `Gemini HTTP ${response.status}`
        };
      }

      const text = data?.candidates?.[0]?.content?.parts?.map(p => p?.text || "").join("")?.trim();
      if (!text) throw new Error("Gemini returned empty response");

      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        const cleaned = text.replace(/^```json\s*/i, "").replace(/\s*```$/i, "").trim();
        parsed = JSON.parse(cleaned);
      }

      const decision = ["ENTRY_VALID", "WAIT_RETRACE", "AVOID"].includes(parsed?.decision)
        ? parsed.decision
        : "WAIT_RETRACE";

      return {
        enabled: true,
        status: "OK",
        model,
        decision,
        direction: context.direction,
        confidence: Math.max(0, Math.min(100, Number(parsed?.confidence) || 0)),
        summary: String(parsed?.summary || "Gemini analysis completed"),
        support: Number.isFinite(Number(parsed?.support)) ? Number(parsed.support) : null,
        resistance: Number.isFinite(Number(parsed?.resistance)) ? Number(parsed.resistance) : null,
        entryZone: {
          low: Number.isFinite(Number(parsed?.entryZone?.low)) ? Number(parsed.entryZone.low) : null,
          high: Number.isFinite(Number(parsed?.entryZone?.high)) ? Number(parsed.entryZone.high) : null
        },
        stopLoss: Number.isFinite(Number(parsed?.stopLoss)) ? Number(parsed.stopLoss) : null,
        takeProfit1: Number.isFinite(Number(parsed?.takeProfit1)) ? Number(parsed.takeProfit1) : null,
        takeProfit2: Number.isFinite(Number(parsed?.takeProfit2)) ? Number(parsed.takeProfit2) : null,
        takeProfit3: Number.isFinite(Number(parsed?.takeProfit3)) ? Number(parsed.takeProfit3) : null,
        rr: Number.isFinite(Number(parsed?.rr)) ? Number(parsed.rr) : null,
        reasoning: Array.isArray(parsed?.reasoning) ? parsed.reasoning.slice(0, 3).map(String) : [],
        invalidation: String(parsed?.invalidation || "")
      };
    } catch (error) {
      return {
        enabled: true,
        status: "ERROR",
        model,
        decision: "ENGINE_SIGNAL_ONLY",
        verdict: error?.message || "Gemini analysis failed"
      };
    }
  }

  async function maybeSendSignalPush(signal, marketSession, price, m5Analysis, m15Analysis, h1Analysis, signalKey, aiContext) {
    // Only confirmed M5 + M15 signals are actionable. Never push WAIT or closed-market data.
    if (!marketSession?.isOpen || !signal?.confirmed) {
      if (marketSession?.isOpen === false) {
        // Keep the previous actionable state while the market is closed so that
        // the first actionable BUY/SELL after reopen can still notify.
      }
      return { attempted: false, sent: 0, reason: !marketSession?.isOpen ? "MARKET_CLOSED" : "NO_CONFIRMED_SIGNAL" };
    }

    const direction = signal.direction === "BUY" || signal.direction === "SELL"
      ? signal.direction
      : null;
    if (!direction) return { attempted: false, sent: 0, reason: "NO_DIRECTION" };

    // IMPORTANT: /api/scalp can be called concurrently by GitHub Actions,
    // push-cron, manual refreshes, or retries. A normal GET/SET state check
    // is not atomic, so two requests can both decide to send the same push.
    // Use Redis SET NX as a short-lived distributed lock.
    const lockToken = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let lockAcquired = false;

    if (REDIS_URL && REDIS_TOKEN) {
      const lockResult = await redisCommand([
        "SET", PUSH_LOCK_KEY, lockToken, "NX", "EX", 90
      ]);
      lockAcquired = lockResult === "OK";
    } else {
      // Fallback for local/no-Redis execution. This does not provide a
      // cross-instance guarantee, but prevents duplicate sends in one instance.
      const nowLock = Date.now();
      const memLock = memoryCache[PUSH_LOCK_KEY];
      if (!memLock || nowLock > memLock.expiresAt) {
        memoryCache[PUSH_LOCK_KEY] = { value: lockToken, expiresAt: nowLock + 90_000 };
        lockAcquired = true;
      }
    }

    if (!lockAcquired) {
      return { attempted: false, sent: 0, reason: "PUSH_LOCKED_DUPLICATE_REQUEST" };
    }

    try {
      const previous = await cacheGet(PUSH_STATE_KEY);
      if (previous?.signalKey === signalKey) {
        return { attempted: false, sent: 0, reason: "ALREADY_NOTIFIED", signalKey };
      }

      const aiAnalysis = await analyzeWithGemini(aiContext);
      // Dynamic import prevents the signal endpoint from depending on VAPID at module load time.
      const { sendPushToAll } = await import("./push-lib.js");

      const icon = "/icon.png";
      const title = `XAUUSDSNIPER — ${direction} SIGNAL`;
      const aiLine = aiAnalysis?.status === "OK"
        ? `AI: ${aiAnalysis.decision.replaceAll("_", " ")} (${aiAnalysis.confidence}%)`
        : `AI: ${aiAnalysis?.decision || "ENGINE SIGNAL ONLY"}`;
      const zoneLine = aiAnalysis?.status === "OK" && aiAnalysis.entryZone?.low != null && aiAnalysis.entryZone?.high != null
        ? `Zone: ${aiAnalysis.entryZone.low.toFixed(2)}-${aiAnalysis.entryZone.high.toFixed(2)}`
        : null;
      const body = [
        `${direction} | M5 ${m5Analysis?.direction || "-"} + M15 ${m15Analysis?.direction || "-"}`,
        `Price: ${Number.isFinite(Number(price)) ? Number(price).toFixed(2) : "-"}`,
        `H1: ${h1Analysis?.direction || "NEUTRAL"}`,
        aiLine,
        zoneLine,
        aiAnalysis?.status === "OK" ? aiAnalysis.summary : aiAnalysis?.verdict
      ].filter(Boolean).join(" • ");

      const result = await sendPushToAll({
        title,
        body,
        icon,
        badge: icon,
        tag: `xau-signal-${direction.toLowerCase()}`,
        url: "/"
      });

      // Record the state only after the push attempt. This prevents a temporary
      // VAPID/Redis failure from permanently suppressing the next notification.
      if (result?.sent > 0) {
        await cacheSet(PUSH_STATE_KEY, {
          direction,
          signalKey,
          sentAt: Date.now(),
          sent: result.sent
        }, 7 * 24 * 60 * 60 * 1000);
      }

      return {
        attempted: true,
        sent: result?.sent || 0,
        removed: result?.removed || 0,
        total: result?.total || 0,
        direction,
        signalKey,
        aiAnalysis,
        reason: result?.sent > 0 ? "PUSH_SENT" : "NO_SUBSCRIPTIONS_OR_DELIVERY"
      };
    } catch (error) {
      console.error("Signal push error:", error?.message || error);
      return {
        attempted: true,
        sent: 0,
        direction,
        signalKey,
        reason: "PUSH_ERROR",
        error: error?.message || "Push failed"
      };
    }
  }

  globalThis.__XAU_CACHE__ ??= {
    m5: null, m15: null, h1: null, price: null, news: null
  };

  const memoryCache = globalThis.__XAU_CACHE__;

  const REDIS_URL =
    process.env.KV_REST_API_URL ||
    process.env.UPSTASH_REDIS_REST_URL ||
    null;

  const REDIS_TOKEN =
    process.env.KV_REST_API_TOKEN ||
    process.env.UPSTASH_REDIS_REST_TOKEN ||
    null;

  async function redisCommand(command) {
    if (!REDIS_URL || !REDIS_TOKEN) return null;
    try {
      const r = await fetch(REDIS_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${REDIS_TOKEN}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(command)
      });
      if (!r.ok) return null;
      const d = await r.json();
      return d?.result ?? null;
    } catch {
      return null;
    }
  }

  async function cacheGet(key) {
    const redisValue = await redisCommand(["GET", key]);
    if (redisValue) {
      try { return JSON.parse(redisValue); } catch { return redisValue; }
    }
    const item = memoryCache[key];
    if (!item) return null;
    if (Date.now() > item.expiresAt) return null;
    return item.value;
  }

  async function cacheSet(key, value, ttlMs) {
    const ttlSeconds = Math.max(1, Math.round(ttlMs / 1000));
    memoryCache[key] = { value, expiresAt: Date.now() + ttlMs };
    if (REDIS_URL && REDIS_TOKEN) {
      try {
        await redisCommand(["SET", key, JSON.stringify(value), "EX", ttlSeconds]);
      } catch {}
    }
  }

  async function getStaleCache(key) {
    if (REDIS_URL && REDIS_TOKEN) {
      const redisValue = await redisCommand(["GET", key]);
      if (redisValue) {
        try { return JSON.parse(redisValue); } catch {}
      }
    }
    return memoryCache[key]?.value || null;
  }

  // ---------------------------------------------------------
  // TIME / CANDLE NORMALIZATION
  // ---------------------------------------------------------

  function intervalMs(interval) {
    if (interval === "5min") return 5 * 60 * 1000;
    if (interval === "15min") return 15 * 60 * 1000;
    if (interval === "1h") return 60 * 60 * 1000;
    return 0;
  }

  function candleTimestamp(value) {
    if (!value) return NaN;
    const s = String(value).trim();
    const iso = s.includes("T") ? s : s.replace(" ", "T");
    const t = Date.parse(
      /(?:Z|[+-]\d\d:\d\d)$/.test(iso) ? iso : `${iso}Z`
    );
    return Number.isFinite(t) ? t : NaN;
  }

  function normalizeCandles(candles, interval) {
    const step = intervalMs(interval);
    const now = Date.now();
    const seen = new Set();

    return (Array.isArray(candles) ? candles : [])
      .map(c => {
        const t = candleTimestamp(c?.datetime);
        return {
          ...c,
          _timestamp: t,
          time: c?.datetime
        };
      })
      .filter(c =>
        Number.isFinite(c._timestamp) &&
        c._timestamp <= now + 60_000 &&
        Number.isFinite(Number(c.open)) &&
        Number.isFinite(Number(c.high)) &&
        Number.isFinite(Number(c.low)) &&
        Number.isFinite(Number(c.close))
      )
      .sort((a, b) => a._timestamp - b._timestamp)
      .filter(c => {
        if (seen.has(c._timestamp)) return false;
        seen.add(c._timestamp);
        return true;
      })
      .map(({ _timestamp, ...c }) => c);
  }

  function getClosedCandles(candles, interval) {
    const step = intervalMs(interval);
    const now = Date.now();
    return (candles || []).filter(c => {
      const t = candleTimestamp(c?.datetime);
      return Number.isFinite(t) && t + step <= now;
    });
  }

  // ---------------------------------------------------------
  // TWELVE DATA
  // ---------------------------------------------------------

  async function twelveDataTimeSeries(interval, outputsize) {
    const url =
      `https://api.twelvedata.com/time_series` +
      `?symbol=${encodeURIComponent(CFG.symbol)}` +
      `&interval=${encodeURIComponent(interval)}` +
      `&outputsize=${outputsize}` +
      `&order=asc` +
      `&timezone=UTC` +
      `&format=JSON` +
      `&apikey=${encodeURIComponent(API_KEY)}`;

    const r = await fetch(url);
    const d = await r.json();

    if (!r.ok || d?.status === "error" || !Array.isArray(d?.values)) {
      throw new Error(d?.message || `Twelve Data ${interval} error`);
    }

    const raw = d.values.slice().map(c => ({
      datetime: c.datetime,
      time: c.datetime,
      open: Number(c.open),
      high: Number(c.high),
      low: Number(c.low),
      close: Number(c.close),
      volume: Number(c.volume || 0)
    }));

    const candles = normalizeCandles(raw, interval);

    if (!candles.length) {
      throw new Error(`No ${interval} candles returned`);
    }

    return candles;
  }

  async function twelveDataPrice() {
    const url =
      `https://api.twelvedata.com/price` +
      `?symbol=${encodeURIComponent(CFG.symbol)}` +
      `&apikey=${encodeURIComponent(API_KEY)}`;

    const r = await fetch(url);
    const d = await r.json();
    const price = Number(d?.price);

    if (!r.ok || d?.status === "error" || !Number.isFinite(price)) {
      throw new Error(d?.message || "Twelve Data price error");
    }

    return price;
  }

  async function getCachedTimeSeries(key, interval, outputsize, ttl) {
    const cached = await cacheGet(key);
    if (cached && Array.isArray(cached.candles) && cached.candles.length) {
      return {
        candles: normalizeCandles(cached.candles, interval),
        source: "CACHE",
        fetchedAt: cached.fetchedAt || null
      };
    }

    try {
      const candles = await twelveDataTimeSeries(interval, outputsize);
      const fetchedAt = Date.now();
      await cacheSet(key, { candles, fetchedAt }, ttl);
      return { candles, source: "TWELVE_DATA", fetchedAt };
    } catch (error) {
      const stale = await getStaleCache(key);
      if (stale && Array.isArray(stale.candles) && stale.candles.length) {
        return {
          candles: normalizeCandles(stale.candles, interval),
          source: "STALE_CACHE",
          fetchedAt: stale.fetchedAt || null,
          error: error?.message || null
        };
      }
      throw error;
    }
  }

  async function getCachedPrice(fallbackPrice) {
    const cached = await cacheGet(`${CACHE_PREFIX}:price`);
    if (cached && Number.isFinite(Number(cached.price))) {
      return {
        price: Number(cached.price),
        source: "TWELVE_DATA_PRICE_CACHE",
        ageSeconds: cached.fetchedAt
          ? Math.round((Date.now() - Number(cached.fetchedAt)) / 1000)
          : null
      };
    }

    try {
      const price = await twelveDataPrice();
      await cacheSet(`${CACHE_PREFIX}:price`, {
        price, fetchedAt: Date.now()
      }, CFG.priceTTL);
      return { price, source: "TWELVE_DATA_PRICE", ageSeconds: 0 };
    } catch (error) {
      return {
        price: fallbackPrice,
        source: "M5_CANDLE_FALLBACK",
        ageSeconds: null,
        error: error?.message || null
      };
    }
  }

  // ---------------------------------------------------------
  // EMA
  // ---------------------------------------------------------

  function ema(values, period) {
    if (!values?.length) return null;
    if (values.length < period) return values.at(-1) ?? null;
    const multiplier = 2 / (period + 1);
    let result = 0;
    for (let i = 0; i < period; i++) result += Number(values[i]);
    result /= period;
    for (let i = period; i < values.length; i++) {
      result = (Number(values[i]) - result) * multiplier + result;
    }
    return result;
  }

  // ---------------------------------------------------------
  // RSI
  // ---------------------------------------------------------

  function rsi(values, period = 14) {
    if (!values || values.length <= period) return 50;
    let gains = 0, losses = 0;
    for (let i = 1; i <= period; i++) {
      const diff = Number(values[i]) - Number(values[i - 1]);
      if (diff >= 0) gains += diff;
      else losses += Math.abs(diff);
    }
    let avgGain = gains / period;
    let avgLoss = losses / period;
    for (let i = period + 1; i < values.length; i++) {
      const diff = Number(values[i]) - Number(values[i - 1]);
      const gain = diff > 0 ? diff : 0;
      const loss = diff < 0 ? Math.abs(diff) : 0;
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
    }
    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - 100 / (1 + rs);
  }

  // ---------------------------------------------------------
  // ATR
  // ---------------------------------------------------------

  function atr(candles, period = 14) {
    if (!candles || candles.length < period + 1) return 0;
    const trs = [];
    for (let i = 1; i < candles.length; i++) {
      const c = candles[i], p = candles[i - 1];
      trs.push(Math.max(
        c.high - c.low,
        Math.abs(c.high - p.close),
        Math.abs(c.low - p.close)
      ));
    }
    if (trs.length < period) return trs.at(-1) || 0;
    let value = 0;
    for (let i = 0; i < period; i++) value += trs[i];
    value /= period;
    for (let i = period; i < trs.length; i++) {
      value = (value * (period - 1) + trs[i]) / period;
    }
    return value;
  }

  // ---------------------------------------------------------
  // CONFIRMED SWINGS
  // ---------------------------------------------------------

  function findConfirmedSwings(candles, left = 2, right = 2) {
    const highs = [], lows = [];
    if (!Array.isArray(candles)) return { highs, lows };

    for (let i = left; i < candles.length - right; i++) {
      const c = candles[i];
      let isHigh = true, isLow = true;

      for (let j = 1; j <= left; j++) {
        if (!(c.high > candles[i - j].high)) isHigh = false;
        if (!(c.low < candles[i - j].low)) isLow = false;
      }
      for (let j = 1; j <= right; j++) {
        if (!(c.high >= candles[i + j].high)) isHigh = false;
        if (!(c.low <= candles[i + j].low)) isLow = false;
      }

      if (isHigh) highs.push({ price: c.high, time: c.datetime, index: i });
      if (isLow) lows.push({ price: c.low, time: c.datetime, index: i });
    }
    return { highs, lows };
  }

  function nearestBelow(swings, price) {
    return swings
      .filter(x => Number.isFinite(x.price) && x.price < price)
      .sort((a, b) => b.price - a.price)[0] || null;
  }

  function nearestAbove(swings, price) {
    return swings
      .filter(x => Number.isFinite(x.price) && x.price > price)
      .sort((a, b) => a.price - b.price)[0] || null;
  }

  function latestBelow(swings, price) {
    return swings.filter(x => Number.isFinite(x.price) && x.price < price).at(-1) || null;
  }

  function latestAbove(swings, price) {
    return swings.filter(x => Number.isFinite(x.price) && x.price > price).at(-1) || null;
  }

  // ---------------------------------------------------------
  // STRUCTURE
  // ---------------------------------------------------------

  function classifyStructure(swingHighs, swingLows) {
    const h = swingHighs.slice(-3), l = swingLows.slice(-3);
    let highPattern = "NONE", lowPattern = "NONE";

    if (h.length >= 2) {
      const a = h.at(-2).price, b = h.at(-1).price;
      highPattern = b > a ? "HH" : b < a ? "LH" : "EQH";
    }
    if (l.length >= 2) {
      const a = l.at(-2).price, b = l.at(-1).price;
      lowPattern = b > a ? "HL" : b < a ? "LL" : "EQL";
    }

    let bias = "NEUTRAL";
    if (highPattern === "HH" && lowPattern === "HL") bias = "BULLISH";
    else if (highPattern === "LH" && lowPattern === "LL") bias = "BEARISH";

    return {
      bias, highPattern, lowPattern,
      lastSwingHigh: h.at(-1)?.price ?? null,
      lastSwingLow: l.at(-1)?.price ?? null
    };
  }

  function detectStructureEvent(candles, swingHighs, swingLows, structure) {
    const last = candles.at(-1);
    if (!last) return {
      type: "NONE", direction: "NONE", price: null, level: null, time: null
    };

    const high = swingHighs.at(-1), low = swingLows.at(-1);

    if (high && last.close > high.price) {
      const type = structure.bias === "BEARISH" ? "CHOCH" : "BOS";
      return {
        type, direction: "BULLISH", price: last.close, level: high.price,
        time: last.datetime,
        description: type === "BOS"
          ? "Bullish BOS - swing high broken"
          : "Bullish CHOCH - bearish structure broken"
      };
    }

    if (low && last.close < low.price) {
      const type = structure.bias === "BULLISH" ? "CHOCH" : "BOS";
      return {
        type, direction: "BEARISH", price: last.close, level: low.price,
        time: last.datetime,
        description: type === "BOS"
          ? "Bearish BOS - swing low broken"
          : "Bearish CHOCH - bullish structure broken"
      };
    }

    return {
      type: "NONE", direction: "NONE", price: null, level: null, time: null,
      description: "No new structure break"
    };
  }

  // ---------------------------------------------------------
  // TIMEFRAME ANALYSIS
  // CLOSED CANDLES ONLY
  // ---------------------------------------------------------

  function analyzeTimeframe(candles, name, interval) {
    if (!candles?.length) {
      return {
        timeframe: name, direction: "NEUTRAL", bias: "NEUTRAL",
        emaFast: null, emaSlow: null, emaTrend: null, rsi: 50, atr: 0,
        lastCandle: null, candleStatus: "NO_DATA"
      };
    }

    const closedCandles = getClosedCandles(candles, interval);
    if (!closedCandles.length) {
      return {
        timeframe: name, direction: "NEUTRAL", bias: "NEUTRAL",
        emaFast: null, emaSlow: null, emaTrend: null, rsi: 50, atr: 0,
        lastCandle: null, candleStatus: "NO_CLOSED_CANDLE"
      };
    }

    const closes = closedCandles.map(c => c.close);
    const fast = ema(closes, CFG.emaFast);
    const slow = ema(closes, CFG.emaSlow);
    const trend = ema(closes, CFG.emaTrend);
    const current = closes.at(-1);
    const r = rsi(closes, CFG.rsiPeriod);
    const a = atr(closedCandles, CFG.atrPeriod);

    let direction = "NEUTRAL";
    if (current > fast && fast > slow && slow > trend) direction = "BUY";
    else if (current < fast && fast < slow && slow < trend) direction = "SELL";
    else if (fast > slow && current > slow) direction = "BUY";
    else if (fast < slow && current < slow) direction = "SELL";

    return {
      timeframe: name, direction, bias: direction,
      price: round(current), emaFast: round(fast), emaSlow: round(slow),
      emaTrend: round(trend), rsi: round(r), atr: round(a),
      lastCandle: closedCandles.at(-1)?.datetime ?? null,
      candleStatus: "CLOSED"
    };
  }

  // ---------------------------------------------------------
  // NEWS
  // ---------------------------------------------------------

  function parseNewsAgeMinutes(pubDate) {
    if (!pubDate) return null;
    const time = new Date(pubDate).getTime();
    if (!Number.isFinite(time)) return null;
    const age = Date.now() - time;
    return age < 0 ? 0 : Math.round(age / 60000);
  }

  function classifyNewsItem(item) {
    const title = String(item.title || "").toLowerCase();
    const ageMinutes = parseNewsAgeMinutes(item.pubDate);

    const highKeywords = [
      "fomc", "fed decision", "interest rate decision", "rate decision",
      "cpi", "consumer price index", "nonfarm", "non-farm", "nfp",
      "payrolls", "fed meeting", "powell", "rate cut", "rate hike"
    ];

    const mediumKeywords = [
      "inflation", "jobs", "employment", "unemployment",
      "treasury yield", "dxy", "dollar", "gold", "bullion"
    ];

    const isHigh = highKeywords.some(k => title.includes(k));
    const isMedium = mediumKeywords.some(k => title.includes(k));

    let level = "LOW";
    if (isHigh && ageMinutes !== null && ageMinutes <= CFG.highNewsMaxAgeMinutes) {
      level = "HIGH";
    } else if (isMedium && ageMinutes !== null && ageMinutes <= CFG.mediumNewsMaxAgeMinutes) {
      level = "MEDIUM";
    } else if (isHigh && ageMinutes === null) {
      level = "UNKNOWN";
    }

    return { ...item, ageMinutes, level };
  }

  function finalizeNewsResult(items, source, fetchedAt) {
    const highItems = items.filter(x => x.level === "HIGH");
    const mediumItems = items.filter(x => x.level === "MEDIUM");

    const validAges = items
      .map(x => x.ageMinutes)
      .filter(x => Number.isFinite(x));

    const newestAgeMinutes = validAges.length ? Math.min(...validAges) : null;

    let level = "LOW", status = "CLEAR", score = 10, fresh = true;

    if (highItems.length) {
      level = "HIGH"; status = "RISK"; score = 80;
    } else if (mediumItems.length) {
      level = "MEDIUM"; status = "WATCH"; score = 45;
    } else if (!items.length) {
      level = "UNKNOWN"; status = "UNKNOWN"; score = 35; fresh = false;
    } else if (
      newestAgeMinutes !== null &&
      newestAgeMinutes > CFG.newsStaleMaxAgeMinutes
    ) {
      level = "UNKNOWN"; status = "STALE"; score = 35; fresh = false;
    }

    return {
      status, level, score, items,
      highCount: highItems.length,
      mediumCount: mediumItems.length,
      source,
      maxHighAgeMinutes: CFG.highNewsMaxAgeMinutes,
      maxMediumAgeMinutes: CFG.mediumNewsMaxAgeMinutes,
      staleAfterMinutes: CFG.newsStaleMaxAgeMinutes,
      newestAgeMinutes,
      fresh,
      fetchedAt: fetchedAt || Date.now(),
      note: "News filter uses published headline age. It is not a full economic calendar."
    };
  }

  async function getNewsFilter() {
    const cached = await cacheGet(`${CACHE_PREFIX}:news`);
    if (cached?.result) {
      const cachedItems = Array.isArray(cached.result.items)
        ? cached.result.items.map(classifyNewsItem)
        : [];
      const refreshed = finalizeNewsResult(
        cachedItems,
        cached.result.source || "CACHE",
        cached.fetchedAt || cached.result.fetchedAt
      );
      return { ...refreshed, source: "CACHE" };
    }

    const feeds = [
      { name: "Gold", query: "gold XAU bullion precious metals" },
      { name: "Fed", query: "Federal Reserve FOMC interest rates" },
      { name: "Inflation", query: "US CPI inflation jobs NFP" },
      { name: "USD", query: "USD dollar DXY treasury yields" }
    ];

    let items = [];

    await Promise.all(feeds.map(async feed => {
      try {
        const url =
          "https://news.google.com/rss/search?q=" +
          encodeURIComponent(feed.query) +
          "&hl=en-US&gl=US&ceid=US:en";

        const r = await fetch(url);
        if (!r.ok) return;
        const xml = await r.text();
        const matches = xml.match(/<item>[\s\S]*?<\/item>/g) || [];

        for (const item of matches.slice(0, 8)) {
          const title = decodeXml(
            (item.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || ""
          );
          const pubDate = decodeXml(
            (item.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1] || ""
          );
          if (title) items.push({ category: feed.name, title, pubDate });
        }
      } catch {}
    }));

    items = items
      .sort((a, b) =>
        new Date(b.pubDate || 0) - new Date(a.pubDate || 0)
      )
      .slice(0, 20)
      .map(classifyNewsItem);

    const fetchedAt = Date.now();
    const result = finalizeNewsResult(items, items.length ? "Google News RSS" : "RSS unavailable", fetchedAt);

    await cacheSet(
      `${CACHE_PREFIX}:news`,
      { result, fetchedAt },
      CFG.newsTTL
    );

    return result;
  }

  // ---------------------------------------------------------
  // SIGNAL
  // ---------------------------------------------------------

  function buildSignal(m5Analysis, m15Analysis) {
    const m5 = m5Analysis.direction, m15 = m15Analysis.direction;

    if (m5 === "BUY" && m15 === "BUY") {
      return {
        signal: "BUY", direction: "BUY", scalpSignal: "BUY",
        confirmed: true, reason: "M5 + M15 searah bullish",
        alignment: "M5/M15 BUY"
      };
    }

    if (m5 === "SELL" && m15 === "SELL") {
      return {
        signal: "SELL", direction: "SELL", scalpSignal: "SELL",
        confirmed: true, reason: "M5 + M15 searah bearish",
        alignment: "M5/M15 SELL"
      };
    }

    return {
      signal: "WAIT", direction: "NEUTRAL", scalpSignal: "WAIT",
      confirmed: false, reason: "M5 + M15 belum searah",
      alignment: "NO ALIGNMENT"
    };
  }

  // ---------------------------------------------------------
  // CONFLUENCE
  // ---------------------------------------------------------

  function buildConfluence(signal, m5, m15, h1, news) {
    let score = 0;
    const reasons = [];

    if (signal.direction === "BUY" || signal.direction === "SELL") {
      score += 40;
      reasons.push("M5 + M15 aligned");
    }

    if (h1.bias === signal.direction) {
      score += 20;
      reasons.push("H1 agrees with scalp direction");
    } else if (h1.bias !== "NEUTRAL") {
      reasons.push("H1 differs - higher-timeframe context only");
    }

    if (signal.direction === "BUY" && m5.rsi >= 50 && m5.rsi < 75) {
      score += 10; reasons.push("M5 RSI supports BUY");
    }
    if (signal.direction === "SELL" && m5.rsi <= 50 && m5.rsi > 25) {
      score += 10; reasons.push("M5 RSI supports SELL");
    }

    if (news.level === "HIGH") {
      score -= 20; reasons.push("Recent high news risk");
    } else if (news.level === "MEDIUM") {
      score -= 8; reasons.push("Recent medium news risk");
    }

    score = Math.max(0, Math.min(100, score));
    let quality = "LOW";
    if (score >= 75) quality = "HIGH";
    else if (score >= 55) quality = "MEDIUM";

    return { score, quality, reasons };
  }

  // ---------------------------------------------------------
  // TRADE PLAN
  // ---------------------------------------------------------

  function buildTradePlan(signal, price, m5, h1Support, h1Resistance, news, marketSession = { isOpen: true }) {
    if (!marketSession.isOpen) {
      return {
        status: "INACTIVE", direction: "WAIT", entry: null, stopLoss: null,
        takeProfit1: null, takeProfit2: null, riskDistance: null,
        newsRisk: news?.level || "UNKNOWN", reason: marketSession.reason
      };
    }

    if (signal.direction !== "BUY" && signal.direction !== "SELL") {
      return {
        status: "WAIT", direction: "WAIT", entry: null, stopLoss: null,
        takeProfit1: null, takeProfit2: null, riskDistance: null,
        newsRisk: news?.level || "UNKNOWN"
      };
    }

    const atrValue = Number(m5.atr) || 0;
    const safeATR = atrValue > 0 ? atrValue : 3;

    if (signal.direction === "BUY") {
      const structuralSL = h1Support?.price ?? null;
      const atrSL = price - safeATR * 1.2;
      const stopLoss =
        structuralSL && structuralSL < price && price - structuralSL <= safeATR * 4
          ? structuralSL : atrSL;
      const risk = Math.max(price - stopLoss, safeATR * 0.8);
      const tp1 = price + risk * 1.2, tp2 = price + risk * 2;

      return {
        status: news.level === "HIGH" ? "CAUTION" : "ACTIVE",
        direction: "BUY", entry: round(price), stopLoss: round(stopLoss),
        takeProfit1: round(tp1), takeProfit2: round(tp2),
        riskDistance: round(risk), newsRisk: news.level,
        structuralReference: h1Support ? {
          type: "H1_CONFIRMED_SWING_LOW",
          price: round(h1Support.price), time: h1Support.time
        } : null
      };
    }

    const structuralSL = h1Resistance?.price ?? null;
    const atrSL = price + safeATR * 1.2;
    const stopLoss =
      structuralSL && structuralSL > price && structuralSL - price <= safeATR * 4
        ? structuralSL : atrSL;
    const risk = Math.max(stopLoss - price, safeATR * 0.8);
    const tp1 = price - risk * 1.2, tp2 = price - risk * 2;

    return {
      status: news.level === "HIGH" ? "CAUTION" : "ACTIVE",
      direction: "SELL", entry: round(price), stopLoss: round(stopLoss),
      takeProfit1: round(tp1), takeProfit2: round(tp2),
      riskDistance: round(risk), newsRisk: news.level,
      structuralReference: h1Resistance ? {
        type: "H1_CONFIRMED_SWING_HIGH",
        price: round(h1Resistance.price), time: h1Resistance.time
      } : null
    };
  }

  // ---------------------------------------------------------
  // LIQUIDITY MAP
  // ---------------------------------------------------------

  function buildLiquidity(price, h1Highs, h1Lows, m15Highs, m15Lows, m5Highs, m5Lows) {
    return {
      above: {
        h1: nearestAbove(h1Highs, price),
        m15: nearestAbove(m15Highs, price),
        m5: nearestAbove(m5Highs, price)
      },
      below: {
        h1: nearestBelow(h1Lows, price),
        m15: nearestBelow(m15Lows, price),
        m5: nearestBelow(m5Lows, price)
      }
    };
  }

  // ---------------------------------------------------------
  // ENTRY QUALITY
  // ---------------------------------------------------------

  function buildEntryQuality(signal, confluence, news, price, m5ATR, support, resistance) {
    if (signal.direction !== "BUY" && signal.direction !== "SELL") {
      return { score: 0, quality: "WAIT", reason: "M5 + M15 belum aligned" };
    }

    let score = confluence.score;
    const atrValue = Number(m5ATR) || 0;
    const safeATR = atrValue > 0 ? atrValue : 3;
    let proximityWarning = false, proximityDistance = null;
    const proximityThreshold = safeATR * 0.5;

    if (signal.direction === "BUY" && resistance?.price && resistance.price > price) {
      proximityDistance = resistance.price - price;
      if (proximityDistance < proximityThreshold) {
        score -= 15; proximityWarning = true;
      }
    }

    if (signal.direction === "SELL" && support?.price && support.price < price) {
      proximityDistance = price - support.price;
      if (proximityDistance < proximityThreshold) {
        score -= 15; proximityWarning = true;
      }
    }

    if (news.level === "HIGH") score -= 15;
    score = Math.max(0, Math.min(100, score));

    let quality = "LOW";
    if (score >= 75) quality = "HIGH";
    else if (score >= 55) quality = "MEDIUM";

    let reason;
    if (proximityWarning && news.level === "HIGH") reason = "S/R terlalu dekat + recent high news risk";
    else if (proximityWarning) reason = "Nearest opposite S/R terlalu dekat";
    else if (news.level === "HIGH") reason = "Recent high news risk";
    else if (quality === "HIGH") reason = "Strong scalp confluence";
    else if (quality === "MEDIUM") reason = "Moderate scalp confluence";
    else reason = "Weak scalp confluence";

    return {
      score, quality, reason, atr: round(safeATR),
      resistanceDistance: signal.direction === "BUY" && resistance?.price
        ? round(resistance.price - price) : null,
      supportDistance: signal.direction === "SELL" && support?.price
        ? round(price - support.price) : null,
      proximityThreshold: round(proximityThreshold),
      proximityWarning
    };
  }

  // ---------------------------------------------------------
  // HELPERS
  // ---------------------------------------------------------

  function round(value, decimals = 2) {
    if (!Number.isFinite(Number(value))) return null;
    const p = 10 ** decimals;
    return Math.round(Number(value) * p) / p;
  }

  function decodeXml(value = "") {
    return String(value)
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
  }

  // ---------------------------------------------------------
  // MARKET SESSION
  // ---------------------------------------------------------

  function getMarketSession(nowMs = Date.now()) {
    const d = new Date(nowMs);
    const day = d.getUTCDay();
    const hour = d.getUTCHours();
    const minute = d.getUTCMinutes();
    const totalMinutes = hour * 60 + minute;

    let status = "OPEN";
    let reason = "XAU/USD session open";

    if (day === 6) {
      status = "CLOSED"; reason = "Weekend - Saturday";
    } else if (day === 0 && totalMinutes < 22 * 60) {
      status = "CLOSED"; reason = "Weekend - before Sunday 22:00 UTC";
    } else if (day === 5 && totalMinutes >= 21 * 60) {
      status = "CLOSED"; reason = "Weekend - Friday session closed";
    } else if (day >= 1 && day <= 5 && totalMinutes >= 21 * 60 && totalMinutes < 22 * 60) {
      status = "CLOSED"; reason = "Daily XAU/USD maintenance break";
    }

    return {
      status, isOpen: status === "OPEN", reason, timezone: "UTC",
      day, utcTime: d.toISOString()
    };
  }

  // ---------------------------------------------------------
  // STRUCTURE-AWARE H1 S/R
  // ---------------------------------------------------------

  function findStructureBreakHistory(candles, swingHighs, swingLows) {
    const events = [];
    if (!Array.isArray(candles) || candles.length < 5) return events;

    const sortedHighs = [...swingHighs].sort((a, b) => a.index - b.index);
    const sortedLows = [...swingLows].sort((a, b) => a.index - b.index);
    const usedBullBreaks = new Set(), usedBearBreaks = new Set();

    for (let i = 0; i < candles.length; i++) {
      const candle = candles[i];
      const priorHighs = sortedHighs.filter(x => x.index < i);
      const priorLows = sortedLows.filter(x => x.index < i);
      const lastHigh = priorHighs.at(-1), lastLow = priorLows.at(-1);

      if (lastHigh && candle.close > lastHigh.price && !usedBullBreaks.has(lastHigh.index)) {
        const priorHighPattern = priorHighs.length >= 2
          ? priorHighs.at(-1).price > priorHighs.at(-2).price ? "HH"
          : priorHighs.at(-1).price < priorHighs.at(-2).price ? "LH" : "EQH"
          : "NONE";
        const priorLowPattern = priorLows.length >= 2
          ? priorLows.at(-1).price > priorLows.at(-2).price ? "HL"
          : priorLows.at(-1).price < priorLows.at(-2).price ? "LL" : "EQL"
          : "NONE";
        const priorBearish = priorHighPattern === "LH" && priorLowPattern === "LL";

        events.push({
          type: priorBearish ? "CHOCH" : "BOS",
          direction: "BULLISH", breakPrice: candle.close, level: lastHigh.price,
          time: candle.datetime, candleIndex: i, brokenSwing: lastHigh,
          protectedSwing: priorLows.at(-1) || null,
          priorHighPattern, priorLowPattern
        });
        usedBullBreaks.add(lastHigh.index);
      }

      if (lastLow && candle.close < lastLow.price && !usedBearBreaks.has(lastLow.index)) {
        const priorHighPattern = priorHighs.length >= 2
          ? priorHighs.at(-1).price > priorHighs.at(-2).price ? "HH"
          : priorHighs.at(-1).price < priorHighs.at(-2).price ? "LH" : "EQH"
          : "NONE";
        const priorLowPattern = priorLows.length >= 2
          ? priorLows.at(-1).price > priorLows.at(-2).price ? "HL"
          : priorLows.at(-1).price < priorLows.at(-2).price ? "LL" : "EQL"
          : "NONE";
        const priorBullish = priorHighPattern === "HH" && priorLowPattern === "HL";

        events.push({
          type: priorBullish ? "CHOCH" : "BOS",
          direction: "BEARISH", breakPrice: candle.close, level: lastLow.price,
          time: candle.datetime, candleIndex: i, brokenSwing: lastLow,
          protectedSwing: priorHighs.at(-1) || null,
          priorHighPattern, priorLowPattern
        });
        usedBearBreaks.add(lastLow.index);
      }
    }
    return events.sort((a, b) => a.candleIndex - b.candleIndex);
  }

  function selectStructuralH1Levels(price, h1Swings, structureEvents, h1Structure) {
    const highs = [...h1Swings.highs].sort((a, b) => a.index - b.index);
    const lows = [...h1Swings.lows].sort((a, b) => a.index - b.index);
    const lastEvent = structureEvents.at(-1) || null;

    let support = null, resistance = null;
    let method = "H1 structure-aware swing fallback";
    let structuralEvent = null;

    if (lastEvent) {
      structuralEvent = lastEvent;

      if (lastEvent.direction === "BULLISH") {
        if (lastEvent.protectedSwing && lastEvent.protectedSwing.price < price) {
          support = lastEvent.protectedSwing;
        }
        const postBreakHighs = highs.filter(x => x.index > lastEvent.candleIndex && x.price > price);
        resistance =
          postBreakHighs.at(-1) ||
          nearestAbove(highs.filter(x => x.index > lastEvent.candleIndex), price) ||
          nearestAbove(highs, price);
        method = lastEvent.type === "CHOCH"
          ? "H1 CHOCH protected swing + post-CHOCH resistance"
          : "H1 BOS protected swing + post-BOS resistance";
      } else {
        if (lastEvent.protectedSwing && lastEvent.protectedSwing.price > price) {
          resistance = lastEvent.protectedSwing;
        }
        const postBreakLows = lows.filter(x => x.index > lastEvent.candleIndex && x.price < price);
        support =
          postBreakLows.at(-1) ||
          nearestBelow(lows.filter(x => x.index > lastEvent.candleIndex), price) ||
          nearestBelow(lows, price);
        method = lastEvent.type === "CHOCH"
          ? "H1 CHOCH protected swing + post-CHOCH support"
          : "H1 BOS protected swing + post-BOS support";
      }
    }

    if (!support) {
      support = h1Structure.bias === "BULLISH"
        ? lows.at(-1) || nearestBelow(lows, price)
        : nearestBelow(lows, price);
    }

    if (!resistance) {
      resistance = h1Structure.bias === "BEARISH"
        ? highs.at(-1) || nearestAbove(highs, price)
        : nearestAbove(highs, price);
    }

    return { support: support || null, resistance: resistance || null, method, structuralEvent };
  }

  // ---------------------------------------------------------
  // MAIN
  // ---------------------------------------------------------

  try {
    const m5Result = await getCachedTimeSeries(
      `${CACHE_PREFIX}:m5`, "5min", CFG.m5OutputSize, CFG.m5TTL
    );
    const m5 = m5Result.candles;

    if (m5.length < 100) {
      return res.status(422).json({ ok: false, error: "M5 candle tidak mencukupi", count: m5.length });
    }

    const m15Result = await getCachedTimeSeries(
      `${CACHE_PREFIX}:m15`, "15min", CFG.m15OutputSize, CFG.m15TTL
    );
    const m15 = m15Result.candles;

    if (m15.length < 50) {
      return res.status(422).json({ ok: false, error: "M15 candle tidak mencukupi", count: m15.length });
    }

    const h1Result = await getCachedTimeSeries(
      `${CACHE_PREFIX}:h1`, "1h", CFG.h1OutputSize, CFG.h1TTL
    );
    const h1 = h1Result.candles;

    if (h1.length < 30) {
      return res.status(422).json({ ok: false, error: "H1 candle tidak mencukupi", count: h1.length });
    }

    const closedM5 = getClosedCandles(m5, "5min");
    const closedM15 = getClosedCandles(m15, "15min");
    const closedH1 = getClosedCandles(h1, "1h");

    const candlePrice = m5.at(-1)?.close ?? null;
    const priceResult = await getCachedPrice(candlePrice);
    const price = priceResult.price;

    const m5Analysis = analyzeTimeframe(m5, "M5", "5min");
    const m15Analysis = analyzeTimeframe(m15, "M15", "15min");
    const h1Analysis = analyzeTimeframe(h1, "H1", "1h");

    const h1Swings = findConfirmedSwings(closedH1, CFG.pivotLeft, CFG.pivotRight);
    const h1Highs = h1Swings.highs, h1Lows = h1Swings.lows;

    const h1Structure = classifyStructure(h1Highs, h1Lows);
    const h1EventHistory = findStructureBreakHistory(closedH1, h1Highs, h1Lows);

    const h1StructuralLevels = selectStructuralH1Levels(
      price, h1Swings, h1EventHistory, h1Structure
    );

    const support = h1StructuralLevels.support;
    const resistance = h1StructuralLevels.resistance;

    const previousSupport = latestBelow(h1Lows, price);
    const previousResistance = latestAbove(h1Highs, price);

    const h1Event = h1EventHistory.at(-1) || detectStructureEvent(
      closedH1, h1Highs, h1Lows, h1Structure
    );

    const m15Swings = findConfirmedSwings(closedM15, CFG.pivotLeft, CFG.pivotRight);
    const m5Swings = findConfirmedSwings(closedM5, CFG.pivotLeft, CFG.pivotRight);

    const signal = buildSignal(m5Analysis, m15Analysis);
    const now = Date.now();
    const marketSession = getMarketSession(now);
    const newsFilter = await getNewsFilter();

    const confluence = buildConfluence(
      signal, m5Analysis, m15Analysis, h1Analysis, newsFilter
    );

    const entryQuality = buildEntryQuality(
      signal, confluence, newsFilter, price,
      m5Analysis.atr, support, resistance
    );

    const tradePlan = buildTradePlan(
      signal, price, m5Analysis, support, resistance,
      newsFilter, marketSession
    );

    const liquidity = buildLiquidity(
      price, h1Highs, h1Lows,
      m15Swings.highs, m15Swings.lows,
      m5Swings.highs, m5Swings.lows
    );

    const marketStatusLabel = marketSession.isOpen ? "MARKET_OPEN" : "MARKET_CLOSED";

    const signalKey = signal.confirmed
      ? `${signal.direction}:${closedM15.at(-1)?.datetime || ""}:${closedM5.at(-1)?.datetime || ""}`
      : `WAIT:${closedM15.at(-1)?.datetime || ""}`;

    const recentM5 = closedM5.slice(-24).map(c => ({
      time: c.datetime, open: c.open, high: c.high, low: c.low, close: c.close
    }));
    const recentM15 = closedM15.slice(-20).map(c => ({
      time: c.datetime, open: c.open, high: c.high, low: c.low, close: c.close
    }));
    const recentH1 = closedH1.slice(-12).map(c => ({
      time: c.datetime, open: c.open, high: c.high, low: c.low, close: c.close
    }));

    const aiContext = {
      symbol: CFG.symbol,
      currentPrice: price,
      direction: signal.direction,
      signalReason: signal.reason,
      signalKey,
      marketSession: marketSession.status || (marketSession.isOpen ? "OPEN" : "CLOSED"),
      m5: {
        direction: m5Analysis.direction, rsi: m5Analysis.rsi, atr: m5Analysis.atr,
        emaFast: m5Analysis.emaFast, emaSlow: m5Analysis.emaSlow,
        structure: m5Analysis.structure, event: m5Analysis.event,
        swings: m5Swings
      },
      m15: {
        direction: m15Analysis.direction, rsi: m15Analysis.rsi, atr: m15Analysis.atr,
        emaFast: m15Analysis.emaFast, emaSlow: m15Analysis.emaSlow,
        structure: m15Analysis.structure, event: m15Analysis.event,
        swings: m15Swings
      },
      h1: {
        direction: h1Analysis.direction, bias: h1Analysis.bias,
        structure: h1Structure, event: h1Event,
        support: support ? { price: support.price, time: support.time } : null,
        resistance: resistance ? { price: resistance.price, time: resistance.time } : null,
        previousSupport: previousSupport ? { price: previousSupport.price, time: previousSupport.time } : null,
        previousResistance: previousResistance ? { price: previousResistance.price, time: previousResistance.time } : null
      },
      supportResistance: {
        support: support?.price ?? null,
        resistance: resistance?.price ?? null,
        previousSupport: previousSupport?.price ?? null,
        previousResistance: previousResistance?.price ?? null
      },
      liquidity,
      confluence,
      entryQuality,
      tradePlan,
      newsFilter: { level: newsFilter.level, reason: newsFilter.reason, items: newsFilter.items?.slice(0, 6) },
      candles: { m5: recentM5, m15: recentM15, h1: recentH1 }
    };

    const pushResult = await maybeSendSignalPush(
      signal, marketSession, price, m5Analysis, m15Analysis, h1Analysis, signalKey, aiContext
    );

    const marketFilter = {
      status: marketStatusLabel === "MARKET_CLOSED"
        ? "MARKET_CLOSED"
        : signal.confirmed ? "SCALP_READY" : "WAIT",
      marketStatus: marketStatusLabel,
      sessionStatus: marketStatusLabel,
      marketOpen: marketSession.isOpen,
      marketReason: marketSession.reason,
      marketTimezone: marketSession.timezone,
      m5: m5Analysis.direction,
      m15: m15Analysis.direction,
      h1: h1Analysis.direction,
      h1Context: h1Analysis.direction === signal.direction
        ? "ALIGNED"
        : h1Analysis.direction === "NEUTRAL"
          ? "NEUTRAL"
          : "HIGHER_TF_DIFFERENT",
      note: !marketSession.isOpen
        ? "Market closed. Cached signals are not actionable and push notifications should be ignored."
        : "H1 disagreement does not cancel M5/M15 scalp signal."
    };

    return res.status(200).json({
      ok: true,
      version: "XAUUSDSNIPER-CACHED-MTF-SCALP-V3.2",
      symbol: CFG.symbol,
      timestamp: now,
      price,

      livePrice: {
        price,
        source: priceResult.source,
        ageSeconds: priceResult.ageSeconds
      },

      candles: m5.map(c => ({
        datetime: c.datetime, open: c.open, high: c.high,
        low: c.low, close: c.close, volume: c.volume
      })),

      m5: {
        ...m5Analysis,
        candles: m5.length,
        closedCandles: closedM5.length,
        source: m5Result.source,
        confirmedSwings: {
          highs: m5Swings.highs.slice(-8).map(x => ({
            price: round(x.price), time: x.time
          })),
          lows: m5Swings.lows.slice(-8).map(x => ({
            price: round(x.price), time: x.time
          }))
        }
      },

      m15: {
        ...m15Analysis,
        candles: m15.length,
        closedCandles: closedM15.length,
        source: m15Result.source,
        confirmedSwings: {
          highs: m15Swings.highs.slice(-8).map(x => ({
            price: round(x.price), time: x.time
          })),
          lows: m15Swings.lows.slice(-8).map(x => ({
            price: round(x.price), time: x.time
          }))
        }
      },

      h1: {
        ...h1Analysis,
        candles: h1.length,
        closedCandles: closedH1.length,
        source: h1Result.source,
        lastClosedTime: closedH1.at(-1)?.datetime ?? null,
        structure: h1Structure,
        structureMethod: h1StructuralLevels.method,
        structureEvent: h1StructuralLevels.structuralEvent,

        support: support ? {
          price: round(support.price),
          time: support.time,
          distance: round(price - support.price)
        } : null,

        resistance: resistance ? {
          price: round(resistance.price),
          time: resistance.time,
          distance: round(resistance.price - price)
        } : null,

        previousSupport: previousSupport ? {
          price: round(previousSupport.price),
          time: previousSupport.time
        } : null,

        previousResistance: previousResistance ? {
          price: round(previousResistance.price),
          time: previousResistance.time
        } : null,

        swings: {
          highs: h1Highs.slice(-15).map(x => ({
            price: round(x.price), time: x.time
          })),
          lows: h1Lows.slice(-15).map(x => ({
            price: round(x.price), time: x.time
          }))
        },

        bos: h1Event.type === "BOS" ? h1Event : null,
        choch: h1Event.type === "CHOCH" ? h1Event : null
      },

      signal,
      scalpSignal: signal.scalpSignal,
      signalKey,
      aiAnalysis: pushResult?.aiAnalysis || null,
      push: pushResult,
      marketFilter,

      market: {
        ...marketSession, status: marketStatusLabel, label: marketStatusLabel
      },

      marketSession: {
        ...marketSession, status: marketStatusLabel, label: marketStatusLabel
      },

      supportResistance: {
        method: h1StructuralLevels.method,
        support: support ? round(support.price) : null,
        supportTime: support?.time ?? null,
        resistance: resistance ? round(resistance.price) : null,
        resistanceTime: resistance?.time ?? null,
        previousSupport: previousSupport ? round(previousSupport.price) : null,
        previousResistance: previousResistance ? round(previousResistance.price) : null
      },

      liquidity,
      confluence,
      entryQuality,
      tradePlan,
      newsFilter,
      news: newsFilter.items,

      filters: {
        scalp: "M5 + M15 closed-candle alignment required",
        h1: "Context / hold only",
        h1Conflict: "Does not block scalp",
        supportResistance: h1StructuralLevels.method,
        marketSession: "Standard XAU/USD session: Sunday 22:00 UTC to Friday 21:00 UTC, with 21:00-22:00 UTC daily break",
        news: "Recent headline age used as risk adjustment"
      },

      cache: {
        storage: REDIS_URL ? "KV/REDIS + MEMORY FALLBACK" : "MEMORY FALLBACK",

        m5: {
          source: m5Result.source,
          ttlSeconds: CFG.m5TTL / 1000,
          ageSeconds: m5Result.fetchedAt
            ? Math.round((now - m5Result.fetchedAt) / 1000) : null
        },

        m15: {
          source: m15Result.source,
          ttlSeconds: CFG.m15TTL / 1000,
          ageSeconds: m15Result.fetchedAt
            ? Math.round((now - m15Result.fetchedAt) / 1000) : null
        },

        h1: {
          source: h1Result.source,
          ttlSeconds: CFG.h1TTL / 1000,
          ageSeconds: h1Result.fetchedAt
            ? Math.round((now - h1Result.fetchedAt) / 1000) : null
        },

        priceTTLSeconds: CFG.priceTTL / 1000,
        newsTTLSeconds: CFG.newsTTL / 1000,
        version: CACHE_PREFIX
      },

      engine: {
        timeframe: "M5 + M15 + H1",
        scalpLogic: "M5 and M15 closed candles must align",
        h1Logic: "H1 is context/hold",
        supportResistance: "H1 BOS/CHOCH structural swings; nearest swings are liquidity only",
        marketSession: "Sunday 22:00 UTC to Friday 21:00 UTC; daily 21:00-22:00 UTC break",
        signalCandle: "CLOSED",
        cache: "Enabled",
        newsAgeFilter: "Enabled",
        entrySRFilter: "ATR-based",
        twelveDataOptimization: "M5 5m / Price 5m / M15 15m / H1 60m",
        timezone: "UTC",
        aiTrader: "Gemini second-layer setup analyst; called only for new confirmed M5+M15 signals",
        candleValidation: "Future + duplicate + invalid timestamps filtered"
      }
    });

  } catch (error) {
    console.error("XAU SCALP ENGINE ERROR", error);
    return res.status(500).json({
      ok: false,
      error: error?.message || "Scalp engine error"
    });
  }
}
