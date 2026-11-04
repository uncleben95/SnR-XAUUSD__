export default async function handler(req,res){
  res.setHeader("Cache-Control","no-store");
  const checks={twelveData:Boolean(process.env.TWELVE_DATA_API_KEY),redisUrl:Boolean(process.env.KV_REST_API_URL),redisToken:Boolean(process.env.KV_REST_API_TOKEN),vapidSubject:Boolean(process.env.VAPID_SUBJECT),vapidPublicKey:Boolean(process.env.VAPID_PUBLIC_KEY),vapidPrivateKey:Boolean(process.env.VAPID_PRIVATE_KEY),xauCronSecret:Boolean(process.env.XAU_CRON_SECRET)};
  const missing=Object.entries(checks).filter(([,v])=>!v).map(([k])=>k);
  res.status(200).json({ok:missing.length===0,service:"SnR-XAUUSD",engine:"H1-BREAKOUT-H4-SR-V1",timestamp:new Date().toISOString(),checks,missing,note:"Configuration presence only."});
}
