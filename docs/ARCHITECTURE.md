# Arsitektur Proyek

Struktur proyek memisahkan entry point, implementasi server, view, aset statis, dan utilitas lintas fitur. `server.js` dipertahankan sebagai entry point kompatibel agar perintah deployment dan import test lama tetap berjalan.

```text
production-dashboard/
|-- server.js                         # Entry point proses Node.js
|-- src/
|   |-- app.js                        # Komposisi Express, dependency wiring, dan lifecycle proses
|   |-- config/
|   |   |-- environment.js            # Pembacaan .env dan parser konfigurasi
|   |   `-- paths.js                  # Seluruh path absolut aplikasi
|   |-- infrastructure/
|   |   |-- storage/
|   |   |   `-- service.js            # Model Sequelize, cache, write queue, backup, dan restore
|   |   `-- sqlite-session-store.js   # Adapter session Express untuk SQLite
|   |-- features/
|   |   |-- backups/                   # Route backup, restore, dan histori
|   |   |-- imports/                   # Parser, template, dan route import
|   |   |-- material-orders/           # Logic, export, dan route material
|   |   |-- production/                # Route line, model, produksi, dan QC
|   |   `-- reports/                   # Kalkulasi laporan dan generator Excel
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

## Komposisi Feature

`src/app.js` bertanggung jawab atas komposisi Express, lifecycle proses, dan dependency wiring. Lifecycle storage yang stateful berada di `src/infrastructure/storage/service.js`, sehingga cache, antrean write, status restore, model Sequelize, dan operasi backup database tetap memiliki satu pemilik. Logic domain dan route yang sudah stabil berada di `src/features`:

- `imports` menangani parsing Excel, pembuatan template, preview, dan konfirmasi import.
- `material-orders` menangani normalisasi, progress produksi, report Excel, dan endpoint material.
- `reports` menangani filter data, ringkasan produksi/QC, dan seluruh workbook laporan.
- `backups` menangani endpoint snapshot, backup database, restore, dan histori.
- `production` menangani endpoint line, model, input produksi, QC, dan public display data.

Export kompatibilitas tetap diteruskan dari `src/app.js` karena test dan integrasi lama masih mengimpor fungsi tersebut melalui `server.js`.

## Arah Refactor Berikutnya

Bagian terbesar yang masih berada di `src/app.js` adalah autentikasi, pengelolaan user, konfigurasi dashboard, dan komposisi lifecycle server. Tahap berikutnya dapat memindahkan route autentikasi/user dan route konfigurasi ke feature masing-masing sambil mempertahankan `src/app.js` sebagai composition root.
