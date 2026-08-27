export default async function handler(req, res) {
  try {
    const API_KEY = process.env.TWELVE_DATA_API_KEY;

    if (!API_KEY) {
      return res.status(500).json({
        error: "TWELVE_DATA_API_KEY belum diset dalam Vercel"
      });
    }

    const base = "https://api.twelvedata.com/time_series";

    async function getData(interval, outputsize) {
      const url =
        `${base}?symbol=XAU/USD` +
        `&interval=${interval}` +
        `&outputsize=${outputsize}` +
        `&apikey=${API_KEY}`;

      const response = await fetch(url);
      const data = await response.json();

      if (!response.ok || data.status === "error") {
        throw new Error(
          `${interval}: ${data.message || "Twelve Data API error"}`
        );
      }

      return data.values || [];
    }

    // 3 API calls sahaja setiap refresh
    const [m5, m15, h1] = await Promise.all([
      getData("5min", 300),
      getData("15min", 300),
      getData("1h", 300)
    ]);

    if (!m5.length || !m15.length || !h1.length) {
      throw new Error("Data candle tidak lengkap");
    }

    return res.status(200).json({
      symbol: "XAU/USD",
      updated: new Date().toISOString(),

      current: {
        price: parseFloat(m5[0].close)
      },

      candles: {
        m5,
        m15,
        h1
      }
    });

  } catch (error) {
    console.error(error);

    return res.status(500).json({
      error: "Server error",
      message: error.message
    });
  }
}
