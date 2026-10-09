# Presensi Ignasian

Presensi digital berbasis QR dengan semangat Ignatian — **Ad Maiorem Dei Gloriam**.
Aplikasi PWA statis (tanpa build step) dengan prinsip **cloud-first, luring
sebagai cadangan**: saat daring, **basis data Supabase menjadi acuan** —
ditarik lebih dahulu setiap aplikasi dibuka atau disinkronkan; perubahan
ditulis dulu ke **IndexedDB** di perangkat lalu dikirim ke server di atasnya.
Saat luring, cadangan perangkat tetap dipakai dan antrean terkirim otomatis
begitu kembali daring.

---

## 1. Ringkasan arsitektur data

```
Pindai QR / kelola akun / jadwal
        │
        ▼
  IndexedDB (perangkat)  ◄── sumber kebenaran saat luring
        │  antrean (outbox) berurutan
        ▼
  Supabase  (Postgres + REST/PostgREST)   ← tabel: users, jadwal, presensi, logs,
                                             password_requests
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
   `presensi`, `logs`, `password_requests`, `materi`, `dokumentasi`,
   `app_settings`, indeks, trigger `updated_at`, lalu mengaktifkan RLS.

### Langkah 3 — (Opsional) Akun awal

> `supabase/seed.sql` SENGAJA tidak lagi berisi akun berkredensial default
> (dulu `admin/admin123` dkk — lihat `SECURITY.md` H3). Berkas itu kini hanya
> panduan + query verifikasi read-only.

Buat akun pertama lewat aplikasi (mode mandiri): buka aplikasi luring sekali,
masuk dengan akun bawaan, lalu **wajib ganti kata sandi** saat login pertama
(minimal 8 karakter, tidak boleh sama dengan username). Setelah itu daftarkan
akun lain lewat menu Registrasi / Input Nomor & Peran.

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
   * Tekan **Uji Koneksi Database** → seluruh tabel (users, jadwal, presensi,
     logs, materi, dokumentasi) harus berstatus terbaca beserta jumlah barisnya.
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
| `terdaftar_at` | `terdaftarAt` | waktu pendaftaran mandiri di layar **Daftar**; NULL = nomor tercatat tetapi belum mendaftar |
| `created_at` / `updated_at` | `createdAt` / `updatedAt` | penanda waktu |

**`public.jadwal`** — `id, nama, pemateri, pemateri_2(pemateri2), venue, durasi,
radius, lat, lng, open_gate(openGate), tanggal, created_by(createdBy),
created_at, updated_at`

*(`pemateri` & `pemateri_2` = nama pemateri/pengisi materi; pemateri ke-2
opsional, diisi bila kotak centang “Pemateri ke-2” dipakai. `open_gate` =
waktu (timestamptz) saat peserta mulai boleh memindai QR — diatur Administrator
pada menu Kelola Jadwal; NULL = gate belum diatur.)*

**`public.presensi`** — `id, user_id(userId), user_name(userName),
jadwal_id(jadwalId), jadwal_nama(jadwalNama), venue, status, metode, lat, lng,
accuracy, distance, keterangan, timestamp, updated_at`

**`public.logs`** — `id, timestamp, updated_at, action, details (jsonb),
user_id, user_name, user_role, user_agent, url`

**`public.app_settings`** (aplikasi ≥ 4.9.4) — `id, data (jsonb),
updated_by(updatedBy), created_at, updated_at`

*(Pengaturan bersama seluruh perangkat — saat ini satu baris: `id = 'pdf-layout'`
untuk tata letak cetakan Daftar Hadir. Bila tabel ini belum ada, aplikasi tetap
jalan memakai nilai bawaan.)*

Penyimpanan **lokal di perangkat** (IndexedDB, bukan tabel Supabase):
`session` (sesi masuk), `theme` (tema terang/gelap), `meta` (waktu sinkron
terakhir), `outbox` (antrean), `tombstones` (penanda hapus), `settings`
(cadangan pengaturan bersama saat luring).


---

## 6. Peran & hak akses

| Peran | Jadwal & QR | Laporan semua peserta | Kelola akun | Log sistem | Ubah/hapus presensi | Sinkronisasi & Penyimpanan Luring | Materi & Dokumentasi |
|---|---|---|---|---|---|---|---|
| **Admin** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ lihat, unggah, hapus |
| **Pengurus** | ✅ | ✅ (baca saja) | ❌ | ❌ | ❌ | ❌ | ✅ lihat, unggah, hapus |
| **Peserta** | ❌ | ringkasan pribadi | ❌ | ❌ | ❌ | ❌ | ✅ lihat & unduh |

Hak akses ditegakkan di antarmuka **dan** disaring di sumbar data aplikasi
(`PAGE_ACCESS` pada `js/app.js`). Halaman yang dikunci tidak dapat dibuka
meski alamat `#halaman` ditulis manual.

Panel **Sinkronisasi** (sambungan, basis data, server sinkronisasi, antrean
perubahan, status sinkron, serta tombol *Uji Koneksi Database*) dan panel
**Penyimpanan Luring** pada menu **Pengaturan** hanya tampil untuk **Admin**.
Pengurus & Peserta hanya melihat kartu pemberitahuan singkat; fungsi-fungsi
itu juga ditolak di lapisan logika
(`testSupabase()` pada `js/app.js`).
Sinkronisasi **otomatis di latar belakang tetap berjalan untuk semua peran**
agar presensi mereka tidak tertahan di perangkat.

Halaman **Atur Layout PDF** (`#pdf`) juga khusus **Admin** — tata letak cetakan
dipakai bersama oleh semua perangkat, sedangkan **Ubah Jadwal** (melengkapi
nama pemateri) tersedia untuk **Admin & Pengurus**.

---

## 6b. Materi & Dokumentasi (Google Drive)

Dua submenu pada **Lainnya** yang terbuka untuk **semua peran**, dikelompokkan
per **acara + tanggal** (memakai data jadwal):

