# SMC Repair bundle — 2026-10-23

This bundle is the full project, not a patch-only ZIP. Preserve existing Vercel environment variables and GitHub Actions secrets when replacing repository files.

## Repairs included

- SMC M5 entry now requires a closed M5 retest candle in the trade direction, closing on the favorable side of the FVG midpoint. A wick touch alone cannot trigger ENTRY.
- BOS notification is limited to the same-direction CHOCH context and must occur within 4 bars of that timeframe (M15 = 4 x 15 minutes; M5 = 4 x 5 minutes).
- Session filtering uses the M15 candle open time to align with the stated UTC sessions (07:00–10:59 and 13:00–16:59).
- The Phase 2 SMC plan applies an estimated round-trip cost to its R-multiple targets. Default is 0.30 XAUUSD price units; configure `XAU_ROUND_TRIP_COST_PRICE_UNITS` to match broker spread, commission and slippage estimates.

## Validation performed

- `npm run check`: passed.
- `npm test`: 16/16 passed.

## Important limits

These are source/unit checks, not a live deployment or phone push-delivery guarantee. The backtest and live strategy still need candle-by-candle parity tests and broker-specific cost calibration. The research result bundled with this project contains only 4 resolved trades and does not support a reliable win-rate estimate. The live sequence still includes an M15 sweep condition in addition to H1 context; if the intended contract is strictly H1 sweep → M15 CHOCH → BOS → FVG → M5 retest, that additional M15-sweep gate needs to be removed in a separate parity-aware strategy change.
