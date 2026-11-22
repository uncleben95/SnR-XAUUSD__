SnR XAUUSD Historical Research Dashboard

Based on the originally attached repository. Includes M5/M15/H4 CSV data, a historical browser dashboard, and a Python research engine.

Run research:
  python -m pip install -r requirements.txt
  python -m engine

Run dashboard:
  python3 -m http.server 8080
  Open http://localhost:8080

CSV data is used for historical research. Twelve Data live polling is not configured. Automated live trading signals and push notifications are disabled in this educational build.
