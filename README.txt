# XAUUSD Historical Indicator Research Dashboard

This repository is converted from a live signal/notification engine into a **historical, educational indicator dashboard**.

## Included
- Supplied historical XAUUSD M5, M15 and H4 CSV datasets in `public/data/`.
- Candlestick chart with EMA 20 and EMA 50 overlays.
- Separate RSI 14, ADX 14 and ATR 14 charts.
- Historical candle replay with pause, step and speed controls.
- Optional browser notifications during replay for indicator-state changes (RSI 30/70, EMA 20/50 cross, ADX context changes).
- No order execution, trade recommendations, entry/exit levels, position sizing, or live BUY/SELL signals.

## Run locally

Use any static web server from the repository root. For example:

```bash
python3 -m http.server 8080
```

Then open `http://localhost:8080`.

## Deploy

The app is static and can be deployed to Vercel or any static hosting provider. No API keys, Redis, VAPID keys, or trading broker credentials are required. The historical data files are served from `public/data/`.

## Data format

Whitespace-separated rows: `date time open high low close volume`.

All notifications are generated locally while replaying the historical dataset. They do not monitor live markets and are not trading instructions.
