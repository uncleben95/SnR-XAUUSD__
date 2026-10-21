# Phase 2 Engine Audit — XAUUSD5.csv

## Outcome
**NOT PASS / NOT YET BACKTESTED.** The requested seven-gate SMC model has not been tested on the supplied CSV. The 80% win-rate target is unverified.

## CSV integrity
- Rows: 100,000 (M5 inferred from timestamp spacing)
- UTC range: 2025-05-25 22:35 to 2026-10-20 20:55
- Timestamp order: monotonic; duplicates: 0
- Invalid OHLC rows: 0; OHLC nulls: 0
- Intervals over five minutes: 366 (must be reviewed; may include market closures/data gaps)

## Existing engine audit
- Automated tests: 16 passed, 0 failed. JavaScript syntax check: PASS.
- `api/scalp-models.js` exposes experimental A/B/C models, and marks itself `backtested: false`.
- Liquidity sweep uses recent M5 rolling highs/lows; no joint H1+M15 sweep confirmation.
- FVG is detected as a three-candle gap, but the full required event order (sweep → CHOCH → BOS → displacement/FVG → retracement) is not enforced.
- No explicit premium/discount gate or London/New York session filter is implemented in these experimental models.
- BUY/SELL candidates are not yet independently evaluated in a historical trade simulator.
- `research/backtest-summary.json` has different data end dates (2026-09-24 vs this CSV's 2026-10-20), so its performance metrics are not a backtest of this supplied file.

## Required before a pass decision
1. Implement a deterministic event-driven backtest with no look-ahead.
2. Aggregate M5 into H1/M15 and only use closed candles; confirm pivots after right-side bars close.
3. Enforce each gate in sequence and independently simulate BUY and SELL.
4. Execute at next available price; apply spread/slippage and conservative SL-first same-bar handling.
5. Report train/walk-forward/untouched holdout separately, trade count, win rate, expectancy in R, profit factor, max drawdown and losing streak.
6. Freeze parameters before the holdout. A win rate ≥80% alone is not a pass if after-cost expectancy is non-positive.

## Machine-readable result
See `phase2-engine-audit.json`.
