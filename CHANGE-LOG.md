# CHANGE-LOG — hardening keamanan

> Revert per commit: `git revert <hash>` (hash ada di `git log --oneline`).

## Fase 1 — fondasi docs (`security/hardening-phase-1`, sudah merge PR #1)

Basis: `main @ 84866e5` (v4.9.9). Prinsip: NOL dampak runtime.

### Commit 1 — `chore: add .gitignore` (`3ba6b16`)
- Berkas: `.gitignore` (baru).
- Isi: `js/config.local.js`, `.env*`, `*.log`, artefak OS/editor, `_edgetmp/`.
- Dampak live: NOL (tidak dibaca browser).

### Commit 2 — `docs: add SECURITY.md` (`df54690`)
- Berkas: `SECURITY.md` (baru).
- Isi: model ancaman, tabel status temuan K1-H6, runbook rotasi kunci,
  daftar hal yang SENGAJA tidak dikerjakan.
- Dampak live: NOL (dokumen).

### Commit 3 — `docs: add CHANGE-LOG.md` (berkas ini, `7d5ad3b`)
- Dampak live: NOL (dokumen).

## Fase 2 — hardening runtime (`security/hardening-phase-2`, v4.9.10)

### Commit 4 — `fix(security): disable default credentials` (`73503f1`)
- `supabase/seed.sql`: SELURUH executable dihapus — kini hanya komentar
  panduan + SELECT verifikasi read-only. Verifikasi: 0 baris executable.
- `js/app.js` `seedDefaultUsers()`: tanpa `pass` hardcoded; sandi awal acak
  10 karakter per-perangkat + flag `harusGantiSandi: true`.
- `js/app.js` `doLogin()`: akun berflag dialihkan ke dialog kunci
  `wajibGantiSandi()` (tanpa Tutup/Batal; klik-luar & Esc diblokir;
  tombol Keluar tetap ada). Syarat sandi baru: min 8, ≠ username.
- `supabase/schema.sql`: `alter table users add column harus_ganti_sandi
  boolean default false` (idempoten). `js/supabase.js`: field mapping baru.
- `simpanResetPassword` & `submitDaftar`: min 6 → 8 + tolak = username.
- `README.md` Langkah 3 ditulis ulang (tanpa tabel password).
- Dampak live: RENDAH — login normal tak tersentuh; hanya mode mandiri
  melihat 1 layar tambahan sekali saat login pertama.

### Commit 5 — `fix(security): escape JS string contexts` (H5)
- Helper baru `escJs()` (split/join, tanpa regex): amankan backslash, kutip,
  CR/LF, U+2028/2029, `<`/`>` untuk nilai dalam `onclick="waTo('...')"`.
- 2 titik (daftar password + hasil reset) `esc()` → `escJs()`.
- Uji: 9/9 payload round-trip `eval()` PASS + `node --check` bersih.
- 5 fitur `passPlain` tetap utuh. Dampak live: NOL.

### Commit 6 — `chore: SRI + bump v4.9.10`
- `index.html`: `integrity` sha384 + `crossorigin="anonymous"` pada 3 CDN
  (leaflet 1.9.4, qrcodejs 1.0.0, html5-qrcode 2.3.8). Hash dihitung dari
  berkas live per 2026-10-02 — hitung ulang bila naik versi pustaka.
- Bump: `CONFIG.VERSION` 4.9.9 → 4.9.10, `sw.js` v32 → v33,
  `?v=29` → `?v=30` (config, supabase, app).
- CSP ketat SENGAJA tidak dikerjakan (butuh refactor inline handler).
- Dampak live: SANGAT RENDAH — mohon buka app sekali di HP: pastikan peta,
  QR scanner, dan sync normal; bila CDN diblokir, SRI menolak script
  (lihat Console) — laporkan bila itu terjadi.

## Fase 3 — privasi log + deteksi login (`security/hardening-phase-3`, v4.9.11)

Rilis ini menyentuh berkas yang sudah live, tetapi **tidak ada satu pun alur
yang berubah** — hanya *isi* log dan retensinya. Uji: 24 pemeriksaan statis +
perilaku LULUS (`node --check` bersih). Skrip uji = scratch lokal
`_edgetmp/verify3.js` (dir `_edgetmp/` ada di `.gitignore`, tidak ikut repo).

