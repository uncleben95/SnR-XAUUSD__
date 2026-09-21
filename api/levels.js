// XAU/USD support/resistance + ADX helper endpoint.
// Uses the same Twelve Data key as scalp.js.
export default async function handler(req, res) {
  const key = process.env.TWELVE_DATA_API_KEY;
  if (!key) return res.status(500).json({ok:false,error:"TWELVE_DATA_API_KEY belum diset"});

  const symbol = "XAU/USD";
  const fetchSeries = async (interval, outputsize) => {
    const u = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}&interval=${interval}&outputsize=${outputsize}&apikey=${key}`;
    const r = await fetch(u);
    const j = await r.json();
    if (!r.ok || j.status === "error") throw new Error(j.message || `Twelve Data ${interval} error`);
    return (j.values||[]).reverse().map(x=>({
      time:x.datetime, open:+x.open, high:+x.high, low:+x.low, close:+x.close
    })).filter(x=>[x.open,x.high,x.low,x.close].every(Number.isFinite));
  };

  const atr = (d,p=14) => {
    if(d.length<p+1) return null;
    const tr=[];
    for(let i=1;i<d.length;i++){
      const c=d[i], pc=d[i-1].close;
      tr.push(Math.max(c.high-c.low,Math.abs(c.high-pc),Math.abs(c.low-pc)));
    }
    return tr.slice(-p).reduce((a,b)=>a+b,0)/p;
  };

  const adx = (d,p=14) => {
    if(d.length < p*2+1) return null;
    const tr=[], plus=[], minus=[];
    for(let i=1;i<d.length;i++){
      const c=d[i], q=d[i-1];
      tr.push(Math.max(c.high-c.low,Math.abs(c.high-q.close),Math.abs(c.low-q.close)));
      const up=c.high-q.high, dn=q.low-c.low;
      plus.push(up>dn && up>0 ? up : 0);
      minus.push(dn>up && dn>0 ? dn : 0);
    }
    const out=[];
    for(let i=p-1;i<tr.length;i++){
      const T=tr.slice(i-p+1,i+1).reduce((a,b)=>a+b,0);
      const P=plus.slice(i-p+1,i+1).reduce((a,b)=>a+b,0);
      const M=minus.slice(i-p+1,i+1).reduce((a,b)=>a+b,0);
      const pdi=T?100*P/T:0, mdi=T?100*M/T:0;
      const dx=(pdi+mdi)?100*Math.abs(pdi-mdi)/(pdi+mdi):0;
      out.push(dx);
    }
    return out.length>=p ? out.slice(-p).reduce((a,b)=>a+b,0)/p : null;
  };

  const levels = (data, price) => {
    const candidates = [];
    const push = (price0,type,tf,kind) => {
      if(!Number.isFinite(price0)) return;
      if(type==="support" && price0 < price) candidates.push({price:price0,timeframe:tf,kind});
      if(type==="resistance" && price0 > price) candidates.push({price:price0,timeframe:tf,kind});
    };

    // Swing levels: local highs/lows + recent range boundaries.
    for(let i=2;i<data.length-2;i++){
      const x=data[i];
      const left=data.slice(i-2,i), right=data.slice(i+1,i+3);
      if(x.high>=Math.max(...left.map(a=>a.high),...right.map(a=>a.high))) push(x.high,"resistance","TF","swing-high");
      if(x.low<=Math.min(...left.map(a=>a.low),...right.map(a=>a.low))) push(x.low,"support","TF","swing-low");
    }

    const rawS=candidates.filter(x=>x.price<price).sort((a,b)=>b.price-a.price);
    const rawR=candidates.filter(x=>x.price>price).sort((a,b)=>a.price-b.price);

    // Cluster nearby levels (0.15%).
    const cluster = arr => {
      const out=[];
      for(const x of arr){
        const hit=out.find(y=>Math.abs(y.price-x.price)/x.price < 0.0015);
        if(hit){ hit.price=(hit.price+x.price)/2; hit.touches++; }
        else out.push({...x,touches:1});
      }
      return out;
    };
    return {supports:cluster(rawS).slice(0,5),resistances:cluster(rawR).slice(0,5)};
  };

  try {
    const [m5,m15,h1,pr] = await Promise.all([
      fetchSeries("5min",300),
      fetchSeries("15min",300),
      fetchSeries("1h",200),
      fetch(`https://api.twelvedata.com/price?symbol=${encodeURIComponent(symbol)}&apikey=${key}`).then(r=>r.json())
    ]);
    const price=Number(pr?.price);
    if(!Number.isFinite(price)) throw new Error("Live price unavailable");

    const s5=levels(m5,price), s15=levels(m15,price), s1=levels(h1,price);
    const allS=[...s5.supports.map(x=>({...x,timeframe:"M5"})),...s15.supports.map(x=>({...x,timeframe:"M15"})),...s1.supports.map(x=>({...x,timeframe:"H1"}))];
    const allR=[...s5.resistances.map(x=>({...x,timeframe:"M5"})),...s15.resistances.map(x=>({...x,timeframe:"M15"})),...s1.resistances.map(x=>({...x,timeframe:"H1"}))];

    const supports=allS.sort((a,b)=>b.price-a.price);
    const resistances=allR.sort((a,b)=>a.price-b.price);

    return res.status(200).json({
      ok:true, symbol, price,
      nearestSupport:supports[0]||null,
      nearestResistance:resistances[0]||null,
      supports:supports.slice(0,6),
      resistances:resistances.slice(0,6),
      adx:{
        m5:adx(m5), m15:adx(m15), h1:adx(h1)
      },
      atr:{m5:atr(m5),m15:atr(m15),h1:atr(h1)},
      timestamp:new Date().toISOString()
    });
  } catch(e) {
    console.error("levels:",e);
    return res.status(502).json({ok:false,error:e.message||"Levels error"});
  }
}
