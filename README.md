# Presensi Ignasian

Presensi digital berbasis QR dengan semangat Ignatian — **Ad Maiorem Dei Gloriam**.
Aplikasi PWA statis (tanpa build step) dengan prinsip **luring lebih dahulu
(offline-first)**: semua data ditulis ke **IndexedDB** di perangkat, lalu
disinkronkan ke **Supabase** saat perangkat kembali daring.

---

## 1. Ringkasan arsitektur data

```
Pindai QR / kelola akun / jadwal
        │
        ▼
  IndexedDB (perangkat)  ◄── sumber kebenaran saat luring
        │  antrean (outbox) berurutan
        ▼
  Supabase  (Postgres + REST/PostgREST)   ← tabel: users, jadwal, presensi, logs
        │  tarikan berkala (60 detik / saat kembali daring)
        ▼
  DIGABUNG (merge) — perubahan lokal yang belum terkirim selalu menang
```

* Tidak ada data yang hilang saat sambungan putus: operasi disimpan dulu di
  perangkat, baru dikirim ketika daring.
* Operasi yang gagal permanen (mis. data tidak sah) **tidak** menghambat
  antrean: digeser ke belakang dengan jeda bertambah, dan tidak pernah dibuang.
* Peran akun tetap tiga: **Admin / Pengurus / Peserta** (kolom `role`).

---

## 2. Struktur berkas

| Berkas | Isi |
|---|---|
| `index.html` | Kerangka aplikasi (PWA), memuat `config.js` → `supabase.js` → `db.js` → `icons.js` → `app.js` |
| `js/config.js` | **Satu-satunya tempat pengisian** `SUPABASE_URL`, `SUPABASE_ANON_KEY`, dan penyetelan sinkronisasi |
| `js/supabase.js` | Lapisan data Supabase (REST/PostgREST): ambil, simpan (upsert), hapus, diagnostik, penerjemahan kolom |
| `js/db.js` | Database perangkat (IndexedDB) |
| `js/app.js` | Inti aplikasi: masuk/keluar, presensi QR, jadwal, laporan, log, outbox sinkron |
| `sw.js` | Service worker (app shell luring, versi cache) |
| `supabase/schema.sql` | Skema tabel + indeks + trigger + RLS (idempoten) |
| `supabase/seed.sql` | (Opsional) tiga akun awal: admin, pengurus, peserta |

---

## 3. Langkah deploy (±10 menit)

### Langkah 1 — Buat proyek Supabase
1. Masuk ke <https://supabase.com> → **New project**.
2. Simpan **Project ref**, lalu buka **Project Settings → API** dan catat:
   * **Project URL** → `https://<project-ref>.supabase.co`
   * **anon public** key
   * (Jangan pakai `service_role` key di aplikasi ini.)

### Langkah 2 — Jalankan skema
1. Buka **SQL Editor → New query**.
2. Tempel seluruh isi `supabase/schema.sql` → **Run**.
   Skrip ini aman dijalankan berulang dan membuat tabel `users`, `jadwal`,
   `presensi`, `logs`, indeks, trigger `updated_at`, lalu mengaktifkan RLS.

### Langkah 3 — (Opsional) Akun awal
Jalankan `supabase/seed.sql` untuk membuat tiga akun contoh:

| Peran | Username | Kata sandi |
|---|---|---|
| Administrator | `admin` | `admin123` |
| Pengurus | `pengurus` | `pengurus123` |
| Peserta | `peserta` | `peserta123` |

> **Segera ganti ketiga kata sandi** setelah login pertama (menu Registrasi
> untuk akun baru, lalu nonaktifkan akun contoh pada menu **Peserta**).
> Bila tidak menjalankan seed, buat akun pertama langsung dari aplikasi:
> buka aplikasi luring sekali (atau isi config setelahnya) dan gunakan akun
> bawaan mode mandiri, lalu ubah kata sandinya — atau jalankan `seed.sql`.

### Langkah 4 — Isi konfigurasi
Buka `js/config.js` dan isi dua nilai:

```js
window.IGN_CONFIG = {
  SUPABASE_URL: 'https://xxxxxxxxxxxx.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
  SUPABASE_SCHEMA: 'public',
  SYNC_INTERVAL: 60000,
  ...
};
```

