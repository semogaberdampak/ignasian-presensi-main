-- ============================================================================
--  PRESENSI IGNASIAN — Data Awal (opsional)
--  ---------------------------------------------------------------------------
--  Membuat tiga akun awal, satu untuk tiap peran yang dipakai aplikasi:
--    admin    / admin123      → Administrator
--    pengurus / pengurus123   → Pengurus
--    peserta  / peserta123    → Peserta
--
--  Jalankan di Supabase → SQL Editor → New query → Run.
--  Berkas ini idempoten: baris yang sudah ada tidak ditimpa (on conflict do nothing).
--
--  PENTING: segera ganti ketiga kata sandi di atas setelah login pertama
--  (Registrasi akun baru + nonaktifkan akun contoh). Kata sandi disimpan
--  sebagai SHA-256 hex, bukan teks asli.
--
--  Cara membuat hash kata sandi baru (jalan di Console peramban mana pun):
--    const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('KataSandiBaru'));
--    [...new Uint8Array(h)].map(b => b.toString(16).padStart(2,'0')).join('');
--  Tempel hasilnya sebagai pass_hash pada perintah update berikut:
--    update public.users set pass_hash = '<hash-baru>' where username = 'admin';
-- ============================================================================

insert into public.users (id, nama, username, pass_hash, hp_hash, hp_plain, role, status, email)
values
  ('seed-admin-0001',    'Administrator',  'admin',
   '240be518fabd2724ddb6f04eeb1da5967448d7e831c08c8fa822809f74c720a9',
   '4f3ac1bcda9069e52d47a3dd55abac9d71a8661ffe93a0213062bf2c0f46c2c8',
   '081234567890', 'admin',    'aktif', 'admin@ignasian.id'),

  ('seed-pengurus-0001', 'Pengurus Umum',  'pengurus',
   '10a7d7922e860efbde52cb12326e758446a97399b9a2d46135d62d43d6561743',
   'c7ec6d641a0752b0a708491eaffb7980de3e3fe75f4ed26087e291e0f4d9d49c',
   '081234567891', 'pengurus', 'aktif', 'pengurus@ignasian.id'),

  ('seed-peserta-0001',  'Peserta Contoh', 'peserta',
   'b1d0478adc310cdc9ee7ed33b201677e5fd3cd3d10eb10e5086472b2248f00c5',
   '8090e44dc3338902ac00d0f6af67702f3ecc086534421880f17928f342219a2b',
   '081234567892', 'peserta',  'aktif', 'peserta@ignasian.id')
on conflict do nothing;

-- Periksa hasilnya:
--   select username, nama, role, status from public.users order by role;
