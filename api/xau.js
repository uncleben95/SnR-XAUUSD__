export default async function handler(req, res) {
  try {
    const API_KEY = process.env.TWELVE_DATA_API_KEY;

    // ─────────────────────────────────────────────
    // 1. CHECK API KEY
    // ─────────────────────────────────────────────
    if (!API_KEY) {
      return res.status(500).json({
        ok: false,
        error: "TWELVE_DATA_API_KEY belum diset dalam Vercel"
      });
    }

    // ─────────────────────────────────────────────
    // 2. TWELVE DATA
    //    500 x 5M candle = lebih daripada cukup
    //    untuk bina M15 + H1 secara local
    // ─────────────────────────────────────────────
    const url =
      "https://api.twelvedata.com/time_series" +
      "?symbol=XAU/USD" +
      "&interval=5min" +
      "&outputsize=500" +
      "&order=ASC" +
      "&apikey=" + encodeURIComponent(API_KEY);

    const response = await fetch(url, {
      cache: "no-store"
    });

    let data;

    try {
      data = await response.json();
    } catch {
      return res.status(502).json({
        ok: false,
        error: "Twelve Data pulangkan response yang bukan JSON"
      });
    }

    // ─────────────────────────────────────────────
    // 3. TWELVE DATA ERROR
    // ─────────────────────────────────────────────
    if (!response.ok || data.status === "error") {
      return res.status(502).json({
        ok: false,
        error: data.message || "Twelve Data API error",
        code: data.code || response.status
      });
    }

    // ─────────────────────────────────────────────
    // 4. CHECK CANDLE
    // ─────────────────────────────────────────────
    if (!Array.isArray(data.values) || data.values.length === 0) {
      return res.status(502).json({
        ok: false,
        error: "Twelve Data tidak pulangkan candle XAU/USD"
      });
    }

    // ─────────────────────────────────────────────
    // 5. NORMALIZE CANDLE
    // ─────────────────────────────────────────────
    const values = data.values
      .map(c => ({
        datetime: c.datetime,

        open: Number(c.open),
        high: Number(c.high),
        low: Number(c.low),
        close: Number(c.close),

        volume:
          c.volume !== undefined &&
          Number.isFinite(Number(c.volume))
            ? Number(c.volume)
            : 0
      }))

      // Buang candle rosak
      .filter(c =>
        c.datetime &&
        Number.isFinite(c.open) &&
        Number.isFinite(c.high) &&
        Number.isFinite(c.low) &&
        Number.isFinite(c.close) &&

        c.high >= c.low &&
        c.high >= c.open &&
        c.high >= c.close &&
        c.low <= c.open &&
        c.low <= c.close
      )

      // Pastikan oldest → newest
      .sort(
        (a, b) =>
          new Date(a.datetime).getTime() -
          new Date(b.datetime).getTime()
      );

    if (!values.length) {
      return res.status(502).json({
        ok: false,
        error: "Candle XAU/USD tidak valid"
      });
    }

    // ─────────────────────────────────────────────
    // 6. LAST CANDLE
    // ─────────────────────────────────────────────
    const last = values[values.length - 1];

    // ─────────────────────────────────────────────
    // 7. CACHE CONTROL
    // ─────────────────────────────────────────────
    res.setHeader(
      "Cache-Control",
      "no-store, max-age=0, must-revalidate"
    );

    res.setHeader(
      "Content-Type",
      "application/json; charset=utf-8"
    );

    // ─────────────────────────────────────────────
    // 8. RESPONSE
    // ─────────────────────────────────────────────
    return res.status(200).json({
      ok: true,

      symbol: "XAU/USD",

      interval: "5min",

      updated: new Date().toISOString(),

      count: values.length,

      lastPrice: last.close,

      lastCandleTime: last.datetime,

      values
    });

  } catch (error) {

    console.error("XAU API ERROR:", error);

    return res.status(500).json({
      ok: false,
      error: "Server error",
      message:
        error && error.message
          ? error.message
          : "Unknown server error"
    });
  }
}