Nilai bawaan lain (jumlah baris per permintaan, batas waktu, batas log,
batas antrean) sudah disetel wajar dan boleh dibiarkan.

### Langkah 5 — Unggah (hosting statis)
Aplikasi hanya berkas statis — tidak perlu build. Contoh:

* **GitHub Pages**: Settings → Pages → Source: `main` / root.
* **Netlify / Vercel**: hubungkan repo, tanpa perintah build, direktori publik = root.
* **Server sendiri**: unggah seluruh berkas ke folder web.

> Wajib **HTTPS** (atau `http://localhost`) agar kamera (pindai QR) dan
> layanan lokasi berfungsi.

---

## 4. Verifikasi setelah deploy

1. Buka aplikasi (HTTPS) → **masuk** dengan akun dari `seed.sql`.
2. Menu **Lainnya → Pengaturan**:
   * **Basis data** menampilkan `Supabase · <host proyek>`.
   * **Server sinkronisasi** menampilkan "Supabase tersambung — sinkronisasi otomatis aktif".
   * Tekan **Uji Koneksi Database** → keempat tabel harus berstatus terbaca
     beserta jumlah barisnya.
3. Uji alur kerja:
   * Masuk sebagai `admin` → menu **Registrasi** tambah akun peserta
     → buka `Table Editor → users` di Supabase: baris baru harus muncul
     (bila belum, tunggu ≤ 60 detik atau tekan **Sinkron sekarang**).
   * Masuk sebagai `pengurus` → menu **Jadwal** buat acara + **Buat QR**
     → pindai QR memakai akun `peserta` → cek `Table Editor → presensi`.
4. Uji luring: aktifkan mode pesawat → lakukan presensi → matikan mode pesawat
   → antrean terkirim otomatis (lihat **Antrean perubahan** di Pengaturan).

Pengujian cepat lewat SQL Editor:

```sql
select 'users' as tabel, count(*) from public.users
union all select 'jadwal',   count(*) from public.jadwal
union all select 'presensi', count(*) from public.presensi
union all select 'logs',     count(*) from public.logs;
```

---

## 5. Pemetaan tabel ↔ variabel aplikasi

Kolom Postgres memakai *snake_case*; aplikasi memakai nama variabel yang sudah
ada (*camelCase*). Penerjemahan ditangani `js/supabase.js` (dua arah).

**`public.users`** — akun & peran
| Kolom | Variabel aplikasi | Catatan |
|---|---|---|
| `id` | `id` | kunci utama (text) |
| `nama` | `nama` | nama lengkap |
| `username` | `username` | unik tanpa beda huruf besar/kecil |
| `pass_hash` | `passHash` | SHA-256 kata sandi (hex) |
| `hp_hash` | `hpHash` | SHA-256 nomor HP |
| `hp_plain` | `hpPlain` | nomor HP apa adanya (kompatibilitas) |
| `role` | `role` | `admin` \| `pengurus` \| `peserta` |
| `status` | `status` | `aktif` \| `nonaktif` |
| `email` | `email` | surel |
| `created_at` / `updated_at` | `createdAt` / `updatedAt` | penanda waktu |

**`public.jadwal`** — `id, nama, venue, durasi, radius, lat, lng, tanggal,
created_by(createdBy), created_at, updated_at`

**`public.presensi`** — `id, user_id(userId), user_name(userName),
jadwal_id(jadwalId), jadwal_nama(jadwalNama), venue, status, metode, lat, lng,
accuracy, distance, keterangan, timestamp, updated_at`

**`public.logs`** — `id, timestamp, updated_at, action, details (jsonb),
user_id, user_name, user_role, user_agent, url`

Penyimpanan **lokal di perangkat** (IndexedDB, bukan tabel Supabase):
`session` (sesi masuk), `theme` (tema terang/gelap), `meta` (waktu sinkron
terakhir), `outbox` (antrean), `tombstones` (penanda hapus).


---

## 6. Peran & hak akses

| Peran | Jadwal & QR | Laporan semua peserta | Kelola akun | Log sistem | Ubah/hapus presensi | Sinkronisasi & Penyimpanan Luring |
|---|---|---|---|---|---|---|
| **Admin** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Pengurus** | ✅ | ✅ (baca saja) | ❌ | ❌ | ❌ | ❌ |
| **Peserta** | ❌ | ringkasan pribadi | ❌ | ❌ | ❌ | ❌ |

