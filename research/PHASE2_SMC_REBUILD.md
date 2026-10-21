# Phase 2 — SMC Strategy Rebuild Specification

## Objective
Test a new XAUUSD strategy using H1/M15 liquidity sweeps, post-sweep CHOCH, BOS confirmation, displacement FVG retracement, premium/discount location, London/New York session filters, and independent BUY/SELL models. Target: >=80% win rate. This is a validation target, not a promised outcome.

## Data and timeframe
- Input currently supplied: XAUUSD M5 OHLC CSV, 100,000 bars, 2025-05-25 22:35 UTC through 2026-10-20 20:55 UTC.
- Derive M15 and H1 candles from M5 OHLC only when all source bars needed for a candle are available. Treat data gaps explicitly; do not forward-fill missing OHLC.
- Use closed candles only. Any pivot requires its right-side confirmation candles to have closed before the pivot is usable.
- A signal formed at a candle close can only execute at the next available tradable price.

## Strategy pipeline (all gates required)
1. **Liquidity sweep, H1/M15:** a confirmed swing high/low is exceeded, followed by a close back through the swept level. Save the swing, sweep timestamp, and sweep extreme. A sweep alone is not an entry.
2. **CHOCH after sweep:** after the sweep, price closes through the relevant opposing confirmed internal swing, within a fixed configurable look-ahead window. The direction must agree with the intended reversal.
3. **BOS confirmation:** after CHOCH, a subsequent closed candle breaks a confirmed structure level in the same direction. Do not count the same candle as both CHOCH and BOS unless a separately documented rule explicitly allows it (default: disallow).
4. **Displacement and FVG:** require a directional impulse candle and a three-candle imbalance. Record FVG bounds and formation time. Reject FVGs that formed before the sweep/CHOCH/BOS sequence or are already invalidated.
5. **Retracement entry:** wait for a later candle to retrace into the FVG; no entry at FVG creation. Entry executes at the next realistically available price after the trigger.
6. **Premium/discount:** define the dealing range using a frozen, causal rule based on confirmed swing points. BUY only below its 50% midpoint; SELL only above it. No future swing information may be used.
7. **Session filter:** allow only configured London and New York windows, using timezone-aware DST rules. Log session for every candidate and trade.
8. **Dual models:** BUY and SELL have independent state machines, trade lists, parameters, counters, and metrics. Report them separately before any combined portfolio result.

## Risk and execution assumptions
- Freeze stop placement before testing; default research candidate is beyond the sweep extreme plus a volatility buffer.
- Freeze target logic and minimum reward/risk before the run; do not tune these on the final holdout.
- Include spread, commission, and slippage. If only OHLC bars are available and both SL and TP are touched within the same bar, count SL first (conservative).
- Do not open a second trade in the same model while that model already has an active trade unless pyramiding is explicitly part of the frozen rules. BUY and SELL models remain independent.
- Report ambiguous fills, gaps, and excluded bars.

## Validation plan
1. Freeze code version, parameters, and data cleaning rules.
2. Use chronological train/validation/walk-forward splits. Reserve the latest segment as a final untouched holdout.
3. Compare BUY and SELL independently; never optimize one side to compensate for the other.
4. Report trade count, wins/losses/breakeven, win rate with confidence interval, expectancy in R after costs, profit factor after costs, maximum drawdown, average win/loss, longest losing streak, and results by session/regime.
5. Require a predeclared minimum sample size and stability across out-of-sample folds. A high win rate with negative expectancy or large drawdown fails.
6. Paper trade for several weeks before any live deployment.

## Pass/fail gate
- **Primary target:** win rate >= 80% on out-of-sample data, reported separately for BUY and SELL.
- **No false pass:** the result must also have positive after-cost expectancy, acceptable predeclared drawdown, adequate trade count, and no major collapse across walk-forward folds.
- If one side fails, mark that side FAIL; do not pool it with the other side to reach 80%.
- If the sample is too small or confidence is too weak, result is INCONCLUSIVE, not PASS.

## Important limitations
The included M5 CSV is OHLC data and does not itself contain bid/ask ticks. Spread/slippage must be estimated conservatively or sourced separately. Backtests and paper trading do not guarantee future results. The existing project's historical summary has negative performance in its latest 30% segment and excludes transaction costs, so it is not evidence that the new model passes.
