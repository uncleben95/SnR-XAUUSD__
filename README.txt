XAUUSD API OPTIMIZATION PATCH

This patch is for the H4 EMA20/EMA50 + H1 Swing Break engine version.
It contains only the files to replace:
  api/scalp.js
  api/levels.js
  index.html

How to apply:
1. Extract this ZIP.
2. Copy the three files into the same paths in your existing GitHub repository.
3. Replace the old files when prompted.
4. Commit and push; Vercel will redeploy.

No new environment variables are required. The patch uses the existing Upstash
Redis connection (KV_REST_API_URL and KV_REST_API_TOKEN) already used by push-lib.js.

API behavior:
- /api/scalp fetches H1 and H4 time_series only; it no longer calls /price.
- Both candle series are cached together in Redis for 75 seconds.
- A Redis NX lock prevents dashboard and GitHub Actions from fetching the same
  market data concurrently. A waiting request reads the shared cache; if the
  first fetch is still in progress, it returns 503 instead of making duplicate
  Twelve Data requests.
- /api/levels reads the same Redis cache and makes no Twelve Data requests.
- Dashboard displays the latest closed H1 close, not a live tick price.

The expected Twelve Data request count on a cache refresh is two HTTP requests
(one H1 time_series and one H4 time_series). Actual credit consumption should be
verified in the Twelve Data usage dashboard because provider credit accounting
can depend on endpoint and plan.
