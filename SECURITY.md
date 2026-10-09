# SECURITY — Presensi Ignasian

> Rilis live saat ini: **v4.9.11** (`main @ cb84ce3`, fase 3 lewat PR #3).
> Dalam pengerasan: **v4.9.12** di `security/hardening-phase-4` (PR belum merge).
> Prinsip: aplikasi live — setiap perubahan runtime diuji `node --check` dan
> dampaknya dicatat di `CHANGE-LOG.md`; perubahan yang menyentuh server
> (rotasi kunci, RLS) hanya sebagai runbook manual.

## 1. Model ancaman

- Frontend statis (GitHub Pages) + Supabase sebagai satu-satunya backend.
- Satu project Supabase dipakai semua perangkat (admin, pengurus, peserta).
- `anon key` wajib publik (di-download tiap HP) — jadi BUKAN rahasia.
- Login & validasi peran berjalan di sisi klien (offline-first).

## 2. Status temuan

| ID | Temuan | Status |
|----|--------|--------|
| K1 | RLS `using (true)` untuk `anon` di 8 tabel (`supabase/schema.sql`) | TERBUKA — ditahan, butuh Edge Function dulu |
| K2 | Kolom `pass_plain` tersinkron ke server | TERBUKA — ditahan, menopang 5 fitur recovery |
| K3 | Tanpa Supabase Auth; seluruh tabel users ditarik ke perangkat | TERBUKA — by design offline-first |
| K4 | Anon key pernah di repo publik | MITIGASI: repo di-private + runbook rotasi di bawah |
| H1 | SHA-256 tanpa salt; password min 6 | SEBAGIAN (fase 2): min 6 → 8 + tolak = username di reset & daftar; salt/KDF butuh server |
| H2 | `fallbackHash` FNV-1a lemah | DITAHAN — menopang mode `file://` |
| H3 | Kredensial default `admin/admin123` dkk | SELESAI (fase 2, v4.9.10): seed.sql tanpa executable; seed mandiri sandi acak + wajib ganti |
| H4 | Tanpa rate limiting / lockout | SEBAGIAN (fase 4, v4.9.12): `LOGIN_FAILED` tercatat (fase 3) + penahan jeda bertingkat sisi peramban (5 gagal → 30 dtk, maks 15 mnt); **lockout sungguhan tetap butuh server** |
| H5 | XSS di `onclick` inline (`waTo('${esc(hp)}')`) | SELESAI (fase 2 + fase 4): `escJs()` saat itu menutup 2 titik; **fase 4 menghapus akar masalahnya** — 143 handler inline jadi delegasi `data-act`, `script-src` tanpa `unsafe-inline` |
| H6 | Presensi bisa dipalsukan via POST langsung | TERBUKA — butuh validasi server |
| H7 | Tanpa Content-Security-Policy | SEBAGIAN (fase 4, v4.9.12): CSP meta aktif; `script-src` ketat, `object-src 'none'`. `style-src` masih `unsafe-inline`; `frame-ancestors` butuh header HTTP |
| M5 | `user_agent` + `location.href` tersimpan permanen di log | SELESAI (fase 3, v4.9.11): `addLog()` tanpa 2 kolom; tidak ada fitur yang membacanya |
| M6 | Tabel `logs` server tumbuh tanpa batas | SELESAI (fase 3, v4.9.11): retensi 90 hari (`bersihkanLogLama()` + `LOG_RETENSI_HARI`) |

## 3. Yang dilakukan

### Fase 1 — fondasi docs (`security/hardening-phase-1`, merge PR #1, v4.9.9)

- Commit 1: `.gitignore` — nol runtime.
- Commit 2: `SECURITY.md` ini — dokumen saja.
- Commit 3: `CHANGE-LOG.md` — dokumen saja.

### Fase 2 — hardening runtime (`security/hardening-phase-2`, v4.9.10)

- Commit 4: nonaktifkan kredensial default (H3) — seed.sql tanpa executable,
  seed mandiri sandi acak + dialog wajib ganti (min 8, ≠ username),
  kolom `harus_ganti_sandi`, reset/daftar min 8. Lihat `CHANGE-LOG.md`.
- Commit 5: `escJs()` untuk konteks string-JS di `onclick` (H5) — 5 fitur
  `passPlain` tetap utuh.
- Commit 6: SRI sha384 + `crossorigin` pada 3 CDN (M1) + bump v4.9.10 /
  SW v33 / `?v=30` agar perangkat mengambil versi baru.

### Fase 3 — privasi log + deteksi login (`security/hardening-phase-3`, v4.9.11)

Commit 7. Dampak live: NOL pada alur — yang berubah hanya isi log & retensinya.
Uji: 24 pemeriksaan statis + perilaku LULUS (skrip scratch lokal
`_edgetmp/verify3.js`; `node --check` bersih).

- **M5**: `addLog()` tanpa `userAgent`/`url` (0 referensi tersisa;
  tidak ada fitur yang membacanya). Kolom DB dibiarkan; baris baru NULL.
- **H4-sebagian**: `LOGIN_FAILED { username, daring }` di cabang login gagal —
  toast & perilaku sama, tanpa lockout. Pantau brute-force di Log Sistem.
- **M6**: retensi 90 hari — `bersihkanLogLama()` sekali saat `loadLocal()`
  (perangkat + `queueDeleteMany` ke server; idempoten). Dua pengaman:
  pengiriman hapus dibatasi **ruang `MAX_QUEUE`** (maks 200/boot) agar tulisan
  presensi yang belum terkirim tidak tergeser; dan catatan **tanpa waktu sah
  TIDAK dihapus** (uji menemukan `Date.parse(0)` = 31 Des 1999, bukan `NaN`,
  sehingga pola `|| 0` akan menua-kan catatan). Batas lewat
  `CONFIG.LOG_RETENSI_HARI` (default 90, override di `js/config.js`).
- **M6 sisi server (opsional)**: `supabase/schema.sql` bagian **3b** —
  `public.bersihkan_log_lama(days)` + `revoke execute … from public, anon,
  authenticated` + panduan penjadwalan (`pg_cron`/manual). Murni tambahan:
  tidak mengubah tabel, RLS, maupun kebijakan.
- Bump: `CONFIG.VERSION` 4.9.10 → 4.9.11, `sw.js` v33 → v34,
  `?v=31` → `?v=32` (config, supabase, app). README riwayat versi diperbarui
  (4.9.10 & 4.9.11).
### Fase 4 — delegasi + CSP + penahan login (`security/hardening-phase-4`, v4.9.12)

Tiga commit: `74e7e34` (4B), `47e487e` (4A), `58e562b` (4C). Dampak live:
rendah — handler tetap berfungsi, yang berubah pengikatannya.
Uji: 23 pemeriksaan statis 4B + 19 uji delegasi, 25 pemeriksaan 4A,
14 uji pembatas login (semua LULUS; skrip scratch `_edgetmp/`).

- **H5 (akar masalah)**: 143 atribut `on<event> inline` menjadi delegasi
  `data-act` + `data-ev` + `data-aN`, dijalankan satu delegasi di
  `js/app.js` seksi 28b. `data-ev` menyimpan jenis event asal — tanpanya
  handler `onerror` ikut terpicu saat diklik dan checkbox `onchange` terpicu
  dua kali. Gelembung inline dipertahankan (naik ke akar, hormati
  `stopPropagation()`, `try/catch` per aksi).
- **H7 (baru)**: meta Content-Security-Policy. `script-src` **tanpa
  `unsafe-inline`** — keempat `<script>` inline dipindahkan ke `js/boot.js`
  dan `js/guard.js` (isi verbatim, urutan dipertahankan).
  `object-src 'none'`, `base-uri`/`form-action 'self'`, `worker-src` untuk
  ZXing, `img-src` memuat host Google Drive (thumbnail dokumentasi).
  SRI sha384 pada 3 CDN tetap berlaku.
- **H4 (lanjutan)**: penahan jeda bertingkat sisi peramban (lihat tabel).
- **Batas yang DICATAT dengan sengaja**:
  - `style-src` masih `'unsafe-inline'` — masih ada 5 atribut `style=` di
    `index.html`, 7 di `js/app.js`, dan satu blok `<style>` untuk `bootVeil`.
  - CSP lewat `<meta>` **mengabaikan `frame-ancestors`**. Bila aplikasi
    di-host di web, kirim kebijakan yang sama lewat header HTTP
    (contoh ada di `_edgetmp/4a-pindah.js`).
  - Dua atribut inline tetap ada dengan sengaja: komentar dokumentasi
    `.pw-eye` dan tombol cetak popup `pdfDocHtml()` yang tidak memuat
    `app.js`, sehingga tidak punya lapisan delegasi.
  - `escJs()` kini tidak terpakai; dipertahankan sebagai utilitas keamanan.
- Bump: `CONFIG.VERSION` 4.9.11 → 4.9.12, `sw.js` v34 → v35,
  `?v=32` → `?v=33` (config, supabase, app, boot, guard).

## 4. Runbook rotasi anon key (MANUAL — jam sepi)

> **STATUS: SUDAH DILAKUKAN** — kunci `sb_publishable_…` baru sudah aktif di
> `js/config.js` (commit `2aa33ed`, `?v=30` → `?v=31` pada `e868d45`) dan
> pengujian live oleh pengguna bersih (tanpa galat, seluruh fungsi jalan).
> Langkah 1-8 di bawah disimpan sebagai prosedur untuk rotasi berikutnya.

> Lakukan SETELAH Commit 1-3 di-merge + terdeploy. Satu deploy saja.

1. Pilih jam sepi (tidak ada jadwal presensi berjalan).
2. Buka Supabase Dashboard project `tpafocyfburbgrxyfgni`.
3. Legacy JWT: `Project Settings > JWT Keys > Rotate Keys`.
   Baru (`sb_publishable_`): `Project Settings > API Keys > Create new publishable key`.
   JANGAN Revoke kunci lama dulu.
4. Update `js/config.js` dengan kunci baru, naikkan `?v=` di `index.html`
   satu angka, commit, push ke `main`, pastikan GitHub Pages terdeploy.
5. Umumkan ke user: "buka aplikasi sekali saat online".
6. Tunggu 1-2 hari, pastikan sinkronisasi jalan (cek tabel `presensi` bertambah).
7. Kembali ke dashboard > kunci lama > `... > Revoke` (legacy) atau `Delete old key`.
8. Sejak itu pemegang kunci lama mendapat `401 Unauthorized`.

Kenapa aman untuk live: login & scan QR tetap jalan offline (hash lokal);
sync antre di `outbox` dan jalan lagi setelah kunci baru terambil
(`config.js?v=` memakai strategi network-first di `sw.js`).

## 5. Yang SENGAJA tidak dikerjakan fase ini

- `REVOKE FROM anon` / kunci RLS (**K1**) — mematikan sync semua perangkat.
- Hapus `pass_plain` (**K2**) — mematikan 5 fitur recovery akun.
- Supabase Auth (**K3**) — login offline menjadi mustahil.
- Hapus `fallbackHash` (**H2**) — mode `file://` ikut mati.
- CSP ketat / unique constraint presensi — butuh refactor & dedupe.

Butuh sisi server (ditahan sampai ada Edge Function/Auth — Fase B):

- **H4 penuh** (rate limit + lockout akun): fase 3 baru *mencatat*
  `LOGIN_FAILED`; kunci akun harus diputuskan server agar tidak dapat
  dilewati dari klien.
- **H6** validasi presensi di server: QR/gate harus diverifikasi di server
  supaya POST langsung tidak dianggap sah.
- **M6 penuh** (retensi otomatis tanpa campur tangan): fase 3 menyiapkan
  `public.bersihkan_log_lama()` di `supabase/schema.sql` bagian 3b; tinggal
  dijadwalkan (`pg_cron` / Database → Cron) oleh Administrator.

