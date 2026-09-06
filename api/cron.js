export default async function handler(req, res) {
  try {
    // ============================================
    // CRON SECURITY
    // ============================================

    const cronSecret = process.env.CRON_SECRET;

    if (
      cronSecret &&
      req.headers.authorization !== `Bearer ${cronSecret}`
    ) {
      return res.status(401).json({
        ok: false,
        error: "Unauthorized"
      });
    }

    // ============================================
    // PRODUCTION URL
    // ============================================

    const baseUrl = process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : null;

    if (!baseUrl) {
      return res.status(500).json({
        ok: false,
        error: "VERCEL_URL tidak tersedia"
      });
    }

    // ============================================
    // CALL /api/scalp
    // ============================================

    const scalpResponse = await fetch(
      `${baseUrl}/api/scalp?t=${Date.now()}`,
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

    const scalpContentType =
      scalpResponse.headers.get("content-type") || "";

    // ============================================
    // SCALP MUST RETURN JSON
    // ============================================

    if (
      !scalpContentType.includes("application/json")
    ) {
      return res.status(502).json({
        ok: false,
        error: "SCALP returned non-JSON",
        httpStatus: scalpResponse.status,
        contentType: scalpContentType,
        preview: scalpText.slice(0, 300)
      });
    }

    let data;

    try {
      data = JSON.parse(scalpText);
    } catch {
      return res.status(502).json({
        ok: false,
        error: "SCALP JSON parse failed",
        httpStatus: scalpResponse.status,
        preview: scalpText.slice(0, 300)
      });
    }

    // ============================================
    // SCALP ERROR
    // ============================================

    if (!scalpResponse.ok || !data.ok) {
      return res.status(502).json({
        ok: false,
        error:
          data.error ||
          `SCALP HTTP ${scalpResponse.status}`,
        scalp: data
      });
    }

    // ============================================
    // ONLY REAL ENTRY
    // ============================================

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

        setupType:
          data.setupType,

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

    // ============================================
    // DUPLICATE PROTECTION
    // ============================================

    const signalKey = [
      data.signal,
      data.setupType,
      data.price
    ].join("-");

    if (
      globalThis.__LAST_XAU_CRON_SIGNAL__ ===
      signalKey
    ) {
      return res.status(200).json({
        ok: true,
        sent: false,
        duplicate: true,

        signal:
          data.signal,

        setupType:
          data.setupType,

        price:
          data.price
      });
    }

    // ============================================
    // SEND PUSH
    // ============================================

    const pushResponse = await fetch(
      `${baseUrl}/api/push-send`,
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/json",

          Accept:
            "application/json"
        },

        body: JSON.stringify({

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

    const pushContentType =
      pushResponse.headers.get(
        "content-type"
      ) || "";

    // ============================================
    // PUSH MUST RETURN JSON
    // ============================================

    if (
      !pushContentType.includes(
        "application/json"
      )
    ) {
      return res.status(502).json({
        ok: false,

        error:
          "PUSH returned non-JSON",

        httpStatus:
          pushResponse.status,

        contentType:
          pushContentType,

        preview:
          pushText.slice(0, 300)
      });
    }

    let pushData;

    try {
      pushData =
        JSON.parse(pushText);
    } catch {
      return res.status(502).json({
        ok: false,

        error:
          "PUSH JSON parse failed",

        httpStatus:
          pushResponse.status,

        preview:
          pushText.slice(0, 300)
      });
    }

    // ============================================
    // PUSH ERROR
    // ============================================

    if (!pushResponse.ok) {
      return res.status(502).json({
        ok: false,

        sent: false,

        signal:
          data.signal,

        push:
          pushData
      });
    }

    // ============================================
    // SAVE LAST SIGNAL
    // ============================================

    globalThis.__LAST_XAU_CRON_SIGNAL__ =
      signalKey;

    // ============================================
    // SUCCESS
    // ============================================

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
