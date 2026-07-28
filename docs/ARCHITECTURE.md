# Arsitektur Proyek

Struktur proyek memisahkan entry point, implementasi server, view, aset statis, dan utilitas lintas fitur. `server.js` dipertahankan sebagai entry point kompatibel agar perintah deployment dan import test lama tetap berjalan.

```text
production-dashboard/
|-- server.js                         # Entry point proses Node.js
|-- src/
|   |-- app.js                        # Komposisi Express, API, storage, dan lifecycle
|   |-- config/
|   |   |-- environment.js            # Pembacaan .env dan parser konfigurasi
|   |   `-- paths.js                  # Seluruh path absolut aplikasi
|   |-- infrastructure/
|   |   `-- sqlite-session-store.js   # Adapter session Express untuk SQLite
|   |-- security/
|   |   |-- passwords.js              # Hash dan verifikasi password
|   |   `-- roles.js                  # Normalisasi role dan aturan role umum
|   |-- shared/
|   |   |-- logger.js                 # Format log aplikasi
|   |   `-- validation.js             # Validator input yang dapat digunakan ulang
|   `-- views/
|       |-- index.html                 # Shell dashboard utama
|       `-- public-display.html        # Shell public display
|-- public/
|   `-- assets/
|       |-- css/                       # Stylesheet dashboard dan public display
|       `-- js/                        # Alpine dashboard dan public display
|-- test/                              # Test logic, route, dan migrasi storage
|-- database-backups/                  # Data runtime, tidak masuk Git
`-- production-dashboard.sqlite        # Data runtime, tidak masuk Git
```

## Aturan Penempatan File

- Simpan konfigurasi dan resolusi path di `src/config`; jangan membaca `.env` tersebar di feature code.
- Simpan adapter database, session, filesystem, atau layanan eksternal di `src/infrastructure`.
- Simpan autentikasi, password, role, dan authorization primitive di `src/security`.
- Simpan helper murni yang dipakai beberapa domain di `src/shared`; helper khusus fitur tetap berada dekat fitur tersebut.
- Simpan HTML yang dikirim server di `src/views`, sedangkan file yang boleh diakses langsung browser berada di `public/assets`.
- Tambahkan test ke `test` dengan nama domain yang diuji, lalu masukkan JavaScript baru ke pemeriksaan sintaks di `package.json`.

## Arah Refactor Berikutnya

`src/app.js` masih memuat route dan logic domain lama dalam satu file agar restrukturisasi ini tidak mengubah kontrak API. Pemecahan berikutnya sebaiknya dilakukan per domain, bukan per jenis teknis:

1. `src/features/production` untuk line, model, hourly output, dan QC.
2. `src/features/reports` untuk summary dan generator Excel.
3. `src/features/imports` untuk parser/template Sewing dan QC.
4. `src/features/backups` untuk snapshot, restore, retention, dan migrasi legacy.
5. `src/features/material-orders` untuk validasi, kalkulasi progress, route, dan export.

Setiap domain idealnya mengekspor router atau service melalui satu `index.js`. Pindahkan satu domain per perubahan dan pertahankan export kompatibilitas dari `src/app.js` sampai semua test tidak lagi mengimpor fungsi internal secara langsung.
