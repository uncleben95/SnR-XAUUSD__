# SMC staged push notifications

## Notification policy

1. **CHOCH**: notify on a fresh bullish/bearish CHOCH event detected on a closed candle (M15 and M5 event detectors are supported). Event keys include symbol, timeframe, direction, and candle time to prevent duplicate sends.
2. **BOS**: notify on a fresh BOS only when a same-direction CHOCH was recorded first for that timeframe and the BOS candle time is later. BOS notification explicitly says this is not an entry signal.
3. **ENTRY BUY/SELL**: notify only when the Phase 2 SMC live setup is `ENTRY_READY` and the final engine state is `status=ENTRY`, `execution=READY`. The live setup requires H1 liquidity-sweep context, M15 sweep/CHOCH/BOS/FVG sequence, and a closed-M5 retest confirmation.

## Delivery safeguards

- Notifications require an authenticated background run and market status permitting pushes.
- Event locks and short-lived claims in Redis prevent duplicate notifications across cron retries / concurrent invocations.
- Failed sends do not receive a long-lived dedupe lock, allowing retry.
- Entry notifications are deduplicated by `signalKey`.
- Push delivery requires valid Web Push subscriptions and configured deployment secrets; a passing code test does not guarantee delivery until deployed and tested with a subscribed device.

## Verification

Run `npm test` and `npm run check` before deployment. Both passed on the bundle when this document was added.
