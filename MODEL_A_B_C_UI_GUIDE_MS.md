# XAU/USD Pro Sniper — UI & Model A/B/C (V18 base)

## Apa yang berubah
- Dashboard cerah, ringkas dan responsif untuk telefon.
- Graf candlestick M5 dengan harga live, pilihan 30/60 candle, serta garis H1 support/resistance apabila berada dalam julat graf.
- Paparan ringkas H1/M15/M5, market regime, S/R, trade plan engine asal dan sebab status.
- Model A Liquidity Sweep, Model B FVG Retracement dan Model C Trend Pullback dikira secara berasingan oleh `api/scalp-models.js` dan dipaparkan serentak.
- Push, signal utama, trade plan dan logik kelulusan signal V18 asal tidak ditukar oleh modul eksperimen ini.

## Status model
Model A/B/C ialah **calon setup eksperimen untuk pemerhatian manual**, bukan signal production yang telah disahkan. `EARLY_SETUP` bermaksud peraturan awal model dikesan, bukan arahan untuk membuka trade. Model tidak menghantar push sendiri dan tidak mengubah `signal`, `status`, `execution`, `tradePlan` atau push authorization V18.

## Peraturan ringkas
- **A — Liquidity Sweep:** mencari candle tertutup yang menyapu julat swing 10 candle terdahulu dan tutup semula ke dalam julat. Invalidation ditunjukkan di luar ekstrem sweep menggunakan buffer ATR.
- **B — FVG Retracement:** mencari FVG tiga-candle terkini yang memenuhi definisi asas dan memaparkan zon, status sentuhan/invalidasi serta jarak harga.
- **C — Trend Pullback:** menggunakan struktur M15 yang tersedia serta retracement jangka pendek M5 untuk mengenal pasti pullback yang mungkin searah trend.

Peraturan ini masih versi eksperimen `A-B-C-0.1`; belum menjalani backtest, walk-forward atau forward test. Semua hasil perlu disemak pada carta dan diuji dengan spread/slippage sebelum digunakan untuk keputusan kewangan.

## Deploy
1. Muat turun dan ekstrak ZIP.
2. Gantikan kandungan repo dengan kandungan folder `SnR-XAUUSD__-main` (atau commit fail yang berubah: `index.html`, `api/scalp.js`, `api/scalp-models.js`, `tests/scalp-models.test.mjs`, `package.json`, dokumen ini).
3. Kekalkan environment variables Vercel sedia ada.
4. Deploy seperti biasa. Tiada API provider baharu diperlukan.
5. Selepas deploy, buka `/api/scalp` dan pastikan JSON mempunyai `experimentalModels.models.A`, `.B` dan `.C`; kemudian buka dashboard di telefon.

## Pengesahan setempat
- `node --check api/scalp.js`
- `node --check api/scalp-models.js`
- `node --test tests/*.test.mjs`

Ujian syntax/unit tidak membuktikan sambungan live Twelve Data, Redis atau penghantaran push di Vercel. Itu masih perlu disahkan selepas deploy.
