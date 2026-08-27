export default async function handler(req, res) {
  try {
    const API_KEY = process.env.TWELVE_DATA_API_KEY;

    if (!API_KEY) {
      return res.status(500).json({
        error: "TWELVE_DATA_API_KEY belum diset dalam Vercel"
      });
    }

    const url =
      "https://api.twelvedata.com/time_series" +
      "?symbol=XAU/USD" +
      "&interval=5min" +
      "&outputsize=3000" +
      "&order=ASC" +
      "&apikey=" + encodeURIComponent(API_KEY);

    const response = await fetch(url, {
      cache: "no-store"
    });

    const data = await response.json();

    if (!response.ok || data.status === "error") {
      return res.status(502).json({
        error: data.message || "Twelve Data API error"
      });
    }

    if (!Array.isArray(data.values) || data.values.length === 0) {
      return res.status(502).json({
        error: "Twelve Data tidak pulangkan candle XAU/USD"
      });
    }

    const values = data.values
      .map(c => ({
        datetime: c.datetime,
        open: Number(c.open),
        high: Number(c.high),
        low: Number(c.low),
        close: Number(c.close),
        volume: Number(c.volume) || 0
      }))
      .filter(c =>
        c.datetime &&
        Number.isFinite(c.open) &&
        Number.isFinite(c.high) &&
        Number.isFinite(c.low) &&
        Number.isFinite(c.close)
      )
      .sort(
        (a, b) =>
          new Date(a.datetime) - new Date(b.datetime)
      );

    if (!values.length) {
      return res.status(502).json({
        error: "Candle XAU/USD tidak valid"
      });
    }

    res.setHeader(
      "Cache-Control",
      "no-store, max-age=0, must-revalidate"
    );

    return res.status(200).json({
      symbol: "XAU/USD",
      interval: "5min",
      updated: new Date().toISOString(),
      count: values.length,
      values
    });

  } catch (error) {
    console.error("XAU API ERROR:", error);

    return res.status(500).json({
      error: "Server error",
      message: error.message
    });
  }
}
