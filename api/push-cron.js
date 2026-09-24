// Background trigger for Web Push.
// GitHub Actions / Vercel Cron -> /api/push-cron -> /api/scalp

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({
      ok: false,
      error: "Method not allowed"
    });
  }

  try {
    const secret = process.env.CRON_SECRET;

    if (!secret) {
      return res.status(500).json({
        ok: false,
        error: "CRON_SECRET belum diset"
      });
    }

    // Accept GitHub Actions header
    const suppliedHeader = req.headers["x-push-cron-secret"];

    // Also accept Vercel-style Authorization header
    const authorization = req.headers.authorization || "";
    const suppliedBearer = authorization.startsWith("Bearer ")
      ? authorization.slice(7)
      : "";

    const supplied = suppliedHeader || suppliedBearer;

    if (!supplied || supplied !== secret) {
      return res.status(401).json({
        ok: false,
        error: "Unauthorized"
      });
    }

    const base = process.env.XAU_APP_URL;

    if (!base) {
      return res.status(500).json({
        ok: false,
        error: "XAU_APP_URL belum diset"
      });
    }

    const url =
      `${base.replace(/\/$/, "")}/api/scalp?cron=${Date.now()}`;

    const r = await fetch(url, {
      method: "GET",
      headers: {
        "cache-control": "no-cache"
      }
    });

    const data = await r.json();

    return res.status(r.status).json({
      ok: r.ok && data?.ok !== false,
      triggered: true,
      signal: data?.signal || "WAIT",
      signalKey: data?.signalKey || null,
      score: data?.score ?? null,
      pushEngine: "api/scalp",
      source: "BACKGROUND"
    });

  } catch (e) {
    console.error("push-cron:", e);

    return res.status(502).json({
      ok: false,
      error: e.message || "Cron trigger failed"
    });
  }
}
