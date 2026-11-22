// Legacy live trading-signal endpoint intentionally disabled.
// This repository version is for historical research and market-data visualization only.
export default function handler(_req, res) {
  return res.status(410).json({
    ok: false,
    disabled: true,
    message: 'Automated live trading signals are disabled in this educational build.'
  });
}
