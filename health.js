export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const checks = {
    twelveData: Boolean(process.env.TWELVE_DATA_API_KEY),
    redisUrl: Boolean(process.env.KV_REST_API_URL),
    redisToken: Boolean(process.env.KV_REST_API_TOKEN),
    vapidSubject: Boolean(process.env.VAPID_SUBJECT),
    vapidPublicKey: Boolean(process.env.VAPID_PUBLIC_KEY),
    vapidPrivateKey: Boolean(process.env.VAPID_PRIVATE_KEY),
    xauCronSecret: Boolean(process.env.XAU_CRON_SECRET)
  };
  const required = ["twelveData", "redisUrl", "redisToken", "vapidSubject", "vapidPublicKey", "vapidPrivateKey", "xauCronSecret"];
  const missing = required.filter(key => !checks[key]);
  return res.status(200).json({
    ok: missing.length === 0,
    service: "SnR-XAUUSD",
    engine: "V18-SCALP-SR-V3-REGIME",
    timestamp: new Date().toISOString(),
    checks,
    missing,
    note: "Configuration presence only. This endpoint does not test Twelve Data quota, Redis connectivity, or actual push delivery. No secret values are returned."
  });
}
