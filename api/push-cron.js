// Background trigger for Web Push.
// Vercel Cron -> /api/push-cron -> /api/scalp
// This runs independently from the dashboard/browser.

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({
      ok: false,
      error: "Method not allowed"
    });
  }

  try {
    // Vercel Cron sends:
    // Authorization: Bearer <CRON_SECRET>
    const cronSecret = process.env.CRON_SECRET;

    if (cronSecret) {
      const auth = req.headers.authorization || "";

      if (auth !== `Bearer ${cronSecret}`) {
        return res.status(401).json({
          ok: false,
          error: "Unauthorized"
        });
      }
    } else {
      // Fallback for manual/external triggering
      const pushSecret = process.env.PUSH_CRON_SECRET;
      const supplied = req.headers["x-push-cron-secret"];

      if (!pushSecret || supplied !== pushSecret) {
        return res.status(401).json({
          ok: false,
          error: "Unauthorized"
        });
      }
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
        "cache-control": "no-cache",
        "x-push-cron": "1"
      }
    });

    const text = await r.text();

    let data;

    try {
      data = JSON.parse(text);
    } catch {
      data = {
        ok: false,
        error: "Invalid JSON from /api/scalp",
        raw: text.slice(0, 500)
      };
    }

    console.log("push-cron result:", {
      status: r.status,
      ok: r.ok,
      signal: data?.signal,
      signalKey: data?.signalKey,
      push: data?.push
    });

    return res.status(r.status).json({
      ok: r.ok && data?.ok !== false,
      triggered: true,
      signal: data?.signal || "WAIT",
      signalKey: data?.signalKey || null,
      score: data?.score ?? null,
      push: data?.push || null,
      pushEngine: "api/scalp",
      source: "VERCEL_CRON"
    });

  } catch (e) {
    console.error("push-cron:", e);

    return res.status(502).json({
      ok: false,
      triggered: false,
      error: e?.message || "Cron trigger failed"
    });
  }
}
