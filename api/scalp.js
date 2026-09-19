import { sendPushToAll } from "./push-lib.js";

export const config = {
  maxDuration: 10,
};

const TWELVE_DATA_API = "https://api.twelvedata.com";
const SYMBOL = "XAU/USD";
const NEWS_TIMEOUT = 5000;

// ============================================================
// HELPERS
// ============================================================

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function avg(arr) {
  const a = arr.filter(Number.isFinite);
  if (!a.length) return 0;
  return a.reduce((x, y) => x + y, 0) / a.length;
}

function round(v, digits = 2) {
  const p = 10 ** digits;
  return Math.round(v * p) / p;
}

function parseTime(v) {
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : 0;
}

function normalizeCandle(c) {
  return {
    datetime: c.datetime,
    open: num(c.open),
    high: num(c.high),
    low: num(c.low),
    close: num(c.close),
    volume: num(c.volume),
  };
}

// ============================================================
// TWELVE DATA
// ============================================================

async function twelveData(path, params) {
  const key = process.env.TWELVE_DATA_API_KEY;

  if (!key) {
    throw new Error("TWELVE_DATA_API_KEY missing");
  }

  const qs = new URLSearchParams({
    ...params,
    apikey: key,
  });

  const url = `${TWELVE_DATA_API}/${path}?${qs.toString()}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: "application/json",
      },
    });

    const text = await response.text();

    let data;

    try {
      data = JSON.parse(text);
    } catch {
      throw new Error("Twelve Data returned invalid JSON");
    }

    if (!response.ok) {
      throw new Error(
        data?.message || `Twelve Data HTTP ${response.status}`
      );
    }

    if (data?.status === "error") {
      throw new Error(
        data?.message || "Twelve Data API error"
      );
    }

    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function getPrice() {
  const data = await twelveData("price", {
    symbol: SYMBOL,
  });

  const price = num(data?.price);

  if (!price) {
    throw new Error("Invalid live price");
  }

  return price;
}

async function getM5() {
  const data = await twelveData("time_series", {
    symbol: SYMBOL,
    interval: "5min",
    outputsize: "500",
    order: "asc",
    format: "JSON",
  });

  if (!Array.isArray(data?.values)) {
    throw new Error("No M5 candle data");
  }

  return data.values
    .map(normalizeCandle)
    .filter(
      (c) =>
        c.datetime &&
        c.open &&
        c.high &&
        c.low &&
        c.close
    )
    .sort(
      (a, b) =>
        parseTime(a.datetime) -
        parseTime(b.datetime)
    );
}

// ============================================================
// AGGREGATE M5 -> M15 / H1
// ============================================================

function aggregateCandles(candles, minutes) {
  if (!candles.length) return [];

  const bucketMs = minutes * 60 * 1000;
  const groups = new Map();

  for (const c of candles) {
    const t = parseTime(c.datetime);

    if (!t) continue;

    const bucket =
      Math.floor(t / bucketMs) * bucketMs;

    if (!groups.has(bucket)) {
      groups.set(bucket, []);
    }

    groups.get(bucket).push(c);
  }

  const output = [];

  for (const [bucket, group] of groups.entries()) {
    group.sort(
      (a, b) =>
        parseTime(a.datetime) -
        parseTime(b.datetime)
    );

    const first = group[0];
    const last = group[group.length - 1];

    output.push({
      datetime: new Date(bucket).toISOString(),
      open: first.open,
      high: Math.max(...group.map((x) => x.high)),
      low: Math.min(...group.map((x) => x.low)),
      close: last.close,
      volume: group.reduce(
        (sum, x) => sum + num(x.volume),
        0
      ),
    });
  }

  return output.sort(
    (a, b) =>
      parseTime(a.datetime) -
      parseTime(b.datetime)
  );
}

// ============================================================
// INDICATORS
// ============================================================

function ema(candles, period) {
  if (candles.length < period) return null;

  let value = avg(
    candles
      .slice(0, period)
      .map((c) => c.close)
  );

  const k = 2 / (period + 1);

  for (let i = period; i < candles.length; i++) {
    value =
      candles[i].close * k +
      value * (1 - k);
  }

  return value;
}

function rsi(candles, period = 14) {
  if (candles.length <= period) return 50;

  let gains = 0;
  let losses = 0;

  const start = candles.length - period;

  for (let i = start; i < candles.length; i++) {
    const prev = candles[i - 1]?.close;
    const curr = candles[i]?.close;

    if (!Number.isFinite(prev) || !Number.isFinite(curr)) {
      continue;
    }

    const change = curr - prev;

    if (change > 0) gains += change;
    if (change < 0) losses += Math.abs(change);
  }

  if (losses === 0) return 100;

  const rs =
    (gains / period) /
    (losses / period);

  return 100 - 100 / (1 + rs);
}

function atr(candles, period = 14) {
  if (candles.length <= period) return 0;

  const trs = [];

  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const p = candles[i - 1];

    const tr = Math.max(
      c.high - c.low,
      Math.abs(c.high - p.close),
      Math.abs(c.low - p.close)
    );

    trs.push(tr);
  }

  return avg(trs.slice(-period));
}

// ============================================================
// TIMEFRAME ANALYSIS
// ============================================================

function timeframeAnalysis(candles) {
  if (!candles.length) {
    return {
      direction: "NEUTRAL",
      trend: "NEUTRAL",
      strength: 0,
      rsi: 50,
      emaFast: 0,
      emaSlow: 0,
      atr: 0,
    };
  }

  const price =
    candles[candles.length - 1].close;

  const fast = ema(candles, 9);
  const slow = ema(candles, 21);
  const r = rsi(candles, 14);
  const a = atr(candles, 14);

  let score = 0;

  if (fast !== null && slow !== null) {
    if (fast > slow) score += 2;
    if (fast < slow) score -= 2;
  }

  if (fast !== null) {
    if (price > fast) score += 1;
    if (price < fast) score -= 1;
  }

  if (r > 55) score += 1;
  if (r < 45) score -= 1;

  let direction = "NEUTRAL";

  if (score >= 2) direction = "BUY";
  if (score <= -2) direction = "SELL";

  return {
    direction,
    trend: direction,
    strength: round(
      clamp((Math.abs(score) / 4) * 100, 0, 100)
    ),
    rsi: round(r, 1),
    emaFast: round(fast || 0, 3),
    emaSlow: round(slow || 0, 3),
    atr: round(a, 3),
  };
}

// ============================================================
// CONFIRMED SWING HIGH / LOW
//
// IMPORTANT:
// A swing is only confirmed after candles appear on BOTH sides.
//
// Example:
//
//      HIGH
//       /\
//      /  \
// ----/----\----
//
// The high candle must have lower highs around it.
//
// We deliberately do NOT use the latest unfinished candle.
// ============================================================

function findConfirmedSwings(
  candles,
  left = 2,
  right = 2
) {
  const highs = [];
  const lows = [];

  if (
    candles.length <
    left + right + 1
  ) {
    return {
      highs,
      lows,
    };
  }

  // Exclude the latest candles because they may still
  // be forming / not fully confirmed.
  const lastIndex =
    candles.length - right - 1;

  for (
    let i = left;
    i <= lastIndex;
    i++
  ) {
    const current = candles[i];

    let swingHigh = true;
    let swingLow = true;

    // LEFT side
    for (
      let j = i - left;
      j < i;
      j++
    ) {
      if (
        candles[j].high >=
        current.high
      ) {
        swingHigh = false;
      }

      if (
        candles[j].low <=
        current.low
      ) {
        swingLow = false;
      }
    }

    // RIGHT side
    for (
      let j = i + 1;
      j <= i + right;
      j++
    ) {
      if (
        candles[j].high >=
        current.high
      ) {
        swingHigh = false;
      }

      if (
        candles[j].low <=
        current.low
      ) {
        swingLow = false;
      }
    }

    if (swingHigh) {
      highs.push({
        price: current.high,
        datetime: current.datetime,
        index: i,
      });
    }

    if (swingLow) {
      lows.push({
        price: current.low,
        datetime: current.datetime,
        index: i,
      });
    }
  }

  return {
    highs,
    lows,
  };
}

// ============================================================
// H1 STRUCTURE
//
// Resistance = LAST CONFIRMED H1 SWING HIGH
// Support    = LAST CONFIRMED H1 SWING LOW
//
// This is NOT simply highest/lowest of 50 candles.
// ============================================================

function getH1Structure(h1Candles, price) {
  const swings =
    findConfirmedSwings(
      h1Candles,
      2,
      2
    );

  const highs = swings.highs;
  const lows = swings.lows;

  // Last confirmed swing BEFORE current price context.
  const resistanceCandidates =
    highs.filter(
      (x) => x.price > price
    );

  const supportCandidates =
    lows.filter(
      (x) => x.price < price
    );

  // Prefer nearest valid level to current price.
  const resistance =
    resistanceCandidates.length
      ? resistanceCandidates.sort(
          (a, b) => a.price - b.price
        )[0]
      : highs.length
        ? highs[highs.length - 1]
        : null;

  const support =
    supportCandidates.length
      ? supportCandidates.sort(
          (a, b) => b.price - a.price
        )[0]
      : lows.length
        ? lows[lows.length - 1]
        : null;

  // Previous levels for extra context.
  const previousResistance =
    highs.length >= 2
      ? highs[highs.length - 2]
      : null;

  const previousSupport =
    lows.length >= 2
      ? lows[lows.length - 2]
      : null;

  return {
    method:
      "Confirmed H1 swing high/low",

    support: support
      ? round(support.price, 3)
      : 0,

    resistance: resistance
      ? round(resistance.price, 3)
      : 0,

    supportDatetime:
      support?.datetime || null,

    resistanceDatetime:
      resistance?.datetime || null,

    previousSupport:
      previousSupport
        ? round(previousSupport.price, 3)
        : 0,

    previousResistance:
      previousResistance
        ? round(previousResistance.price, 3)
        : 0,

    confirmedSwingHighs:
      highs.slice(-10).map((x) => ({
        price: round(x.price, 3),
        datetime: x.datetime,
      })),

    confirmedSwingLows:
      lows.slice(-10).map((x) => ({
        price: round(x.price, 3),
        datetime: x.datetime,
      })),
  };
}

// ============================================================
// M15 / M5 STRUCTURE
// ============================================================

function getStructureLevels(candles) {
  const swings =
    findConfirmedSwings(
      candles,
      2,
      2
    );

  const latestHigh =
    swings.highs.length
      ? swings.highs[swings.highs.length - 1]
      : null;

  const latestLow =
    swings.lows.length
      ? swings.lows[swings.lows.length - 1]
      : null;

  return {
    swingHigh:
      latestHigh
        ? round(latestHigh.price, 3)
        : 0,

    swingLow:
      latestLow
        ? round(latestLow.price, 3)
        : 0,

    swingHighDatetime:
      latestHigh?.datetime || null,

    swingLowDatetime:
      latestLow?.datetime || null,
  };
}

// ============================================================
// LIQUIDITY MAP
// ============================================================

function liquidityMap(
  candles,
  price,
  h1Structure
) {
  const highs = [];
  const lows = [];

  const swings =
    findConfirmedSwings(
      candles,
      2,
      2
    );

  for (const h of swings.highs) {
    if (h.price > price) {
      highs.push(h.price);
    }
  }

  for (const l of swings.lows) {
    if (l.price < price) {
      lows.push(l.price);
    }
  }

  // Add H1 confirmed structure as major liquidity.
  if (
    h1Structure.resistance &&
    h1Structure.resistance > price
  ) {
    highs.push(
      h1Structure.resistance
    );
  }

  if (
    h1Structure.support &&
    h1Structure.support < price
  ) {
    lows.push(
      h1Structure.support
    );
  }

  const above = [
    ...new Set(
      highs.map((x) => round(x, 3))
    ),
  ].sort((a, b) => a - b);

  const below = [
    ...new Set(
      lows.map((x) => round(x, 3))
    ),
  ].sort((a, b) => b - a);

  return {
    above: above.slice(0, 8),
    below: below.slice(0, 8),

    nearestAbove:
      above.length
        ? above[0]
        : 0,

    nearestBelow:
      below.length
        ? below[0]
        : 0,
  };
}

// ============================================================
// FREE NEWS FILTER
// Google News RSS - NO API KEY
// ============================================================

function googleNewsUrl(query) {
  return (
    "https://news.google.com/rss/search?" +
    new URLSearchParams({
      q: `${query} when:2d`,
      hl: "en-US",
      gl: "US",
      ceid: "US:en",
    }).toString()
  );
}

async function fetchNewsFeed(query) {
  const controller =
    new AbortController();

  const timer = setTimeout(
    () => controller.abort(),
    NEWS_TIMEOUT
  );

  try {
    const response =
      await fetch(
        googleNewsUrl(query),
        {
          signal:
            controller.signal,

          headers: {
            Accept:
              "application/rss+xml, application/xml, text/xml",

            "User-Agent":
              "XAUUSDSNIPER/1.0",
          },
        }
      );

    if (!response.ok) {
      throw new Error(
        `News HTTP ${response.status}`
      );
    }

    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

function xmlDecode(text = "") {
  return text
    .replace(
      /<!\[CDATA\[(.*?)\]\]>/gs,
      "$1"
    )
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'");
}

function parseRSS(xml) {
  const items = [];

  const matches =
    xml.match(
      /<item[\s\S]*?<\/item>/gi
    ) || [];

  for (
    const item of matches.slice(0, 20)
  ) {
    const title =
      item.match(
        /<title[^>]*>([\s\S]*?)<\/title>/i
      )?.[1] || "";

    const link =
      item.match(
        /<link[^>]*>([\s\S]*?)<\/link>/i
      )?.[1] || "";

    const pubDate =
      item.match(
        /<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i
      )?.[1] || "";

    const source =
      item.match(
        /<source[^>]*>([\s\S]*?)<\/source>/i
      )?.[1] || "";

    const cleanTitle =
      xmlDecode(title)
        .replace(/<[^>]+>/g, "")
        .trim();

    if (!cleanTitle) continue;

    items.push({
      title: cleanTitle,
      link: xmlDecode(link).trim(),
      pubDate:
        xmlDecode(pubDate).trim(),
      source:
        xmlDecode(source)
          .replace(/<[^>]+>/g, "")
          .trim() || "Google News",
    });
  }

  return items;
}

function newsImpact(title) {
  const t =
    title.toLowerCase();

  const high = [
    "federal reserve",
    "fed decision",
    "fed rate",
    "interest rate decision",
    "rate hike",
    "rate cut",
    "fomc",
    "cpi",
    "consumer price index",
    "nonfarm payroll",
    "non-farm payroll",
    "nfp",
    "jobs report",
    "employment report",
    "ppi",
    "producer price index",
    "powell",
    "fed chair",
    "inflation",
    "us inflation",
    "us jobs",
    "treasury yield",
    "dollar index",
    "dxy",
  ];

  const medium = [
    "gold",
    "xau",
    "bullion",
    "precious metals",
    "usd",
    "us dollar",
    "oil",
    "crude",
    "opec",
    "middle east",
    "geopolitical",
    "safe haven",
    "central bank",
    "economic data",
    "retail sales",
    "pmi",
    "gdp",
    "jobless claims",
    "unemployment",
  ];

  if (
    high.some((k) => t.includes(k))
  ) {
    return "HIGH";
  }

  if (
    medium.some((k) => t.includes(k))
  ) {
    return "MEDIUM";
  }

  return "LOW";
}

function newsRelevant(title) {
  const t =
    title.toLowerCase();

  const keywords = [
    "gold",
    "xau",
    "bullion",
    "precious metal",
    "silver",
    "fed",
    "federal reserve",
    "fomc",
    "powell",
    "interest rate",
    "rate hike",
    "rate cut",
    "inflation",
    "cpi",
    "ppi",
    "nonfarm",
    "non-farm",
    "nfp",
    "jobs report",
    "employment",
    "unemployment",
    "dollar",
    "dxy",
    "treasury",
    "yield",
    "oil",
    "crude",
    "opec",
    "geopolitical",
    "middle east",
    "safe haven",
    "central bank",
    "economic data",
  ];

  return keywords.some((k) =>
    t.includes(k)
  );
}

async function getNewsFilter() {
  const queries = [
    '"gold" OR "XAU" OR bullion',
    '"Federal Reserve" OR FOMC OR "interest rate"',
    "CPI OR inflation OR NFP OR \"jobs report\"",
    '"US dollar" OR DXY OR "Treasury yield"',
  ];

  try {
    const results =
      await Promise.allSettled(
        queries.map(
          (q) => fetchNewsFeed(q)
        )
      );

    let all = [];

    for (const result of results) {
      if (
        result.status ===
        "fulfilled"
      ) {
        all.push(
          ...parseRSS(
            result.value
          )
        );
      }
    }

    const unique =
      new Map();

    for (const item of all) {
      const key =
        item.title.toLowerCase();

      if (!unique.has(key)) {
        unique.set(
          key,
          item
        );
      }
    }

    const news =
      [...unique.values()]
        .filter((item) =>
          newsRelevant(
            item.title
          )
        )
        .map((item) => ({
          ...item,

          impact:
            newsImpact(
              item.title
            ),

          timestamp:
            Date.parse(
              item.pubDate
            ) || Date.now(),
        }))
        .sort(
          (a, b) =>
            b.timestamp -
            a.timestamp
        )
        .slice(0, 15);

    const high =
      news.filter(
        (n) =>
          n.impact ===
          "HIGH"
      );

    const medium =
      news.filter(
        (n) =>
          n.impact ===
          "MEDIUM"
      );

    let status = "CLEAR";
    let risk = "LOW";

    if (high.length) {
      status = "RISK";
      risk = "HIGH";
    } else if (medium.length) {
      status = "WATCH";
      risk = "MEDIUM";
    }

    return {
      enabled: true,
      status,
      risk,
      source: "Google News RSS",
      count: news.length,
      highImpact: high.length,
      mediumImpact: medium.length,
      news,
      checkedAt:
        new Date().toISOString(),

      message:
        status === "RISK"
          ? "High-impact market news detected"
          : status === "WATCH"
            ? "Relevant market news detected"
            : "No major XAU/USD news detected",
    };
  } catch (error) {
    return {
      enabled: true,
      status: "UNKNOWN",
      risk: "UNKNOWN",
      source: "Google News RSS",
      count: 0,
      highImpact: 0,
      mediumImpact: 0,
      news: [],
      checkedAt:
        new Date().toISOString(),

      message:
        "News feed unavailable",

      error:
        error?.message ||
        "News error",
    };
  }
}

// ============================================================
// SCALP SIGNAL
//
// M5 + M15 MUST ALIGN
//
// H1 DOES NOT BLOCK SCALP
// ============================================================

function buildScalpSignal(
  m5Analysis,
  m15Analysis,
  h1Analysis,
  news
) {
  const aligned =
    m5Analysis.direction !==
      "NEUTRAL" &&
    m15Analysis.direction !==
      "NEUTRAL" &&
    m5Analysis.direction ===
      m15Analysis.direction;

  let signal = "WAIT";

  if (aligned) {
    signal =
      m5Analysis.direction ===
      "BUY"
        ? "BUY"
        : "SELL";
  }

  let confidence =
    avg([
      m5Analysis.strength,
      m15Analysis.strength,
    ]);

  if (aligned) {
    confidence += 10;
  }

  if (
    h1Analysis.direction ===
    signal &&
    signal !== "WAIT"
  ) {
    confidence += 5;
  }

  if (
    news?.risk === "HIGH"
  ) {
    confidence -= 15;
  }

  if (
    news?.risk === "MEDIUM"
  ) {
    confidence -= 5;
  }

  confidence = clamp(
    round(confidence),
    0,
    100
  );

  return {
    signal,
    scalpSignal: signal,

    aligned,

    m5:
      m5Analysis.direction,

    m15:
      m15Analysis.direction,

    h1:
      h1Analysis.direction,

    confidence,

    newsRisk:
      news?.risk ||
      "UNKNOWN",

    holdContext:
      h1Analysis.direction ===
        signal &&
      signal !== "WAIT",

    note:
      signal === "WAIT"
        ? "Wait for M5 + M15 alignment"
        : news?.risk === "HIGH"
          ? "M5 + M15 aligned but high news risk"
          : h1Analysis.direction ===
              signal
            ? "M5 + M15 aligned; H1 supports hold context"
            : "M5 + M15 aligned; H1 is scalp context only",
  };
}

// ============================================================
// TRADE PLAN
//
// Uses H1 confirmed swing levels when available.
// ============================================================

function tradePlan(
  price,
  signal,
  candles,
  h1Structure
) {
  const a = atr(
    candles,
    14
  );

  if (
    !price ||
    signal === "WAIT" ||
    !a
  ) {
    return {
      active: false,
      direction: "WAIT",
      entry: price || 0,
      stopLoss: 0,
      takeProfit1: 0,
      takeProfit2: 0,
      riskDistance: 0,
      support: h1Structure.support,
      resistance:
        h1Structure.resistance,
    };
  }

  const atrRisk =
    Math.max(
      a * 1.2,
      price * 0.001
    );

  if (signal === "BUY") {
    let stop =
      price - atrRisk;

    // If confirmed H1 support exists below entry,
    // use it as structural reference.
    if (
      h1Structure.support &&
      h1Structure.support < price
    ) {
      const structureStop =
        h1Structure.support -
        Math.max(
          a * 0.15,
          price * 0.00015
        );

      // Don't put the stop absurdly far away.
      if (
        price - structureStop <=
        atrRisk * 2.2
      ) {
        stop =
          Math.min(
            stop,
            structureStop
          );
      }
    }

    const risk =
      price - stop;

    return {
      active: true,
      direction: "BUY",

      entry:
        round(price, 3),

      stopLoss:
        round(stop, 3),

      takeProfit1:
        round(
          price + risk * 1.2,
          3
        ),

      takeProfit2:
        round(
          price + risk * 2,
          3
        ),

      riskDistance:
        round(risk, 3),

      support:
        h1Structure.support,

      resistance:
        h1Structure.resistance,

      stopBasis:
        h1Structure.support
          ? "ATR + H1 confirmed swing support"
          : "ATR",
    };
  }

  let stop =
    price + atrRisk;

  if (
    h1Structure.resistance &&
    h1Structure.resistance > price
  ) {
    const structureStop =
      h1Structure.resistance +
      Math.max(
        a * 0.15,
        price * 0.00015
      );

    if (
      structureStop - price <=
      atrRisk * 2.2
    ) {
      stop =
        Math.max(
          stop,
          structureStop
        );
    }
  }

  const risk =
    stop - price;

  return {
    active: true,
    direction: "SELL",

    entry:
      round(price, 3),

    stopLoss:
      round(stop, 3),

    takeProfit1:
      round(
        price - risk * 1.2,
        3
      ),

    takeProfit2:
      round(
        price - risk * 2,
        3
      ),

    riskDistance:
      round(risk, 3),

    support:
      h1Structure.support,

    resistance:
      h1Structure.resistance,

    stopBasis:
      h1Structure.resistance
        ? "ATR + H1 confirmed swing resistance"
        : "ATR",
  };
}

// ============================================================
// ENTRY QUALITY
// ============================================================

function entryQuality(
  m5,
  m15,
  h1,
  news
) {
  let score = 0;

  if (
    m5.direction !==
    "NEUTRAL"
  ) {
    score += 25;
  }

  if (
    m15.direction !==
    "NEUTRAL"
  ) {
    score += 25;
  }

  if (
    m5.direction ===
    m15.direction
  ) {
    score += 30;
  }

  if (
    h1.direction ===
    m5.direction
  ) {
    score += 10;
  }

  if (
    news.risk === "HIGH"
  ) {
    score -= 25;
  }

  if (
    news.risk === "MEDIUM"
  ) {
    score -= 10;
  }

  score = clamp(
    score,
    0,
    100
  );

  let label = "LOW";

  if (score >= 75) {
    label = "HIGH";
  } else if (score >= 50) {
    label = "MEDIUM";
  }

  return {
    score,
    label,
  };
}

// ============================================================
// HANDLER
// ============================================================

export default async function handler(
  req,
  res
) {
  res.setHeader(
    "Access-Control-Allow-Origin",
    "*"
  );

  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET,OPTIONS"
  );

  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type"
  );

  if (req.method === "OPTIONS") {
    return res
      .status(200)
      .end();
  }

  try {
    if (
      !process.env
        .TWELVE_DATA_API_KEY
    ) {
      return res.status(500).json({
        ok: false,
        error:
          "TWELVE_DATA_API_KEY missing",
      });
    }

    // --------------------------------------------------------
    // FETCH
    // --------------------------------------------------------

    const [
      priceResult,
      m5Result,
      newsResult,
    ] =
      await Promise.allSettled([
        getPrice(),
        getM5(),
        getNewsFilter(),
      ]);

    if (
      priceResult.status !==
      "fulfilled"
    ) {
      throw new Error(
        priceResult.reason?.message ||
          "Unable to get live price"
      );
    }

    if (
      m5Result.status !==
      "fulfilled"
    ) {
      throw new Error(
        m5Result.reason?.message ||
          "Unable to get M5 candles"
      );
    }

    const price =
      priceResult.value;

    const m5Candles =
      m5Result.value;

    const news =
      newsResult.status ===
      "fulfilled"
        ? newsResult.value
        : {
            enabled: true,
            status: "UNKNOWN",
            risk: "UNKNOWN",
            source:
              "Google News RSS",
            count: 0,
            highImpact: 0,
            mediumImpact: 0,
            news: [],
            checkedAt:
              new Date().toISOString(),
            message:
              "News feed unavailable",
          };

    // --------------------------------------------------------
    // TIMEFRAMES
    // --------------------------------------------------------

    const m15Candles =
      aggregateCandles(
        m5Candles,
        15
      );

    const h1Candles =
      aggregateCandles(
        m5Candles,
        60
      );

    const m5Analysis =
      timeframeAnalysis(
        m5Candles
      );

    const m15Analysis =
      timeframeAnalysis(
        m15Candles
      );

    const h1Analysis =
      timeframeAnalysis(
        h1Candles
      );

    // --------------------------------------------------------
    // H1 STRUCTURE
    // --------------------------------------------------------

    const h1Structure =
      getH1Structure(
        h1Candles,
        price
      );

    // M15 / M5 structures
    const m15Structure =
      getStructureLevels(
        m15Candles
      );

    const m5Structure =
      getStructureLevels(
        m5Candles
      );

    // --------------------------------------------------------
    // SIGNAL
    // --------------------------------------------------------

    const scalp =
      buildScalpSignal(
        m5Analysis,
        m15Analysis,
        h1Analysis,
        news
      );

    // --------------------------------------------------------
    // LIQUIDITY
    // --------------------------------------------------------

    const liquidity =
      liquidityMap(
        m5Candles,
        price,
        h1Structure
      );

    // --------------------------------------------------------
    // TRADE PLAN
    // --------------------------------------------------------

    const plan =
      tradePlan(
        price,
        scalp.signal,
        m5Candles,
        h1Structure
      );

    // --------------------------------------------------------
    // ENTRY QUALITY
    // --------------------------------------------------------

    const quality =
      entryQuality(
        m5Analysis,
        m15Analysis,
        h1Analysis,
        news
      );

    // --------------------------------------------------------
    // CONFLUENCE
    // --------------------------------------------------------

    const confluence = [
      {
        name: "M5 Direction",
        value:
          m5Analysis.direction,
        pass:
          m5Analysis.direction !==
          "NEUTRAL",
      },

      {
        name: "M15 Direction",
        value:
          m15Analysis.direction,
        pass:
          m15Analysis.direction !==
          "NEUTRAL",
      },

      {
        name:
          "M5 + M15 Alignment",
        value:
          scalp.aligned
            ? "ALIGNED"
            : "WAIT",
        pass:
          scalp.aligned,
      },

      {
        name: "H1 Context",
        value:
          h1Analysis.direction,
        pass:
          h1Analysis.direction ===
            scalp.signal &&
          scalp.signal !==
            "WAIT",
      },

      {
        name: "H1 Support",
        value:
          h1Structure.support,
        pass:
          !!h1Structure.support,
      },

      {
        name: "H1 Resistance",
        value:
          h1Structure.resistance,
        pass:
          !!h1Structure.resistance,
      },

      {
        name: "News Filter",
        value:
          news.status,
        pass:
          news.risk !== "HIGH",
      },
    ];

    // --------------------------------------------------------
    // MARKET FILTER
    // --------------------------------------------------------

    let marketFilter =
      "NEUTRAL";

    if (
      news.risk === "HIGH"
    ) {
      marketFilter =
        "NEWS RISK";
    } else if (
      scalp.signal !==
      "WAIT"
    ) {
      marketFilter =
        scalp.signal;
    }

    // --------------------------------------------------------
    // RESPONSE
    // --------------------------------------------------------

    return res.status(200).json({
      ok: true,

      symbol: SYMBOL,

      timestamp:
        Date.now(),

      price,

      livePrice: {
        price,
        source:
          "Twelve Data REST",
      },

      // Raw M5 candles
      candles:
        m5Candles,

      // ------------------------------------------------------
      // M5
      // ------------------------------------------------------

      m5: {
        candles:
          m5Candles,

        ...m5Analysis,

        structure:
          m5Structure,
      },

      // ------------------------------------------------------
      // M15
      // ------------------------------------------------------

      m15: {
        candles:
          m15Candles,

        ...m15Analysis,

        structure:
          m15Structure,
      },

      // ------------------------------------------------------
      // H1
      // ------------------------------------------------------

      h1: {
        candles:
          h1Candles,

        ...h1Analysis,

        structure:
          h1Structure,

        support:
          h1Structure.support,

        resistance:
          h1Structure.resistance,

        supportDatetime:
          h1Structure.supportDatetime,

        resistanceDatetime:
          h1Structure.resistanceDatetime,

        previousSupport:
          h1Structure.previousSupport,

        previousResistance:
          h1Structure.previousResistance,

        swingMethod:
          h1Structure.method,
      },

      // ------------------------------------------------------
      // SIGNAL
      // ------------------------------------------------------

      signal:
        scalp.signal,

      scalpSignal:
        scalp,

      marketFilter,

      // ------------------------------------------------------
      // STRUCTURE / LIQUIDITY
      // ------------------------------------------------------

      supportResistance: {
        timeframe: "H1",

        method:
          "Confirmed H1 swing high/low",

        support:
          h1Structure.support,

        resistance:
          h1Structure.resistance,

        previousSupport:
          h1Structure.previousSupport,

        previousResistance:
          h1Structure.previousResistance,
      },

      liquidity,

      // ------------------------------------------------------
      // CONFLUENCE
      // ------------------------------------------------------

      confluence,

      entryQuality:
        quality,

      // ------------------------------------------------------
      // TRADE PLAN
      // ------------------------------------------------------

      tradePlan:
        plan,

      // ------------------------------------------------------
      // NEWS
      // ------------------------------------------------------

      newsFilter:
        news,

      news,

      // ------------------------------------------------------
      // FILTERS
      // ------------------------------------------------------

      filters: {
        news:
          news.status,

        market:
          marketFilter,

        m5m15Aligned:
          scalp.aligned,

        h1Support:
          h1Structure.support,

        h1Resistance:
          h1Structure.resistance,
      },

      // ------------------------------------------------------
      // ENGINE
      // ------------------------------------------------------

      engine: {
        scalpDirection:
          scalp.signal,

        m5Direction:
          m5Analysis.direction,

        m15Direction:
          m15Analysis.direction,

        h1Direction:
          h1Analysis.direction,

        h1Hold:
          scalp.holdContext,

        h1Support:
          h1Structure.support,

        h1Resistance:
          h1Structure.resistance,

        newsRisk:
          news.risk,

        swingMethod:
          "Confirmed swing high/low",
      },
    });
  } catch (error) {
    console.error(
      "SCALP API ERROR:",
      error
    );

    return res.status(500).json({
      ok: false,
      error:
        error?.message ||
        "API error",
    });
  }
}