| Submenu | Isi | Siapa yang boleh menambah/menghapus |
|---|---|---|
| **Materi** | berkas kegiatan (PDF, slide, audio, …) — daftar + tombol Unduh | Administrator & Pengurus |
| **Dokumentasi** | foto kegiatan — galeri thumbnail + tombol Unduh | Administrator & Pengurus |

Aplikasi **hanya menyimpan tautan Google Drive** pada tabel `materi` &
`dokumentasi` (Supabase); berkasnya tetap berada di kuota Google Drive (15 GB) —
tanpa OAuth, tanpa backend tambahan, dan metadata tetap sinkron otomatis
(outbox → Supabase, tarikan + Realtime).

**Penyiapan (sekali):**

1. Buat satu folder di Google Drive, mis. `Presensi Ignasian — Materi & Dokumentasi`
   (disarankan berisi subfolder per acara).
2. Klik **Bagikan → Siapa saja yang punya link dapat melihat** (Viewer).
3. Upload materi/foto ke folder, lalu salin tautannya
   (klik kanan file → **Bagikan → Salin tautan**).
4. Di aplikasi: **Lainnya → Materi → Tambah Materi** (atau **Tambah Foto**) →
   pilih acara, isi judul/keterangan, tempel tautan → **Bagikan**.

**Catatan:**

* Tautan boleh berupa file Drive, **folder** (tombol menjadi *Buka di Drive*),
  dokumen Google (diunduh sebagai PDF/XLSX/PPTX), maupun tautan lain.
* Form **Tambah Foto** menerima banyak tautan sekaligus: tempelan hasil
  **Ctrl+C** / **Salin tautan** di Google Drive (nama berkas + tautan, sering
  tersalin dalam satu baris) maupun daftar biasa (satu tautan per baris, boleh
  dipisah spasi/koma). Kotak tempelan menampilkan jumlah tautan yang terbaca
  sebelum tombol **Bagikan** ditekan.
* Menghapus entri di aplikasi **tidak** menghapus berkas di Google Drive.
* Tautan bersifat publik-tertaut: jangan letakkan berkas sensitif di sana.
* Belum menjalankan ulang `supabase/schema.sql`? Menu ini kosong dan
  **Uji Koneksi Database** gagal — jalankan ulang berkas tersebut lebih dahulu.
* **Pratinjau foto** memakai layanan thumbnail Google Drive sehingga berkas
  wajib dibagikan **"Siapa saja yang punya link dapat melihat"**. Bila
  pratinjau ditolak (hak akses/kuota), aplikasi mencoba tautan berkas sekali
  lalu menampilkan ikon pengganti — tombol **Unduh** tetap berfungsi.
  Pratinjau selalu diambil dari jaringan saat daring, dan disimpan per-berkas
  di cache perangkat (`?id=…` selalu dibedakan) untuk dipakai saat luring.

---

## 7. Pengembangan lokal

Service worker, kamera, dan lokasi memerlukan `http://localhost` atau HTTPS:

```powershell
# dari folder proyek
python -m http.server 5173
# lalu buka http://localhost:5173
```

Atau memakai ekstensi **Live Server** di VS Code.

**Aturan rilis — lakukan setiap ada perubahan/fitur baru:**

1. Naikkan `CONFIG.VERSION` pada `js/app.js` — satu-satunya sumber nomor versi
   yang tampil di *Tentang Aplikasi*, *Bantuan*, dan layar masuk.
2. Naikkan `VERSION` pada `sw.js` (versi **cache**; cache lama otomatis
   dibuang saat service worker baru aktif, termasuk pratinjau foto lama).
3. Naikkan `?v=` pada `<script src="js/app.js?v=…">` di `index.html`.
4. Muat ulang dengan *hard reload*.

Service worker diperbarui otomatis (`updateViaCache: 'none'`); saat versi baru
terpasang pengguna melihat pemberitahuan **"Versi baru … siap dipakai"** dan
diminta menutup lalu membuka ulang aplikasi.

---

## 8. Pemecahan masalah

