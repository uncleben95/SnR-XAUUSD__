// Background trigger for Web Push.
// /api/scalp already contains the signal engine + automatic push.
// This endpoint simply forces /api/scalp to run without the dashboard being open.
export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ ok:false, error:"Method not allowed" });

  const secret = process.env.PUSH_CRON_SECRET;
  const supplied = req.headers["x-push-cron-secret"];
  if (!secret || supplied !== secret) {
    return res.status(401).json({ ok:false, error:"Unauthorized" });
  }

  try {
    const base = process.env.XAU_APP_URL;
    if (!base) return res.status(500).json({ ok:false, error:"XAU_APP_URL belum diset" });

    const r = await fetch(`${base.replace(/\/$/,"")}/api/scalp?cron=${Date.now()}`, {
      headers: { "cache-control":"no-cache" }
    });
    const data = await r.json();

    return res.status(r.status).json({
      ok: r.ok && data?.ok !== false,
      triggered: true,
      signal: data?.signal || "WAIT",
      signalKey: data?.signalKey || null,
      score: data?.score ?? null,
      pushEngine: "api/scalp"
    });
  } catch (e) {
    console.error("push-cron:", e);
    return res.status(502).json({ ok:false, error:e.message || "Cron trigger failed" });
  }
}
