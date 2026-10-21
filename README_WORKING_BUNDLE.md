# XAUUSD Phase 2 — Full Repository Bundle

This bundle contains the web app/API source, tests, the M5 CSV dataset, and the SMC research backtester.

## Run locally

Requirements: Node.js 20+, Python 3.10+, pip.

### Check the web/API source

```bash
npm ci
npm run check
npm test
```

### Run a backtest on the included CSV

Linux/macOS:

```bash
./scripts/backtest.sh
```

Windows:

```bat
scripts\backtest.bat
```

Or manually:

```bash
python -m pip install -r requirements.txt
python research/phase2_smc_backtest.py --csv XAUUSD5.csv --out research/backtest-results-latest
```

Use a new dataset by passing its path as the first script argument or via `--csv`:

```bash
python research/phase2_smc_backtest.py --csv /path/to/new_XAUUSD5.csv --out research/backtest-new
```

Options include `--timezone-offset-hours`, `--rr`, `--spread`, `--min-fvg-gap`, `--allow-no-h1-context`, `--max-setup-bars`, `--max-bos-wait-bars`, and `--max-retrace-bars`. Run `python research/phase2_smc_backtest.py --help` for details.

## Results included in this bundle

The default configuration was run against the included 100,000-row `XAUUSD5.csv` dataset. It produced 4 resolved trades (BUY 1 win / 1 loss; SELL 0 wins / 2 losses). That is not enough evidence to claim a reliable edge or 80% win rate. The script reports trade-level records, setup-event diagnostics, and separate BUY/SELL statistics.

## Important limitations

- This is a runnable repository bundle, not a guarantee of profitability.
- The CSV timestamp timezone and real broker spread/slippage must be verified before trusting results.
- Same-bar stop and target hits are conservatively treated as stop-loss first.
- Backtest results are not a live-trading recommendation.
- The API app may require its configured deployment secrets/environment variables for push notification and hosted features.
