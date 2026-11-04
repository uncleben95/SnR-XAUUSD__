# XAU/USD H1 Breakout + H4 Support/Resistance

## New engine rules
- **H4**: support and resistance structure only.
- **H1**: breakout trigger only.
- A breakout is valid only after the **H1 candle has closed** beyond an H4 level.
- **BUY breakout**: previous H1 close was at/below H4 resistance and latest closed H1 closes above it.
- **SELL breakout**: previous H1 close was at/above H4 support and latest closed H1 closes below it.
- **No M5 data, no M15 data, no M5 retest and no M15 confirmation.**
- Push alert is deduplicated by direction + broken level + H1 candle time.

The dashboard is redesigned around H4 levels and H1 candles.
