# XAUUSDSNIPER — M5/M15 Scalper

Focus:
- M5 trigger
- M15 confirmation
- Closed-candle CHOCH only
- Nearest confirmed M5/M15 swing S/R
- AI evaluates after a completed structure event
- WAIT is valid and preferred when setup quality is insufficient
- Background GitHub Actions scanner every 5 minutes
- Web Push through the existing push stack

## GitHub Action
`.github/workflows/xau-push.yml` runs every 5 minutes and calls:
`https://sn-r-xauusd-ta3j.vercel.app/api/scalp`

Optional repository secret:
`CRON_SECRET`

If the deployed `/api/scalp` endpoint requires the secret, add the same value to
GitHub Actions Secrets. The Vercel environment must contain the corresponding
runtime secrets used by the existing push implementation.

## iPhone Web Push
Open the deployed app in Safari, add it to Home Screen, open the Home Screen
app, and enable notifications. The subscription must be stored in the existing
push storage used by the project.
