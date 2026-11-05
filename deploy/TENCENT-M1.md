# Operasi platform M1 pada Tencent

Target operator adalah ubuntu@43.173.41.24 dengan alias bts-tencent-m1 dan
host key ED25519 yang diverifikasi. VPS yang sama masih melayani Hubify melalui
proxy Docker single-store-proxy-1 pada 80/443. Platform menggunakan proyek Compose
btos-platform, database dan jaringan tersendiri, serta 127.0.0.1:8088. Jangan
menjalankan installer seller pada Tencent platform atau Helipod.

## Rilis dan pemeriksaan

1. Build lokal dengan npm ci dan npm run build. Uji database disposable.
2. Tempatkan checkout Git dari SHA yang ditinjau di
   /opt/btos-platform/releases/<SHA>. Verifikasi remote asal dan SHA, lalu
   jalankan sudo bash deploy/activate-platform.sh <SHA> dari checkout tersebut.
3. Cek curl -fsS http://127.0.0.1:8088/api/platform/health. Pemeriksaan DB
   sukses berbeda dari konfigurasi OTP dan persetujuan rilis.
4. Untuk UI dari workstation, jalankan
   ssh -N -L 8088:127.0.0.1:8088 bts-tencent-m1.
   Buka http://127.0.0.1:8088/ untuk melihat halaman. Uji cookie Secure melalui
   HTTPS dengan nama produksi, bukan browser HTTP pada tunnel.
5. Periksa docker logs btos-platform-app-1, docker stats --no-stream, free -m,
   dan df -h /. Pastikan endpoint Hubify /api/v1/ready tetap sehat.

Konfigurasi platform berada di /etc/btos-platform. Isi RESEND_API_KEY dan
RESEND_FROM di runtime.env lewat editor sudo pada server, dari secret dan
alamat pengirim yang sudah diverifikasi. Jangan menyalin secret melalui chat
atau ke Git. Buat ulang container app untuk menerapkan env. Daftar rilis
approved-releases.json berisi array {repository,version,sha,approved}. Masukkan
hanya tag semver rilis publik yang disetujui, commit penuh yang cocok, dan
approved=true. Array kosong menutup bootstrap dan pairing dengan aman.
Uji pengiriman OTP ke kotak masuk berizin serta instalasi pada VPS disposable
yang kosong dan domain uji berizin sebelum rilis dibuka ke seller.

## Backup dan rollback

Aktivasi menyimpan snapshot konfigurasi serta pg_dump platform yang sudah
ada ke /var/backups/btos-platform, hanya dapat dibaca root. Buat backup rutin
ke lokasi terlindungi. Verifikasi struktur dump dengan pg_restore --list.
Snapshot hash Caddy Hubify dipakai untuk memastikan routing tidak berubah.
Untuk rollback rilis berikutnya, jalankan deploy/rollback-platform.sh dengan
path backup yang menyimpan SHA sebelumnya. Migrasi M1 bersifat aditif.
Rollback pertama cukup hentikan app platform tanpa menghapus database.
Pemulihan data perlu target database terpisah, pengujian restore, serta
keputusan operator sebelum mengganti data aktif.

## DNS dan HTTPS

Audit 5 November 2026 menemukan A staging.buattokosendiri.web.id menuju
43.173.41.24. Caddy aktif hanya mengenal Hubify, dan penyimpanan sertifikatnya
hanya memuat Hubify. File dan volume bernama staging yang dipakai deployment
Hubify dipertahankan. Periksa juga callback eksternal di akun operator.
Di DomainNesia, hapus hanya record A host staging dengan target tersebut
setelah dipastikan tidak dipakai integrasi. Verifikasi jawaban authoritative.
Jangan menghapus zona atau menyentuh @, www, dashboard maupun record email.

Cutover utama perlu persetujuan operator setelah OTP, instalasi disposable,
backup, rollback, dan pemetaan backend lama terbukti. Siapkan TLS DNS-01 dengan
sertifikat yang sah, atau rencanakan penerbitan ACME setelah DNS menunjuk Tencent.
Caddyfile.production adalah fragmen vhost. Jangan mengganti Caddyfile Hubify.
Cadangkan file routing dengan izin root. Hubungkan proxy yang ada ke jaringan
web platform saat integrasi routing diotorisasi, validasi gabungan dengan
caddy validate, reload, lalu pastikan Hubify tetap sehat. Atur TRUST_PROXY=1
hanya setelah forwarding dari proxy tepercaya diverifikasi. Pertahankan
bind localhost selama verifikasi. Gunakan curl --resolve dengan TLS valid
untuk menguji Host/SNI ke Tencent sebelum perubahan DNS jika sertifikat tersedia.

Setelah persetujuan, ubah A @ dari 43.173.21.197 ke 43.173.41.24. Pertahankan
CNAME www dan semua record lain. Verifikasi authoritative dan resolver publik,
HTTPS, landing, wizard, OTP, PDF, serta Hubify. Jika gagal, kembalikan A @
ke 43.173.21.197, konfirmasi Helipod tetap dapat melayani, lalu batalkan routing
platform dengan snapshot setelah perubahan DNS terpropagasi. Pertahankan backup
registrasi lama dan evaluasi konsistensi data yang ditulis selama cutover.
