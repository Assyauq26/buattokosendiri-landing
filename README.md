# Buat Toko Online Sendiri — Landing Page

Repository mandiri untuk website publik [buattokosendiri.web.id](https://buattokosendiri.web.id/).
Kode halaman, CSS, JavaScript, gambar, panduan instalasi, dan PDF berada di root repository ini.

## Halaman

- `/` — landing page dan tombol panduan instalasi.
- `/pendaftaran/` — antarmuka pendaftaran seller.
- `/panduan-instalasi/` — panduan pemasangan toko dan tautan PDF.
- `/daftar/` dan `/masuk/` — kompatibilitas tautan lama.
- `/kebijakan-privasi/` — kebijakan privasi.

**Batas arsitektur:** endpoint `/api/registration` yang dipakai formulir pendaftaran bukan bagian dari repository statis ini. Reverse proxy/backend pendaftaran harus tetap tersedia saat migrasi domain. Dashboard, database, installer, dan aplikasi seller tetap di repository serta prosedur deployment masing-masing.

## Pengembangan dan rilis

- Tidak ada auto-deploy atau CI yang dipicu oleh `push` atau pull request.
- GitHub Actions `Manual landing checks` hanya dapat dijalankan oleh owner melalui `workflow_dispatch` jika diminta.
- Cek lokal opsional: `node --check deploy/prepare-release.cjs` dan `bash -n deploy/activate-static-landing.sh`.
- Build paket rilis statis dari **SHA commit tepat**: `node deploy/prepare-release.cjs FULL_SHA_40 /tmp/btos-landing-output registration`.
- Aktivasi di VPS hanya untuk operator berizin dengan validasi domain, backup, hash aset, dan rollback; petunjuk di [deploy/STATIC-LANDING.md](deploy/STATIC-LANDING.md).

Pembuatan commit/merge pada repository ini **tidak berarti deployment ke website live**. Aktivasi memerlukan inspeksi routing Caddy dan persetujuan operator, khususnya untuk memastikan `/api/registration` tetap berfungsi. Helper aplikasi seller tidak dimodifikasi.

## Asal kode

Dimigrasikan dari direktori `landing/jetseller/` di `Assyauq26/Gheverhan`, snapshot commit `46e48786d07bbb70993091934658c238ba81acfd` (branch refactor deployment statis). File gambar asli dipertahankan byte-for-byte; atribusi aset tercantum dalam `assets/img/PROVENANCE.md`.
