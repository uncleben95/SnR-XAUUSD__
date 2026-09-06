export default async function handler(req, res) {

  try {

    // =====================================================
    // SECURITY
    // =====================================================

    const cronSecret =
      process.env.CRON_SECRET;

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
    // CALL V10 SCALP ENGINE
    // =====================================================

    const baseUrl =
      process.env.VERCEL_URL
        ? `https://${process.env.VERCEL_URL}`
        : "http://localhost:3000";

    const response =
      await fetch(
        `${baseUrl}/api/scalp`,
        {
          method: "GET",
          cache: "no-store"
        }
      );

    if (!response.ok) {
      throw new Error(
        `SCALP HTTP ${response.status}`
      );
    }

    const data =
      await response.json();

    if (!data.ok) {
      throw new Error(
        data.error ||
        "SCALP ERROR"
      );
    }

    // =====================================================
    // ONLY SEND REAL ENTRY
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
        status: data.status,
        signal: data.signal,
        reason: "No ENTRY signal"
      });

    }

    // =====================================================
    // PREVENT DUPLICATE ALERT
    // =====================================================

    const signalKey =
      `${data.signal}-${data.setupType}-${data.price}`;

    const lastSignal =
      globalThis.__LAST_XAU_CRON_SIGNAL__;

    if (
      lastSignal === signalKey
    ) {

      return res.status(200).json({
        ok: true,
        sent: false,
        duplicate: true,
        signal: data.signal
      });

    }

    globalThis.__LAST_XAU_CRON_SIGNAL__ =
      signalKey;

    // =====================================================
    // PUSH
    // =====================================================

    const pushResponse =
      await fetch(
        `${baseUrl}/api/push-send`,
        {
          method: "POST",

          headers: {
            "Content-Type":
              "application/json"
          },

          body: JSON.stringify({

            title:
              `XAU/USD ${data.signal} 🚨`,

            body:
              `${data.setupType} • ` +
              `Score ${data.score} • ` +
              `Entry ${Number(data.price).toFixed(2)}`
          })
        }
      );

    const pushData =
      await pushResponse.json();

    if (!pushResponse.ok) {

      return res.status(502).json({
        ok: false,
        signal: data.signal,
        push: pushData
      });

    }

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

      score:
        data.score,

      price:
        data.price,

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
