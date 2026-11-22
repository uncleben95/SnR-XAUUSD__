// Legacy web-push route intentionally disabled in this educational build.
export default function handler(_req, res) {
  return res.status(410).json({ ok: false, disabled: true, message: 'Automated trading push notifications are disabled.' });
}
