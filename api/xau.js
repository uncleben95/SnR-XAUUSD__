export default async function handler(req, res) {

  try {

    const API_KEY =
      process.env.TWELVE_DATA_API_KEY;

    if (!API_KEY) {

      return res.status(500).json({
        error:
          "TWELVE_DATA_API_KEY belum diset dalam Vercel"
      });

    }

    async function getCandles(interval) {

      const url =
        `https://api.twelvedata.com/time_series` +
        `?symbol=XAU/USD` +
        `&interval=${interval}` +
        `&outputsize=200` +
        `&apikey=${API_KEY}`;

      const response =
        await fetch(url);

      const data =
        await response.json();

      if (
        !response.ok ||
        data.status === "error"
      ) {

        throw new Error(
          data.message ||
          `Twelve Data error (${interval})`
        );

      }

      return data.values || [];

    }

    const [
      m5,
      m15,
      h1
    ] = await Promise.all([

      getCandles("5min"),
      getCandles("15min"),
      getCandles("1h")

    ]);

    if (
      !m5.length ||
      !m15.length ||
      !h1.length
    ) {

      return res.status(502).json({
        error:
          "Data candle tidak lengkap daripada Twelve Data"
      });

    }

    const latest =
      m5[0];

    const price =
      parseFloat(latest.close);

    return res.status(200).json({

      symbol: "XAU/USD",

      price,

      updated:
        new Date().toISOString(),

      m5,
      m15,
      h1

    });

  } catch (error) {

    console.error(
      "XAU API ERROR:",
      error
    );

    return res.status(500).json({

      error: "Server error",

      message:
        error.message

    });

  }

}
