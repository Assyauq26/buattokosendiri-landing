# Dashboard pusat dan identitas instalasi

Audit dan kandidat implementasi, 11 November 2026.

## Kondisi yang diperiksa

| Komponen | Kondisi aktual |
| --- | --- |
| Platform publik | Container aplikasi dari ea945b47be4340b67d18ff9716ef9cc93ec92d0d |
| Relay WhatsApp | Branch sumber codex/updater-openwa-control, fc5d08d |
| Hubify | Aplikasi aktif 87e0783b9ccfe3b3239a311cfb7a9fc8047f8f66 |
| Main platform | e5ff243901dd9df136de877f88da0149832a826d |
| Main toko | cc4e42e34044dc327094258abb2583bbd4d1f6ca |
| Akses operator | SSH bts-tencent-m1 tersedia dengan sudo |
| Health publik | Platform ok, otpConfigured dan installerEnabled true. Hubify ready |
| Super Admin yang ditetapkan pemilik | Akun sudah terverifikasi melalui platform. Alamat ditetapkan melalui console server |
| OpenWA | ghcr.io/rmyndharis/openwa pada digest 3902f1bc22744dd46b07f010653e345001832d8b79fdbe76d057869b378d186c |

Pemeriksaan server memakai metadata container, health, serta keberadaan akun.
Pengujian agent di server memakai direktori temporer dan mock, tanpa menjalankan installer.
Kredensial provider dan data chat tidak diambil sebagai bukti.

## Peta sistem

Platform memakai Node HTTP, PostgreSQL dan frontend HTML/JavaScript existing.
Seller masuk menggunakan OTP email. stores.id merupakan tenant immutable dan
stores.seller_id merupakan pemilik tunggal pada kontrak M1 saat ini.
Agent keluar melalui HTTPS, membawa credential khusus instalasi.
Installer memilih tag dan commit aplikasi yang telah disetujui.

Email relay memakai token per toko dan registry internal platform.
Alamat pengirim tetap otp@buattokosendiri.web.id. Resend key berada pada layanan operator.
Gateway WhatsApp berada di service tersendiri dengan schema whatsapp_pilot dan role btos_whatsapp.
Updater lokal memakai katalog Ed25519 dan worker terbatas yang sudah ada.
Customer, transaksi, dan database toko tetap berada pada instalasi masing-masing.

## Temuan

| Masalah | Akar penyebab | Implementasi |
| --- | --- | --- |
| Nama toko tertolak saat disimpan | Pemeriksaan registry menjadi prasyarat publish lokal | Publish dan event sinkronisasi disimpan dalam transaksi yang sama |
| Relay menolak email selama nama berbeda | Nama request dibandingkan dengan registry lama | Tenant dinamis memakai identitas registry terakhir untuk mengirim |
| Nama dari event terlambat berpotensi menimpa | Registry belum memiliki revision nama | Revision monoton, repeat idempoten, konflik mendapat 409 |
| Pairing memerlukan dua kali penyalinan | Token diminta melalui getpass | Satu blok heredoc, token masuk melalui stdin |
| Pengulangan setup setelah respons hilang | Credential lokal belum dikaitkan dengan percobaan enrollment | Credential dan hash percobaan disimpan sebelum network |
| Pusat belum memiliki operator RBAC | Session pusat hanya membedakan seller | Role Super Admin, Operator, Support dengan pemeriksaan server |
| Reset kehilangan riwayat atau mengunci registrasi | Satu row agent/job per toko | Histori operasional diarsipkan, slot aktif dibuka kembali |
| Agent/updater mempunyai identitas terpisah | Bootstrap updater membuat ID acak sendiri | Instalasi baru menggunakan UUID agent dalam representasi hex updater |
| Status aplikasi setelah update tidak terlihat | Evidence instalasi hanya snapshot penyelesaian | Observasi agent terpisah dari evidence saat instalasi selesai |

## Perilaku produk yang tersedia

- /admin/ menampilkan registry tenant, pencarian, filter status/versi/heartbeat,
  pagination server-side, detail pemilik, observasi, instalasi dan audit.
- Role operator hanya diberikan melalui console tepercaya kepada seller yang sudah
  memverifikasi email. Role runtime tidak boleh mengubah tabel pemberian akses.
- Retry hanya untuk instalasi gagal atau menunggu DNS dengan agent yang sah.
- Reset memerlukan Super Admin, OTP terakhir kurang dari 15 menit, alasan, ID tenant,
  serta installation ID yang masih sesuai.
