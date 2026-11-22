// Legacy automated trading notifications intentionally disabled.
export default function handler(_req, res) {
  return res.status(410).json({ ok: false, disabled: true, message: 'Automated trading notifications are disabled in this educational build.' });
}