| Gejala | Penyebab & tindakan |
|---|---|
| **Uji Koneksi**: "SUPABASE_URL dan SUPABASE_ANON_KEY belum diisi" | Isi `js/config.js` (Langkah 4), lalu muat ulang. |
| **Uji Koneksi**: "Tabel belum ada di Supabase" | Jalankan `supabase/schema.sql` (Langkah 2). |
| Peserta ditolak saat **Daftar**: "nomor ini belum tercatat" | Administrator belum mencatat nomor HP peserta. Buka **Lainnya → Input Nomor & Peran** (Admin), tempel `nomor, nama, peran`, tekan **Periksa Daftar** lalu **Simpan Semua**. Peserta baru dapat mendaftar setelah nomornya tercatat. |
| Peserta ditolak: "nomor ini sudah terdaftar" | Nomor tersebut sudah pernah berhasil mendaftar (satu nomor = satu pendaftaran). Peserta cukup **masuk** dengan username &amp; password-nya; bila lupa, gunakan **Lupa Password?** di layar masuk. |
| Nomor yang di-*input* Admin tidak dikenali peserta | Periksa formatnya (`08…`/`628…`, minimal 8 angka, tanpa tanda baca) pada kolom **Keterangan** di *Hasil Penomoran*. Penulisan berbeda tetap dikenali karena normalisasi menyamakan `0812…`, `62812…`, dan `812…`. |
| Pendaftaran berhasil tetapi **tidak muncul di perangkat lain** | Jalankan ulang `supabase/schema.sql` bila *Uji Koneksi* menandai kolom `terdaftar_at` belum ada; kolom yang belum ada dilewati saat kirim dan ikut tersinkron otomatis begitu skema diperbarui. Data di antrean tidak pernah dibuang. |
| **Nama pemateri tidak tercetak** pada Daftar Hadir (PDF) | Nama pemateri kini tercetak otomatis dari data acara. Bila barisnya kosong: (1) kolom pemateri pada acara itu memang belum diisi — lengkapi lewat **Kelola Jadwal → Ubah**; atau (2) opsi **Baris pemateri** dimatikan pada **Lainnya → Atur Layout PDF**. |
| **Layout PDF** tersimpan di satu perangkat saja, tidak berlaku di perangkat lain | Tabel `app_settings` belum ada di proyek → jalankan **ulang** `supabase/schema.sql`, lalu **Pengaturan → Uji Koneksi Database** (8 tabel). Selama tabel belum ada, aplikasi tetap berjalan memakai tata letak bawaan dan pengaturan Anda tetap tersimpan di perangkat tersebut (antrean tidak pernah dibuang). |
| Materi/Dokumentasi dibuat di satu perangkat tetapi **kosong di perangkat lain** (Console: `404` pada `/rest/v1/materi`, "Could not find the table 'public.materi' in the schema cache") | Proyek lama belum memiliki tabel `materi`/`dokumentasi` → jalankan **ulang** `supabase/schema.sql`, tunggu ±1 menit (segarkan cache PostgREST), lalu **Pengaturan → Uji Koneksi Database** (7 tabel harus terbaca) dan **Sinkron sekarang**. Data yang sudah dibuat tetap aman di antrean perangkat dan terkirim otomatis setelah tabelnya ada. |
| Menempel **banyak tautan Drive** pada *Tambah Foto* tetapi hanya muncul 1 entri | Perbaikan 4.8.1: tempelan "nama berkas + tautan" (dipisah TAB, sering dalam satu baris) kini dikenali semua — lihat penghitung di bawah kotak tempelan. Muat ulang aplikasi, lalu hapus entri lama. |
| **Nama pemateri** tidak muncul di perangkat lain (Console: `column "pemateri" ... does not exist`) | Skema lama belum memiliki kolom `pemateri`/`pemateri_2` → jalankan **ulang** `supabase/schema.sql` (`add column if not exists`, aman berkali-kali), lalu **Sinkron sekarang**. Selama belum dijalankan, jadwal tetap tersimpan & tersinkron tanpa kolom itu (sejak **4.9.1** aplikasi melewati kolom yang hilang secara berulang sampai berhasil + memberi pengingat di Pengaturan; pada 4.9.0 pengiriman jadwal bisa tertahan terus). |
| **Data terbaru hanya terlihat di 1 peramban** — peramban lain / mode privat kosong atau ketinggalan | Sejak **4.9.2** sinkronisasi memakai **mode cloud-first** (basis data ditarik lebih dahulu sebagai acuan). Periksa berurutan: (1) **Pengaturan → Status Sinkron**: kolom **Tarik** harus menunjukkan waktu terbaru dan **Realtime: tersambung** — bila "terputus", perangkat masih mengejar lewat tarikan tiap 60 detik; (2) di perangkat asal **Antrean perubahan = 0** dan **Kirim** terbaru (tekan **Sinkron sekarang** bila belum); (3) **Uji Koneksi Database** — bila menyebut kolom kurang (mis. `pemateri`), jalankan **ulang** `supabase/schema.sql`; (4) semua peramban harus versi **4.9.2** / service worker **v25** — buka sekali saat daring lalu tutup & buka ulang. Data di antrean TIDAK pernah dibuang. |
| **Thumbnail galeri Dokumentasi tampak SAMA semua**, padahal berkas saat diunduh berbeda-beda | Service worker 4.8.1 mencocokkan cache dengan `ignoreSearch` sehingga `…/thumbnail?id=AAA` dan `…/thumbnail?id=BBB` dianggap berkas yang sama → semua kartu memakai foto pertama yang tersimpan. Perbaikan **4.8.2** memakai URL penuh dan pratinjau Drive selalu diambil dari jaringan. Buka aplikasi sekali saat daring (service worker **v20** mengganti cache lama), lalu muat ulang. |
| Pratinjau foto tidak tampil (hanya ikon) | Berkas belum dibagikan **"Siapa saja yang punya link dapat melihat"** → ubah hak akses di Drive, lalu **Pengaturan → Sinkron sekarang**. Tombol **Unduh** tetap berfungsi walau pratinjau gagal. |
| Aplikasi masih memakai berkas/tampilan lama setelah ada pembaruan | Nomor versi belum dinaikkan → naikkan `CONFIG.VERSION` (`js/app.js`), `VERSION` (`sw.js`), dan `?v=` pada `index.html`; buka sekali saat daring, lalu tutup & buka ulang aplikasi. |
| **Uji Koneksi**: "Kunci anon Supabase ditolak" | Salin ulang **anon public** key; pastikan tidak ada spasi/enter. |
| Login gagal padahal akun ada | Perangkat luring → sambungkan internet lalu coba lagi; atau akun memang belum dibuat. |
| Pemindaian QR menolak "bukan kode QR Presensi Ignasian" | QR berasal dari aplikasi/versi lain → buat ulang QR pada **Buat Kode QR** (format kini lebih ringkas & mudah terbaca). |
| Pemindaian QR menolak karena "acara lain" | Buka **Beranda → Sesi Hari Ini** lalu ketuk acara yang benar, atau batalkan pilihan acara pada kartu **Acara yang Dipindai**. |
| Pemindaian QR ditolak: `Presensi … belum dibuka` atau `OPEN-GATE … dibuka pada …` | Itu memang aturan **OPEN-GATE**: Administrator harus mengaturnya lebih dahulu pada **Kelola Jadwal → OPEN-GATE** (atau lewat jendela **Ubah**) lalu menunggu sampai waktunya. Tombol **Buka sekarang** membuka gate seketika; **Tutup Gate** menutupnya kembali. |
| Gate yang diatur Admin **tidak muncul di perangkat lain** | Kolom `open_gate` belum ada di proyek → jalankan **ulang** `supabase/schema.sql`, tunggu ±1 menit, lalu **Pengaturan → Uji Koneksi Database** & **Sinkron sekarang**. Selama kolom belum ada, gate tetap tersimpan di perangkat asal dan ikut tersinkron setelah skema diperbarui. |
| Log/riwayat terhapus muncul kembali | Jalankan ulang `supabase/schema.sql` (kolom & tabel baru), lalu tekan **Sinkron sekarang**. |
| Perubahan tidak muncul di Supabase | Buka **Pengaturan** → cek **Antrean perubahan**; tekan **Sinkron sekarang**; periksa pesan galat pada **Server sinkronisasi**. |
| Kamera tidak terbuka | Buka via HTTPS/localhost dan izinkan kamera; alternatif tombol **Pindai dari Foto**. |
| Data lama masih tampil | Tutup lalu buka ulang aplikasi (tarik ulang otomatis), atau jalankan ulang `supabase/schema.sql` bila kolom/tabel belum ada. |
| Perlu mulai dari nol di perangkat | **Pengaturan → Bersihkan data perangkat** (data Supabase tidak terhapus). |