### Commit 7 — `fix(security): redact log PII, log failed logins, log retention`
> Hash commit terbaru: lihat `git log --oneline -1` (commit tidak dapat
> memuat hash-nya sendiri).
- **M5 (privasi)** — `js/app.js` `addLog()` tidak lagi menyimpan `userAgent`
  & `url`. Verifikasi: 0 sisa referensi `navigator.userAgent`/`location.href`
  di seluruh `js/app.js`. Kolom DB dibiarkan ada (skema kompatibel; baris baru
  bernilai NULL) sehingga tidak ada perangkat lama yang rusak.
- **H4 sebagian** — `doLogin()` mencatat `LOGIN_FAILED`
  `{ username, daring }` pada cabang gagal. Toast & alur tetap identik
  (uji memastikan teks `Username/password salah` masih ada); **tanpa** lockout.
- **M6 (retensi)** — `bersihkanLogLama()` dipanggil sekali dari `loadLocal()`;
  membuang log > `CONFIG.LOG_RETENSI_HARI` (default 90) lalu
  `queueDeleteMany('logs', …)` agar ikut terhapus di server. Dua pengaman:
  1. **ruang antrean** — hanya mengirim selama `MAX_QUEUE` masih punya tempat
     (maks 200/boot) supaya tulisan presensi/jadwal yang belum terkirim saat
     luring panjang tidak tergeser keluar antrean; sisa baris tetap ditandai
     kubur agar tidak "hidup kembali" dari tarikan cloud;
  2. **waktu tak sah tidak dihapus** — uji menemukan jebakan `Date.parse(0)`
     yang menghasilkan **31 Des 1999** (bukan `NaN`), sehingga pola
     `Date.parse(x || 0) || 0` akan "menua-kan" catatan tanpa waktu. Kini hanya
     teks tanggal sah yang diparse; catatan tanpa waktu sah dipertahankan.
- **M6 (server, opsional)** — `supabase/schema.sql` bagian **3b**:
  `public.bersihkan_log_lama(hari integer default 90)` + `revoke execute … from
  public, anon, authenticated` + panduan penjadwalan harian. Murni tambahan
  (tidak mengubah tabel/RLS/kebijakan) — **jalankan ulang `supabase/schema.sql`**
  bila ingin pembersihan server otomatis.
- **Naik versi** — `CONFIG.VERSION` 4.9.10 → 4.9.11; `sw.js` v33 → v34;
  `?v=31` → `?v=32` (`config.js`, `supabase.js`, `app.js`).
- **Berkas**: `js/app.js`, `js/config.js`, `index.html`, `sw.js`,
  `supabase/schema.sql`, `SECURITY.md`, `CHANGE-LOG.md`, `README.md`.
- **Dampak live**: NOL pada alur; yang berubah hanya isi log + retensi.
- **Revert**: `git revert <hash Commit 7>` (bila `supabase/schema.sql` sudah
  dijalankan, fungsi `bersihkan_log_lama` cukup dibiarkan — tidak dipakai
  aplikasi).
## Fase 4 — CSP ketat + delegasi aksi (`security/hardening-phase-4`, v4.9.12)

Tiga commit. Dampak live: RENDAH pada alur — handler tetap berfungsi, hanya
mekanisme pengikatan dan Kebijakan sumber daya yang berubah.

### Commit 8 — `refactor(security): ganti 143 handler inline dengan delegasi data-act` (`74e7e34`)

- **Berkas**: `index.html`, `js/app.js`.
- 143 titik `on<event>="…"` (68 di `index.html`, 75 di `js/app.js`) menjadi
  `data-act="aksi" data-ev="jenis" data-aN="argumen"`.
- Satu delegasi di `js/app.js` seksi **28b** mengganti seluruh listener
  per-elemen: `IGN_ACTS` (85 aksi) + `delegasiAksi()` yang dikaitkan di
  `bindEvents()`. Penanda `@self`, `@self.checked`, `@null`, `@false`,
  `@event` diterjemahkan jadi nilai nyata.
