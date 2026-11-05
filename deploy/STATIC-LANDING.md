# Rilis landing statis Buat Toko Online Sendiri (manual, tanpa CI)

Dokumen ini hanya untuk aset publik `buattokosendiri.web.id`. **Bukan**
pengganti deploy aplikasi seller, dashboard/control plane, database, installer,
publisher bertanda tangan, atau mekanisme recovery mereka.

## 1. Kebijakan sederhana

- CI landing UI dijalankan **hanya** lewat `workflow_dispatch` atas permintaan owner.
- Perubahan landing tidak mengubah atau menjalankan suite pengujian aplikasi
  seller maupun backend pendaftaran yang berada di repository terpisah.
- Tidak ada auto-deploy. Operator memilih exact SHA Git dan menyetujui aktivasi.
- Helper **tidak memeriksa status CI maupun PR**, tetapi masih memeriksa domain,
  container Caddy, mount root, manifest/hash seluruh aset, backup dan rollback.
- Helper tidak memodifikasi Caddyfile, proxy, Docker Compose, database, atau
  aplikasi seller. Ini prosedur untuk website statis yang sudah dikonfigurasi.

## 2. Siapkan aset di komputer operator

Pada checkout `Assyauq26/buattokosendiri-landing` yang memuat SHA yang disetujui:

```bash
node deploy/prepare-release.cjs FULL_SHA_40 /tmp/btos-landing-output registration
```

Perintah menghasilkan direktori baru `/tmp/btos-landing-output/FULL_SHA_40`
dan `release-manifest.json` berisi hash seluruh file. Tidak ada jaringan,
deployment, atau pemanggilan CI. File publik baru di `assets/`,
`pendaftaran/`, dan `panduan-instalasi/` (termasuk PDF/SVG) ikut otomatis;
`tests/`, `deploy/`, serta source aplikasi seller tidak ikut.

Transfer **direktori rilis utuh** ke path `releases/FULL_SHA_40` pada root
landing di mount Caddy, dengan owner root dan izin read-only publik. Gunakan
kanal transfer operator yang sudah diotorisasi dan bandingkan hash sebelum
aktivasi. Jangan mengunggah ke direktori `current` yang aktif.

## 3. Prasyarat VPS (operator dengan sudo)

Helper mengharapkan:

- Caddy container yang benar meng-mount host directory ke `/data`.
- Caddyfile tervalidasi dan secara eksplisit melayani
  `buattokosendiri.web.id` dari
  `/data/landing/buattokosendiri/current`.
- Di host, `<CADDY_DATA>/landing/buattokosendiri/releases/<SHA>` berisi
  rilis immutable serta manifest lengkap.
- `current` sudah berupa symlink relatif `releases/<SHA_SEBELUMNYA>`.

Jika konfigurasi awal belum mengikuti struktur tersebut, **hentikan**.
Migrasi vhost/struktur aset pertama kali memerlukan review operator terpisah,
backup Caddyfile, dan rollback yang sesuai. Jangan mengubah semua vhost atau
route Gheverhan secara otomatis.

## 4. Aktivasi manual

```bash
sudo bash deploy/activate-static-landing.sh deploy FULL_SHA_40 NAMA_CONTAINER_CADDY
```

Operator memverifikasi nama container dari `docker ps`, bukan menebak.
Sebelum pergantian, helper memvalidasi root domain, manifest, setiap SHA256,
dan membuat backup `/var/backups/btos-landing/`. Pointer `current` diganti
secara atomik, lalu halaman utama, panduan instalasi, serta PDF dicek lewat HTTPS.
Jika verifikasi gagal, pointer lama dikembalikan otomatis. Tidak ada restart
Docker atau perubahan data seller.

Rollback manual ke SHA sebelumnya, hanya setelah melihat daftar rilis dan
riwayat backup:

```bash
sudo bash deploy/activate-static-landing.sh rollback SHA_SEBELUMNYA_40 NAMA_CONTAINER_CADDY
```

Rollback juga membuat backup target sebelumnya dan memvalidasi respons publik.
Jangan menggunakan rollback untuk mengatasi kesalahan konfigurasi Caddy; itu
memerlukan prosedur operator vhost tersendiri.

## 5. Batasan

- Merge Git dan pembuatan paket **bukan** deployment. Versi live tetap lama
  sampai operator melakukan aktivasi.
- Halaman `/pendaftaran` menggunakan endpoint backend `/api/registration` yang
  **tidak** ada dalam repository statis ini. Sebelum cutover, operator wajib
  memastikan reverse proxy untuk API pendaftaran tetap aktif dan sesuai asal
  domain; jangan mengganti route aplikasi secara diam-diam.
- Ini deployment statis; database/OTP/platform registration punya siklus
  deployment dan pengaman masing-masing.
- CI tetap tersedia untuk pengujian manual. Mematikan trigger CI landing
  tidak otomatis mengubah branch protection/ruleset GitHub yang mungkin
  mensyaratkan check proyek lain.
- Jangan memberikan root shell/akses Docker pada akun automation terbatas
  hanya supaya proses ini lebih cepat.
