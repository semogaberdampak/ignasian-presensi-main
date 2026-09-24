-- ============================================================================
--  PRESENSI IGNASIAN — Skema Basis Data Supabase
--  ---------------------------------------------------------------------------
--  Cara pakai (sekali saja):
--    1) Buka Dashboard Supabase → SQL Editor → New query.
--    2) Tempel seluruh isi berkas ini → Run.
--    3) (Opsional, untuk akun awal) jalankan juga supabase/seed.sql.
--
--  Berkas ini idempoten: aman dijalankan berulang kali.
--
--  Peran akun tetap tiga jenis, sesuai aplikasi:
--    admin    → Administrator (kelola akun, jadwal, QR, log, seluruh presensi)
--    pengurus → Pengurus (kelola jadwal & QR, membaca laporan)
--    peserta  → Peserta (memindai QR, melihat riwayat sendiri)
--
--  Kolom setiap tabel mengikuti variabel yang sudah dipakai aplikasi
--  (lihat js/app.js) dengan penamaan snake_case khas Postgres, mis.
--  `passHash` → pass_hash, `jadwalId` → jadwal_id, `updatedAt` → updated_at.
-- ============================================================================

-- ---------- 1. TABEL --------------------------------------------------------

-- Pengguna aplikasi (autentikasi dilakukan aplikasi memakai hash SHA-256)
create table if not exists public.users (
  id          text primary key,                                   -- uid() aplikasi
  nama        text not null,                                      -- nama lengkap
  username    text not null,                                      -- nama pengguna (unik, tanpa beda huruf besar/kecil)
  pass_hash   text,                                               -- SHA-256 kata sandi (hex)
  hp_hash     text,                                               -- SHA-256 nomor HP (hex)
  hp_plain    text,                                               -- nomor HP apa adanya (demi kompatibilitas skema lama)
  role        text not null default 'peserta'
              check (role in ('admin', 'pengurus', 'peserta')),
  status      text not null default 'aktif'
              check (status in ('aktif', 'nonaktif')),
  email       text,
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);

-- Jadwal/acara: venue, durasi, radius validasi, dan titik koordinat
create table if not exists public.jadwal (
  id          text primary key,
  nama        text not null,
  venue       text,
  durasi      integer default 60,                                 -- menit
  radius      integer default 50,                                 -- meter
  lat         double precision,
  lng         double precision,
  tanggal     timestamptz,                                        -- waktu mulai acara
  created_by  text,                                               -- users.id pembuat
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);

-- Presensi (hasil pindai QR, satu baris per peserta per acara)
create table if not exists public.presensi (
  id          text primary key,
  user_id     text,                                               -- users.id
  user_name   text,
  jadwal_id   text,                                               -- jadwal.id
  jadwal_nama text,
  venue       text,
  status      text default 'hadir'
              check (status in ('hadir', 'izin', 'alpha')),
  metode      text default 'qr',
  lat         double precision,
  lng         double precision,
  accuracy    double precision,
  distance    double precision,                                   -- jarak ke venue (meter)
  keterangan  text,
  timestamp   timestamptz default now(),
  updated_at  timestamptz default now()
);

-- Log aktivitas sistem (hanya dibaca Administrator)
create table if not exists public.logs (
  id          text primary key,
  timestamp   timestamptz default now(),
  updated_at  timestamptz default now(),
  action      text,                                               -- LOGIN, PRESENSI, CREATE_JADWAL, ...
  details     jsonb default '{}'::jsonb,
  user_id     text,
  user_name   text,
  user_role   text,
  user_agent  text,
  url         text
);

-- Permintaan pemulihan kata sandi ("Lupa password?") — dikirim pengguna dari
-- layar masuk dengan memasukkan nomor HP/WA terdaftar, lalu ditindaklanjuti
-- Administrator (hubungi via WhatsApp langsung).
create table if not exists public.password_requests (
  id           text primary key,
  user_id      text,                                              -- users.id peminta
  nama         text,
  username     text,
  role         text,
  hp           text,                                              -- nomor HP/WA terdaftar
  status       text not null default 'menunggu'
               check (status in ('menunggu', 'selesai')),
  requested_at timestamptz default now(),
  handled_by   text,                                              -- users.id Administrator
  handled_at   timestamptz,
  updated_at   timestamptz default now()
);

-- Salinan kata sandi untuk pemulihan oleh Administrator.
-- Aplikasi tetap memakai pass_hash (SHA-256) untuk masuk; kolom ini hanya
-- dibaca pada menu khusus Administrator agar dapat menghubungi pemilik akun.
-- (Bila tidak diinginkan, kolom ini boleh dibiarkan kosong.)
alter table public.users add column if not exists pass_plain text;

-- ---------- 2. INDEKS -------------------------------------------------------

-- Login: username dibandingkan tanpa membedakan huruf besar/kecil
create unique index if not exists users_username_key on public.users (lower(username));
create index if not exists users_role_idx on public.users (role);
create index if not exists users_status_idx on public.users (status);

create index if not exists jadwal_tanggal_idx on public.jadwal (tanggal desc);
create index if not exists jadwal_created_by_idx on public.jadwal (created_by);

-- Catatan: keunikan "satu presensi per peserta per acara" ditegakkan aplikasi
-- (bukan indeks unik) supaya proses sinkronisasi tidak pernah macet karena
-- bentrok 409 yang meninggalkan data di perangkat.
create index if not exists presensi_jadwal_idx on public.presensi (jadwal_id);
create index if not exists presensi_user_idx on public.presensi (user_id);
create index if not exists presensi_timestamp_idx on public.presensi (timestamp desc);
create index if not exists presensi_status_idx on public.presensi (status);

