# Repair changelog — 2026-10-23

## Changed
- `api/scalp.js`
  - Require directional closed M5 candle confirmation on FVG retest; wick-only touch no longer qualifies.
  - Limit BOS push to four bars after same-direction CHOCH on that timeframe.
  - Evaluate session by M15 candle open timestamp to match the configured UTC candle sessions.
  - Add configurable estimated round-trip cost (`XAU_ROUND_TRIP_COST_PRICE_UNITS`, default 0.30 price units) to Phase 2 SMC R-multiple targets.
- `README_SMC_REPAIR_2026-10-23.md`: install/validation notes and limitations.

## Validation
- `npm run check`: PASS.
- `npm test`: 16/16 PASS.

## Not claimed as verified
- Live push receipt on an actual phone.
- Candle-by-candle live/backtest parity.
- Strategy profitability or an 80% win rate.
- Exact broker transaction cost; configure the environment variable after measuring the broker's spread/commission/slippage.

The current live setup still has an additional M15 sweep gate alongside H1 sweep context. Removing that gate requires a matching backtest update and parity test; this bundle deliberately does not pretend that the live/backtest strategy is already identical.
