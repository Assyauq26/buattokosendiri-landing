# Buat Toko Online Sendiri — Platform Pusat M1

Platform pusat untuk landing, pendaftaran seller melalui OTP, wizard instalasi,
dan pemantauan provisioning. Jalankan satu deployment platform permanen pada
Tencent 43.173.41.24. Hubify adalah lingkungan pengembangan aplikasi toko.
Installer, database toko, storefront, dan dashboard tetap dikelola oleh
repository Assyauq26/buattokoonline dan berjalan pada VPS masing-masing seller.

- /pendaftaran/ — registrasi atau login seller dan wizard instalasi.
- /panduan-instalasi/ — panduan lengkap dan PDF.
- /api/platform/ — API platform, session seller, dan protokol agent.
- /bootstrap.sh — bootstrap HTTPS, hanya tersedia bila rilis disetujui.

Untuk pengembangan lokal gunakan Node 24+, PostgreSQL terpisah, dan npm ci.
Jalankan npm run build. Uji integrasi membutuhkan TEST_DATABASE_URL yang
mengarah ke database disposable bernama platform_m1_test, lalu npm test.
Pengiriman email dalam uji lokal menggunakan adapter di memori.

Gunakan [runbook Tencent](deploy/TENCENT-M1.md) untuk aktivasi, backup, dan
cutover DNS. Push dan PR tidak menjalankan CI atau deploy secara otomatis.
Data pendaftaran lama tetap pada backend asal sampai proses ekspor/migrasi
dan kebijakan aksesnya ditetapkan.