- Reset mengarsipkan metadata job/event, mencabut credential lama, menaikkan generation,
  merotasi token mail, dan mempertahankan tenant, akun, konfigurasi serta domain.
  Tidak ada perintah filesystem dalam reset registry.
- Lepas IPv4 hanya mengosongkan konfigurasi pusat. Agent dan riwayat IP tetap terlihat.
  Perubahan ini ditolak selama ada instalasi yang belum selesai.
- Seller dapat membuat permintaan reinstall, domain, ownership, tutup toko,
  penghapusan akun, uninstall dan purge. Operator dapat mencatat hasil tinjauan atau penolakan.
- WhatsApp pusat/seller dan agregat antrean tujuh hari berasal dari view read-only.
  Nomor hanya ditampilkan empat digit terakhir. Tidak ada chat atau token pada projection.
- Pause WhatsApp tenant menaikkan generation dan membatalkan antrean queued tenant tersebut.
  Pengiriman yang sudah diteruskan ke provider tetap mengikuti hasil aktual provider.
- Katalog rilis diperiksa dengan trust Ed25519 existing sebelum ditampilkan.

## Status milestone

| Milestone | Hasil kandidat |
| --- | --- |
| M0 | Audit, peta sistem, akar masalah dan dependency tersedia |
| M1 | Role, pemeriksaan akses, reauthentication, audit, identitas generation tersedia |
| M2 | Event lokal transaksional, retry/backoff, registry revision dan sender fallback tersedia |
| M3 | Enrollment dan updater memakai identitas baru yang konsisten. Instalasi legacy dilaporkan dengan alias updater existing |
| M4 | Wizard menghasilkan satu blok. Legacy pairing tetap kompatibel |
| M5 | Dashboard tenant, rilis, observasi health lokal, updater dan backup tersedia |
| M6 | Reset/reinstall registration dan lepas IP tersedia. Operasi domain/owner/deletion dicatat sebagai permintaan |
| M7 | Registry email, observasi WA, agregat queue, pause/resume per tenant tersedia |
| M8 | Pengujian lokal dan browser tersedia. Pilot deployment dan instalasi fresh-VPS penuh belum dijalankan |

## Batas implementasi yang masih harus diselesaikan

Permintaan domain, transfer owner, penutupan, penghapusan akun, uninstall dan purge
belum mempunyai executor. Status reviewed hanya menyatakan tinjauan operator.
UI tidak menampilkan operasi tersebut sebagai completed.

Model durable teardown dengan requested, scheduled, executing, partially_completed,
completed dan failed masih perlu dibangun bersama executor agent ber-capability.
Penghapusan data lokal serta cutover database antar-VPS belum tersedia.
Kontrol QR pusat, reconnect/logout dari dashboard operator, pause global, retry queue
operator dan pengaturan retensi/feature flag belum dipindahkan dari fasilitas operator existing.
Transport job updater tetap lokal. Pusat hanya menerima laporan state terakhirnya.
Restore backup belum dilaporkan sebagai bukti oleh agent. Timestamp backup hanya bukti manifest tersedia.
MFA TOTP/WebAuthn belum didukung oleh autentikasi platform existing.

## Threat model

| Ancaman | Pengamanan kandidat | Batas bukti |
| --- | --- | --- |
| Seller menebak tenant ID | API ops memeriksa role dari database, seller request memakai seller_id sesi | Pengujian lokal |
| Support menjalankan reset | Role hanya baca dan pemeriksaan ulang di transaksi | Ditolak pada tes |
| CSRF dan sesi operator lama | Origin exact dan OTP reauthentication 15 menit | Ditolak pada tes |
| Dua VPS memakai token yang sama | Store/token row lock, credential lokal berbeda ditolak | Tes consume bersamaan |
| Respons enrollment hilang | Ulang credential yang sama, hash token lokal, consume idempoten | Tes backend dan agent Linux mock |
| Agent lama kembali setelah reset | Hash credential keluar dari registry aktif, generation bertambah | Tes penolakan request dan enrollment ulang |
| Nama lama datang terlambat | Revision pusat serta CAS acknowledgment lokal | Tes concurrency |
| Seller mengirim sebagai toko lain | Token dan origin menentukan registry, request brand tidak menentukan From | Tes relay |
| URL health dipakai untuk SSRF | Agent memakai endpoint loopback tetap, tanpa redirect | Tidak ada arbitrary URL probe |
| Pencurian provider key | Toko hanya menerima scoped relay token, status UI tanpa secret | Audit kode dan tes relay |
| Reset registry menghapus transaksi VPS | Reset hanya transaksi metadata pusat | Tes preservasi objek dan audit |

