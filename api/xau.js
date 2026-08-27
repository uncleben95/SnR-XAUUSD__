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

    /*
      Pilih timeframe melalui:
      /api/xau?interval=5min
      /api/xau?interval=15min
      /api/xau?interval=1h

      Default = 5min
    */

    const requestedInterval =
      req.query?.interval || "5min";

    const allowedIntervals = [
      "5min",
      "15min",
      "1h"
    ];

    const interval =
      allowedIntervals.includes(
        requestedInterval
      )
        ? requestedInterval
        : "5min";

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

      return res.status(502).json({

        error:
          data.message ||
          "Twelve Data API error",

        interval

      });

    }

    const values =
      data.values || [];

    if (!values.length) {

      return res.status(502).json({

        error:
          "Twelve Data tidak pulangkan candle",

        interval

      });

    }

    const latest =
      values[0];

    const price =
      parseFloat(latest.close);

    return res.status(200).json({

      symbol: "XAU/USD",

      interval,

      price,

      updated:
        new Date().toISOString(),

      candleUpdated:
        latest.datetime,

      values

    });

  } catch (error) {

    console.error(
      "XAU API ERROR:",
      error
    );

    return res.status(500).json({

      error:
        "Server error",

      message:
        error.message

    });

  }

}
