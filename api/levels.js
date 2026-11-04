// H4 support/resistance endpoint used by the H1 breakout dashboard.
export default async function handler(req,res){
  if(req.method!=="GET") return res.status(405).json({ok:false,error:"Method not allowed"});
  const key=process.env.TWELVE_DATA_API_KEY;
  if(!key) return res.status(500).json({ok:false,error:"TWELVE_DATA_API_KEY is not configured"});
  try{
    const symbol="XAU/USD";
    const [s,p]=await Promise.all([
      fetch(`https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}&interval=4h&outputsize=220&apikey=${key}`,{signal:AbortSignal.timeout(12000)}).then(r=>r.json()),
      fetch(`https://api.twelvedata.com/price?symbol=${encodeURIComponent(symbol)}&apikey=${key}`,{signal:AbortSignal.timeout(12000)}).then(r=>r.json())
    ]);
    if(s.status==="error"||p.status==="error") throw new Error(s.message||p.message||"Provider error");
    const price=Number(p.price), d=(s.values||[]).reverse().map(x=>({time:x.datetime,high:+x.high,low:+x.low})).filter(x=>Number.isFinite(x.high)&&Number.isFinite(x.low)).slice(0,-1);
    const supports=[],resistances=[];
    for(let i=2;i<d.length-2;i++){
      const x=d[i],l=d.slice(i-2,i),r=d.slice(i+1,i+3);
      if(x.low<=Math.min(...l.map(z=>z.low),...r.map(z=>z.low))&&x.low<price)supports.push({price:x.low,time:x.time,timeframe:"H4",kind:"swing-low"});
      if(x.high>=Math.max(...l.map(z=>z.high),...r.map(z=>z.high))&&x.high>price)resistances.push({price:x.high,time:x.time,timeframe:"H4",kind:"swing-high"});
    }
    supports.sort((a,b)=>b.price-a.price);resistances.sort((a,b)=>a.price-b.price);
    res.status(200).json({ok:true,symbol,price,nearestSupport:supports[0]||null,nearestResistance:resistances[0]||null,supports:supports.slice(0,8),resistances:resistances.slice(0,8),timestamp:new Date().toISOString()});
  }catch(e){res.status(502).json({ok:false,error:e.message||"Levels error"});}
}
