# Historical research engine

This engine reads the supplied M5, M15 and H4 CSVs, calculates EMA20/EMA50, RSI14, ADX14 and ATR14, then measures how often future candle direction matched a historical EMA bias over selected M15 horizons.

**Important:** `directional_match_pct` is a descriptive historical statistic, not a trade win rate, forecast, or trading instruction. The engine does not create BUY/SELL alerts, entries, exits, position sizing, broker orders, or live market polling.

Run from the repository root:

```bash
python -m pip install -r requirements.txt
python -m engine
```

Output files are written to `research_results/`.

CSV layout: whitespace-separated `date time open high low close volume`.