create index if not exists logs_timestamp_idx on public.logs (timestamp desc);
create index if not exists logs_action_idx on public.logs (action);
create index if not exists logs_user_idx on public.logs (user_id);

create index if not exists password_requests_status_idx
  on public.password_requests (status, requested_at desc);
create index if not exists password_requests_user_idx
  on public.password_requests (user_id);

-- ---------- 3. PENANDA WAKTU PERUBAHAN --------------------------------------
-- updated_at selalu terisi saat baris diubah (mis. lewat Table Editor),
-- sehingga penggabungan data di aplikasi tetap menentukan versi terbaru
-- dengan benar. Nilai kiriman aplikasi yang lebih baru tidak ditimpa.

create or replace function public.ign_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  if new.updated_at is not distinct from old.updated_at then
    new.updated_at := now();
  end if;
  return new;
end;
$$;

drop trigger if exists ign_touch_updated_at on public.users;
create trigger ign_touch_updated_at before update on public.users
  for each row execute function public.ign_touch_updated_at();

drop trigger if exists ign_touch_updated_at on public.jadwal;
create trigger ign_touch_updated_at before update on public.jadwal
  for each row execute function public.ign_touch_updated_at();

drop trigger if exists ign_touch_updated_at on public.presensi;
create trigger ign_touch_updated_at before update on public.presensi
  for each row execute function public.ign_touch_updated_at();

drop trigger if exists ign_touch_updated_at on public.logs;
create trigger ign_touch_updated_at before update on public.logs
  for each row execute function public.ign_touch_updated_at();

drop trigger if exists ign_touch_updated_at on public.password_requests;
create trigger ign_touch_updated_at before update on public.password_requests
  for each row execute function public.ign_touch_updated_at();

-- ---------- 4. HAK AKSES & ROW LEVEL SECURITY ------------------------------
-- Aplikasi memakai kunci "anon" (sama seperti model Web App "Anyone" pada
-- versi Google Apps Script). Karena itu RLS diaktifkan dengan kebijakan yang
-- mengizinkan peran anon membaca & menulis — lihat bagian 5 untuk pengerasan.

grant usage on schema public to anon, authenticated;
grant select, insert, update, delete
  on public.users, public.jadwal, public.presensi, public.logs, public.password_requests
  to anon, authenticated;

alter table public.users    enable row level security;
alter table public.jadwal   enable row level security;
alter table public.presensi enable row level security;
alter table public.logs     enable row level security;
alter table public.password_requests enable row level security;

drop policy if exists ign_client_all on public.users;
create policy ign_client_all on public.users
  for all to anon, authenticated using (true) with check (true);

drop policy if exists ign_client_all on public.jadwal;
create policy ign_client_all on public.jadwal
  for all to anon, authenticated using (true) with check (true);

drop policy if exists ign_client_all on public.presensi;
create policy ign_client_all on public.presensi
  for all to anon, authenticated using (true) with check (true);

drop policy if exists ign_client_all on public.logs;
create policy ign_client_all on public.logs
  for all to anon, authenticated using (true) with check (true);

drop policy if exists ign_client_all on public.password_requests;
create policy ign_client_all on public.password_requests
  for all to anon, authenticated using (true) with check (true);


-- ---------- 5. PENGERASAN KEAMANAN (OPSIONAL, JALANKAN NANTI) ---------------
-- Model saat ini = "klien tepercaya": siapa pun yang memiliki anon key dapat
-- membaca/menulis keempat tabel. Ini setara Web App "Anyone" pada versi lama
-- dan dinilai cukup untuk aplikasi internal (kata sandi disimpan sebagai hash,
-- bukan teks asli). Bila kelak perlu lebih ketat, pilih salah satu:
--
-- A) Supabase Auth (paling rapi, perubahan aplikasi sedang)
--    1. Aktifkan Authentication → Email/Password; daftarkan akun petugas.
--    2. Ganti kebijakan anon di atas dengan kebijakan berdasarkan auth.uid(),
--       mis. membaca laporan hanya untuk peran admin/pengurus:
--         drop policy ign_client_all on public.presensi;
--         create policy presensi_read on public.presensi for select
--           to authenticated using (true);
--         create policy presensi_write on public.presensi for insert
--           to authenticated with check (true);
--       (lalu sesuaikan aplikasi agar masuk memakai supabase.auth.signIn).
--
-- B) Edge Function perantara (tanpa mengubah basis data)
--    1. Buat function `sync` (Deno) yang memegang service_role key.
--    2. Batasi policy hanya untuk `authenticated`/`service_role`, lalu arahkan
--       aplikasi memanggil function tersebut.
--
-- Jangan pernah menaruh service_role key pada berkas yang diunggah ke hosting
-- statis (js/config.js, index.html, dsb.).

-- ---------- 6. VERIFIKASI ---------------------------------------------------
-- Jalankan potongan berikut untuk memastikan semuanya siap:
--
--   select 'users' as tabel, count(*) as baris from public.users
--   union all select 'jadwal',   count(*) from public.jadwal
--   union all select 'presensi', count(*) from public.presensi
--   union all select 'logs',     count(*) from public.logs
--   union all select 'password_requests', count(*) from public.password_requests;
--
--   -- pastikan RLS aktif dan kebijakan ada:
--   select tablename, policyname, roles from pg_policies
--   where schemaname = 'public' order by tablename;
--
-- Setelah itu, buka aplikasi → menu Lainnya → Pengaturan →
-- tombol "Uji Koneksi Database": keempat tabel harus berstatus terbaca.

