# Buat Toko Online Sendiri — Landing Page

Repository mandiri untuk landing statis `https://buattokosendiri.web.id`.

Source asal: `Assyauq26/Gheverhan`, direktori `landing/jetseller/`, kandidat refactor `chore/btos-simple-static-deploy` (commit `46e48786d07bbb70993091934658c238ba81acfd`).

## Status migrasi

Repository ini sedang dipisahkan dari Gheverhan. Website produksi belum dialihkan dan tidak ada perubahan database, aplikasi seller, dashboard, atau API pendaftaran.

## Prinsip

- HTML/CSS/JS, gambar, panduan instalasi dan PDF dikelola di sini.
- Pendaftaran tetap bergantung pada backend yang melayani endpoint `/api/registration` di domain terkait; migrasi source statis **tidak** memindahkan backend.
- CI landing hanya manual bila diminta owner.
- Deploy manual untuk exact SHA, backup, validasi checksum dan rollback tetap wajib.
- Source lama dipertahankan sampai cutover selesai dan terverifikasi.

Lihat `deploy/STATIC-LANDING.md` setelah proses migrasi selesai.
