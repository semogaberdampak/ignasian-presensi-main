-- ============================================================================
--  PRESENSI IGNASIAN — Migrasi Fase B, tahap B0 (ADITIF, tanpa breaking)
-- ----------------------------------------------------------------------------
--  Aman dijalankan berulang (idempoten) dan berdampingan dengan aplikasi
--  v4.9.12 yang masih memakai REST langsung. TIDAK mengubah policy yang ada.
--  Jalankan via: supabase db execute -f supabase/migrasi-b0.sql
--  (atau tempel ke Dashboard -> SQL Editor -> Run).
--
--  Isi:
--   1. pass_bcrypt pada users (upgrade bertahap SHA-256 -> PBKDF2-SHA256).
--   2. login_attempts (throttle server-side function `login`).
--   3. Unique (user_id, jadwal_id) pada presensi (anti-duplikat di level DB;
--      duplikat dari function dijawab "sudah tercatat", bukan 500).
-- ============================================================================

-- 1. Kolom hash baru (aplikasi lama mengabaikan; function memakai ini dulu).
alter table public.users add column if not exists pass_bcrypt text;

-- 2. Throttle login server-side (kunci = 'login:<username-lowercase>').
create table if not exists public.login_attempts (
  kunci        text primary key,
  gagal        integer not null default 0,
  kunci_sampai timestamptz,
  updated_at   timestamptz default now()
);

-- Function memakai service_role (bypass RLS), tapi kunci baca/tulis untuk
-- anon juga dibuka agar kegagalan service_role tidak mematikan login.
-- Risiko ditahan: tabel ini hanya berisi {kunci, jumlah, waktu} — bukan data
-- sensitif — dan akan dikunci penuh pada tahap B1 (lockdown).
alter table public.login_attempts enable row level security;
drop policy if exists ign_client_all on public.login_attempts;
create policy ign_client_all on public.login_attempts
  for all to anon, authenticated using (true) with check (true);

-- 3. Anti-duplikat presensi di level DB (NULL user_id/jadwal_id dikecualikan
-- otomatis oleh Postgres — baris lama yang tak lengkap tidak bentrok).
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'presensi_unik_peserta_acara'
  ) then
    alter table public.presensi
      add constraint presensi_unik_peserta_acara unique (user_id, jadwal_id);
  end if;
end $$;
