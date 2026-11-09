import { redis } from "./push-lib.js";

// Compatibility endpoint: derive H4 levels from the shared market-data cache.
// This endpoint deliberately makes ZERO Twelve Data requests.
const MARKET_CACHE_KEY = "xau_market_data_h1_h4_v1";

function atr(data, period = 14) {
  if (!Array.isArray(data) || data.length < period + 1) return null;
  const ranges = [];
  for (let i = 1; i < data.length; i++) {
    const current = data[i], previous = data[i - 1];
    ranges.push(Math.max(current.high - current.low, Math.abs(current.high - previous.close), Math.abs(current.low - previous.close)));
  }
  return ranges.slice(-period).reduce((sum, value) => sum + value, 0) / period;
}

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ ok: false, error: "Method not allowed" });
  try {
    let cached = await redis.get(MARKET_CACHE_KEY);
    if (typeof cached === "string") cached = JSON.parse(cached);
    if (!cached?.h1?.length || !cached?.h4?.length) {
      return res.status(503).json({ ok: false, error: "Shared market-data cache is empty. Load /api/scalp first; this endpoint does not make provider requests." });
    }

    const data = cached.h4;
    const price = cached.h1.at(-1).close;
    const tolerance = Math.max((atr(data) || 10) * 0.35, 2);
    const supports = [], resistances = [];
    for (let i = 2; i < data.length - 2; i++) {
      const candle = data[i];
      const left = data.slice(i - 2, i), right = data.slice(i + 1, i + 3);
      if (candle.low <= Math.min(...left.map(x => x.low), ...right.map(x => x.low)) && candle.low < price) supports.push({ price: candle.low, time: candle.time, timeframe: "H4", kind: "swing-low" });
      if (candle.high >= Math.max(...left.map(x => x.high), ...right.map(x => x.high)) && candle.high > price) resistances.push({ price: candle.high, time: candle.time, timeframe: "H4", kind: "swing-high" });
    }

    const cluster = (levels) => {
      const groups = [];
      for (const level of levels.sort((a, b) => a.price - b.price)) {
        const group = groups.at(-1);
        if (group && Math.abs(level.price - group.anchor) <= tolerance) {
          group.items.push(level);
          group.anchor = group.items.reduce((sum, item) => sum + item.price, 0) / group.items.length;
        } else groups.push({ anchor: level.price, items: [level] });
      }
      return groups.map(group => ({ price: group.anchor, time: group.items.at(-1).time, timeframe: "H4", touches: group.items.length }));
    };

    const supportLevels = cluster(supports).filter(x => x.price < price).sort((a, b) => b.price - a.price).slice(0, 8);
    const resistanceLevels = cluster(resistances).filter(x => x.price > price).sort((a, b) => a.price - b.price).slice(0, 8);
    return res.status(200).json({
      ok: true, symbol: "XAU/USD", price,
      nearestSupport: supportLevels[0] || null,
      nearestResistance: resistanceLevels[0] || null,
      supports: supportLevels, resistances: resistanceLevels,
      source: "Shared Redis cache; no Twelve Data request",
      fetchedAt: cached.fetchedAt || null,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error("Cached H4 levels:", error?.message || error);
    return res.status(503).json({ ok: false, error: error.message || "Cached levels unavailable" });
  }
}
