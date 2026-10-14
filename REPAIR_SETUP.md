# SnR-XAUUSD — Full Repair Setup

## What changed

- Background push is now allowed only from an authenticated GitHub Actions run.
- BUY/SELL push is sent only when the final signal is `ENTRY + READY`.
- BUY/SELL notification is transition-based (`WAIT -> BUY/SELL` or `BUY <-> SELL`) so a persistent signal is not pushed every 5 minutes.
- CHOCH push uses the real `false -> true` event detector on the newest closed candle.
- Redis locks prevent duplicate push delivery when GitHub Actions retries.
- Public dashboard calls to `/api/scalp` no longer trigger push notifications.
- `/api/push-test` is protected by `PUSH_TEST_SECRET`; the dashboard test button was removed rather than exposing a secret.
- Push subscription input and manual push payloads have basic validation/size limits.
- GitHub Actions no longer depends exclusively on the hardcoded Vercel URL; `XAU_APP_URL` can be configured as a GitHub Actions variable.
- Node runtime is pinned to Node 20+ through `package.json` engines.

## Vercel environment variables

Required for the existing engine:

- `TWELVE_DATA_API_KEY`
- `KV_REST_API_URL`
- `KV_REST_API_TOKEN`
- `VAPID_SUBJECT`
- `VAPID_PUBLIC_KEY`
- `VAPID_PRIVATE_KEY`
- `PUSH_API_SECRET`

Required for background push:

- `XAU_CRON_SECRET`

Optional, only if you want to use `/api/push-test` manually:

- `PUSH_TEST_SECRET`

`XAU_CRON_SECRET` must be the same value in Vercel and GitHub Actions.

## GitHub Actions

Repository Settings -> Secrets and variables -> Actions:

### Secret

- `XAU_CRON_SECRET` = same value as Vercel `XAU_CRON_SECRET`

### Variable

- `XAU_APP_URL` = your production Vercel URL, for example `https://your-project.vercel.app`

The workflow runs approximately every 5 minutes. GitHub scheduled workflows can be delayed, so this is a background polling trigger rather than an exact-time scheduler.

## Push flow after repair

```text
GitHub Actions
    -> /api/scalp?source=github-actions
    -> XAU_CRON_SECRET validation
    -> closed M5/M15/H1 data
    -> signal engine
    -> Redis event/state dedupe
    -> Web Push
    -> Service Worker
    -> phone notification
```

Opening the website is no longer required to run the background signal/push engine.

## Important

After deploying, manually run the GitHub Actions workflow once and confirm the response contains:

- `ok: true`
- `push.authorized: true`

Then use the website's `ENABLE` button once on the phone/browser that should receive notifications.