---

## 9. Catatan keamanan (baca sebelum dipakai luas)

* Aplikasi memakai **anon public key** + kebijakan RLS yang mengizinkan peran
  `anon` membaca/menulis seluruh tabel — setara model Web App "Anyone" pada
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
* **4.9.12** — pengerasan fase 4 (delegasi aksi + CSP + penahan login):
  * **Tidak ada lagi JavaScript di dalam markup.** 143 atribut
    `onclick`/`onchange`/`oninput`/`onerror` diganti menjadi
    `data-act` + `data-a1..N`, dan satu "delegasi" di `js/app.js`
    menjalankannya. Semua tombol, menu, dan kolom tetap berfungsi seperti
    sebelumnya — hanya cara pemicunya yang berubah.
  * **Content-Security-Policy aktif.** Skrip hanya boleh berasal dari
    berkas aplikasi sendiri dan 2 CDN yang sudah dikunci hash SRI-nya.
    Empat `<script>` kecil yang tadinya tertanam di `index.html` dipindahkan
    ke `js/boot.js` dan `js/guard.js`.
  * **Penahan login gagal.** Setelah 5 kali gagal untuk nama pengguna yang
    sama, percobaan berikutnya ditahan 30 detik, lalu 60 detik, 120 detik,
    dan seterusnya sampai maksimum 15 menit. Satu coba yang berhasil
    langsung menghapus riwayatnya.
  * Berkas berubah: `index.html`, `js/app.js`, `sw.js`, `js/boot.js`
    (baru), `js/guard.js` (baru), `?v=33`, SW `v35`.
  * Catatan: kebijakan gaya (CSS) masih mengizinkan gaya sebaris, dan
    `frame-ancestors` hanya berlaku bila dikirim lewat header server —
    lihat `SECURITY.md` bagian 3.

* **4.9.11** — pengerasan fase 3 (privasi log + deteksi login gagal):
  * **Log tanpa data pribadi perangkat**: `addLog()` tidak lagi menyimpan
    `userAgent` dan URL halaman (keduanya tidak pernah dipakai fitur apa pun
    dan ikut tersinkron ke Supabase). Yang tersimpan: siapa, kapan, aksi apa.
  * **Percobaan masuk gagal tercatat** sebagai `LOGIN_FAILED` (berisi username
    yang dicoba + status daring) — memudahkan Administrator melihat pola
    tebakan sandi di **Log Sistem**. Perilaku layar masuk tidak berubah dan
    akun **tidak** dikunci (kunci akun butuh sisi server).
  * **Retensi log otomatis 90 hari** (dapat diubah lewat `LOG_RETENSI_HARI`
    pada `js/config.js`): log yang lebih tua dibuang dari perangkat dan
    diantrekan untuk dihapus di server — sekaligus menjaga antrean tetap
    ringan (maksimal 200 catatan per pemuatan aplikasi).
  * **Pembersihan sisi server** (opsional): jalankan ulang
    `supabase/schema.sql` bagian **3b** untuk memasang
    `public.bersihkan_log_lama(90)` lalu jadwalkan harian.
  * Berkas berubah: `js/app.js` (**4.9.11**), `js/config.js` (`?v=32`),
    `index.html` (`?v=32`), `sw.js` (**v34**), `supabase/schema.sql`,
    `SECURITY.md`, `CHANGE-LOG.md`, `README.md`.

* **4.9.10** — pengerasan fase 2 (kredensial default, XSS, integritas CDN):
  * `supabase/seed.sql` tidak lagi memuat perintah yang dapat dijalankan
    (hanya panduan + verifikasi); akun mandiri memakai sandi acak per perangkat
    dengan penanda **wajib ganti sandi** saat login pertama (kolom baru
    **`public.users.harus_ganti_sandi`** — **jalankan ulang
    `supabase/schema.sql`**).
  * Nilai yang disisipkan ke `onclick="waTo('…')"` diamankan lewat helper
    `escJs()`; panjang sandi minimal reset/daftar 6 → 8 karakter.
  * Tiga pustaka CDN (Leaflet, qrcodejs, html5-qrcode) dipasang dengan
    **SRI sha384** + `crossorigin`.
  * Berkas berubah: `js/app.js` (**4.9.10**), `js/supabase.js` (`?v=30`),
    `index.html` (`?v=30`), `sw.js` (**v33**), `supabase/seed.sql`.

* **4.9.9** — tombol modal OPEN-GATE kini selalu di dalam kartu:
  * Aksi modal memakai kelas baru `modal-actions-wrap` (bungkus otomatis ke
    baris berikut dengan `flex:1 1 140px`, dipakai jendela **OPEN-GATE**) —
    keempat tombol (**Batal**, **Buka sekarang**, **Tutup Gate**,
    **Simpan**) tetap di dalam kartu pada layar HP (2 baris × 2 tombol) dan
    rapat sebaris pada layar lebar; perilaku modal lain tidak berubah.
  * Berkas berubah: `js/app.js`, `css/pages.css`, `index.html` (`?v=29`),
    `sw.js` (**v32**), `README.md`.

