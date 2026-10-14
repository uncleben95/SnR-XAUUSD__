SnR-XAUUSD V18 — COMBINED TECHNICAL PATCH

Patch ini merangkumi pengoptimuman API, pemeriksaan kesegaran candle, pengesahan risk plan Model A/B/C dan perlindungan deduplication push. Ia berasaskan projek V18 Mobile + Model A/B/C.

FAIL YANG PERLU DIGANTI
1. api/scalp.js
2. api/scalp-models.js
3. tests/scalp-models.test.mjs
4. package.json

APA YANG DIBAIKI

1) Penggunaan Twelve Data
- Cache candle dan harga diperiksa melalui Redis sebelum panggilan provider.
- TTL cache: M5 10 minit, M15 30 minit, H1 60 minit, live price 4 minit.
- Model A/B/C mengira setup daripada candle M5/M15 yang sudah dimuatkan; setiap model tidak membuat panggilan Twelve Data sendiri.
- Anggaran kasar pada operasi 24 jam: M5 144 refresh/hari + M15 48 + H1 24 + harga 360 = kira-kira 576 permintaan provider/hari. Ini anggaran, bukan jaminan; retry, cache miss serentak, had kredit provider dan request lain boleh menambah penggunaan.
- Harga cache boleh berusia sehingga 4 minit. Untuk scalping, semak `livePrice.source`, `livePrice.ageSeconds`, `cache.sources` dan `cache.ageSeconds` selepas deploy.

2) Kesegaran data
- Masa candle diparse dengan sokongan timestamp UTC dan ISO timezone.
- Signal/push production disekat jika candle M5 berusia lebih 12 minit, M15 lebih 45 minit, H1 lebih 120 minit, atau feed kelihatan sintetik/flat.
- Model A/B/C diberi status DATA_STALE dan entry zone/SL/TP dibuang apabila data candle tidak boleh dipercayai.

3) Risk plan Model A/B/C
- Semak arah invalidation/SL berbanding entry zone.
- Semak target mesti berada di arah keuntungan yang betul.
- Kira RR daripada titik tengah entry zone; calon dengan RR di bawah 1.2R atau geometri tidak sah ditandakan INVALID_RISK_PLAN dan `setupFound:false`.
- Semakan ini hanya semakan matematik setup, bukan bukti model profitable. Model kekal untuk semakan manual dan tidak mengaktifkan execution automatik.

4) Push notification
- Tambah Redis claim atomik `NX` sebelum menghantar push, supaya dua request serentak tidak mudah menghantar event sama dua kali.
- Dedupe kekal berasaskan event/candle key. Model eksperimen A/B/C tidak diberi kuasa menghantar push.

CARA APPLY
1. Extract ZIP.
2. Gantikan empat fail di atas pada repo dengan struktur folder yang sama.
3. Commit dan push ke GitHub; tunggu deployment Vercel selesai.
4. Semak `/api/scalp`: `marketStatus`, `experimentalModels.models.*.validation`, `livePrice.ageSeconds`, `cache.sources` dan status push.
5. Jangan anggap deployment sah hanya kerana GitHub Actions hijau; semak respons API sebenar dan dashboard.

UJIAN SETEMPAT
- `npm run check`: lulus.
- `npm test`: 8 ujian lulus.
- Deployment/live Twelve Data dan penerimaan push belum boleh disahkan dari ujian setempat ini.

NOTA PENTING
Patch ini mengubah fail engine dan boleh mengubah bila signal/push dibenarkan kerana pemeriksaan freshness. Buat deploy, kemudian periksa respons API sebelum bergantung pada signal. Tiada jaminan keuntungan atau ketepatan pasaran.
