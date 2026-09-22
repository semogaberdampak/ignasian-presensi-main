/* ==========================================================================
   PRESENSI IGNASIAN — Konfigurasi Aplikasi
   --------------------------------------------------------------------------
   Berkas ini adalah SATU-SATUNYA tempat pengaturan layanan diisi.
   Ambil dua nilai berikut dari Dashboard Supabase → Project Settings → API:

     • SUPABASE_URL      : https://<project-ref>.supabase.co
     • SUPABASE_ANON_KEY : anon public key

   CATATAN KEAMANAN
   • Hanya "anon public key" yang boleh ditaruh di sini (memang dirancang
     untuk peramban). JANGAN pernah menempelkan "service_role key" — kunci
     itu hanya untuk sisi server/pihak tepercaya.
   • Setiap tabel dilindungi Row Level Security (lihat supabase/schema.sql).
   • Kata sandi pengguna disimpan sebagai hash SHA-256, bukan teks asli.

   Catatan: seluruh nilai di bawah dapat ditimpa saat deploy tanpa mengubah
   berkas ini, misalnya dengan menulis lebih dahulu:
     <script>window.IGN_CONFIG = { SUPABASE_URL: '...', ... };</script>
   ========================================================================== */
window.IGN_CONFIG = {

  /* ---------- Supabase (WAJIB diisi sebelum dipakai bersama) ---------- */
  SUPABASE_URL: 'https://tpafocyfburbgrxyfgni.supabase.co',            // contoh: https://abcdefghijklm.supabase.co
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRwYWZvY3lmYnVyYmdyeHlmZ25pIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTAwNTg0ODUsImV4cCI6MjEwNTYzNDQ4NX0.LE8OvQNAxJtXThZYNS4SButPOJIJg6V_Csp7G79AQ9s',   // contoh:yJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
  SUPABASE_SCHEMA: 'public',        // skema Postgres yang dipakai aplikasi

  /* ---------- Penyetelan sinkronisasi basis data ---------- */
  PAGE_SIZE: 1000,                  // jumlah baris per permintaan (batas PostgREST Supabase = 1000)
  MAX_ROWS: 20000,                  // pagar pengaman satu tarikan data (baris)
  TIMEOUT_MS: 15000,                // batas waktu satu permintaan (milidetik)
  LOG_PULL_LIMIT: 200,              // jumlah log terbaru yang ditarik (hanya Administrator)

  /* ---------- Penyetelan aplikasi ---------- */
  SYNC_INTERVAL: 60000,             // jeda sinkron latar saat daring (milidetik)
  MAX_USERS: 50,                    // batas jumlah akun
  MAX_QUEUE: 500,                   // batas antrean perubahan yang belum terkirim
  MAX_LOG: 500,                     // batas log yang disimpan di perangkat
  MAX_SYNC_TRIES: 5                 // setelah N kegagalan, operasi digeser ke belakang antrean
};
