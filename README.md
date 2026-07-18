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
- Management user, kategori defect, backup, dan aksi sistem untuk admin.
- Laporan berdasarkan tanggal dan export Excel.
- Public display monitor di `/public-display` dengan layout statik seperti display line.
- Backup harian ke folder `history` dan arsip backup ke `history/backups`.

## Role dan Akses

| Role | Akses |
| --- | --- |
| `admin` | Semua fitur, termasuk user, kategori defect, backup, delete line/model, input dan koreksi data. |
| `admin_operator_sewing` | Dashboard, ringkasan line, management line/model, dan report sewing. |
| `admin_operator_qc` | Dashboard, ringkasan line, report QC, koreksi hasil QC, dan pengelolaan kategori defect. |
| `operator` | Ringkasan line dan input line miliknya. Tidak bisa melihat dashboard utama. Data produksi per jam terkunci setelah disimpan. |

Default user saat inisialisasi ada di `server.js`:

| Username | Password | Role |
| --- | --- | --- |
| `admin` | `admin123` | `admin` |
| `admin_operator` | `adminop123` | `admin_operator` |
| `operator1` | `password123` | `operator` |

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

Package script `start` belum didefinisikan, jadi jalankan server langsung:

```bash
node server.js
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

Laporan berdasarkan tanggal tersedia untuk `admin` dan `admin_operator`.

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
| `GET /api/export/:lineName/:modelId` | Export line/model tertentu. |

## Data dan Backup

File dan folder penting:

| Path | Keterangan |
| --- | --- |
| `production-dashboard.sqlite` | Database SQLite lokal. |
| `history/data_YYYY-MM-DD.json` | Backup data per tanggal. |
| `history/backups/` | Arsip backup dengan timestamp. |
| `public-display.html` | Tampilan public display monitor. |
| `DISPLAY LINE.html` | Referensi layout display line. |

Sistem menjalankan auto-check tanggal dan membuat backup harian saat server berjalan.

## Development Notes

- Frontend utama ada di `index.html` dan `public/assets/js/alpine.js`.
- Style dashboard ada di `public/assets/css/style.css`.
- Backend dan endpoint API ada di `server.js`.
- Public display memakai `public-display.html` dan mengambil data dari `/api/public/line/:lineName/:modelId`.

## Validasi Cepat

Cek sintaks server:

```bash
node --check server.js
```

Cek sintaks Alpine app:

```bash
node --check public/assets/js/alpine.js
```

## Catatan Keamanan

- Ganti password default sebelum dipakai di produksi.
- Batasi akses jaringan ke server bila dipakai di area internal produksi.
- Backup folder `history` dan file SQLite secara berkala.