* **4.9.8** — **OPEN-GATE** (kunci waktu pemindaian QR) + nama pemateri
  sepenuhnya otomatis pada cetakan:
  * **OPEN-GATE (khusus Administrator)** — pada menu **Kelola Jadwal** setiap
    kartu acara kini memiliki tombol **OPEN-GATE**. Admin menentukan **jam**
    peserta mulai boleh memindai QR (contoh: acara 19.00, gate 18.30), memakai
    tombol **Buka sekarang**, atau **Tutup Gate** untuk menutupnya kembali.
    Selama gate belum diatur atau belum waktunya, **kamera**, **galeri**, dan
    **foto QR** peserta ditolak dengan penjelasan alasannya (tercatat pada Log
    Sistem sebagai `OPEN_GATE` / `PRESENSI_GAGAL`). Status gate tampil pada
    kartu jadwal (`gate terbuka` / `gate 18.30` / `gate belum diatur`) dan pada
    halaman **Presensi**. Tombol hanya muncul bagi Administrator; Pengurus
    dapat melihat statusnya dan medan gate pada jendela **Ubah** dibiarkan
    terkunci bagi mereka.
  * **Kolom baru `public.jadwal.open_gate`** (`timestamptz`) — **jalankan ulang
    `supabase/schema.sql`** (aman berkali-kali). Bila kolomnya belum ada,
    aplikasi melewatinya saat sinkron (data jadwal lain tetap terkirim) dan
    gate langsung ikut tersinkron setelah skema diperbarui.
  * **Kolom koreksi pemateri di jendela Cetak PDF dihapus** — nama pemateri
    kini **selalu tercetak otomatis** pada Daftar Hadir (baris
    `Pemateri / Pengisi Materi: …`); melengkapi/koreksinya dilakukan lewat
    tombol **Ubah** pada *Kelola Jadwal*.
  * Berkas berubah: `js/app.js`, `js/supabase.js`, `index.html` (`?v=28`),
    `supabase/schema.sql`, `sw.js` (**v31**), `README.md`.

* **4.9.7** — Tombol "mata" pada kolom password:
  * Tombol mata (lihat/sembunyikan) kini ada di keempat kolom yang diketik:
    **Masuk** (`loginPass`), **Daftar** (`daftarPass` + `daftarPass2`), dan
    **Registrasi** (`regPass`). Ikon baru `eyeoff` (mata tercoret).
  * Tombol duduk di dalam kolom (`.pw-wrap`/`.pw-eye`), mengikuti pola
    `aria-pressed` + `aria-label`/`title` yang berganti otomatis.
  * Saat keluar, kolom password masuk dikembalikan ke mode tersembunyi.
  * Berkas berubah: `js/app.js`, `js/icons.js`, `css/components.css`,
    `index.html` (`?v=27`), `sw.js` (**v30**), `README.md`.

* **4.9.6** — Rapikan layar sukses **DAFTAR**, lencana Data Peserta, kecepatan
  penghapusan, dan time-out sesi:
  * Tombol **Kirim lewat WhatsApp** dihapus (tidak terpakai); tersisa satu tombol
    **Kembali ke Halaman Login** yang dipusatkan di tengah kotak ringkasan.
  * Fungsi `waDaftarKredensial()` ikut dihapus. `waTo()`/`pesanKirimPassword()`
    tetap dipakai halaman Data Peserta & Lupa Password.
  * **Lencana PERAN/STATUS tidak lagi bertumpuk** di Data Peserta: lencana dibatasi
    selebar selnya (boleh turun baris), kolom Peran/Status dilebarkan
    (15%/12% pada desktop, `min-width` pada tablet), dan peran panjang dirapatkan.
  * **Penghapusan benar-benar sampai ke Supabase dalam hitungan detik**: operasi
    `delete` didahulukan di antrean, ditambah pengawas flush tiap **4 detik**
    (`startFlushWatchdog`) sehingga tidak lagi menunggu sinkronisasi 60 detik.
  * **Time-out sesi per peran**: Peserta **30 menit**, Pengurus **45 menit**,
    Administrator **60 menit** (sebelumnya 6/12 jam). Sesi lama ikut terpotong
    memakai aturan baru saat aplikasi dibuka. `fmtDurasi()` kini menulis menit.
  * Pop-up sesi habis (saat runtime maupun saat membuka aplikasi) disederhanakan
    menjadi **"Sesi Anda sudah habis, silakan login kembali."**
  * Berkas berubah: `js/app.js`, `css/utilities.css`, `index.html` (`?v=26`),
    `sw.js` (**v29**), `README.md`.

* **4.9.5** — layar **DAFTAR** untuk umum + **Input Nomor & Peran** (multiple create, Admin):
  * **Layar Daftar** di layar masuk: pendaftaran memakai **nomor HP/WA** (`08…`, `628…`, atau `8…`).
    * Nomor **belum tercatat** → pendaftaran **ditolak** ("hubungi Administrator").
    * Nomor **tercatat** → nomor & **peran tampil terkunci** (diambil dari `users`), peserta
      hanya mengisi **nama, username, dan password** pilihannya sendiri.
    * **Berhasil → baris `users` ter-update otomatis** (nama, username, `pass_hash` + `pass_plain`,
      `status` aktif, `terdaftar_at`) lalu ikut tersinkron ke semua perangkat seperti perubahan biasa.
    * **Satu nomor hanya boleh mendaftar satu kali**: bila `terdaftar_at` sudah terisi, pendaftaran
      ditutup dan pengguna diarahkan masuk. Dicek dua lapis — lokal (state) dan, saat daring,
      langsung ke server (`supaCariUserByHp`) sehingga dua perangkat tidak bisa memakai nomor sama.
    * Nomor dicari ke **server** bila tidak ditemukan di perangkat (perangkat yang datanya belum
      pernah tersinkron tetap dapat mendaftar dengan benar).
    * Setelah berhasil: layar-ringkasan + tombol **Kembali ke Halaman Login**
      (tombol kirim kredensial WhatsApp dihapus karena tidak terpakai).
  * **Halaman baru *Input Nomor & Peran*** (menu **Lainnya**, khusus Administrator) —
   Pendamping CRUD member: **multiple create** lewat textarea tempel
    (`nomor, nama, peran`, pemisah koma/titik koma/TAB/`|`) → **Periksa Daftar** (pratinjau
    *baru / perbarui / gagal* + alasannya) → **Simpan Semua**. Nomor yang sudah ada di-update
    (peran & nama; username/password/pendaftaran milik pemilik tidak disentuh), nomor baru
    dibuat dengan **username sementara** (`hp628…`, dijamin unik) sampai peserta mendaftar.
  * **Daftar Nomor Tercatat**: tabel nomor + status pendaftaran (*belum mendaftar* / *terdaftar*
    + tanggal), pencarian, ubah peran, dan hapus/lepas nomor (akun yang sudah terdaftar tetap
    beserta riwayat presensinya). Lencana yang sama muncul pada **Data Peserta**, dan kolom
    pencarian sana kini bisa dipakai untuk nomor HP.
  * Kolom baru **`public.users.terdaftar_at`** — **jalankan ulang `supabase/schema.sql`**
    (aman berkali-kali). Bila belum ada, kolom dilewati saat sinkron (data lain tetap terkirim)
    dan akan ikut tersinkron otomatis begitu skema diperbarui.
  * Formulir **Registrasi Pengguna** (single) tetap ada dan tidak berubah.

