export default async function handler(req, res) {

  try {

    // =====================================================
    // SECURITY
    // =====================================================

    const cronSecret = process.env.CRON_SECRET;

    if (
      cronSecret &&
      req.headers.authorization !==
        `Bearer ${cronSecret}`
    ) {
      return res.status(401).json({
        ok: false,
        error: "Unauthorized"
      });
    }

    // =====================================================
    // BASE URL
    // =====================================================

    const baseUrl =
      process.env.VERCEL_URL
        ? `https://${process.env.VERCEL_URL}`
        : `http://localhost:${process.env.PORT || 3000}`;

    // =====================================================
    // CALL /api/scalp
    // =====================================================

    const scalpResponse = await fetch(
      `${baseUrl}/api/scalp?t=${Date.now()}`,
      {
        method: "GET",
        cache: "no-store",
        headers: {
          "Cache-Control": "no-cache",
          "Accept": "application/json"
        }
      }
    );

    const scalpText =
      await scalpResponse.text();

    let data;

    try {

      data =
        JSON.parse(scalpText);

    } catch {

      console.error(
        "SCALP RETURNED NON-JSON:",
        scalpText.slice(0, 500)
      );

      return res.status(502).json({
        ok: false,
        error:
          `SCALP returned non-JSON HTTP ${scalpResponse.status}`,
        preview:
          scalpText.slice(0, 200)
      });
    }

    if (!scalpResponse.ok) {

      return res.status(502).json({
        ok: false,
        error:
          `SCALP HTTP ${scalpResponse.status}`,
        scalp: data
      });
    }

    if (!data.ok) {

      return res.status(502).json({
        ok: false,
        error:
          data.error ||
          "SCALP ERROR",
        scalp: data
      });
    }

    // =====================================================
    // ONLY REAL ENTRY
    // =====================================================

    const isEntry =
      data.status === "ENTRY" &&
      (
        data.signal === "BUY" ||
        data.signal === "SELL"
      );

    if (!isEntry) {

      return res.status(200).json({

        ok: true,

        sent: false,

        status:
          data.status,

        signal:
          data.signal,

        score:
          data.score,

        price:
          data.price,

        reason:
          "No ENTRY signal",

        timestamp:
          new Date().toISOString()
      });
    }

    // =====================================================
    // DUPLICATE PROTECTION
    // =====================================================

    const signalKey =
      [
        data.signal,
        data.setupType,
        data.price,
        data.timestamp
      ].join("-");

    const lastSignal =
      globalThis.__LAST_XAU_CRON_SIGNAL__;

    if (
      lastSignal === signalKey
    ) {

      return res.status(200).json({

        ok: true,

        sent: false,

        duplicate: true,

        signal:
          data.signal,

        price:
          data.price
      });
    }

    // =====================================================
    // SEND PUSH
    // =====================================================

    const pushResponse =
      await fetch(
        `${baseUrl}/api/push-send`,
        {
          method: "POST",

          headers: {
            "Content-Type":
              "application/json",

            "Accept":
              "application/json"
          },

          body:
            JSON.stringify({

              title:
                `XAU/USD ${data.signal} 🚨`,

              body:
                `${data.setupType} • ` +
                `Score ${data.score} • ` +
                `Entry ${Number(
                  data.price
                ).toFixed(2)}`
            })
        }
      );

    const pushText =
      await pushResponse.text();

    let pushData;

    try {

      pushData =
        JSON.parse(pushText);

    } catch {

      return res.status(502).json({

        ok: false,

        error:
          `PUSH returned non-JSON HTTP ${pushResponse.status}`,

        preview:
          pushText.slice(0, 200)
      });
    }

    if (!pushResponse.ok) {

      return res.status(502).json({

        ok: false,

        signal:
          data.signal,

        push:
          pushData
      });
    }

    // =====================================================
    // SAVE LAST SIGNAL
    // =====================================================

    globalThis.__LAST_XAU_CRON_SIGNAL__ =
      signalKey;

    // =====================================================
    // DONE
    // =====================================================

    return res.status(200).json({

      ok: true,

      sent: true,

      signal:
        data.signal,

      status:
        data.status,

      setupType:
        data.setupType,

      signalType:
        data.signalType,

      execution:
        data.execution,

      score:
        data.score,

      context:
        data.context,

      price:
        data.price,

      tradePlan:
        data.tradePlan,

      push:
        pushData,

      timestamp:
        new Date().toISOString()
    });

  } catch (error) {

    console.error(
      "XAU CRON ERROR:",
      error
    );

    return res.status(500).json({

      ok: false,

      error:
        error.message ||
        "CRON ERROR"
    });
  }
}
