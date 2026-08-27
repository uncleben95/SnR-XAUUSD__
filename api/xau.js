export default async function handler(req, res) {
  try {
    const API_KEY = process.env.TWELVE_DATA_API_KEY;

    if (!API_KEY) {
      return res.status(500).json({
        error: "TWELVE_DATA_API_KEY belum diset dalam Vercel"
      });
    }

    const url =
      `https://api.twelvedata.com/time_series` +
      `?symbol=XAU/USD` +
      `&interval=5min` +
      `&outputsize=200` +
      `&apikey=${API_KEY}`;

    const response = await fetch(url);
    const data = await response.json();

    if (!response.ok || data.status === "error") {
      return res.status(502).json({
        error: data.message || "Twelve Data API error"
      });
    }

    return res.status(200).json({
      symbol: "XAU/USD",
      interval: "5min",
      updated: new Date().toISOString(),
      values: data.values || []
    });

  } catch (error) {
    return res.status(500).json({
      error: "Server error",
      message: error.message
    });
  }
}