* **4.9.4** — nama pemateri pada cetakan + halaman **Atur Layout PDF** (Admin):
  * **Nama pemateri kini selalu tercetak** pada Daftar Hadir, sebagai baris
    tersendiri `Pemateri / Pengisi Materi: …` (bukan menyatu di paragraf
    informasi). Bila kolomnya kosong, dicetak garis isian `……………`, dan
    jendela cetak menyediakan kolom koreksi + tombol **Simpan & Cetak** yang
    menyimpan nama tersebut ke acara (ikut tersinkron ke semua perangkat).
  * **Tombol *Ubah* pada Kelola Jadwal** (Administrator & Pengurus) — melengkap
    atau mengoreksi nama acara, lokasi, **pemateri** (termasuk pemateri ke-2),
    durasi, dan radius — inilah cara melengkapi nama pemateri pada acara lama.
  * **Halaman baru *Atur Layout PDF*** (menu **Lainnya**, khusus Administrator):
    mengatur judul kop, nama lembaga, motto, baris mana yang dicetak (nama
    acara, pemateri, informasi, rekap), kolom tabel (No, Nama, Status,
    Tanggal, Jam, Metode, Jarak, Keterangan), ukuran kertas (A4/F4/Letter),
    orientasi, margin, font & tebal garis, warna kop/garis, blok tanda tangan,
    dan catatan kaki — lengkap dengan **pratinjau** memakai dokumen yang sama
    dengan hasil cetak, tombol **Simpan Layout**, dan **Kembalikan ke Bawaan**.
  * Pengaturan layout disimpan sebagai **satu baris di tabel baru
    `public.app_settings`** (disinkronkan ke semua perangkat) + cadangan lokal
    di IndexedDB. **Jalankan ulang `supabase/schema.sql`** (aman berkali-kali)
    agar layout ikut tersebar ke perangkat lain; selama tabel belum ada,
    aplikasi tetap berjalan memakai nilai bawaan.
  * Cetak QR dan berkas CSV/Excel tidak berubah — keduanya memakai data penuh.

* **4.9.3** — perbaikan tata letak & alur masuk:
  * **Tombol ekspor dipindah** ke kartu *Daftar Hadir per Acara* sendiri dan
    diletakkan **di atas** tabel (sebelumnya menumpuk/menutupi daftar hadir).
  * **Riwayat jadi baris ringkas** (bukan kartu besar) + **dropdown acara**:
    hanya menampilkan data acara yang dipilih; bila belum dipilih, tampil
    arahan "Pilih acara terlebih dahulu".
  * **Tombol tanggal tidak lagi overflowing** — responsif, menumpuk otomatis
    di layar sempit.
  * **Tombol *Sinkronisasi Sekarang* & *Muat Ulang Data Perangkat* dihapus**:
    sinkron cloud-first berjalan penuh otomatis, tidak perlu tombol manual.
  * **Sesi Hari Ini** kini memunculkan **modal detail acara** (untuk semua
    peran) dengan tombol **Hadir** (lanjut ke halaman Presensi & pindai QR)
    dan **Batal**.
  * **Perbaikan galat saat aplikasi dibuka pertama kali** — `renderHome()`
    tidak lagi melempar `TypeError: … reading 'id'` sehingga login dengan
    akun terdaftar berhasil pada percobaan pertama.
* **4.9.2** — **Sinkronisasi cloud-first** (basis data daring sebagai acuan,
  luring sebagai cadangan) menggantikan urutan lama "kirim dulu, tarik
  kemudian" yang membuat peramban lain sering tertinggal:
  * **Urutan baru `syncNow`**: tarik (cloud = acuan) → kirim antrean lokal
    di atasnya → tarik-ulang sekali bila ada yang terkirim (echo versi resmi).
  * **Boot menarik data lebih dahulu**: sesudah sesi pulih, tarikan berjalan
    **sebelum layar utama tampil** (dibatasi 4 detik; gagal/luring → cadangan
    perangkat). Masuk lewat layar login juga langsung menarik lalu mengirim.
  * **Aturan gabung diubah**: server menang **apa adanya** untuk catatan yang
    bukan bagian antrean lokal — tidak lagi "timestamp lebih baru menang"
    (selisih jam antar-perangkat tak lagi membuat peramban tertinggal);
    catatan pending & tombstone tetap dilindungi sampai terkirim.
  * **Baris hantu dibersihkan**: catatan yang dihapus di perangkat lain ikut
    hilang saat tarikan **lengkap** (penanda `__complete` mencegah salah
    hapus bila tarikan terpotong batas).
  * **Kartu Pengaturan** kini "Status Sinkron (Tarik · Kirim · Realtime)" —
    menampilkan waktu tarik, waktu kirim, dan status saluran realtime
    (`supaRealtimeStatus`) sebagai alat diagnosis antar-peramban.
  * Berkas berubah: `js/app.js`, `js/supabase.js`, `index.html` (`?v=22`),
    `sw.js` (**v25**), `README.md`.