Hak akses ditegakkan di antarmuka **dan** disaring di sumbar data aplikasi
(`PAGE_ACCESS` pada `js/app.js`). Halaman yang dikunci tidak dapat dibuka
meski alamat `#halaman` ditulis manual.

Panel **Sinkronisasi** (sambungan, basis data, server sinkronisasi, antrean
perubahan, sinkron terakhir, serta tombol *Sinkron sekarang*, *Muat ulang data
peranti*, dan *Uji Koneksi Database*) dan panel **Penyimpanan Luring** pada menu
**Pengaturan** hanya tampil untuk **Admin**. Pengurus & Peserta hanya melihat
kartu pemberitahuan singkat; fungsi-fungsi itu juga ditolak di lapisan logika
(`syncNow(true)`, `testSupabase()`, `reloadLocalData()` pada `js/app.js`).
Sinkronisasi **otomatis di latar belakang tetap berjalan untuk semua peran**
agar presensi mereka tidak tertahan di perangkat.

---

## 7. Pengembangan lokal

Service worker, kamera, dan lokasi memerlukan `http://localhost` atau HTTPS:

```powershell
# dari folder proyek
python -m http.server 5173
# lalu buka http://localhost:5173
```

Atau memakai ekstensi **Live Server** di VS Code. Setelah mengubah berkas
`js/`/`css/`, muat ulang dengan *hard reload* (service worker menyimpan
app shell pada versi cache yang sama; naikkan `VERSION` di `sw.js` bila perlu).

---

## 8. Pemecahan masalah

| Gejala | Penyebab & tindakan |
|---|---|
| **Uji Koneksi**: "SUPABASE_URL dan SUPABASE_ANON_KEY belum diisi" | Isi `js/config.js` (Langkah 4), lalu muat ulang. |
| **Uji Koneksi**: "Tabel belum ada di Supabase" | Jalankan `supabase/schema.sql` (Langkah 2). |
| **Uji Koneksi**: "Kunci anon Supabase ditolak" | Salin ulang **anon public** key; pastikan tidak ada spasi/enter. |
| Login gagal padahal akun ada | Perangkat luring → sambungkan internet lalu coba lagi; atau akun memang belum dibuat. |
| Perubahan tidak muncul di Supabase | Buka **Pengaturan** → cek **Antrean perubahan**; tekan **Sinkron sekarang**; periksa pesan galat pada **Server sinkronisasi**. |
| Kamera tidak terbuka | Buka via HTTPS/localhost dan izinkan kamera; alternatif tombol **Pindai dari Foto**. |
| Data lama masih tampil | **Pengaturan → Muat ulang data peranti**. |
| Perlu mulai dari nol di perangkat | **Pengaturan → Bersihkan data perangkat** (data Supabase tidak terhapus). |

---

## 9. Catatan keamanan (baca sebelum dipakai luas)

* Aplikasi memakai **anon public key** + kebijakan RLS yang mengizinkan peran
  `anon` membaca/menulis keempat tabel — setara model Web App "Anyone" pada
  versi sebelumnya. Cocok untuk aplikasi internal sekolah/komunitas.
* Kata sandi **tidak** disimpan sebagai teks asli, melainkan **SHA-256**;
  autentikasi dilakukan di sisi aplikasi (bukan Supabase Auth).
* **Jangan pernah** menaruh `service_role` key di berkas front-end.
* Pengerasan opsional (Supabase Auth / Edge Function perantara) dijelaskan
  pada bagian 5 berkas `supabase/schema.sql`.
* Aktifkan **Point-in-Time Recovery / backup harian** pada proyek Supabase bila
  data presensi bersifat penting.
* Bila kunci anon bocor: **Project Settings → API → Rotate** lalu perbarui
  `js/config.js` dan unggah ulang.

---

## 10. Riwayat versi singkat

* **4.1.0** — Basis data pindah ke **Supabase** (REST/PostgREST), konfigurasi
  terpusat di `js/config.js`, outbox lebih tahan gagal (tanpa head-of-line
  blocking), tombol **Uji Koneksi Database**, login dapat menarik akun dari
  basis data, service worker v11.
* **4.0.1** — Penyimpanan luring pindah dari `localStorage` ke **IndexedDB**.
* Sebelumnya — Presensi QR, jadwal & venue, laporan CSV/PDF, PWA.

