# Phase 2 Backtest Protocol

`backtest-summary.json` is descriptive only. The latest 30% segment shows weaker/negative performance, and the summary does not model spread, slippage, or commissions. Do not treat these results as evidence of a stable trading edge.

## Validation checklist

1. **Freeze the strategy** before evaluating out-of-sample data. Record every parameter and code version.
2. **Use walk-forward evaluation** and keep a final untouched holdout period. Do not tune parameters against the holdout.
3. **Avoid look-ahead bias:** pivots may only be used after all required right-side candles have closed. A signal from a closed candle should be executed at the next realistically available price, not at an unachievable historical close.
4. **Model execution costs:** use bid/ask or at least variable spread, commission, slippage, latency, and rejected/requoted orders where relevant. Do not assume SL/TP fills exactly at the trigger during gaps.
5. **Handle intrabar conflicts conservatively:** if SL and TP are both touched in one candle and tick data is unavailable, document a conservative assumption (SL first) and report sensitivity.
6. **Report meaningful metrics:** expectancy in R, profit factor after costs, maximum drawdown, average win/loss, trade count, exposure, and longest losing streak.
7. **Segment results** by market regime, session, volatility, and major-event periods. Avoid conclusions based on small samples.
8. **Compare changes one at a time** against a frozen baseline. Keep a change only when out-of-sample results support it.
9. **Paper trade** signals for several weeks. Record signal timestamps, executable prices, spread, hypothetical entry, SL/TP, outcome, and rejection reason.
10. **Stop and investigate** if after-cost expectancy is negative, out-of-sample results are unstable, drawdown exceeds your independently defined limit, or performance is overly sensitive to small parameter changes.

Backtests do not guarantee future results. Paper trading does not fully reproduce live slippage or execution risk.
