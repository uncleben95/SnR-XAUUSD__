export default async function handler(req, res) {
  const started = Date.now();

  try {
    // =========================================================
    // 1. CHECK API KEY
    // =========================================================

    const API_KEY = process.env.TWELVE_DATA_API_KEY;

    if (!API_KEY) {
      return res.status(500).json({
        ok: false,
        error: "TWELVE_DATA_API_KEY belum diset dalam Vercel"
      });
    }

    // =========================================================
    // 2. TWELVE DATA REQUEST
    // =========================================================

    const url = new URL(
      "https://api.twelvedata.com/time_series"
    );

    url.searchParams.set("symbol", "XAU/USD");
    url.searchParams.set("interval", "5min");
    url.searchParams.set("outputsize", "3000");
    url.searchParams.set("order", "ASC");
    url.searchParams.set("apikey", API_KEY);

    // Timeout supaya API tak tergantung terlalu lama
    const controller = new AbortController();

    const timeout = setTimeout(() => {
      controller.abort();
    }, 12000);

    let response;
    let data;

    try {
      response = await fetch(url, {
        method: "GET",
        cache: "no-store",
        signal: controller.signal,
        headers: {
          Accept: "application/json"
        }
      });

      const text = await response.text();

      // Pastikan response memang JSON
      try {
        data = JSON.parse(text);
      } catch {
        return res.status(502).json({
          ok: false,
          error: "Twelve Data pulangkan response bukan JSON"
        });
      }

    } catch (error) {

      if (error?.name === "AbortError") {
        return res.status(504).json({
          ok: false,
          error: "Twelve Data timeout selepas 12 saat"
        });
      }

      return res.status(502).json({
        ok: false,
        error: "Gagal sambung ke Twelve Data",
        message:
          error?.message ||
          "Unknown network error"
      });

    } finally {

      clearTimeout(timeout);

    }

    // =========================================================
    // 3. TWELVE DATA ERROR
    // =========================================================

    if (
      !response.ok ||
      data?.status === "error"
    ) {
      return res.status(502).json({
        ok: false,

        error:
          data?.message ||
          "Twelve Data API error",

        code:
          data?.code ||
          response.status
      });
    }

    // =========================================================
    // 4. CHECK CANDLE DATA
    // =========================================================

    if (
      !Array.isArray(data?.values) ||
      data.values.length === 0
    ) {
      return res.status(502).json({
        ok: false,
        error:
          "Twelve Data tidak pulangkan candle XAU/USD"
      });
    }

    // =========================================================
    // 5. NORMALIZE CANDLE
    // =========================================================

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

      // -------------------------------------------------------
      // Buang candle rosak
      // -------------------------------------------------------

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

      // -------------------------------------------------------
      // Pastikan oldest → newest
      // -------------------------------------------------------

      .sort(
        (a, b) =>
          new Date(a.datetime).getTime() -
          new Date(b.datetime).getTime()
      );

    // =========================================================
    // 6. CHECK MINIMUM DATA
    // =========================================================

    if (values.length < 250) {

      return res.status(502).json({
        ok: false,

        error:
          "Candle XAU/USD tidak mencukupi",

        count:
          values.length
      });

    }

    // =========================================================
    // 7. LAST CANDLE
    // =========================================================

    const last =
      values[values.length - 1];

    // =========================================================
    // 8. CACHE CONTROL
    // =========================================================

    res.setHeader(
      "Cache-Control",
      "no-store, max-age=0, must-revalidate"
    );

    res.setHeader(
      "Content-Type",
      "application/json; charset=utf-8"
    );

    // =========================================================
    // 9. RESPONSE
    // =========================================================

    return res.status(200).json({

      ok: true,

      symbol:
        "XAU/USD",

      interval:
        "5min",

      updated:
        new Date().toISOString(),

      responseMs:
        Date.now() - started,

      count:
        values.length,

      lastPrice:
        last.close,

      lastCandleTime:
        last.datetime,

      values

    });

  } catch (error) {

    console.error(
      "XAU API ERROR:",
      error
    );

    return res.status(500).json({

      ok: false,

      error:
        "Server error",

      message:
        error?.message ||
        "Unknown error"

    });

  }
}
