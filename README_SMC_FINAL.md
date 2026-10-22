# XAUUSD SMC Final Bundle — deployment notes

## Signal pipeline in the live API

The `api/scalp.js` production path includes a Phase 2 setup builder with the sequence:

1. H1 liquidity-sweep context.
2. M15 sweep and CHOCH on closed candles.
3. A subsequent M15 BOS (not the same candle as CHOCH).
4. Directional displacement FVG and premium/discount filter.
5. FVG retest by a closed M5 candle, with price still within the configured zone/buffer.
6. H1 direction guard, risk plan validation, and final `ENTRY/READY` gate.

The current implementation uses UTC session windows 07:00–11:00 and 13:00–17:00, with timezone-safe market-closed checks elsewhere in the engine. The live setup is cancelled implicitly when its age/window/structure/FVG/price conditions no longer pass; it does not preserve an unlimited pending setup.

## Push notifications

Authenticated background cron runs can send separate event notifications:

- M15 and M5 CHOCH events on newly detected closed candles.
- M15 and M5 BOS events only when a same-direction CHOCH was persisted first and the BOS candle is later.
- Existing M5 S/R breakout notifications.
- Final BUY/SELL entry notification only when `status === ENTRY` and `execution === READY`.

Notifications use Redis event keys and a short claim lock to reduce duplicate delivery across cron invocations. CHOCH/BOS alerts are informational, not entry instructions. The API response `push` diagnostics now count BOS attempts as well.

## Risk / cost / backtest caveats

The live SMC candidate uses a stop beyond the M15 sweep extreme plus an ATR-derived buffer and currently sets its first target at 1.5R. Do not interpret this as a guarantee of positive expectancy. The research backtester has configurable spread/cost and uses conservative SL-first handling when both SL and TP are touched in a candle. A true parity claim requires running both engines on exactly the same candle feed and matching every event timestamp and fill assumption; this bundle has not been certified for full live/backtest parity or an 80% win rate.

## Regression

Run `npm run check` and `npm test` before deployment. Existing API routes, push subscription flow, service worker, and workflow files are retained. End-to-end push delivery still depends on correct Vercel environment variables, Redis, a valid Web Push subscription, and the GitHub Actions cron secret.