* **4.9.1** — Perbaikan sinkronisasi: **perubahan terbaru kini sampai ke semua
  peramban** (gejala: data baru hanya terlihat di 1 peramban, tidak muncul di
  peramban lain maupun mode privat).
  * **Penyebab**: kolom baru `jadwal.pemateri` & `jadwal.pemateri_2` belum ada
    di Supabase (`supabase/schema.sql` belum dijalankan ulang) sehingga
    PostgREST menolak pengiriman dengan `PGRST204`. Penanganan galat 4.9.0
    hanya mengenali **satu** kolom per percobaan dan tidak mengulanginya,
    sehingga pengiriman jadwal **tidak pernah konvergen** → jadwal baru hanya
    tersimpan di IndexedDB perangkat pembuatnya dan tidak pernah sampai ke
    server; peramban lain/mode privat (yang menarik dari server) tak
    pernah melihatnya.
  * **Perbaikan**: `supaPush` kini mengulang pengiriman sampai semua kolom yang
    hilang dikenali lalu dilewati (maks. 8 putaran), dan setiap
    `SCHEMA_RETRY_MS` (5 menit, bisa diubah di `js/config.js`) mencoba
    mengirim **lengkap** lagi — begitu `supabase/schema.sql` dijalankan ulang,
    kolom pemateri ikut tersinkron **otomatis** tanpa menutup aplikasi.
  * **Uji Koneksi Database memeriksa kelengkapan kolom** pada 7 tabel dan
    menampilkan daftar kolom yang belum ada beserta langkah memperbaikinya —
    sebelumnya laporan "siap" tetap muncul walau kolom kurang.
  * Pengenalan galat `42703` (format `column jadwal.pemateri does not exist`)
    diperbaiki — sebelumnya hanya `PGRST204` yang dikenali.
  * **Antrean lebih tahan banting**: operasi yang sudah `MAX_SYNC_TRIES` kali
    gagal dengan jawaban server digeser ke belakang (data tidak dibuang) agar
    tidak menahan data lain; seluruh operasi tertahan dicoba ulang segera
    setiap aplikasi dibuka.
  * Berkas berubah: `js/supabase.js`, `js/app.js`, `js/config.js`,
    `index.html` (`?v=21`), `sw.js` (**v24**).

* **4.9.0** — Ukuran Tulisan lebih lega, Kelola Jadwal lebih lengkap, dan
  modal notifikasi baru.
  * **Ukuran Tulisan** (*Lainnya*) dinaikkan **dua tingkat**: seluruh tangga
    skala naik karena keempat pilihan lama masih terasa kecil. Tangga baru:
    **Kecil 1,05× · Normal 1,18× · Besar 1,32× · Sangat Besar 1,45×**
    (dulu 0,90× / 1,00× / 1,12× / 1,25×) — pilihan terkecil sekarang pun
    lebih besar daripada "Normal" versi lama.
  * Kunci pilihan (`kecil`/`normal`/`besar`/`sangat-besar`) **tidak berubah**,
    jadi pengaturan tersimpan di perangkat tetap terbaca (hanya skalanya naik
    otomatis ke tingkat baru).
  * Nilai tangga disamakan di tiga tempat: `FONT_SIZES` (js/app.js), peta
    skala awal pada `index.html`, dan bawaan `--font-scale` di
    css/variables.css (= Normal), lengkap dengan catatan silang agar tidak
    tertinggal bila diubah lagi.
  * **Kelola Jadwal**: setelah memilih tanggal & jam, pilihan ditegaskan
    dengan tombol **OK** (atau **Batal** untuk membatalkannya) — jadwal hanya
    dapat disimpan setelah tanggal & jam ditegaskan. Kolom baru
    **Pemateri / Pengisi Materi** tampil di antara tanggal dan lokasi, dengan
    **kotak centang “Pemateri ke-2”** yang membuka kolom pemateri tambahan
    bila acara diisi lebih dari satu orang.
  * **Nama pemateri ikut tampil** pada daftar jadwal, keterangan laporan,
    **kolom `Pemateri` pada berkas CSV/Excel yang diunduh**, dan kop cetak
    daftar hadir.
  * **Modal notifikasi baru**: dialog modern namun ringan yang muncul
    **di tengah layar** — sudut membulat, garis aksen + ikon dengan warna
    nada (sukses / peringatan / bahaya), animasi pop halus, fokus otomatis ke
    tombol utama, dapat ditutup dengan **Esc** / ketukan latar, dan gulir
    latar dikunci. Hanya CSS + sedikit JS (`showModal`), tanpa pustaka baru.
  * **Kolom baru `jadwal.pemateri` & `jadwal.pemateri_2`** — **jalankan ulang
    `supabase/schema.sql`** (aman dijalankan berkali-kali). Bila belum
    dijalankan, jadwal tetap tersimpan & tersinkron tanpa kolom itu (kolom
    dilewati sementara + pengingat sekali di menu Pengaturan), sehingga
    antrean tidak pernah macet.
  * Ikon baru `check` & `xmark` (tombol OK/Batal) pada `js/icons.js`.
  * **Kartu laporan lebih hemat tempat di HP**: pada layar ≤620px, baris laporan
    tidak lagi menumpuk satu bidang per baris — **rekap kehadiran** menampilkan
    *Nama · Hadir · Persentase* **sebaris**, dan **daftar hadir per acara**
    mengalir beberapa bidang per baris (nama & tombol Kelola tetap selebar
    kartu). Tampilan di layar lebar tidak berubah.
  * service worker **v23**.

* **4.8.2** — Perbaikan galeri Dokumentasi & aturan versi:
  * **Thumbnail semuanya sama**: penyebabnya *service worker* mencocokkan
    cache dengan `ignoreSearch`, sehingga seluruh pratinjau Google Drive
    (`…/thumbnail?id=…`) dianggap satu berkas yang sama dan semua kartu
    memakai foto pertama yang tersimpan — walau tautan tiap entri berbeda
    (berkas hasil **Unduh** memang sudah benar). Kini pencocokan memakai
    **URL penuh** dan pratinjau Drive selalu diambil dari jaringan, dengan
    cache per-berkas sebagai cadangan saat luring.
  * Pratinjau yang gagal dimuat (berkas belum dibagikan / kuota pratinjau)
    mencoba **tautan berkas** sekali sebelum menampilkan ikon pengganti.
  * **Versi aplikasi satu sumber**: `CONFIG.VERSION` kini ditampilkan otomatis
    pada *Tentang Aplikasi*, *Bantuan*, dan layar masuk (sebelumnya kartu
    *Tentang Aplikasi* masih menulis 4.6.0). Setiap rilis wajib menaikkan
    `CONFIG.VERSION` (js/app.js), `VERSION` (sw.js), dan `?v=` pada index.html.
  * Service worker memeriksa pembaruan sendiri (`updateViaCache: 'none'`), lalu
    memberi tahu **"Versi baru … siap dipakai"** agar pengguna memuat ulang.
  * service worker **v20**.

