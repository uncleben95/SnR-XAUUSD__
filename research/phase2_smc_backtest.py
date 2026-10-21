#!/usr/bin/env python3
"""
XAUUSD Phase 2 SMC research backtester.
Input CSV: whitespace-delimited date time open high low close volume (as supplied).
No look-ahead in signal construction: all M15 signals use closed bars and prior rolling levels.
Session times default to UTC; change --timezone-offset-hours if CSV timestamps are broker-local.
"""
import argparse, json
from pathlib import Path
import pandas as pd
import numpy as np

def load_data(path):
    df = pd.read_csv(path, sep=r"\s+", header=None,
                     names=["date","time","open","high","low","close","volume"])
    df["dt"] = pd.to_datetime(df["date"]+" "+df["time"], errors="coerce")
    for c in ["open","high","low","close","volume"]:
        df[c] = pd.to_numeric(df[c], errors="coerce")
    df = df.dropna(subset=["dt","open","high","low","close"]).sort_values("dt")
    df = df.drop_duplicates("dt").set_index("dt")
    df = df[(df.high >= df[["open","close","low"]].max(axis=1)) &
            (df.low <= df[["open","close","high"]].min(axis=1))]
    return df

def ohlc_resample(df, rule):
    return df.resample(rule, label="right", closed="right").agg(
        {"open":"first","high":"max","low":"min","close":"last","volume":"sum"}).dropna(subset=["open","high","low","close"])

