export default async function handler(req, res) {
  try {
    const BASE_URL = "https://sn-r-xauusd-tau.vercel.app";

    // =========================
    // CALL /api/scalp
    // =========================

    const scalpResponse = await fetch(
      `${BASE_URL}/api/scalp?t=${Date.now()}`,
      {
        method: "GET",
        cache: "no-store",
        headers: {
          Accept: "application/json",
          "Cache-Control": "no-cache"
        }
      }
    );

    const scalpText = await scalpResponse.text();

    let data;

    try {
      data = JSON.parse(scalpText);
    } catch {
      return res.status(502).json({
        ok: false,
        error: `SCALP returned non-JSON HTTP ${scalpResponse.status}`,
        preview: scalpText.slice(0, 300)
      });
    }

    if (!scalpResponse.ok || !data.ok) {
      return res.status(502).json({
        ok: false,
        error: data.error || `SCALP HTTP ${scalpResponse.status}`,
        scalp: data
      });
    }

    // =========================
    // ONLY REAL ENTRY
    // =========================

    const isEntry =
      data.status === "ENTRY" &&
      (data.signal === "BUY" || data.signal === "SELL");

    if (!isEntry) {
      return res.status(200).json({
        ok: true,
        sent: false,
        status: data.status,
        signal: data.signal,
        score: data.score,
        price: data.price,
        reason: "No ENTRY signal",
        timestamp: new Date().toISOString()
      });
    }

    // =========================
    // DUPLICATE PROTECTION
    // =========================

    const signalKey = [
      data.signal,
      data.setupType,
      data.price
    ].join("-");

    if (
      globalThis.__LAST_XAU_CRON_SIGNAL__ === signalKey
    ) {
      return res.status(200).json({
        ok: true,
        sent: false,
        duplicate: true,
        signal: data.signal,
        price: data.price
      });
    }

    // =========================
    // SEND PUSH
    // =========================

    const pushResponse = await fetch(
      `${BASE_URL}/api/push-send`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json"
        },
        body: JSON.stringify({
          title: `XAU/USD ${data.signal} 🚨`,
          body:
            `${data.setupType} • ` +
            `Score ${data.score} • ` +
            `Entry ${Number(data.price).toFixed(2)}`
        })
      }
    );

    const pushText = await pushResponse.text();

    let pushData;

    try {
      pushData = JSON.parse(pushText);
    } catch {
      return res.status(502).json({
        ok: false,
        error:
          `PUSH returned non-JSON HTTP ${pushResponse.status}`,
        preview: pushText.slice(0, 300)
      });
    }

    if (!pushResponse.ok) {
      return res.status(502).json({
        ok: false,
        signal: data.signal,
        push: pushData
      });
    }

    // Save only after successful push
    globalThis.__LAST_XAU_CRON_SIGNAL__ = signalKey;

    // =========================
    // DONE
    // =========================

    return res.status(200).json({
      ok: true,
      sent: true,
      signal: data.signal,
      status: data.status,
      setupType: data.setupType,
      signalType: data.signalType,
      execution: data.execution,
      score: data.score,
      context: data.context,
      price: data.price,
      tradePlan: data.tradePlan,
      push: pushData,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error("XAU CRON ERROR:", error);

    return res.status(500).json({
      ok: false,
      error: error.message || "CRON ERROR"
    });
  }
}
