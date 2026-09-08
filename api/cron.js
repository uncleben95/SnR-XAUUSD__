export default async function handler(req, res) {
  try {
    const base =
      process.env.VERCEL_URL
        ? `https://${process.env.VERCEL_URL}`
        : `https://${req.headers.host}`;

    const response = await fetch(
      `${base}/api/scalp?cron=1&ts=${Date.now()}`,
      {
        method: "GET",
        headers: {
          "x-cron-internal": "XAU-SCALP-CRON"
        },
        cache: "no-store"
      }
    );

    const text = await response.text();

    return res.status(response.status).send(text);

  } catch (error) {

    console.error("CRON ERROR:", error);

    return res.status(500).json({
      ok: false,
      error: error?.message || "Cron failed"
    });
  }
}
