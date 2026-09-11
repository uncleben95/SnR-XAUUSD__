# XAU/USD Push Monitor

The browser is NOT required to stay open for automatic signal checking.

GitHub Actions calls `/api/push-cron` every 5 minutes. The Vercel backend then runs
`/api/scalp`, checks the M15 + M5 alignment, and sends Web Push through the saved
subscription when a new BUY/SELL entry appears.

## Required GitHub Actions secrets

Repository → Settings → Secrets and variables → Actions → New repository secret:

- `XAU_APP_URL` = your production Vercel URL, e.g. `https://your-project.vercel.app`
- `PUSH_CRON_SECRET` = exactly the same value as the Vercel environment variable

Required Vercel environment variables already used by the app:

- `TWELVE_DATA_API_KEY`
- `VAPID_SUBJECT`
- `VAPID_PUBLIC_KEY`
- `VAPID_PRIVATE_KEY`
- `KV_REST_API_URL`
- `KV_REST_API_TOKEN`
- `PUSH_CRON_SECRET`
- `XAU_APP_URL`

After deploying, open the dashboard once and press **ENABLE** for Web Push permission.
After that, the scheduled backend checks continue even when the phone/browser is closed.

GitHub scheduled workflows have a minimum supported interval of 5 minutes. Runs can
occasionally be delayed by GitHub Actions load.
