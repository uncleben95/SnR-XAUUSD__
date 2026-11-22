# SnR XAUUSD — Historical Research Dashboard

This version is based on the originally attached repository. It retains the original project structure and non-trading API files, adds the historical M5/M15/H4 dashboard and Python research engine, and includes the supplied CSV datasets.

## Included
- Historical M5, M15 and H4 CSV data in `public/data/`
- Browser dashboard with candlesticks and EMA20/EMA50, RSI14, ADX14 and ATR14 panels
- Historical replay and educational indicator-change notices
- Python research engine in `engine/`
- Research outputs in `research_results/`
- Original `api/` and `tests/` folders retained; legacy automated trading signal and push endpoints return HTTP 410 and the scheduled push workflow is removed

## Run historical research

```bash
python -m pip install -r requirements.txt
python -m engine
```

## Run dashboard locally

```bash
python3 -m http.server 8080
```
Open `http://localhost:8080`.

## Data source separation
- CSV files are used for historical research and replay.
- No Twelve Data live feed is configured in this bundle. Live market polling and automated trading signals are not included.
- Indicator calculations are local and are not broker instructions.

`directional_match_pct` in research output is a historical directional statistic, not a trade win rate or a forecast.
