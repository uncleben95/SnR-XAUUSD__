# XAUUSD Phase 2 SMC Backtest Engine

## Run
Python 3.10+ recommended.
```bash
pip install -r requirements.txt
python research/phase2_smc_backtest.py --csv XAUUSD5.csv --out research/backtest-results
```

The input format is the supplied whitespace-separated CSV:
`date time open high low close volume`

Optional parameters:
- `--timezone-offset-hours 0`: hours subtracted from CSV timestamps to obtain UTC. Set this to your broker/server offset if known.
- `--rr 1.5`: take-profit risk multiple.
- `--spread 0.30`: round-trip cost in XAU price units.
- `--min-fvg-gap 0.20`: minimum FVG width.

## Important
This is an executable research/backtest prototype, not a live-trading bot. It uses closed M15 candles and prior rolling liquidity levels, independent BUY/SELL state machines, CHOCH -> BOS -> FVG retracement, premium/discount gating, London/New York UTC session filter, and stop-first handling when SL and TP touch in the same M5 bar.

The first run on the supplied data produced **zero qualified trades** with the current strict gate combination. That is an INCONCLUSIVE strategy result, not an 80% win-rate pass. Do not use it for live trading before debugging/validating signal frequency, broker timezone, spread/commission/slippage and out-of-sample performance.
