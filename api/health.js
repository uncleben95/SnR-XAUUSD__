export default function handler(req,res){
  res.setHeader("Cache-Control","no-store");
  return res.status(200).json({
    ok:true,
    service:"xauusd-scalp-engine",
    engine:"XAUUSD-SCALP-V4",
    time:new Date().toISOString()
  });
}
