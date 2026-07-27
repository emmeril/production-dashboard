# Production Dashboard

Dashboard produksi berbasis Express untuk memantau output line, target per jam, defect, laporan harian, export Excel, dan public display monitor.

## Fitur Utama

- Login berbasis role: `admin`, `admin_operator`, dan `operator`.
- Dashboard produksi untuk `admin` dan `admin_operator`.
- Ringkasan line dan detail model aktif per line.
- Input hasil produksi per jam.
- QC check `Good` dan `Defect` dengan kategori `Jenis Defect` dan `Defect Area`.
- Lock data produksi per jam untuk operator setelah data disimpan.
- Management line dan model produksi.
- Management user, kategori defect, dan Backup Data untuk admin.
- Backup Data membuat salinan SQLite lengkap yang bisa diunduh dan dipulihkan kembali dengan backup pengaman otomatis.
- Laporan berdasarkan tanggal dan export Excel.
- Input data historis dipisahkan menjadi template Produksi per jam dan template QC dengan dropdown defect.
- Public display monitor di `/public-display` dengan layout statik seperti display line.
- Histori produksi tersimpan di tabel `production_snapshots`; backup fisik SQLite dibuat harian atau secara manual.

## Role dan Akses

| Role | Akses |
| --- | --- |
| `admin` | Semua fitur, termasuk user, kategori defect, backup, delete line/model, input dan koreksi data. |
| `admin_operator_sewing` | Dashboard, ringkasan line, management line/model, serta report produksi dan QC lengkap. |
| `admin_operator_qc` | Dashboard, ringkasan line, report produksi dan QC lengkap, koreksi hasil QC, dan pengelolaan kategori defect. |
| `operator` | Ringkasan line dan input line miliknya. Tidak bisa melihat dashboard utama. Data produksi per jam terkunci setelah disimpan. |

User awal dibuat saat inisialisasi pertama. Password bootstrap disimpan di `database-backups/bootstrap-credentials.json`, atau bisa ditentukan lewat env var `DEFAULT_ADMIN_PASSWORD`, `DEFAULT_ADMIN_OPERATOR_PASSWORD`, dan `DEFAULT_OPERATOR_PASSWORD` sebelum server pertama kali dijalankan.

| Username | Role |
| --- | --- |
| `admin` | `admin` |
| `admin_operator` | `admin_operator_sewing` |
| `operator1` | `operator` |

## Requirement

- Node.js 18+ direkomendasikan.
- npm atau pnpm.
- SQLite digunakan lewat file lokal `production-dashboard.sqlite`.

## Instalasi

```bash
npm install
```

Atau jika memakai pnpm:

```bash
pnpm install
```

## Menjalankan Aplikasi

Konfigurasi lokal dibaca otomatis dari file `.env`. Environment variable yang sudah diberikan oleh server, PM2, Docker, atau shell tetap memiliki prioritas dan tidak akan ditimpa oleh file tersebut.

Jalankan server dengan package script:

```bash
npm start
```

Default server berjalan di:

```text
http://localhost:3000
```

Port bisa diubah dengan environment variable `PORT`:

```bash
PORT=4000 node server.js
```

Di PowerShell:

```powershell
$env:PORT=4000; node server.js
```

Untuk deployment, set juga `SESSION_SECRET` ke nilai acak yang panjang agar sesi login tetap aman dan konsisten setelah server restart:

```powershell
$env:SESSION_SECRET='ganti-dengan-random-secret-yang-panjang'; npm start
```

Sesi login disimpan di SQLite agar tetap tersedia setelah restart. Jika server berjalan di balik reverse proxy HTTPS, set `NODE_ENV=production`, `SESSION_COOKIE_SECURE=true`, dan `TRUST_PROXY=1`. Jangan mematikan cookie secure pada deployment HTTPS.

Proteksi login membatasi percobaan gagal per akun/IP. Nilai default dapat disesuaikan melalui `LOGIN_RATE_LIMIT_MAX_ATTEMPTS`, `LOGIN_RATE_LIMIT_MAX_ATTEMPTS_PER_IP`, dan `LOGIN_RATE_LIMIT_WINDOW_MS`.

## URL Penting

| URL | Keterangan |
| --- | --- |
| `/` | Aplikasi dashboard utama. |
| `/admin` | Route SPA untuk admin/management. |
| `/leader` | Route SPA lama untuk dashboard. |
| `/line/:lineName` | Detail line tertentu. |
| `/input/:lineName` | Input data line tertentu. |
| `/public-display?line=LINE_NAME&model=MODEL_ID` | Public display monitor untuk line dan model tertentu. |

Contoh public display:

```text
http://localhost:3000/public-display?line=Line%201&model=MODEL_001
```

