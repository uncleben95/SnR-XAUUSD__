# XAUUSDSNIPER — M5/M15 CHOCH Scalper

This build is intentionally focused on the requested scalp workflow:

1. M5 closed candle is the trigger timeframe.
2. A **NEW M5 CHOCH** must be detected from confirmed previous swing structure.
3. M15 must point in the same direction for confirmation.
4. H1 is context only and does not cancel an M5/M15 scalp.
5. Support/resistance comes from the nearest confirmed M5/M15 swing structure. When a bullish CHOCH breaks a previous high, that broken level is also treated as the first retest/reference support. The inverse applies to bearish CHOCH.
6. Gemini is called only after a confirmed M5 CHOCH + M15 confirmation. It can return ENTRY_VALID, WAIT_RETRACE or AVOID.
7. The system never forces an entry. WAIT is a normal output.
8. Push notification is keyed to the exact M5 CHOCH event so repeated dashboard refreshes do not resend the same event.
9. `.github/workflows/xau-push.yml` runs every 5 minutes so the signal engine can run without the dashboard being open.

## Required Vercel environment variables

Keep the project's existing variables and values:

- `TWELVE_DATA_API_KEY`
- `GEMINI_API_KEY`
- `GEMINI_MODEL` (optional; defaults to `gemini-3.5-flash-lite`)
- `VAPID_SUBJECT`
- `VAPID_PUBLIC_KEY`
- `VAPID_PRIVATE_KEY`
- `KV_REST_API_URL`
- `KV_REST_API_TOKEN`

## iPhone push

Use Safari, Add to Home Screen, open the installed Home Screen app, then tap Enable Notifications. The subscription is saved in the existing Redis/Upstash push store.

## Background scanner

GitHub Actions workflow:
`.github/workflows/xau-push.yml`

It calls:
`https://sn-r-xauusd-ta3j.vercel.app/api/scalp?source=github-actions`

The workflow is deliberately independent of the dashboard UI.


## IMPORTANT — background notification

The dashboard does NOT need to stay open. GitHub Actions calls `/api/scalp` every 5 minutes in the background. The server-side signal engine is the only component that sends signal push notifications.

Expected flow:
`GitHub Actions → /api/scalp → M5 closed-candle CHOCH + M15 alignment → Gemini → Web Push → iPhone`

The same M5 CHOCH event is not pushed repeatedly on every 5-minute scan. A new notification is generated when a new qualifying M5 CHOCH event appears.

Before relying on background alerts, make sure GitHub Actions is enabled for the repository and the workflow exists on the default branch.
