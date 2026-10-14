# SnR XAUUSD — Full Breakout Monitor Update

## Apa yang ditambah
- Panel breakout S/R M5 berasingan daripada signal entry utama.
- `BREAKOUT_DETECTED` berdasarkan lintasan close M5 merentasi level S/R H1 yang dikenal pasti daripada candle.
- `signalStage` membezakan `WAIT`, `BUY_SETUP`, `SELL_SETUP`, `BUY_SETUP`/`SELL_SETUP` akibat breakout, `TIMEFRAME_CONFLICT`, `DATA_BLOCKED`, dan `ENTRY_READY`.
- Dashboard menunjukkan arah breakout, level S/R dan masa candle yang mencetuskan lintasan.
- Alasan breakout dimasukkan ke senarai `reasons` apabila engine masih `WAIT`, melainkan guard data/pasaran mengatasi status tersebut.
- Dashboard poll API setiap 8 saat.

## Yang sengaja tidak diubah
- Breakout sahaja tidak memaksa signal production menjadi BUY/SELL.
- Confirmation M15/M5 dan market/data-quality guard kekal. Ini mengelakkan breakout visual terus dianggap entry yang disahkan.
- Cache candle M5 (5 minit) dan live price (4 minit) masih mengawal freshness provider. Poll dashboard setiap 8 saat tidak bermaksud harga/candle provider diperbaharui setiap 8 saat.
- Tiada auto-trading ditambah.

## Cara apply
1. Extract ZIP.
2. Deploy seluruh folder projek pada repo yang sama seperti struktur asal.
3. Pastikan environment variable `TWELVE_DATA_API_KEY` dan konfigurasi Redis yang projek perlukan masih diset di Vercel.
4. Selepas deploy, buka `/api/scalp` dan semak `signalStage`, `breakoutWatch`, `marketStatus`, `livePrice.ageSeconds`, dan `cache.ageSeconds.m5`.
5. Bandingkan masa candle dan level dengan chart broker. Provider, spread, timezone, dan definisi S/R boleh menyebabkan paparan berbeza.

## Ujian
- Syntax check untuk API JavaScript lulus.
- `npm test`: 8/8 ujian sedia ada lulus.
- Ujian live feed XAUUSD dan deployment Vercel belum dijalankan; jangan anggap keputusan ujian setempat sebagai pengesahan signal live atau profitability.
