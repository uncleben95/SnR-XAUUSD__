import fs from 'node:fs';
const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
for (const required of ['XAUUSD Research Dashboard','RSI 14','ADX 14','ATR 14','EMA 20','Historical replay']) {
  if (!html.includes(required)) throw new Error(`Missing dashboard section: ${required}`);
}
console.log('Dashboard content check passed.');