- **`data-ev` itu wajib.** Tanpa itu jenis event asal hilang: gambar yang
  handler-nya dari `onerror` ikut terpicu saat diklik, dan checkbox
  `onchange` terpicu dua kali (klik + ubah). Terdapat 57 pasangan bersarang
  berbeda jenis di `index.html`.
- Gelembung inline dipertahankan: delegasi naik dari elemen sasaran ke akar
  dan menjalankan tiap `data-act` yang cocok, terputas bila ada aksi memanggil
  `stopPropagation()` (aksi gabungan `qrSesiStop`). Kegagalan satu aksi
  dibungkus `try/catch` agar tak mematikan aksi lain.
- Dua atribut inline **sengaja** tersisa: komentar dokumentasi `.pw-eye` dan
  tombol cetak di dokumen popup `pdfDocHtml()` yang tidak memuat `app.js`.
- Empat `data-act` lama (`pw`/`reset`/`toggle`/`del`) dibiarkan tanpa
  `data-ev` sehingga dilewati pendelegasian.
- `escJs()` kini tidak terpakai (konteksnya berubah dari string-JS menjadi
  atribut HTML); fungsi dipertahankan sebagai utilitas keamanan.
- **Uji**: 23 pemeriksaan statis + 19 uji fungsional delegasi (DOM tiruan).

### Commit 9 — `feat(security): Content-Security-Policy ketat tanpa unsafe-inline script` (`47e487e`)

- **Berkas**: `index.html`, `js/app.js`, `sw.js`, `js/boot.js` (baru),
  `js/guard.js` (baru).
- Keempat `<script>` inline dipindahkan ke berkas luar **verbatim**, urutan
  dipertahankan (`boot.js` tetap sinkron di `<head>`; `guard.js` tetap
  setelah pustaka CDN dan sebelum `app.js`).
- Meta CSP: `script-src` **tanpa `unsafe-inline`**; `object-src 'none'`;
  `base-uri`/`form-action 'self'; `worker-src 'self' blob:` (ZXing);
  `img-src` memuat host Google Drive karena thumbnail dokumentasi dimuat
  sebagai `<img>`.
- `sw.js`: kedua berkas baru masuk precache, `VERSION` v34 → v35.
- **Batas yang diketahui**: `style-src` masih memuat `'unsafe-inline'`
  (masih ada 5 atribut `style=` di `index.html`, 7 di `js/app.js`, dan satu
  blok `<style>` untuk `bootVeil`). Menghapusnya perlu refactor CSS tersendiri.
  CSP lewat `<meta>` juga **mengabaikan `frame-ancestors`** — kirim kebijakan
  yang sama lewat header HTTP bila aplikasi di-host di web.
- **Uji**: 25 pemeriksaan (tanpa script inline, script-src ketat, seluruh
  script/CSS/CDN/host tercakup, baseline keamanan, cache SW, sintaks).

### Commit 10 — `feat(security): penahan login gagal bertingkat` (`58e562b`)

- **Berkas**: `js/app.js` (seksi 11a + `doLogin()`).
- Menutup H4: sebelum membandingkan kata sandi, jeda bila nama pengguna
  tersebut sudah 5 kali gagal. Jeda naik bertahap 30 dtk → 60 dtk → … → maks
  15 mnt; satu percobaan berhasil menghapus riwayat; kunci tidak membedakan
  huruf besar-kecil; pesan tidak membocorkan apakah nama terdaftar.
- Sifat: hanya di memori (per tab), dan **bukan lockout** — lockout sungguhan
  butuh sisi server (Fase B).
- **Uji**: 14 uji fungsional dengan jam tiruan.

### Ringkasan Fase 4

- **Naik versi** — `CONFIG.VERSION` 4.9.11 → 4.9.12; `sw.js` v34 → v35;
  `?v=32` → `?v=33` (termasuk `js/boot.js` & `js/guard.js`).
- **Berkas**: `index.html`, `js/app.js`, `sw.js`, `js/boot.js` (baru),
  `js/guard.js` (baru), `SECURITY.md`, `CHANGE-LOG.md`, `README.md`.
- **Dampak live**: rendah. Semua alur tetap bekerja; yang berubah adalah
  pengikatan event dan allowable sumber daya.
- **Revert**: `git revert <hash>` per commit di atas (urutan dibalik:
  10 → 9 → 8).

