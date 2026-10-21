# XAUUSD Phase 2 SMC Backtest Engine v1.1

This is a research/backtest tool. It does not automatically replace the live Vercel signal engine.

## Run locally or in GitHub Actions

```bash
pip install -r requirements.txt
python research/phase2_smc_backtest.py --csv XAUUSD5.csv --out research/backtest-results
```

Optional flags:
- `--timezone-offset-hours 0`: hours subtracted from CSV timestamps to obtain UTC.
- `--rr 1.5`: take-profit risk multiple.
- `--spread 0.30`: round-trip cost in XAU price units.
- `--min-fvg-gap 0.20`: minimum FVG width.

## Outputs

- `summary.json`: metrics per BUY/SELL plus diagnostic counters.
- `trades.csv`: resolved trades.

Diagnostics count the setup funnel (M15 sweeps, H1 sweep context, CHOCH, BOS, FVG, premium/discount rejections, retracement touches, risk rejections and resolved trades). The v1.1 change allows an FVG created on the BOS candle to be recorded rather than silently skipping it.

## Important

The first engine version produced zero trades. The v1.1 diagnostic run on the bundled CSV produced only one resolved trade (BUY), and zero SELL trades. That is **inconclusive**, not proof of an 80% win rate. The BUY's 100% win rate is one trade only and does not pass the minimum-30-trade rule. Validate broker timezone, spread/commission/slippage, the SMC definitions and out-of-sample performance before any live use.

This is not connected to the Vercel live signal path automatically. Integrate only after the strategy and backtest are validated.


## v1.2 setup-audit update

The research backtester now writes `setup-events.csv` alongside `trades.csv` and `summary.json`. The event log records accepted sweeps, CHOCH/BOS confirmations, FVG acceptance/rejection, retracement touches, setup cancellations, risk rejections, and resolved/unresolved trades. This is diagnostic only; it does not change the live Vercel signal path and does not guarantee an 80% win rate.

Run:

```bash
python research/phase2_smc_backtest.py --csv XAUUSD5.csv --out research/backtest-results-v1.2-setup-audit
```

Review `research/backtest-results-v1.2-setup-audit/summary.json` and `setup-events.csv`. Do not replace the deployed Vercel project with this research archive.

## v1.3 alternative setup / lifecycle fix

The research engine now measures setup expiry in eligible in-session M15 candles rather than wall-clock elapsed time. This avoids treating overnight/off-session gaps as if they were active setup candles. It also uses separate counters for the pre-FVG setup, BOS-to-FVG wait, and FVG retracement window. The default still requires the closed-H1 sweep context; use `--allow-no-h1-context` only as an experimental comparison, because allowing more raw setups did not improve results in the initial sample.

Run the v1.3 configuration:

```bash
python research/phase2_smc_backtest.py --csv XAUUSD5.csv --out research/backtest-results-v1.3-alternative-setup
```

Optional lifecycle settings: `--max-setup-bars 16`, `--max-bos-wait-bars 4`, and `--max-retrace-bars 8`. These are counts of eligible in-session M15 candles. The bundled v1.3 run produced 4 resolved trades (BUY 1 win / 1 loss; SELL 0 wins / 2 losses), versus 1 resolved trade in the previous v1.2 run. This is still far too small a sample to establish edge or a target win rate, and the SELL model is currently poor. Treat this as a corrected research baseline, not a live-trading recommendation.