Jika `model` tidak dikirim, server memakai model aktif line tersebut.

## Alur Operator

1. Login sebagai operator.
2. Buka ringkasan line atau input line miliknya.
3. Pilih jam produksi.
4. Isi `Output Produksi` dan `Target Manual`.
5. Klik `Simpan Produksi`.
6. Setelah tersimpan, jam tersebut terkunci untuk operator dan tidak bisa diedit ulang.

Admin tetap bisa melakukan koreksi data bila diperlukan.

## Laporan dan Export Excel

Laporan berdasarkan tanggal tersedia untuk `admin`, `admin_operator_sewing`, dan `admin_operator_qc`. Ketiga role menggunakan tampilan report, data, dan template Excel lengkap yang sama. Role `operator` tidak memiliki akses report maupun export.

Export Excel mencakup:

- Summary produksi.
- Detail produksi per line.
- Data per jam.
- Detail defect: `Jam`, `Jenis Defect`, `Defect Area`, `Qty`, dan `Notes`.
- Performance overview.

Endpoint utama:

| Endpoint | Keterangan |
| --- | --- |
| `GET /api/date-report/:date` | Data laporan tanggal. |
| `GET /api/export-date-report/:date` | Export laporan tanggal ke Excel. |

## Import Data Historis

Admin menggunakan dua template dan dua proses import yang terpisah:

1. `Input Produksi` diisi satu baris untuk setiap jam produksi. Kolom utamanya adalah `Tanggal`, `Line`, `Label/Week`, `Model`, `Jam`, `Target Manual`, dan `Output`. Seluruh delapan jam produksi wajib diisi; target dan output harian dihitung otomatis.
2. `Input QC` dilakukan setelah data Produksi tersedia. Setiap baris berisi `Jam`, `Hasil QC`, dan `Qty`. Untuk hasil `Good`, jenis dan area defect dikosongkan. Untuk hasil `Defect`, pengguna memilih `Jenis Defect` dan `Defect Area` melalui dropdown yang diambil dari master aplikasi.

QC Checked, Good, Total Defect, severity, dan defect rate dihitung otomatis dari baris QC. Input Produksi tidak menghapus data QC yang sudah ada, sedangkan Input QC tidak mengubah target maupun output Produksi. Kedua template menyertakan petunjuk, referensi dropdown, dan contoh dari data historis tersimpan.

## Data dan Backup

File dan folder penting:

| Path | Keterangan |
| --- | --- |
| `production-dashboard.sqlite` | Database SQLite lokal. |
| `database-backups/` | Backup SQLite konsisten dari `VACUUM INTO`, dengan retensi default 7 hari. |
| `public-display.html` | Tampilan public display monitor. |

Histori harian dan snapshot restore tersimpan di database. Instalasi lama akan mengimpor file JSON dari `history/` satu kali, membuat backup database pengaman, kemudian membersihkan file JSON tersebut. Sistem tidak lagi membuat arsip pada setiap startup.

Saat startup, sistem juga memulihkan snapshot yang belum ada dari file SQLite di `database-backups/`. Snapshot yang sudah ada di database aktif tidak ditimpa, sehingga histori tetap tersedia setelah database aktif diganti atau dipulihkan dari backup lama.

File backup SQLite yang berumur lebih dari 7 hari dihapus otomatis saat startup dan setiap satu jam oleh background worker. Hanya file backup dengan pola nama aplikasi yang dibersihkan; file seperti `bootstrap-credentials.json` tidak disentuh.

Retensi backup SQLite dapat diatur dalam satuan hari melalui `DATABASE_BACKUP_RETENTION_DAYS` (atau nama lama `DATABASE_BACKUP_RETENTION`). Snapshot harian, manual, dan snapshot pengaman restore/reset di dalam database tidak memiliki masa kedaluwarsa otomatis.

## Development Notes

- Frontend utama ada di `index.html` dan `public/assets/js/alpine.js`.
- Style dashboard ada di `public/assets/css/style.css`.
- Backend dan endpoint API ada di `server.js`.
- Public display memakai `public-display.html` dan mengambil data dari `/api/public/line/:lineName/:modelId`.

## Validasi Cepat

Jalankan seluruh pemeriksaan sintaks:

```bash
npm test
```

Atau periksa file secara terpisah:

Cek sintaks server:

```bash
node --check server.js
```

Cek sintaks Alpine app:

```bash
node --check public/assets/js/alpine.js
```

## Catatan Keamanan

- Amankan file bootstrap credential dan ganti password awal setelah setup.
- Batasi akses jaringan ke server bila dipakai di area internal produksi.
- Backup folder `history` dan file SQLite secara berkala.
