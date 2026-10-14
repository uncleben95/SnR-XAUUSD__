# Protokol backtest — sebelum gunakan untuk FTMO

## Status sedia ada
`backtest-summary.json` ialah ringkasan deskriptif. Segmen 30% terakhir menunjukkan prestasi lebih lemah/negatif dan tiada model spread, slippage atau komisen. Jangan anggap hasil itu sebagai bukti edge yang stabil.

## Prosedur minimum
1. **Bekukan versi strategi**: rekod commit SHA, semua threshold, timeframe, definisi candle tertutup dan kaedah exit.
2. **Data**: gunakan data XAU/USD yang timestamp konsisten. Buang candle pendua, lubang data dan nilai OHLC tidak sah. Pastikan timezone dan waktu sesi betul.
3. **Elak look-ahead**: swing/pivot hanya boleh digunakan selepas semua candle kanan yang diperlukan sudah tertutup. Signal pada candle tertutup hanya boleh dieksekusi pada harga seterusnya yang munasabah, bukan harga close yang diketahui selepas kejadian jika ia tidak boleh dicapai.
4. **Execution model**: modelkan bid/ask atau sekurang-kurangnya spread berubah, komisen, slippage, latency, requote/penolakan jika relevan. Jangan andaikan semua SL/TP diisi tepat pada harga trigger ketika gap.
5. **Intrabar conflict**: jika SL dan TP kedua-duanya tersentuh dalam satu candle dan data tick tiada, gunakan andaian konservatif yang didokumenkan (SL dahulu) dan laporkan sensitivity.
6. **Out-of-sample**: asingkan kronologi train/validation/test. Jangan ubah parameter berdasarkan test set. Gunakan walk-forward dengan parameter dibekukan untuk setiap window.
7. **Metrik**: laporkan trade count, win rate, expectancy dalam R, profit factor selepas kos, average win/loss, maximum equity drawdown, losing streak, exposure, hasil mengikut sesi/regime/news window dan prestasi OOS.
8. **Stress test**: naikkan spread/slippage, kurangkan kualiti fill, uji hari volatiliti tinggi dan data yang hilang. Periksa sama ada hasil masih boleh diterima.
9. **Paper trading**: jalankan signal tanpa risiko sekurang-kurangnya beberapa minggu; rekod timestamp signal, harga boleh laksana, spread, entry hipotetikal, SL/TP, hasil dan sebab signal ditolak.
10. **Keputusan**: jangan teruskan jika expectancy selepas kos negatif, OOS tidak stabil, drawdown melanggar had dalaman atau keputusan sensitif melampau kepada sedikit perubahan parameter.

## Templat log trade yang disyorkan
`timestamp_utc, signal_key, direction, setup, regime, entry_reference, executable_entry, stop_loss, take_profit, spread, slippage, commission, risk_usd, pnl_usd, pnl_R, exit_reason, data_source, candle_age_seconds, news_distance_minutes`

## Pengurusan risiko ujian FTMO
- Simulasikan had kerugian harian dan maksimum berdasarkan definisi FTMO semasa, termasuk floating P/L dan kos yang berkaitan.
- Letakkan had dalaman lebih ketat daripada had akaun rasmi.
- Anggap signal berturut-turut sebagai risiko portfolio jika posisi bertindih.
- Backtest tidak menjamin hasil masa depan; paper trading juga tidak menggantikan risiko slippage live.
