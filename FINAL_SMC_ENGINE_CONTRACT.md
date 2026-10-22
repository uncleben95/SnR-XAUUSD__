# FINAL SMC ENGINE CONTRACT — XAUUSD

## Status
This is the frozen strategy contract for implementation and parity testing. It is NOT evidence that the existing live API already implements this strategy. The production `api/scalp.js` and push pipeline remain unchanged until the new engine passes parity tests.

## Required event sequence (closed candles only)
1. H1 liquidity sweep: only a completed H1 candle may confirm a sweep of a prior confirmed liquidity level and close back inside it. Store direction, level, extreme, timestamp.
2. M15 CHOCH: after the H1 sweep timestamp, a completed M15 candle must close beyond the latest confirmed opposing internal swing. A wick is insufficient.
3. M15 BOS: a later, distinct completed M15 candle must close through the next confirmed structure level in the same direction. CHOCH candle cannot double as BOS.
4. M15 displacement/FVG: require a directional displacement candle and a three-candle imbalance formed after BOS. Freeze exact FVG bounds and creation timestamp. Reject already invalidated gaps.
5. M5 retest: only M5 candles strictly later than FVG creation may trigger. BUY requires overlap with the FVG and a bullish candle close back above the FVG midpoint; SELL requires overlap and a bearish close back below midpoint. No intrabar signal and no entry on the FVG creation candle.
6. Entry price: signal is known at the M5 trigger candle close; simulated fill is next available M5 open plus adverse execution costs. Live output must expose the trigger close and expected next-price estimate separately; do not pretend a future fill is known.

## Risk / targets
- BUY stop = minimum of the H1 sweep low and M5 retest low, minus buffer.
- SELL stop = maximum of the H1 sweep high and M5 retest high, plus buffer.
- Buffer = max(configured absolute XAU price buffer, 0.10 × M5 ATR(14)); ATR uses closed candles only.
- Risk distance must be positive and greater than estimated round-trip costs. Reject if stop distance is zero, invalid, or exceeds configured maximum risk.
- Default target candidate: TP = entry ± 2.0 × (absolute entry-to-SL distance + estimated round-trip costs), directionally correct. Report gross RR and after-cost RR separately. Never silently remove spread, commission, or slippage.
- Position size must be calculated from user-configured cash risk and contract specification; do not hardcode a lot size. If contract/tick-value metadata is unavailable, report risk in price units and do not claim a reliable cash risk.

## Timing / lifecycle
- Closed-candle rule: H1/M15/M5 candles must be complete according to candle timestamp and timeframe; no current forming candle may confirm a stage.
- Sessions: London 08:00–11:00 Europe/London and New York 08:00–11:00 America/New_York, timezone-aware DST. These windows are configuration defaults and must be aligned to the broker/data feed before production.
- Setup expiry: 8 eligible M15 session candles after H1 sweep for CHOCH/BOS/FVG sequence; 8 eligible M5 session candles after FVG for retest. Count eligible session candles, not wall-clock time.
- Cancel on opposing confirmed structure break, FVG invalidation before entry, stop invalidation, session end, expiry, stale/missing data, or malformed OHLC. Never revive a cancelled setup.

## Live/backtest parity
- One shared pure engine function must consume the same normalized OHLC bars and config in live and backtest. No duplicate strategy implementations.
- Replay exact same candle rows in timestamp order. At each timestamp, only candles whose close time has passed may be visible.
- Compare per-candle stage, setup ID, side, sweep level/extreme, CHOCH/BOS times, FVG bounds, trigger time, entry estimate, SL, TP, cancellation reason, and final signal. First mismatch fails parity.
- Backtest fills at next available bar open, applies spread/commission/slippage, and resolves same-bar SL/TP ambiguity as SL-first. Missing intervals are not forward-filled.
- Report BUY and SELL independently; chronological train/validation/untouched holdout; trade count, win rate, expectancy after costs, profit factor after costs, max drawdown, losing streak, and per-session results. 80% win rate is a target only, never a guarantee. Insufficient trades = INCONCLUSIVE.

## Regression gate
- Run `npm test` and `npm run check`.
- Verify `/api/scalp`, `/api/health`, `/api/levels`, push subscribe/test/send/state/cron/config routes retain their response contracts.
- Verify no duplicate push for the same event key; a new unique BUY/SELL event can notify.
- Verify WAIT / stale-data / market-closed handling remains unchanged unless explicitly tested.
- Do not deploy or replace production signals until parity and strategy validation pass.

## Known baseline caveat
The supplied project currently contains a research backtester separate from the live `api/scalp.js` strategy path. Its own documentation reports only four resolved trades in a prior v1.3 diagnostic run (BUY 1 win/1 loss; SELL 0 wins/2 losses). This is far too small to establish an edge. This contract alone does not mean the production engine has been integrated or validated.