def backtest(df, offset=0, rr=1.5, risk_buffer=0.0, spread=0.30, min_gap=0.20,
             sweep_lookback=12, structure_lookback=5, range_lookback=40):
    # Shift timestamps to UTC for session filter; user can adjust offset.
    m5=df.copy()
    m5.index = m5.index - pd.Timedelta(hours=offset)
    m15=ohlc_resample(m5,"15min")
    h1=ohlc_resample(m5,"1h")
    # Prior-only liquidity pools. Rolling excludes current candle.
    m15["prior_hi"]=m15.high.shift(1).rolling(sweep_lookback).max()
    m15["prior_lo"]=m15.low.shift(1).rolling(sweep_lookback).min()
    m15["struct_hi"]=m15.high.shift(1).rolling(structure_lookback).max()
    m15["struct_lo"]=m15.low.shift(1).rolling(structure_lookback).min()
    m15["range_hi"]=m15.high.shift(1).rolling(range_lookback).max()
    m15["range_lo"]=m15.low.shift(1).rolling(range_lookback).min()
    # H1 liquidity sweep context (prior 8 completed H1 bars)
    h1["prior_hi"]=h1.high.shift(1).rolling(8).max()
    h1["prior_lo"]=h1.low.shift(1).rolling(8).min()
    h1["sweep_hi"]=(h1.high>h1.prior_hi)&(h1.close<h1.prior_hi)
    h1["sweep_lo"]=(h1.low<h1.prior_lo)&(h1.close>h1.prior_lo)
    # H1 flags only become available after the H1 candle closes.
    h1flags=h1[["sweep_hi","sweep_lo"]].copy()
    # A completed H1 sweep remains valid context for the next four hours.
    h1flags["sweep_hi"]=h1flags.sweep_hi.rolling(4,min_periods=1).max().astype(bool)
    h1flags["sweep_lo"]=h1flags.sweep_lo.rolling(4,min_periods=1).max().astype(bool)
    m15["h1_sweep_hi"]=h1flags.sweep_hi.reindex(m15.index,method="ffill").fillna(False).astype(bool)
    m15["h1_sweep_lo"]=h1flags.sweep_lo.reindex(m15.index,method="ffill").fillna(False).astype(bool)
    # Three-candle FVG; displacement is required to exceed min_gap and body >= 55% range.
    m15["bull_fvg"]=(m15.low > m15.high.shift(2)) & ((m15.low-m15.high.shift(2))>=min_gap) & ((m15.close-m15.open).abs() >= (m15.high-m15.low)*0.55) & (m15.close>m15.open)
    m15["bear_fvg"]=(m15.high < m15.low.shift(2)) & ((m15.low.shift(2)-m15.high)>=min_gap) & ((m15.close-m15.open).abs() >= (m15.high-m15.low)*0.55) & (m15.close<m15.open)
    m15["bull_top"]=m15.low
    m15["bull_bottom"]=m15.high.shift(2)
    m15["bear_top"]=m15.low.shift(2)
    m15["bear_bottom"]=m15.high
    # Session filter UTC: London 07-11 and New York 13-17. Strict hours.
    trades=[]
    # State machine: sweep -> CHOCH -> BOS with FVG -> retracement; independently per side.
    states={"BUY":None,"SELL":None}
    # Map M5 bars to each completed M15 close. Entries execute only after the signal M15 closes.
    m5_groups={t:g for t,g in m5.groupby(pd.Grouper(freq="15min",label="right",closed="right"))}
    m5idx=m5.index
    for t,row in m15.iterrows():
        if pd.isna(row.prior_hi) or pd.isna(row.range_hi): continue
        hour=t.hour
        if not (7<=hour<11 or 13<=hour<17): continue
        # Update independent state machines.
        for side in ("BUY","SELL"):
            bullish=side=="BUY"
            sweep=(row.low<row.prior_lo and row.close>row.prior_lo)
            if not bullish: sweep=(row.high>row.prior_hi and row.close<row.prior_hi)
            h1ok=bool(row.h1_sweep_lo if bullish else row.h1_sweep_hi)
            if states[side] is None:
                if sweep:
                    states[side]={"stage":"swept","sweep_extreme":float(row.low if bullish else row.high),
                                  "sweep_time":t,"choch_level":float(row.struct_hi if bullish else row.struct_lo)}
                continue
            st=states[side]
            # Cancel stale setups after 16 M15 bars.
            if (t-st["sweep_time"]).total_seconds()>16*900:
                states[side]=None; continue
            if st["stage"]=="swept":
                choch=(row.close>st["choch_level"]) if bullish else (row.close<st["choch_level"])
                if choch:
                    st["stage"]="choch"; st["choch_time"]=t
                continue
            if st["stage"]=="choch":
                bos=(row.close>row.struct_hi) if bullish else (row.close<row.struct_lo)
                if bos:
                    st.update(stage="bos", bos_time=t, expiry=t+pd.Timedelta(minutes=15*4))
                continue
            if st["stage"]=="bos":
                if t>st["expiry"]:
                    states[side]=None; continue
                fvg=bool(row.bull_fvg if bullish else row.bear_fvg)
                if not fvg: continue
                lo=float(row.bull_bottom if bullish else row.bear_bottom)
                hi=float(row.bull_top if bullish else row.bear_top)
                if not np.isfinite(lo+hi) or hi<=lo: continue
                mid=(float(row.range_hi)+float(row.range_lo))/2
                zone_mid=(lo+hi)/2
                if (bullish and zone_mid>=mid) or ((not bullish) and zone_mid<=mid):
                    states[side]=None; continue
                st.update(stage="retrace", fvg_lo=lo, fvg_hi=hi, entry=(lo+hi)/2,
                          expiry=t+pd.Timedelta(minutes=15*8))
                continue
            if st["stage"]=="retrace":
                if t>st["expiry"]:
                    states[side]=None; continue
                # Need subsequent bars to revisit FVG midpoint.
                touched=(row.low<=st["entry"]<=row.high)
                if not touched or t<=st["bos_time"]: continue
                entry=float(st["entry"])
                stop=float(st["sweep_extreme"] - risk_buffer if bullish else st["sweep_extreme"] + risk_buffer)
                risk=(entry-stop) if bullish else (stop-entry)
                if risk<=spread*2 or risk>max(10.0, entry*0.01):
                    states[side]=None; continue
                target=entry+rr*risk if bullish else entry-rr*risk
                # Execute from next M5 bar after M15 signal/touch close, conservative no lookahead.
                i0=m5.index.searchsorted(t, side="right")
                i1=m5.index.searchsorted(t+pd.Timedelta(days=2), side="right")
                future=m5.iloc[i0:i1]
                outcome=None; exit_time=None; exit_price=None
                for ft,bar in future.iterrows():
                    if bullish:
                        sl=bar.low<=stop; tp=bar.high>=target
                    else:
                        sl=bar.high>=stop; tp=bar.low<=target
                    if sl and tp: outcome="LOSS"; exit_price=stop; exit_time=ft; break # SL-first
                    if sl: outcome="LOSS"; exit_price=stop; exit_time=ft; break
                    if tp: outcome="WIN"; exit_price=target; exit_time=ft; break
                if outcome:
                    pnl=(exit_price-entry if bullish else entry-exit_price)-spread
                    trades.append({"side":side,"entry_time":t.isoformat(),"exit_time":exit_time.isoformat(),
                                   "entry":entry,"stop":stop,"target":target,"result":outcome,
                                   "pnl_price":round(pnl,5),"R":round((pnl/risk),4),
                                   "sweep_time":st["sweep_time"].isoformat(),"choch_time":st.get("choch_time","").isoformat() if st.get("choch_time") is not None else "",
                                   "bos_time":st.get("bos_time","").isoformat() if st.get("bos_time") is not None else ""})
                states[side]=None
    return pd.DataFrame(trades),m15

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--csv",default="XAUUSD5.csv")
    ap.add_argument("--out",default="phase2_results")
    ap.add_argument("--timezone-offset-hours",type=float,default=0,
                    help="Hours to subtract from CSV timestamps to obtain UTC; default assumes CSV already UTC")
    ap.add_argument("--rr",type=float,default=1.5)
    ap.add_argument("--spread",type=float,default=0.30,help="round-trip cost in XAU price units, applied to each trade")
    ap.add_argument("--min-fvg-gap",type=float,default=0.20)
    args=ap.parse_args()
    df=load_data(args.csv)
    trades,_=backtest(df,offset=args.timezone_offset_hours,rr=args.rr,spread=args.spread,min_gap=args.min_fvg_gap)
    out=Path(args.out); out.mkdir(parents=True,exist_ok=True)
    trades.to_csv(out/"trades.csv",index=False)
    summaries=[]
    for side in ["BUY","SELL"]:
        x=trades[trades.side==side] if len(trades) else pd.DataFrame()
        n=len(x); wins=int((x.result=="WIN").sum()) if n else 0
        gross_win=x.loc[x.pnl_price>0,"pnl_price"].sum() if n else 0
        gross_loss=-x.loc[x.pnl_price<0,"pnl_price"].sum() if n else 0
        eq=x.R.cumsum() if n else pd.Series(dtype=float)
        dd=float((eq-eq.cummax()).min()) if n else 0
        summaries.append({"model":side,"trades":n,"wins":wins,"losses":n-wins,
          "win_rate_pct":round(wins/n*100,2) if n else None,
          "net_pnl_price_units":round(float(x.pnl_price.sum()),4) if n else 0,
          "expectancy_R":round(float(x.R.mean()),4) if n else None,
          "profit_factor":round(float(gross_win/gross_loss),3) if gross_loss else (None if not n else "inf"),
          "max_drawdown_R":round(dd,3),"target_80pct_met":bool(n>=30 and wins/n>=0.8)})
    report={"engine":"Phase 2 SMC research backtester v1.0","symbol":"XAUUSD",
      "input":str(Path(args.csv).name),"source_rows":int(len(df)),
      "start":str(df.index.min()),"end":str(df.index.max()),
      "timezone_assumption":"CSV timestamps treated as UTC unless --timezone-offset-hours is set",
      "sessions_UTC":["07:00-10:59","13:00-16:59"],
      "rr":args.rr,"round_trip_cost_price_units":args.spread,
      "same_bar_sl_tp":"stop loss first","trade_count":int(len(trades)),
      "models":summaries,
      "limitations":["Research implementation; verify broker timestamp offset and realistic XAUUSD spread/commission/slippage.",
        "H1 sweep must be confirmed by closed H1 candle. No parameter optimization performed.",
        "Win-rate target is evaluated separately; target flag requires at least 30 trades and >=80% wins. This is not a profitability guarantee."]}
    (out/"summary.json").write_text(json.dumps(report,indent=2))
    print(json.dumps(report,indent=2))
if __name__=="__main__": main()
