# XAU/USD Pro Sniper V18 — Regime + Multi-TF S/R

This package is the full replacement build based on the latest uploaded repository.

## Core architecture
- M5 = primary scalp trigger.
- M15 = confirmation / quality.
- H1 = swing bias + hold context only.
- H1 S/R never blocks a valid M5 scalp entry.
- M5/M15/H1 S/R are used for target hierarchy and management.
- Only closed candles are used for signal structure.

## S/R V3
- Confirmed swing levels are clustered into zones.
- H1 extremes are marked as `MAJOR_EXTREME` rather than ordinary swings.
- Strength uses touches, recency, major-level status and proximity.
- TP target candidates are built separately for M5, M15 and H1.
- TP1/TP2/TP3 remain monotonic and fall back to R-multiples when a suitable S/R level is unavailable.

## Market regime
- Efficiency Ratio (ER) measures directional efficiency without another API request.
- M15 ER is the primary regime driver.
- M5/M15 ATR ratios classify volatility as LOW / NORMAL / HIGH.
- Regime is reported as TRENDING, RANGING or TRANSITION with direction where applicable.
- Regime adjusts quality score and SL/TP aggressiveness but does not independently block a scalp.

## Risk / target behaviour
- Normal SL buffer: 0.15 ATR.
- High-volatility SL buffer: 0.20 ATR.
- Low-volatility SL buffer: 0.12 ATR.
- Trending fallback targets: 1.5R / 3R / 5R.
- Ranging fallback targets: 1.5R / 2.25R / 3R.
- Transition fallback targets: 1.5R / 2.5R / 4R.

## Push / cache
Existing authenticated background push, Redis locks, candle caches, live-price cache and closed-candle handling are preserved.

## Deployment
Replace the repository with this full ZIP. No environment-variable changes are required beyond the existing Twelve Data, Redis and push/VAPID configuration already used by the project.