* **4.8.1** — Perbaikan Materi & Dokumentasi:
  * **Banyak tautan sekali tempel**: hasil "Salin tautan" dari Google Drive
    (nama berkas + tautan dipisah TAB, sering tersalin dalam SATU baris) kini
    dikenali seluruhnya — sebelumnya seluruh tempelan dianggap satu tautan
    sehingga hanya 1 foto yang masuk. Kotak tempelan kini menampilkan
    penghitung "n tautan Drive terdeteksi", dan nama berkas ditampilkan
    di galeri.
  * **Tabel belum ada tidak lagi menahan sinkronisasi**: galat
    `PGRST205`/`42P01` (mis. `supabase/schema.sql` belum dijalankan ulang)
    menahan hanya data tabel itu sendiri — presensi & jadwal tetap terkirim,
    dan data materi tetap menunggu di antrean sampai tabelnya dibuat.
  * Pesan galat tarikan data kini menampilkan tindakan yang harus dilakukan
    ("Tabel belum ada di Supabase — jalankan supabase/schema.sql").
  * Trigger `updated_at` ditambahkan untuk `materi` & `dokumentasi`.
  * service worker **v19**.

* **4.8.0** — Dua submenu baru pada **Lainnya**:
  * **Materi** & **Dokumentasi** — semua anggota dapat melihat & mengunduh
    berkas/foto kegiatan yang **dikelompokkan per acara + tanggal**;
    hanya **Administrator & Pengurus** yang dapat menambah/menghapus.
  * Penyimpanan memakai **Google Drive (tautan)**: aplikasi mencatat tautan di
    tabel Supabase baru `materi` & `dokumentasi`; berkas tetap di kuota Drive
    (15 GB). Lihat bagian **6b** untuk langkah penyiapan folder Drive.
  * Galeri foto dengan thumbnail Drive, tautan unduh langsung
    (`uc?export=download`), dukungan tautan folder & dokumen Google.
  * Sinkronisasi penuh: IndexedDB store baru (DB v3), outbox, tarikan, dan
    Realtime; **jalankan ulang `supabase/schema.sql`** pada proyek yang ada.
  * service worker **v18**.

* **4.7.0** —
  * **Ukuran Tulisan** baru pada menu **Lainnya** (Kecil / Normal / Besar /
    Sangat Besar) — tersedia untuk **semua peran**, berlaku ke seluruh menu,
    dan tersimpan per perangkat (IndexedDB, seperti tema).
  * Status presensi kini hanya **Hadir**: pilihan **Izin** dan **Tanpa
    Keterangan** dihapus dari edit Administrator, kartu statistik beranda,
    tabel/CSV laporan, dan cetak daftar hadir. Baris lama di perangkat
    otomatis diubah menjadi `hadir` saat aplikasi dibuka — **jalankan ulang
    `supabase/schema.sql`** agar baris & batasan di server ikut diperbarui.
  * service worker **v17**.

* **4.6.0** — Penyempurnaan menyeluruh:
  * Pemindai QR jauh lebih tangguh: format isi QR diringkas (v2) + dukungan
    format cetakan lama, acara dicocokkan dengan data jadwal di perangkat,
    pemeriksaan acara ganda saat lebih dari satu acara berlangsung, dan
    pemindaian foto kini bisa dari **Galeri**.
  * **Sesi Hari Ini** di Beranda menjadi pintasan: ketuk acara → langsung ke
    halaman Presensi dengan acara terpilih (staff juga mendapat tombol **QR**).
  * Aktivitas Terbaru & Log selalu urut **terbaru di atas**; penghapusan log
    (per baris maupun sekaligus) kini benar-benar terhapus di perangkat
    **dan** server.
  * Riwayat Presensi (Administrator) mendapat kolom **Kelola → Hapus**.
  * Panduan Pemakaian ditampilkan **hanya sesuai peran**.
  * Data Peserta: kolom **Password** + tombol **Lihat Semua Password**,
    **Atur Ulang Password**, dan pintasan **WhatsApp** (tindakan tercatat di log).
  * **Lupa Password?** pada layar masuk: pengguna mengirim nomor HP/WA
    terdaftar → permintaan masuk ke Administrator yang sedang login
    (pemberitahuan + kartu di Beranda) → Administrator menghubungi via
    WhatsApp langsung. Tabel baru `password_requests`.
  * Selubung awal saat menyegarkan halaman: tidak ada lagi kedipan/redirect
    ke layar login, dan halaman terakhir tetap terbuka.
  * **Time-out sesi**: Pengurus & Peserta 6 jam, Administrator 12 jam —
    dengan pemberitahuan ramah sesaat sebelum keluar otomatis.
  * Skema: kolom `users.pass_plain` (salinan kata sandi untuk pemulihan) —
    **jalankan ulang `supabase/schema.sql`** pada proyek yang sudah ada.
* **4.1.0** — Basis data pindah ke **Supabase** (REST/PostgREST), konfigurasi
  terpusat di `js/config.js`, outbox lebih tahan gagal (tanpa head-of-line
  blocking), tombol **Uji Koneksi Database**, login dapat menarik akun dari
  basis data, service worker v11.
* **4.0.1** — Penyimpanan luring pindah dari `localStorage` ke **IndexedDB**.
* Sebelumnya — Presensi QR, jadwal & venue, laporan CSV/PDF, PWA.