## Review UI

| Before | After | Why |
| --- | --- | --- |
| Error registry menggagalkan simpan nama | Nama tersimpan dengan status sinkronisasi | Seller dapat melanjutkan pengaturan |
| Token dan perintah disalin terpisah | Satu blok pribadi dengan masa berlaku | Mengurangi langkah terminal |
| Belum ada halaman operator | Tenant, filter URL, detail, riwayat, role dan tindakan tersedia | Operator dapat meninjau data aktual |
| Bukti lama tidak membedakan sumber | Target rilis, evidence selesai dan observasi terbaru diberi label terpisah | Status terlambat dapat dikenali |
| Operasi sensitif tidak memiliki dampak yang jelas | Alasan, scope, ID dan hasil aktual ditampilkan | Mengurangi salah sasaran |

## Aktivasi dan recovery

1. Review dua branch beserta dependency PR WhatsApp/updater sebelumnya.
2. Siapkan backup platform dan toko, uji restore pada salinan database.
3. Terapkan schema platform memakai migration role. Runtime memakai grant yang terbatas.
   Jika schema WA sudah ada, migration membuat projection read-only untuk dashboard.
4. Deploy controller platform dan relay kandidat terlebih dahulu. Pertahankan blok publik
   /api/platform/internal/* dan routing /api/platform/store-mail/status existing.
5. Masuk OTP melalui platform untuk akun Super Admin yang telah ditetapkan.
   Dengan DATABASE_URL migration role yang hanya ada di server, jalankan
   node server/ops-grant.mjs EMAIL_OPERATOR_TERVERIFIKASI super_admin.
   Command tersedia dalam image platform. Gunakan service migrate dengan command override.
6. Terapkan migration toko 20261111090000_store_mail_brand_sync, lalu build dan aktifkan
   aplikasi toko kandidat. Timer maintenance existing menjalankan retry nama.
7. Upgrade agent secara terkontrol melalui bootstrap yang telah diverifikasi.
   Instalasi legacy mempertahankan database, credential updater dan histori.
8. Uji canary nama toko, outage/retry, sender From, OTP, observasi, dan installer satu-paste.
   Enrollment fresh-VPS penuh memerlukan VPS disposable yang diotorisasi.

Token di blok terminal bersifat sekali pakai dan berlaku 15 menit. Perlakukan riwayat
terminal sebagai data sensitif selama jendela tersebut. Token tidak dikirim sebagai URL
atau argumen proses. Hash dan credential permanen disimpan root-only.

Code rollback mempertahankan schema additive dan arsip instalasi. Registry aktif tetap
menyimpan maksimal satu agent dan satu job sehingga controller lama tidak membaca
beberapa instalasi sebagai slot aktif. Trigger generation mendukung enrollment dari
controller lama. Controller lama tidak menyediakan antarmuka riwayat baru.
Jangan menjalankan migrasi schema lama ketika rollback karena dapat mengembalikan
grant database yang lebih luas. Gunakan rollback image aplikasi tanpa database restore.

Toko versi lama tidak membaca event sinkronisasi baru. Selama rollback, hentikan pengeditan
nama sementara melalui pengendalian operasional dan pertahankan event untuk forward recovery.
Token relay hasil rotasi tidak dikembalikan ke token lama. Recovery menerbitkan credential
baru melalui agent sah. Database restore memerlukan penilaian transaksi baru tersendiri.

## Bukti kandidat

- Platform source/build dan 13 tes backend terkait lulus.
- Toko typecheck, production build dan 22 tes terarah lulus.
- Relay HTTP/SQLite existing, 7 tes lulus.
- Updater existing, 34 tes lokal lulus.
- Agent Linux, 7 tes mock dalam direktori temporer lulus.
- Browser nyata dengan database disposable, 360/390/430/1440 px lulus.
- Screenshot platform berada di output/operations dan toko di output/store-identity.
- Simpan nama dan reload, event persisten, pencarian/detail, akses anonim, empty state,
  serta overflow responsif diperiksa melalui entry point normal.

Keseluruhan brief masih berstatus NOT READY untuk rilis penuh karena executor lifecycle,
kontrol operator WA lengkap, pilot email nyata baru dan fresh-VPS end-to-end belum selesai.
Kandidat ini dapat ditinjau dan diuji untuk milestone yang tersedia.
