/* Dimuat langsung di <head> (sinkron, sebelum CSS terakhir) agar:
   1) selubung awal (data-boot) menyala SEBELUM halaman digambar ->
      tidak ada kedipan "dialihkan ke login";
   2) tema dari preferensi sistem langsung terpasang;
   3) tema & ukuran tulisan dari IndexedDB menggantikan preferensi
      begitu database siap, tanpa menunggu app.js.
   Dipisah dari inline (Fase 4A) agar CSP dapat mengaktifkan script-src
   TANPA unsafe-inline. */

/* Tema awal mengikuti preferensi sistem agar tidak berkedip.
   Tema yang tersimpan di DATABASE (IndexedDB) diterapkan segera
   setelah database siap — lihat js/db.js + js/app.js init().

   data-boot="1" menyalakan SELUBUNG AWAL: layar masuk & aplikasi utama
   disembunyikan sampai aplikasi selesai memeriksa sesi. Dengan begitu tidak
   ada kedipan "dialihkan ke halaman login" saat pengguna menyegarkan halaman. */
(function () {
  var root = document.documentElement;
  root.setAttribute('data-boot', '1');
  /* Selubung pengaman: bila aplikasi tidak selesai menyiapkan diri (mis. JS
     gagal / CSS lama dari cache), selubung dilepas PAKSA agar layar tidak
     terkunci. Hapus atribut data-boot SEKALIGUS sembunyikan #bootVeil via
     inline style — karena veil memakai style="display:flex" inline, hanya
     menghapus atribut tidak cukup bila CSS lama (tanpa !important) masih
     dipakai dari cache service worker. */
  setTimeout(function () {
    try { root.removeAttribute('data-boot'); } catch (e) {}
    try {
      var v = document.getElementById('bootVeil');
      if (v) { v.style.cssText = 'display:none !important'; v.setAttribute('aria-hidden', 'true'); }
    } catch (e2) {}
  }, 5000);
  try {
    var t = (window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
    root.setAttribute('data-theme', t);
    var m = document.querySelector('meta[name="theme-color"]');
    if (m) m.setAttribute('content', t === 'dark' ? '#130F0C' : '#6E2632');
  } catch (e) { /* abaikan */ }
})();

/* Terapkan tema tersimpan dari database IndexedDB sedini mungkin (tanpa localStorage).
   Dibuka TANPA nomor versi agar tidak bentrok ketika skema database dinaikkan
   (lihat DB_VERSION pada js/db.js). */
(function () {
  try {
    var req = indexedDB.open('ign_presensi_db');
    req.onupgradeneeded = function () {
      var db = req.result;
      ['users','jadwal','presensi','logs','outbox','tombstones','requests','materi','dokumentasi','kv'].forEach(function (s) {
        if (!db.objectStoreNames.contains(s)) db.createObjectStore(s);
      });
    };
    req.onsuccess = function () {
      try {
        var tx = req.result.transaction('kv', 'readonly');
        var g = tx.objectStore('kv').get('theme');
        g.onsuccess = function () {
          var t = g.result;
          if (t === 'dark' || t === 'light') {
            document.documentElement.setAttribute('data-theme', t);
            var m = document.querySelector('meta[name="theme-color"]');
            if (m) m.setAttribute('content', t === 'dark' ? '#130F0C' : '#6E2632');
          }
        };
        /* Ukuran tulisan tersimpan (menu Lainnya) — diterapkan sedini mungkin
           agar teks tidak "kedip" dari ukuran bawaan ke ukuran pilihan pengguna. */
        var gf = tx.objectStore('kv').get('fontSize');
        gf.onsuccess = function () {
          /* Nilai HARUS sama dengan FONT_SIZES pada js/app.js (tangga 4.9.0). */
          var skala = { kecil: 1.05, normal: 1.18, besar: 1.32, 'sangat-besar': 1.45 }[gf.result];
          if (skala) document.documentElement.style.setProperty('--font-scale', String(skala));
        };
      } catch (e) { /* abaikan */ }
    };
  } catch (e) { /* IndexedDB tidak tersedia — pakai preferensi sistem */ }
})();
