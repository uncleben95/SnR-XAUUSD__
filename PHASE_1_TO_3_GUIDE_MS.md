# SnR-XAUUSD — Pakej Penambahbaikan Fasa 1–3

Pakej ini menambah alat risiko dan diagnostik tanpa menukar formula entry utama V18 secara agresif. Ia bukan jaminan keuntungan dan belum dianggap production-verified sehingga deploy serta ujian sebenar selesai.

## Apa yang ditambah

### Fasa 1 — Baiki dan sahkan
- GitHub Actions menghantar `x-xau-cron-secret` kepada `/api/scalp?source=github-actions`.
- Workflow gagal awal jika GitHub Actions secret `XAU_CRON_SECRET` tiada, bukan memberi status berjaya palsu.
- `api/push-cron.js` kini membezakan secret masuk `PUSH_CRON_SECRET` daripada secret engine keluar `XAU_CRON_SECRET`.
- `api/health.js` menunjukkan kehadiran konfigurasi sahaja; ia tidak memaparkan nilai rahsia.
- Dashboard menunjukkan `CACHE / VERIFY` dan amaran jika respons menandakan data cache/stale.
- Tajuk dashboard diselaraskan kepada V18.

### Fasa 2 — Risiko dan bukti prestasi
- `risk-manager.html` menyediakan kalkulator saiz posisi, anggaran kerugian USD/peratus dan pemeriksaan R:R/S/R.
- `risk-math.js` mengandungi pengiraan yang dikongsi dan diuji menggunakan Node test runner.
- `research/PHASE2_BACKTEST_PROTOCOL.md` menyediakan prosedur backtest realistik, out-of-sample dan kriteria penerimaan.

### Fasa 3 — S/R, berita dan volatiliti
- Risk Manager membenarkan input support/resistance dan menilai ruang sehala berbanding sasaran.
- Planner berita membenarkan acara manual dan amaran masa sebelum/selepas acara; acara disimpan pada peranti/browser tersebut sahaja.
- Planner **bukan kalendar berita live** dan tidak menghalang order. Semak kalendar ekonomi sendiri.
- Engine asal sudah mengandungi analisis regime/volatiliti dan roadblock. Pakej ini tidak mengubah ambang signal tersebut tanpa hasil backtest baharu.

## Deployment

### 1. Vercel Environment Variables
Pastikan variables sedia ada kekal. Khususnya:
- `TWELVE_DATA_API_KEY`
- `KV_REST_API_URL`
- `KV_REST_API_TOKEN`
- `VAPID_SUBJECT`
- `VAPID_PUBLIC_KEY`
- `VAPID_PRIVATE_KEY`
- `XAU_CRON_SECRET` — nilai rawak panjang yang sama akan dimasukkan sebagai GitHub Actions repository secret.

Jika menggunakan endpoint `/api/push-cron` secara berasingan, tetapkan juga `PUSH_CRON_SECRET` dan `XAU_APP_URL`. Workflow dalam pakej ini memanggil `/api/scalp` terus dan tidak memerlukan `PUSH_CRON_SECRET`.

### 2. GitHub Repository Secret
Tambah `XAU_CRON_SECRET` di Settings → Secrets and variables → Actions → New repository secret. Nilainya mesti sama tepat dengan Vercel `XAU_CRON_SECRET`. Jangan masukkan secret ke dalam source code atau commit.

### 3. Deploy dan smoke test
1. Deploy ke Vercel.
2. Buka `/api/health`; semak semua `checks` yang diperlukan bernilai `true`. Endpoint ini hanya menyemak kewujudan env vars, bukan sambungan sebenar.
3. Buka `/api/scalp` tanpa `source=github-actions` dan pastikan respons API normal.
4. Jalankan GitHub Actions `workflow_dispatch`; pastikan workflow tidak gagal kerana secret tiada.
5. Periksa JSON/log untuk `push.authorized`, `push.attempted`, status setiap event dan bilangan subscriber. HTTP 200 sahaja tidak membuktikan push sampai ke telefon.
6. Uji dengan peranti/browser sebenar dan pastikan notification permission aktif. Jangan gunakan notification ujian sebagai bukti signal trading telah dihantar.
7. Pastikan dashboard memaparkan amaran cache/stale apabila API menandakan `stale: true`.

### 4. Ujian lokal
- `npm test` atau `npm run test:risk` menjalankan ujian pengiraan risiko.
- `npm run check` membuat pemeriksaan syntax fail API utama.
- Semak `research/PHASE2_BACKTEST_PROTOCOL.md` sebelum menganggap strategi layak untuk live.

## Batasan penting
- Nilai kontrak XAU/USD boleh berbeza mengikut spesifikasi akaun/platform; sahkan contract size, lot step, tick size, spread dan komisen.
- Risk Manager ialah kalkulator manual. Ia tidak membaca trade/equity FTMO sebenar dan tidak menghantar order.
- News Planner adalah manual, local browser storage; ia tidak mempunyai feed ekonomi automatik.
- `api/health` tidak membuat ujian end-to-end kepada Twelve Data, Redis atau Web Push.
- Tiada tuntutan bahawa signal menguntungkan. Backtest sedia ada dalam `research/backtest-summary.json` mempunyai out-of-sample yang lemah dan tiada model spread/slippage/komisen; lihat protokol fasa 2.
- Semak semula peraturan FTMO terkini, termasuk Trading Objectives dan Forbidden Trading Practices, sebelum trading.
