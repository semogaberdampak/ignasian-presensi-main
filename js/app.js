
/* ============================================================
   PRESENSI IGNASIAN — Aplikasi Inti
   ------------------------------------------------------------
   Prinsip: OFFLINE FIRST, sinkron daring menyusul.
   1) Setiap perubahan langsung ditulis ke penyimpanan perangkat (IndexedDB).
   2) Perubahan masuk ke antrean (outbox) yang dikirim ke basis data
      Supabase saat perangkat kembali daring (berurutan, tanpa kehilangan data).
   3) Data Supabase DIGABUNG (merge) — tidak menimpa perubahan lokal
      yang belum terkirim.
   ============================================================ */

/* ---------- 1. KONFIGURASI ------------------------------------------------ */
/* Pengaturan layanan (SUPABASE_URL, SUPABASE_ANON_KEY, dsb.) diambil dari
   js/config.js agar hanya ada satu tempat pengisian. */
const CONFIG = Object.assign({
  APP_NAME: 'Presensi Ignasian',
  /* Versi aplikasi — NAIKKAN setiap ada perbaikan atau fitur baru, dan
     samakan dengan VERSION pada sw.js (versi cache) serta ?v= pada index.html
     agar perangkat pengguna benar-benar memakai berkas terbaru. Nomor ini
     ditampilkan otomatis di Tentang Aplikasi, Bantuan, dan layar masuk
     (lihat terapkanVersi()). */
  VERSION: '4.9.9',
  SYNC_INTERVAL: 60000,   // 60 detik saat daring
  MAX_USERS: 50,
  MAX_QUEUE: 500,
  MAX_LOG: 500,
  MAX_SYNC_TRIES: 5,
  /* Masa berlaku sesi masuk (mili-detik) demi keamanan akun.
     Peserta 30 menit, Pengurus 45 menit, Administrator 60 menit. */
  SESSION_TTL_PESERTA: 30 * 60 * 1000,
  SESSION_TTL_STAFF: 45 * 60 * 1000,
  SESSION_TTL_ADMIN: 60 * 60 * 1000,
  SESSION_WARN_MS: 5 * 60 * 1000   // peringatan ramah 5 menit sebelum sesi berakhir
}, window.IGN_CONFIG || {});

/* ---------- 1b. VERSI APLIKASI (SATU SUMBER) ------------------------------ */
/* Seluruh nomor versi yang tampil di layar diambil dari CONFIG.VERSION agar
   tidak pernah tertinggal dari rilis terakhir: kartu "Tentang Aplikasi",
   halaman Bantuan, layar masuk, dan setiap elemen bertanda data-versi-app.
   Cukup ubah CONFIG.VERSION (satu tempat) saat merilis pembaruan. */
function versiLabel() { return 'Versi ' + CONFIG.VERSION; }

function terapkanVersi() {
  setText('tentangVersi', versiLabel() + ' · Ignatian Edition · © 2026');
  setText('bantuanVersi', versiLabel());
  try {
    document.querySelectorAll('[data-versi-app]').forEach(el => { el.textContent = versiLabel(); });
  } catch (e) { /* abaikan */ }
}

const STORE_KEYS = {
  users: 'ign_users', jadwal: 'ign_jadwal', presensi: 'ign_presensi',
  logs: 'ign_logs', session: 'ign_session', outbox: 'ign_outbox',
  tomb: 'ign_tombstones', meta: 'ign_meta', theme: 'ign_theme',
  requests: 'ign_requests', materi: 'ign_materi', dokumentasi: 'ign_dokumentasi',
  settings: 'ign_settings'
};

const STAFF_ROLES = ['admin', 'pengurus'];
/* Halaman yang dikunci per peran — JADWAL & BUAT QR hanya ADMIN/PENGURUS */
const PAGE_ACCESS = {
  jadwal: 'staff', 'qr-gen': 'staff',
  users: 'admin', registrasi: 'admin', log: 'admin', pdf: 'admin', member: 'admin'
};
const ROLE_LABEL = { admin: 'Administrator', pengurus: 'Pengurus', peserta: 'Peserta' };

/* ---------- 2. STATE ----------------------------------------------------- */
let state = {
  currentUser: null,
  users: [], jadwal: [], presensi: [], logs: [], requests: [],
  materi: [], dokumentasi: [],
  settings: [],                 /* pengaturan bersama (mis. layout PDF daftar hadir) */
  outbox: [], tombstones: [],
  meta: { lastSync: null, mountedAt: new Date().toISOString() },
  scanner: null,
  map: null, mapJadwal: null, markerJadwal: null,
  userLat: null, userLng: null,
  syncing: false, activePage: 'home',
  apiHint: null,          // pesan ramah bila basis data menolak permintaan
  backoffUntil: 0,        // jeda agar tidak membanjiri server yang bermasalah
  lastPushError: null,    // galat terakhir saat mengirim antrean
  activeJadwalId: null,   // acara yang dipilih di halaman Presensi (pintasan "Sesi Hari Ini")
  sessionExp: 0,          // kapan sesi masuk berakhir (mili-detik)
  sessionWarned: false,   // peringatan menjelang sesi berakhir sudah ditampilkan
  pendingRequestIds: []   // id permintaan lupa password yang belum diketahui Administrator
};

/* ---------- 3. UTILITAS -------------------------------------------------- */
const $ = id => document.getElementById(id);

/* Jaring pengaman global: NotAllowedError / SecurityError dari API opsional
   (Background Sync, SW, kamera, dsb. — umum bila dibuka via file:// atau
   tanpa izin) TIDAK BOLEH menjadi "Uncaught (in promise)" yang menghentikan
   alur boot. Penanganan khusus tetap di tempatnya; ini hanya jaring terakhir. */
try {
  window.addEventListener('unhandledrejection', ev => {
    const r = ev && ev.reason;
    const name = r && (r.name || '');
    const msg = String((r && (r.message || r)) || '');
    if (name === 'NotAllowedError' || name === 'SecurityError' ||
        name === 'NotSupportedError' || /permission denied|not allowed/i.test(msg)) {
      try { ev.preventDefault(); } catch (e) {}
    }
  });
} catch (e) { /* abaikan */ }

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/* KEAMANAN (H5): escape untuk nilai yang disisipkan ke dalam literal string
   JavaScript di dalam atribut HTML (mis. onclick="waTo('...')").
   esc() saja TIDAK cukup: browser men-decode entitas HTML (&#39; → ')
   SEBELUM JavaScript di-parse, sehingga kutip tetap bisa menutup literal
   dan menyuntikkan kode. escJs() menetralkan backslash, kutip, newline,
   dan pemisah baris Unicode agar nilai tidak bisa keluar dari literal. */
function escJs(v) {
  return String(v == null ? '' : v)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r').replace(/\n/g, '\\n')
     .replace(/\\u2028/g, '\\\\u2028').replace(/\\u2029/g, '\\\\u2029')
     .replace(/</g, '\\\\x3c').replace(/>/g, '\\\\x3e');
 }
/* SHA-256 bila tersedia (konteks aman); jika tidak, hash cadangan
   agar aplikasi tetap berfungsi saat dibuka luring dari berkas lokal. */
async function sha256(text) {
  if (window.crypto && crypto.subtle && crypto.subtle.digest) {
    try {
      const buf = new TextEncoder().encode(text);
      const hash = await crypto.subtle.digest('SHA-256', buf);
      return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
    } catch (e) { /* jatuh ke cadangan */ }
  }
  return 'v1:' + fallbackHash(text);
}

function fallbackHash(text) {
  let h1 = 0x811c9dc5, h2 = 0x1000193;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = (h1 ^ c) * 16777619 >>> 0;
    h2 = (h2 + c * (i + 7)) >>> 0;
  }
  return h1.toString(16) + h2.toString(16);
}

function toast(msg, type) {
  const t = $('toast');
  if (!t) return;
  t.textContent = msg;
  t.className = 'toast show' + (type ? ' ' + type : '');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.className = 'toast'; }, 3400);
}

function fmtDate(d) {
  const dt = new Date(d);
  if (isNaN(dt)) return '-';
  return dt.toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' });
}
function fmtTime(d) {
  const dt = new Date(d);
  if (isNaN(dt)) return '-';
  return dt.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
}
function fmtDateTime(d) { return fmtDate(d) + ' · ' + fmtTime(d); }

function notify(msg, type) { toast(msg, type); }

/* ---------- 4. TEMA (TERANG / GELAP) ------------------------------------- */
const THEME_COLOR = { light: '#6E2632', dark: '#130F0C' };
let _themeCache = null; /* cache tema dari database (IndexedDB) */

function systemTheme() {
  return (window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
}
function storedTheme() {
  /* Tema kini dibaca dari database (IndexedDB); cache memori untuk kecepatan */
  return _themeCache;
}
function currentTheme() { return storedTheme() || systemTheme(); }

/* Terapkan tema ke <html data-theme>; perbarui sakelar, label, dan warna bilah */
function applyTheme(mode, persist) {
  const m = (mode === 'dark') ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', m);
  if (persist) {
    _themeCache = m;
    kvSet('theme', m); /* disimpan di database, bukan localStorage */
  }

  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', THEME_COLOR[m]);

  const sw = $('themeSwitch');
  if (sw) {
    sw.setAttribute('aria-pressed', m === 'dark' ? 'true' : 'false');
    sw.setAttribute('aria-label', m === 'dark' ? 'Ubah ke tema terang' : 'Ubah ke tema gelap');
  }
  const knobIcon = document.querySelector('#themeSwitch .knob [data-ic]');
  if (knobIcon) knobIcon.setAttribute('data-ic', m === 'dark' ? 'moonstar' : 'sunray');
  if (window.Icon) Icon.hydrate(sw || document);

  const label = $('themeState');
  if (label) label.textContent = (m === 'dark' ? 'Gelap' : 'Terang');
  const sysNote = $('themeSystem');
  if (sysNote) sysNote.classList.toggle('hidden', !!storedTheme());
}

function toggleTheme() {
  const next = (currentTheme() === 'dark') ? 'light' : 'dark';
  applyTheme(next, true);
  toast(next === 'dark' ? 'Tema gelap dinyalakan' : 'Tema terang dinyalakan', 'success');
}

function watchSystemTheme() {
  if (!window.matchMedia) return;
  const mq = matchMedia('(prefers-color-scheme: dark)');
  const handler = () => { if (!storedTheme()) applyTheme(systemTheme(), false); };
  if (mq.addEventListener) mq.addEventListener('change', handler);
  else if (mq.addListener) mq.addListener(handler);
}

/* ---------- 4b. UKURAN TULISAN (MENU LAINNYA — SEMUA PERAN) ---------------
   Diterapkan lewat variabel CSS --font-scale pada <html>, sehingga seluruh
   teks berbasis rem (judul, tombol, tabel, kartu) ikut mengecil/membesar.
   Pilihan disimpan di IndexedDB (kv 'fontSize') — sama seperti tema — jadi
   berlaku per perangkat dan dipakai lagi pada kunjungan berikutnya.
   TANGGA SKALA (4.9.0): seluruh tombol dinaikkan DUA TINGKAT dari tangga lama
   (0.90 / 1.00 / 1.12 / 1.25) karena keempat pilihan lama dirasakan masih
   terlalu kecil. Kini pilihan paling kecil (1.05×) pun lebih besar daripada
   "Normal" lama, dan puncaknya 1.45× (sebelumnya 1.25×).
   PENTING: nilai ini harus SAMA dengan peta skala pada index.html, yang
   menerapkan ukuran tulisan lebih awal (sebelum CSS/JS utama dimuat) agar
   teks tidak "kedip" dari ukuran bawaan ke ukuran pilihan pengguna. */
const FONT_SIZES = [
  { key: 'kecil',        label: 'Kecil',        scale: 1.05 },
  { key: 'normal',       label: 'Normal',       scale: 1.18 },
  { key: 'besar',        label: 'Besar',        scale: 1.32 },
  { key: 'sangat-besar', label: 'Sangat Besar', scale: 1.45 }
];
let _fontSizeCache = null; /* kunci ukuran tulisan dari database (IndexedDB) */

function fontSizeOption(key) {
  return FONT_SIZES.find(o => o.key === key) || FONT_SIZES[1]; /* default: Normal */
}

/* Terapkan skala ke <html>; perbarui label & tombol pilihan pada menu Lainnya */
function applyFontSize(key, persist) {
  const opt = fontSizeOption(key);
  document.documentElement.style.setProperty('--font-scale', String(opt.scale));
  if (persist) {
    _fontSizeCache = opt.key;
    kvSet('fontSize', opt.key); /* disimpan di database, bukan localStorage */
  }
  const label = $('fontSizeState');
  if (label) label.textContent = opt.label;
  document.querySelectorAll('#fontSizeChoices .fs-choice').forEach(btn => {
    const active = btn.getAttribute('data-fs') === opt.key;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
}

function setFontSize(key) {
  const opt = fontSizeOption(key);
  applyFontSize(opt.key, true);
  toast('Ukuran tulisan diubah ke ' + opt.label, 'success');
}
/* ---------- 5. PENYIMPANAN DATABASE (IndexedDB, OFFLINE FIRST) ------------
   Semua data (pengguna, jadwal, presensi, log, antrean, sesi, tema)
   disimpan di IndexedDB — basis data peramban — bukan localStorage. */

function saveLocal() {
  try {
    dbReplaceAll('users', state.users, r => r.id);
    dbReplaceAll('jadwal', state.jadwal, r => r.id);
    dbReplaceAll('presensi', state.presensi, r => r.id);
    dbReplaceAll('logs', state.logs, r => r.id);
    dbReplaceAll('requests', state.requests, r => r.id);
    dbReplaceAll('materi', state.materi, r => r.id);
    dbReplaceAll('dokumentasi', state.dokumentasi, r => r.id);
    dbReplaceAll('settings', state.settings, r => r.id);
    dbReplaceAll('outbox', state.outbox, r => r.opId);
    dbReplaceAll('tombstones', state.tombstones, (r, i) => r.c + ':' + r.id + ':' + i);
    kvSet('meta', state.meta);
    return true;
  } catch (e) {
    toast('Penyimpanan database penuh — mohon sinkronkan lalu bersihkan', 'error');
    return false;
  }
}

/* Tandai waktu perubahan agar penggabungan data bisa menentukan versi terbaru */
function stamp(rec) {
  rec.updatedAt = new Date().toISOString();
  return rec;
}
function stampAll(list, fallbackField) {
  (list || []).forEach(r => {
    if (!r.updatedAt) r.updatedAt = r[fallbackField] || r.createdAt || new Date(0).toISOString();
  });
  return list || [];
}

async function loadLocal() {
  await migrateLegacyKV();
  await dbLoadAll();
  state.users = stampAll(dbRows('users'), 'createdAt');
  state.jadwal = stampAll(dbRows('jadwal'), 'createdAt');
  state.presensi = stampAll(dbRows('presensi'), 'timestamp');
  state.logs = sortLogs(stampAll(dbRows('logs'), 'timestamp'));
  state.requests = stampAll(dbRows('requests'), 'ts');
  state.materi = stampAll(dbRows('materi'), 'createdAt');
  state.dokumentasi = stampAll(dbRows('dokumentasi'), 'createdAt');
  state.settings = stampAll(dbRows('settings'), 'createdAt');
  state.outbox = dbRows('outbox');
  /* Operasi yang sedang menunggu jeda (galat pada sesi sebelumnya) dicoba lagi
     SEGERA setiap aplikasi dimuat — penting setelah pembaruan aplikasi/skema
     agar data yang tertahan cepat terkirim tanpa menunggu jeda panjang. */
  state.outbox.forEach(o => { if (o && typeof o === 'object') delete o.nextTryAt; });
  state.tombstones = dbRows('tombstones');
  state.meta = Object.assign({ lastSync: null }, await kvGet('meta', {}));
}

/* ---------- 5b. MIGRASI STATUS PRESENSI (IZIN & TANPA KETERANGAN DIHAPUS) --
   Status presensi kini HANYA 'hadir'. Baris lama berstatus 'izin'/'alpha'
   dinetralkan menjadi 'hadir'; pemanggil memutuskan apakah perubahan ikut
   dimasukkan ke antrean sinkron (agar baris di Supabase juga diperbarui).
   Idempoten — baris 'hadir' tidak disentuh. */
function normalizePresensiStatus() {
  const ubah = [];
  (state.presensi || []).forEach(p => {
    if (p && p.status && p.status !== 'hadir') {
      p.status = 'hadir';
      p.updatedAt = new Date().toISOString();
      ubah.push(p);
    }
  });
  return ubah;
}

/* Catatan aktivitas SELALU tersusun dari yang TERBARU ke yang terlama —
   saat dimuat dari perangkat, sesudah sinkronisasi, dan saat ditampilkan. */
function sortLogs(list) {
  return (list || []).slice().sort((a, b) =>
    (Date.parse(b.timestamp || b.updatedAt || 0) || 0) -
    (Date.parse(a.timestamp || a.updatedAt || 0) || 0));
}

/* ---------- 6. ANTREAN SINKRON (OUTBOX) --------------------------------- */
/* Basis data daring siap dipakai? (Supabase sudah dikonfigurasi di js/config.js) */
function apiReady() {
  return typeof supaReady === 'function' && supaReady();
}
function isOnline() { return navigator.onLine !== false; }

/* Simpan dahulu di perangkat lalu kirim (tahan-luring); PEMBACAAN cloud-first:
   data server menjadi acuan dan ditarik lebih dahulu — lihat syncNow(). */
function enqueue(type, data, extra) {
  const op = Object.assign({ opId: uid(), type: type, data: data, ts: Date.now(), tries: 0 }, extra || {});
  state.outbox.push(op);
  if (state.outbox.length > CONFIG.MAX_QUEUE) state.outbox = state.outbox.slice(-CONFIG.MAX_QUEUE);
  saveLocal();
  updateSyncUI();
  flushQueue();
  return op;
}

/* Nama koleksi aplikasi → seluruh jenis operasi antrean yang menulis ke
   koleksi tersebut. Wajib ada karena jenis operasi memakai bentuk tunggal
   (user, log, request) sedangkan nama koleksi berbentuk jamak (users, logs, ...). */
function outboxTypesFor(coll) {
  const types = [coll];
  const peta = (typeof SUPA_OUTBOX_TABLES !== 'undefined' && SUPA_OUTBOX_TABLES) ? SUPA_OUTBOX_TABLES : {};
  Object.keys(peta).forEach(t => {
    if (peta[t] === coll) types.push(t);
  });
  return types;
}

function queueDelete(collection, id) {
  state.tombstones.push({ c: collection, id: id, ts: Date.now() });
  if (state.tombstones.length > 500) state.tombstones = state.tombstones.slice(-500);
  const types = outboxTypesFor(collection);
  /* Buang operasi tulis yang belum terkirim untuk catatan ini — kalau tidak,
     catatan yang baru dihapus akan "hidup kembali" saat antrean dikirim. */
  state.outbox = state.outbox.filter(o => {
    const d = o.data || {};
    if (o.type === 'delete') return !(d.collection === collection && d.id === id);
    return !(d.id === id && types.indexOf(o.type) !== -1);
  });
  return enqueue('delete', { collection: collection, id: id });
}

/* Hapus banyak catatan sekaligus dengan satu pembersihan antrean —
   dipakai "Bersihkan Tampilan Log" agar ratusan operasi tidak dibuat
   satu per satu (antrean tetap ringan dan pengiriman tetap berurutan). */
function queueDeleteMany(collection, ids) {
  const list = (ids || []).filter(Boolean);
  if (!list.length) return 0;
  const types = outboxTypesFor(collection);
  const set = new Set(list.map(String));

  list.forEach(id => state.tombstones.push({ c: collection, id: id, ts: Date.now() }));
  if (state.tombstones.length > 500) state.tombstones = state.tombstones.slice(-500);

  state.outbox = state.outbox.filter(o => {
    const d = o.data || {};
    if (o.type === 'delete') return !(d.collection === collection && set.has(String(d.id)));
    return !(d.id && set.has(String(d.id)) && types.indexOf(o.type) !== -1);
  });
  list.forEach(id => state.outbox.push({
    opId: uid(), type: 'delete', data: { collection: collection, id: id },
    ts: Date.now(), tries: 0
  }));
  if (state.outbox.length > CONFIG.MAX_QUEUE) state.outbox = state.outbox.slice(-CONFIG.MAX_QUEUE);

  saveLocal();
  updateSyncUI();
  flushQueue();
  return list.length;
}

function isTombstoned(coll, id) {
  return state.tombstones.some(t => t.c === coll && t.id === id);
}
function pendingIds(coll) {
  const ids = new Set();
  /* Jenis operasi memakai bentuk tunggal (user/log/request) sedangkan
     koleksi berbentuk jamak (users/logs/requests) — pakai pemetaan. */
  const types = outboxTypesFor(coll);
  state.outbox.forEach(o => {
    if (o.data && o.data.id && types.indexOf(o.type) !== -1) ids.add(o.data.id);
  });
  return ids;
}

/* Kirim satu operasi antrean ke basis data Supabase.
   Mengembalikan true bila berhasil; galat terakhir disimpan di
   state.lastPushError supaya flushQueue() dapat memutuskan langkah berikutnya. */
async function postToServer(op) {
  state.lastPushError = null;
  try {
    if (op.type === 'delete') {
      const data = op.data || {};
      await supaDelete(data.collection, data.id);
      return true;
    }
    const coll = SUPA_OUTBOX_TABLES[op.type] || null;
    if (!coll) {
      console.warn('[Outbox] jenis operasi tidak dikenal, dilewati:', op.type);
      return true;                       /* dibuang agar antrean tidak macet */
    }
    await supaPush(coll, op.data);
    return true;
  } catch (e) {
    state.lastPushError = e;
    return false;
  }
}

/* Geser operasi ke belakang antrean agar tidak menghambat data lain.
   Data TIDAK pernah dihapus — tidak ada yang hilang karena galat sementara. */
function postponeOp(op) {
  op._postponed = true;
  state.outbox.shift();
  state.outbox.push(op);
}

async function flushQueue() {
  /* Mengembalikan jumlah operasi yang BERHASIL TERKIRIM — dipakai syncNow
     (cloud-first) untuk memutuskan apakah perlu menarik ulang versi resmi
     dari server sesudah pengiriman. */
  if (state.syncing || !apiReady() || !isOnline() || state.outbox.length === 0) {
    updateSyncUI();
    return 0;
  }
  state.syncing = true;
  updateSyncUI();

  const total = state.outbox.length;
  let sent = 0;
  let postponed = 0;

  try {
    /* Operasi HAPUS didahulukan: baris yang dihapus admin harus benar-benar
       lenyap dari Supabase dalam hitungan detik — jangan tertahan di belakang
       antrean tulis yang sedang menumpuk atau menunggu jeda galat.
       Array#sort() stabil, jadi urutan relatif tiap jenis operasi terjaga. */
    state.outbox.sort((a, b) =>
      ((a && a.type === 'delete') ? 0 : 1) - ((b && b.type === 'delete') ? 0 : 1));
    while (state.outbox.length && postponed < total) {
      const op = state.outbox[0];
      if (op._postponed) break;                  /* sudah dicoba sekali pada proses ini */

      /* Operasi yang sedang menunggu jeda (galat tetap) tidak menghambat sisanya */
      if (op.nextTryAt && Date.now() < op.nextTryAt) {
        postponeOp(op);
        postponed++;
        continue;
      }

      const ok = await postToServer(op);
      if (!ok) {
        const err = state.lastPushError;
        op.tries = (op.tries || 0) + 1;
        op.lastTry = new Date().toISOString();
        op.lastError = err ? String(err.detail || err.message || err) : 'gagal terkirim';
        state.apiHint = err ? supaErrorHint(err) : null;

        /* Tabel yang belum dibuat (mis. supabase/schema.sql belum dijalankan
           pada proyek yang sudah ada) hanya menahan data tabel itu sendiri:
           geser ke belakang dengan jeda tetap agar presensi/jadwal tetap
           terkirim — data TIDAK pernah dibuang. */
        if (supaNeedsSchema(err)) {
          op.nextTryAt = Date.now() + 5 * 60 * 1000;
          postponeOp(op);
          postponed++;
          continue;
        }

        /* Galat tetap (data tidak sah, mis. 400/409) tidak boleh menahan antrean:
           geser ke belakang dan beri jeda bertambah, lalu lanjut ke operasi lain. */
        if (supaIsPermanent(err)) {
          op.nextTryAt = Date.now() + Math.min(30 * 60 * 1000, 60 * 1000 * op.tries);
          postponeOp(op);
          postponed++;
          continue;
        }

        /* Sudah GAGAL berulang kali DAN servernya menjawab (bukan galat jaringan):
           geser ke belakang dengan jeda bertambah agar data lain di belakangnya
           tetap terkirim — satu operasi bermasalah tidak boleh menghambat
           antrean (data TIDAK pernah dibuang). */
        if (err && !err.network && op.tries >= CONFIG.MAX_SYNC_TRIES) {
          op.nextTryAt = Date.now() + Math.min(30 * 60 * 1000, 60 * 1000 * op.tries);
          postponeOp(op);
          postponed++;
          continue;
        }
        break;                                   /* galat sementara: coba lagi nanti */
      }

      delete op.nextTryAt;
      delete op.lastError;
      state.outbox.shift();
      sent++;
      /* Kolom baru yang belum ada di basis data lama sudah dilewati agar
         sinkron tidak macet — beri tahu SEKALI supaya schema.sql dijalankan
         ulang dan fitur baru (mis. pemateri) ikut tersinkron. */
      if (!flushQueue._colHint && typeof supaMissingColumns === 'function') {
        const hilang = supaMissingColumns();
        if (hilang.length) {
          flushQueue._colHint = true;
          state.apiHint = 'Kolom baru (' + hilang.join(', ') +
            ') belum ada di Supabase — jalankan ulang supabase/schema.sql agar ikut tersinkron.';
          toast(state.apiHint, 'error');
        }
      }
      saveLocal();
      updateSyncUI();
    }
    if (sent) {
      state.meta.lastSync = new Date().toISOString();
      state.meta.lastPush = state.meta.lastSync;   /* waktu pengiriman (kartu Pengaturan) */
    }
  } finally {
    state.outbox.forEach(o => { delete o._postponed; });
    state.syncing = false;
    saveLocal();
    updateSyncUI();
  }
  return sent;
}
/* ---------- 7. SINKRONISASI DARING (MENYUSUL, TANPA MENIMPA LOKAL) ------- */
function sig(list) {
  return (list || []).map(r => r.id + ':' + (r.updatedAt || r.createdAt || r.timestamp || '')).sort().join('|');
}

/* CLOUD-FIRST (4.9.2): basis data SERVER adalah acuan; data lokal hanya menang
   bila catatan itu masih DALAM ANTREAN (belum terkirim) atau ditandai hapus
   (tombstone). Perangkat lain karena itu selalu menerima versi terbaru apa
   adanya — tidak lagi bergantung pada kecocokan jam antar-perangkat seperti
   aturan lama "timestamp lebih baru menang".
   `remoteLengkap` = tarikan server benar-benar SELURUH baris (bukan terpotong
   batas tarikan): hanya saat itulah baris lokal yang tiada di server boleh
   dibuang (artinya sudah dihapus di perangkat lain). */
function mergeList(local, remote, coll, remoteLengkap) {
  const locked = pendingIds(coll);
  const byId = new Map();

  /* 1. Baris server masuk apa adanya — kecuali yang dilindungi lokal. */
  (remote || []).forEach(r => {
    if (!r || !r.id) return;
    if (isTombstoned(coll, r.id)) return;   /* sudah dihapus di perangkat ini */
    if (locked.has(r.id)) return;           /* belum terkirim → diisi dari lokal */
    byId.set(r.id, r);
  });

  /* 2. Baris lokal yang TIDAK ada di server: */
  (local || []).forEach(r => {
    if (!r || !r.id || byId.has(r.id)) return;
    if (locked.has(r.id)) { byId.set(r.id, r); return; }   /* antrean lokal menang */
    if (isTombstoned(coll, r.id)) return;    /* sudah dihapus → jangan dihidupkan */
    if (!remoteLengkap) byId.set(r.id, r);   /* tarikan terpotong → jangan dibuang */
    /* remoteLengkap & tiada di server → dihapus di perangkat lain: buang. */
  });

  return Array.from(byId.values());
}

function mergeRemote(data) {
  let changed = false;
  const lengkap = (data && data.__complete) || {};
  ['users', 'jadwal', 'presensi', 'logs', 'requests', 'materi', 'dokumentasi', 'settings'].forEach(key => {
    if (!Array.isArray(data[key])) return;
    const before = sig(state[key]);
    state[key] = mergeList(state[key], data[key], key, !!lengkap[key]);
    if (key === 'logs') state[key] = sortLogs(state[key]);   /* terbaru tetap di atas */
    if (sig(state[key]) !== before) changed = true;
  });
  return changed;
}

async function pullRemote(silent) {
  if (!apiReady() || !isOnline()) { updateSyncUI(); return false; }
  /* Jangan membanjiri server yang sedang bermasalah (mis. tabel belum dibuat
     atau kunci anon salah): jeda 5 menit setelah gagal konfigurasi. */
  if (state.backoffUntil && Date.now() < state.backoffUntil) { updateSyncUI('error'); return false; }
  try {
    const data = await supaPullAll({ includeLogs: isAdmin(), includeRequests: isAdmin() });
    const changed = mergeRemote(data);
    /* Baris server yang masih berstatus lama ('izin'/'alpha') dinetralkan
       sebelum ditampilkan — tanpa mendorong antrean di tengah tarikan. */
    const ternetralisir = normalizePresensiStatus().length > 0;
    state.apiHint = null;
    state.backoffUntil = 0;
    state.meta.lastSync = new Date().toISOString();
    state.meta.lastPull = state.meta.lastSync;   /* waktu tarikan (kartu Pengaturan) */
    saveLocal();
    if (changed || ternetralisir) {
      notifyNewResetRequests();       /* pemberitahuan permintaan lupa password (ADMIN) */
      /* Penyegaran tampilan TIDAK boleh membuat tarikan dianggap gagal:
         data sudah tersimpan di atas. Galat di sini (mis. elemen halaman belum
         siap) ditangkap agar pengguna tetap masuk & memakai data terbaru. */
      try { renderActivePage(); } catch (e) { console.warn('Segarkan tampilan gagal:', e); }
      if (!silent && changed) toast('Data diperbarui dari Supabase', 'success');
    }
    updateSyncUI();
    return true;
  } catch (e) {
    state.apiHint = supaErrorHint(e);
    /* Gagal konfigurasi (tabel/kunci) bukan sekadar luring — beri jeda agar
       console dan kuota tidak terbuang. Galat jaringan cukup dicoba lagi. */
    if (!e || !e.network) state.backoffUntil = Date.now() + 5 * 60 * 1000;
    console.warn('[Supabase] tarikan data gagal:', e);
    updateSyncUI('error');
    return false;
  }
}

/* CLOUD-FIRST: basis data DITARIK LEBIH DAHULU sebagai acuan, lalu
   perubahan lokal yang belum terkirim dikirim DI ATASNYA; bila ada yang
   terkirim, tarik sekali lagi untuk mengambil versi resmi dari server (echo).
   Saat luring semuanya gagal dengan tenang — cadangan perangkat tetap dipakai.
   Sinkron berjalan SEPENUHNYA otomatis (4.9.3): saat aplikasi dibuka, tiap
   SYNC_INTERVAL saat daring, dan setiap kali perangkat kembali daring.
   Tidak ada lagi tombol sinkron manual di Pengaturan. */
function syncNow(manual) {
  if (manual && !isAdmin()) {
    toast('Sinkronisasi manual hanya untuk Administrator', 'error');
    return Promise.resolve(false);
  }
  if (!apiReady()) {
    if (manual) toast('Basis data Supabase belum diatur — isi SUPABASE_URL & SUPABASE_ANON_KEY pada js/config.js', 'error');
    updateSyncUI();
    return Promise.resolve(false);
  }
  if (!isOnline()) {
    if (manual) toast('Perangkat sedang luring — data tetap aman di perangkat ini', 'error');
    updateSyncUI();
    return Promise.resolve(false);
  }
  return (async () => {
    const ditarik = await pullRemote(!manual);       /* 1. cloud = acuan */
    const terkirim = await flushQueue();             /* 2. perubahan lokal di atasnya */
    if (terkirim > 0) await pullRemote(true);        /* 3. echo versi resmi server */
    if (manual) {
      const left = state.outbox.length;
      if (left) toast(left + ' data belum terkirim, akan dicoba lagi', 'error');
      else if (state.apiHint) toast(state.apiHint, 'error');
      else if (!ditarik) toast('Perubahan terkirim — penarikan data gagal, akan dicoba lagi', 'error');
      else toast('Sinkronisasi selesai · basis data ditarik sebagai acuan', 'success');
    }
    return true;
  })();
}

/* ---------- 8. INDIKATOR STATUS SINKRON (LATAR BELAKANG) ------------------
   Sinkronisasi tidak lagi menampilkan bilah pada halaman agar tata letak
   tidak berubah tinggi. Status hanya ditampilkan di menu Pengaturan. */
function updateSyncUI(stateOverride) {
  if ($('page-pengaturan') && !$('page-pengaturan').classList.contains('hidden')) renderSettingsSync();
}

/* JARING PENGAMAN ANTREAN (4.9.6): flushQueue() memang sudah dipanggil
   begitu ada operasi baru, tetapi bisa TERLEWAT bila kebetulan sinkronisasi
   sedang berjalan (state.syncing) atau sedang ada galat jaringan — akibatnya
   operasi hapus baru terkirim pada sinkronisasi berkala berikutnya (60 detik).
   Pengawas ini menekan flushQueue() tiap 4 detik selama masih ada antrean
   yang tertunda sehingga penghapusan benar-benar terjadi dalam hitungan detik.
   Tidak membanjiri server: dilewati bila luring/belum siap/sedang sinkron,
   atau bila SEMUA operasi sedang menunggu jeda galat (nextTryAt). */
function startFlushWatchdog() {
  if (startFlushWatchdog._on) return;
  startFlushWatchdog._on = true;
  setInterval(() => {
    if (!state.outbox.length || state.syncing || !apiReady() || !isOnline()) return;
    if (!state.outbox.some(o => !o || !o.nextTryAt || o.nextTryAt <= Date.now())) return;
    flushQueue();
  }, 4000);
}

/* Pemicu sinkron: kembali daring, kembali ke aplikasi, berkala, realtime
   antar-pengguna, dan dari SW. Semua berjalan senyap di latar belakang —
   tanpa toast & tanpa bilah. */
function setupConnectivity() {
  startFlushWatchdog();          /* antrean (khususnya hapus) tak boleh tertunda */
  try { window.addEventListener('online', () => { syncNow(false); scheduleRealtimeCatchup(); }); } catch (e) {}
  try { window.addEventListener('offline', () => updateSyncUI()); } catch (e) {}
  try {
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && state.currentUser) { syncNow(false); scheduleRealtimeCatchup(); }
    });
  } catch (e) {}
  try { setInterval(() => { if (state.currentUser) syncNow(false); }, CONFIG.SYNC_INTERVAL); } catch (e) {}
  /* Saluran Realtime dinyalakan SEKALI di sini (bukan per-login) + setiap
     login/logout memperbarui visibilitas kartu sinkron (beberapa tombol
     hanya admin, tapi realtime + syncNow latar jalan untuk SEMUA peran). */
  try { scheduleRealtimeCatchup(); } catch (e) {}

  /* Service worker + Background Sync hanya di konteks aman (https/localhost).
     Dibuka via file:// (double-click) atau http biasa tanpa izin → API ini
     melempar NotAllowedError/SecurityError. Bungkus total agar TIDAK PERNAH
     menjadi "Uncaught (in promise)". */
  try {
    const isFile = location.protocol === 'file:';
    if (isFile || !window.isSecureContext) return;
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.addEventListener('message', ev => {
      if (ev.data && ev.data.type === 'flush-outbox') syncNow(false);
    });
    /* updateViaCache: 'none' → berkas sw.js SELALU diambil dari jaringan,
       sehingga kenaikan VERSION (versi cache) cepat terpakai di perangkat. */
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(reg => {
      try {
        if (reg && reg.sync && typeof reg.sync.register === 'function') {
          const p = reg.sync.register('ign-outbox');
          if (p && typeof p.then === 'function') {
            p.then(() => {}, () => { /* izin sync ditolak — abaikan, sinkron manual tetap jalan */ });
          }
        }
      } catch (e) { /* izin ditolak sinkron — abaikan */ }
      /* Versi baru siap dipakai → beri tahu pengguna, sebab berkas app.js/CSS
         baru baru berlaku setelah aplikasi dimuat ulang. */
      try {
        const kabariVersiBaru = () => {
          if (!navigator.serviceWorker.controller) return;  /* pemasangan pertama */
          if (!state.currentUser) return;                    /* diam di layar masuk */
          toast('Versi baru Presensi Ignasian siap dipakai — tutup lalu buka ulang aplikasi', 'success');
        };
        if (reg.waiting) kabariVersiBaru();
        reg.addEventListener('updatefound', () => {
          const baru = reg.installing;
          if (!baru) return;
          baru.addEventListener('statechange', () => {
            if (baru.state === 'installed') kabariVersiBaru();
          });
        });
        const upd = reg.update();
        if (upd && typeof upd.catch === 'function') upd.catch(() => {});
      } catch (e) { /* abaikan */ }
    }).catch(e => console.warn('Service worker gagal didaftarkan', e));
  } catch (e) { /* abaikan */ }
}
/* Menyalakan Saluran Realtime saat: sudah login + daring + Supabase siap.
   Dipanggil dari login/logout/online/focus, jadi admin TIDAK perlu menekan
   tombol apa pun — perubahan dari semua pengguna masuk otomatis. */
function scheduleRealtimeCatchup() {
  try {
    if (typeof startSupaRealtime === 'function') startSupaRealtime();
  } catch (e) {}
}

/* ---------- 9. CATATAN AUDIT (hanya dilihat ADMIN & PENGURUS) ------------ */
function addLog(action, details, userId) {
  const now = new Date().toISOString();
  const entry = {
    id: uid(),
    timestamp: now,
    updatedAt: now,
    action: action,
    details: details || {},
    userId: userId || (state.currentUser ? state.currentUser.id : 'system'),
    userName: state.currentUser ? state.currentUser.nama : 'Sistem',
    userRole: state.currentUser ? state.currentUser.role : 'system',
    userAgent: navigator.userAgent,
    url: location.href
  };
  state.logs.unshift(entry);
  if (state.logs.length > CONFIG.MAX_LOG) state.logs = state.logs.slice(0, CONFIG.MAX_LOG);
  saveLocal();
  enqueue('log', entry);
}

/* ---------- 10. PERAN & HAK AKSES --------------------------------------- */
function isStaff() { return !!state.currentUser && STAFF_ROLES.indexOf(state.currentUser.role) !== -1; }
function isAdmin() { return !!state.currentUser && state.currentUser.role === 'admin'; }
function roleName(role) { return ROLE_LABEL[role] || role; }

function roleAllows(need) {
  if (!state.currentUser) return false;
  if (!need || need === 'any') return true;
  if (need === 'admin') return isAdmin();
  if (need === 'staff') return isStaff();
  if (need === 'peserta') return state.currentUser.role === 'peserta';
  return false;
}
function canAccess(page) {
  const need = PAGE_ACCESS[page];
  return need ? roleAllows(need) : !!state.currentUser;
}

/* Sembunyikan HANYA tombol/menu berbasis peran (mis. LOG, JADWAL, BUAT QR
   tidak tampil bagi PESERTA). JANGAN sembunyikan section.page / kartu di sini:
   visibilitas halaman dikendalikan penuh oleh showPage() + renderHome().
   Menyentuh .page di sini membuat banyak halaman admin tampil bertumpuk. */
function applyRoleVisibility() {
  document.querySelectorAll('[data-role]').forEach(el => {
    if (el.classList && el.classList.contains('page')) return;
    if (el.id === 'homeActivityCard') return;
    el.classList.toggle('hidden', !roleAllows(el.getAttribute('data-role')));
  });
  document.querySelectorAll('[data-admin-note]').forEach(el => {
    el.classList.toggle('hidden', !isAdmin());
  });
  /* Kebalikannya: kartu pengganti yang HANYA tampil bagi Pengurus & Peserta
     (mis. pemberitahuan bahwa panel Sinkronisasi & Penyimpanan Luring dikunci). */
  document.querySelectorAll('[data-non-admin-note]').forEach(el => {
    el.classList.toggle('hidden', isAdmin());
  });
}

/* ---------- 10z. TOMBOL "MATA" PADA KOLOM PASSWORD ----------------------
   Menampilkan/menyembunyikan teks password yang sedang diketik. Dipakai
   layar Masuk, layar Daftar (password & ulangi password), dan Registrasi
   Administrator. Strukturnya: <div class="pw-wrap"><input …><button class=
   "pw-eye" onclick="toggleLihatPassword(this)">. */
function setPwVisible(input, visible) {
  if (!input) return;
  input.type = visible ? 'text' : 'password';
  const wrap = input.parentElement;
  const btn = (wrap && wrap.classList && wrap.classList.contains('pw-wrap'))
    ? wrap.querySelector('.pw-eye') : null;
  if (!btn) return;
  btn.setAttribute('aria-pressed', visible ? 'true' : 'false');
  btn.setAttribute('aria-label', visible ? 'Sembunyikan password' : 'Tampilkan password');
  btn.setAttribute('title', visible ? 'Sembunyikan password' : 'Tampilkan password');
  btn.innerHTML = ic(visible ? 'eyeoff' : 'eye');
}

function toggleLihatPassword(btn) {
  const wrap = btn ? btn.parentElement : null;
  const input = wrap ? wrap.querySelector('input') : null;
  if (input) setPwVisible(input, input.type === 'password');
}

/* ---------- 11. MASUK / KELUAR ------------------------------------------ */
async function doLogin() {
  const u = $('loginUser').value.trim();
  const p = $('loginPass').value;
  if (!u || !p) { toast('Lengkapi username & password', 'error'); return; }

  /* Akun contoh hanya dibuat saat aplikasi berdiri sendiri (Supabase belum
     diatur). Pada mode Supabase, akun dibuat lewat Registrasi atau seed.sql
     supaya kata sandi bawaan tidak pernah ikut terpasang di produksi. */
  if (state.users.length === 0 && !apiReady()) await seedDefaultUsers();

  const btn = $('btnLogin');
  if (btn) { btn.disabled = true; btn.dataset.label = btn.innerHTML; btn.textContent = 'Memeriksa…'; }

  try {
    const passHash = await sha256(p);
    const needle = u.toLowerCase();
    const findUser = () => state.users.find(x =>
      String(x.username || '').toLowerCase() === needle && x.passHash === passHash && x.status === 'aktif');

    let user = findUser();

    /* Akun dibuat Administrator di peranti lain → tarik dahulu dari Supabase
       agar pengguna baru dapat langsung masuk pada peranti ini.
       Catatan: findUser() diperiksa ULANG setelah tarikan apa pun hasilnya —
       data bisa sudah masuk walau tarikan mengembalikan false (mis. galat saat
       menyegarkan tampilan), sehingga akun terdaftar tidak ikut tertolak. */
    if (!user && apiReady() && isOnline() &&
      !state.users.some(x => String(x.username || '').toLowerCase() === needle)) {
      try { await pullRemote(true); } catch (e) { 
           /* abaikan — cek lokal tetap jalan */ 
           if (state.users.length === 0) { 
               await seedDefaultUsers(); 
           } 
       }
      user = findUser();
    }

    if (!user) {
      if (apiReady() && !isOnline() && state.users.length === 0) {
        toast('Akun belum tersimpan di peranti ini dan perangkat sedang luring — sambungkan internet lalu coba lagi', 'error');
      } else if (apiReady() && !state.users.length) {
        toast('Belum ada akun pada basis data. Minta Administrator membuat akun pertama (supabase/seed.sql atau menu Registrasi).', 'error');
      } else if (state.apiHint) {
        toast(state.apiHint + ' — coba lagi sebentar lagi.', 'error');
      } else {
        toast('Username/password salah atau akun nonaktif', 'error');
      }
      return;
    }

    state.currentUser = user;
    startSession(user);   /* catat masa berlaku sesi + pengawas waktu (30/45/60 menit) */
    addLog('LOGIN', { username: user.username, masaBerlaku: fmtDurasi(sessionTtlMs(user)) });
    toast('Selamat datang, ' + user.nama + '!', 'success');
    /* KEAMANAN (H3): akun bawaan mode mandiri wajib ganti sandi saat login
       pertama — kunci layar sampai sandi baru tersimpan. */
    if (user.harusGantiSandi === true) {
      showMainApp('home');
      try { syncNow(false); } catch (e) {}
      wajibGantiSandi(user);
      return;
    }
    showMainApp('home');
    try { scheduleRealtimeCatchup(); } catch (e) {}
    /* CLOUD-FIRST: setelah masuk, tarik basis data sebagai acuan lalu kirim
       antrean — tanpa menunggu interval 60 detik atau saluran realtime. */
    try { syncNow(false); } catch (e) {}
  } finally {
    if (btn) { btn.disabled = false; if (btn.dataset.label) btn.innerHTML = btn.dataset.label; }
  }
}

function doLogout(opts) {
  const simpanUsername = !!(opts && opts.keepUsername);
  const usernameTerakhir = state.currentUser ? state.currentUser.username : '';
  if (state.currentUser) addLog('LOGOUT', { username: state.currentUser.username });
  state.currentUser = null;
  state.sessionExp = 0;
  state.sessionWarned = false;
  state.activeJadwalId = null;
  kvSet('session', null); /* hapus sesi dari database */
  stopScanner();
  $('mainApp').classList.add('hidden');
  $('loginScreen').classList.remove('hidden');
  $('loginUser').value = simpanUsername ? usernameTerakhir : '';
  /* Kolom password dikosongkan SEKALIGUS dikembalikan ke mode tersembunyi,
     agar pengguna berikutnya tidak mewarisi tampilan "terlihat". */
  setPwVisible($('loginPass'), false);
  $('loginPass').value = '';
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  endBoot();
}

/* ---------- 11b. MASA BERLAKU SESI (TIME-OUT LOGIN) --------------------- */
/* Demi keamanan akun: sesi Peserta berakhir setelah 30 menit, Pengurus
   setelah 45 menit, dan Administrator setelah 60 menit. Ketika berakhir,
   pengguna otomatis keluar dan diberi pemberitahuan singkat. */
function sessionTtlMs(user) {
  const role = (user && user.role) || 'peserta';
  if (role === 'admin') return Number(CONFIG.SESSION_TTL_ADMIN) || 60 * 60 * 1000;
  if (role === 'pengurus') return Number(CONFIG.SESSION_TTL_STAFF) || 45 * 60 * 1000;
  return Number(CONFIG.SESSION_TTL_PESERTA) || 30 * 60 * 1000;
}

/* Teks durasi untuk log: "30 menit", "45 menit", "1 jam", "1,5 jam". */
function fmtDurasi(ms) {
  const menit = Math.round(Number(ms) / 60000);
  if (!isFinite(menit) || menit <= 0) return '-';
  if (menit < 60) return menit + ' menit';
  const jam = menit / 60;
  return (Number.isInteger(jam) ? jam : String(jam).replace('.', ',')) + ' jam';
}

/* Catat sesi di database peranti agar tetap berlaku saat halaman disegarkan */
function startSession(user) {
  const now = Date.now();
  const exp = now + sessionTtlMs(user);
  state.sessionExp = exp;
  state.sessionWarned = false;
  kvSet('session', { id: user.id, t: now, exp: exp, role: user.role });
}

/* Pengawas waktu: memeriksa sesi tiap 30 detik dan saat aplikasi difokuskan */
function startSessionWatch() {
  if (startSessionWatch._on) return;
  startSessionWatch._on = true;
  setInterval(checkSessionTimeout, 30000);
  window.addEventListener('focus', checkSessionTimeout);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) checkSessionTimeout(); });
}

function checkSessionTimeout() {
  if (!state.currentUser || !state.sessionExp) return;
  const sisa = state.sessionExp - Date.now();
  if (sisa <= 0) { sesiBerakhir(); return; }
  if (sisa <= CONFIG.SESSION_WARN_MS && !state.sessionWarned) {
    state.sessionWarned = true;
    const menit = Math.max(1, Math.round(sisa / 60000));
    toast('Sesi Anda berakhir dalam ' + menit + ' menit. Silakan simpan pekerjaan Anda dahulu, ya.', 'info');
  }
}

function sesiBerakhir() {
  const user = state.currentUser;
  addLog('SESSION_TIMEOUT', { username: user ? user.username : '-' });
  state.sessionExp = 0;
  try { stopScanner(); } catch (e) { /* abaikan */ }
  doLogout({ keepUsername: true });
  showModal('Sesi Berakhir',
    '<p>Sesi Anda sudah habis, silakan login kembali.</p>' +
    '<div class="modal-actions"><button class="btn btn-primary" onclick="closeModal()">' +
    ic('keycross') + 'Masuk Kembali</button></div>',
    { icon: 'keycross', tone: 'warn' });
}

/* Pengguna contoh untuk pemakaian mandiri (tanpa Supabase).
   Pada mode Supabase gunakan supabase/seed.sql — lihat README.md.
   KEAMANAN (H3): akun bawaan memakai kata sandi acak per-perangkat dan
   WAJIB diganti saat login pertama (flag harusGantiSandi) — tidak ada lagi
   kata sandi default yang sama di semua instalasi. */
async function seedDefaultUsers() {
  const defaults = [
    { nama: 'Administrator', username: 'admin', hp: '081234567890', role: 'admin', email: 'admin@ignasian.id' },
    { nama: 'Pengurus Umum', username: 'pengurus', hp: '081234567891', role: 'pengurus', email: 'pengurus@ignasian.id' },
    { nama: 'Peserta Contoh', username: 'peserta', hp: '081234567892', role: 'peserta', email: 'peserta@ignasian.id' }
  ];
  const created = [];
  for (const d of defaults) {
    const now = new Date().toISOString();
    /* Kata sandi awal acak per-perangkat (10 karakter) — hanya jembatan agar
       akun dapat dibuat tanpa kata sandi default global. Pemilik WAJIB
       menggantinya saat login pertama (lihat harusGantiSandi + doLogin). */
    const passAwal = passwordAcak();
    created.push({
      id: uid(),
      nama: d.nama,
      username: d.username,
      passHash: await sha256(passAwal),
      passPlain: passAwal,        /* disimpan demi pemulihan oleh Administrator */
      hpHash: await sha256(d.hp),
      hpPlain: d.hp,          // disimpan demi kompatibilitas skema lama
      role: d.role,
      status: 'aktif',
      email: d.email,
      harusGantiSandi: true,  /* kunci: login pertama dialihkan ke ganti sandi */
      createdAt: now,
      updatedAt: now
    });
  }
  state.users = state.users.concat(created);
  saveLocal();
  for (const u of created) { try { enqueue('user', u); } catch (e) { /* luring */ } }
}

async function checkSession() {
  const s = await kvGet('session', null);
  if (!s || !s.id) return false;
  /* Sesi yang sudah kedaluwarsa (time-out login) langsung ditutup. */
  if (s.exp && Date.now() > Number(s.exp)) {
    await kvSet('session', null);
    _sessionExpiredAtBoot = true;
    return false;
  }
  const user = state.users.find(u => u.id === s.id && u.status === 'aktif');
  if (!user) return false;
  state.currentUser = user;
  /* Masa berlaku dihitung dari waktu mulai sesi memakai ATURAN PERAN YANG
     BERLAKU SEKARANG — sesi lama (dulu 6/12 jam) ikut dipotong menjadi
     30/45/60 menit tanpa perlu keluar-masuk dahulu. */
  const mulai = Number(s.t) || Date.now();
  const ttl = sessionTtlMs(user);
  state.sessionExp = Math.min(Number(s.exp) || (mulai + ttl), mulai + ttl);
  state.sessionWarned = false;
  return true;
}

/* Tandai bahwa sesi sebelumnya berakhir karena waktu (dipakai init()) */
let _sessionExpiredAtBoot = false;

function showLoginScreen() {
  const ls = $('loginScreen');
  const ma = $('mainApp');
  if (ls) ls.classList.remove('hidden');
  if (ma) ma.classList.add('hidden');
  /* WAJIB: jalur tanpa sesi (pengguna baru / sesi habis) juga harus melepas
     selubung. Sebelumnya hanya showMainApp() yang memanggil endBoot(),
     sehingga layar login macet di logo IHS selamanya. */
  try { endBoot(); } catch (e) { /* abaikan */ }
}
/* ---------- 12. NAVIGASI ------------------------------------------------- */
const NAV_GROUPS = {
  home: 'home', presensi: 'presensi', riwayat: 'riwayat', laporan: 'laporan',
  lainnya: 'lainnya', profil: 'lainnya', pengaturan: 'lainnya', bantuan: 'lainnya',
  users: 'lainnya', registrasi: 'lainnya', jadwal: 'lainnya', 'qr-gen': 'lainnya', log: 'lainnya',
  materi: 'lainnya', dokumentasi: 'lainnya', pdf: 'lainnya', member: 'lainnya'
};

function showPage(name, btn) {
  if (!state.currentUser) return;

  if (!canAccess(name)) {
    const need = PAGE_ACCESS[name];
    toast(need === 'admin'
      ? 'Halaman ini hanya untuk Administrator'
      : 'Halaman ini hanya untuk Administrator & Pengurus', 'error');
    name = 'home';
    btn = null;
  }

  state.activePage = name;

  applyRoleVisibility();
  document.querySelectorAll('.page').forEach(p => p.classList.add('hidden'));
  const target = $('page-' + name);
  if (target) target.classList.remove('hidden');

  const group = NAV_GROUPS[name] || name;
  document.querySelectorAll('.nav-item').forEach(n => {
    n.classList.toggle('active', n.getAttribute('data-page') === group);
  });
  if (btn) btn.classList.add('active');

  renderPage(name);
  terapkanVersi();   /* nomor versi selalu dari CONFIG.VERSION (satu sumber) */

  if (('#' + name) !== location.hash) {
    try { history.replaceState(null, '', '#' + name); } catch (e) { /* abaikan */ }
  }
  window.scrollTo(0, 0);
}

function renderPage(name) {
  switch (name) {
    case 'home': renderHome(); break;
    case 'presensi': renderPresensiSesi(); break;
    case 'riwayat': renderRiwayat(); break;
    case 'laporan': prepareLaporan(); break;
    case 'lainnya': renderLainnya(); break;
    case 'materi': renderMateri(); break;
    case 'dokumentasi': renderDokumentasi(); break;
    case 'profil': loadProfil(); break;
    case 'pengaturan': applyTheme(currentTheme(), false); renderSettingsSync(); break;
    case 'users': renderUsers(); renderResetRequests(); break;
    case 'member': renderMemberList(); break;
    case 'jadwal': renderJadwal(); setTimeout(initMapJadwal, 120); break;
    case 'qr-gen': renderQrJadwalSelect(); break;
    case 'log': renderLog(); break;
    case 'pdf': renderPdfSettings(); break;
    case 'bantuan': renderBantuan(); break;
    default: break;
  }
}
function renderActivePage() {
  /* Tanpa pengguna yang masuk, halaman Beranda tidak boleh dirender: renderHome()
     memakai state.currentUser.id dan akan melempar galat bila currentUser masih
     null. Ini terjadi saat tarikan data berjalan SEBELUM login selesai
     (mis. doLogin() → pullRemote()), yang sebelumnya menggagalkan login. */
  if (!state.currentUser) return;
  renderPage(state.activePage);
}

/* Tampilkan aplikasi utama.
   startPage menentukan halaman yang dibuka:
     • sesudah LOGIN        → selalu Beranda
     • sesudah SEGAR halaman (refresh) → halaman terakhir dari #hash, sehingga
       pengguna tetap berada di halaman yang sama dan tidak dilempar ke mana-mana. */
function showMainApp(startPage) {
  $('loginScreen').classList.add('hidden');
  $('mainApp').classList.remove('hidden');

  renderUserChip();
  applyRoleVisibility();
  updateSyncUI();

  const page = (startPage && canAccess(startPage)) ? startPage : 'home';
  try { history.replaceState(null, '', '#' + page); } catch (e) { /* abaikan */ }
  showPage(page);
  endBoot();
}

/* Lepas selubung awal (lihat index.html + css/utilities.css).
   Dipanggil setelah aplikasi tahu layar mana yang harus ditampilkan sehingga
   tidak ada kedipan "dialihkan ke halaman login" saat halaman disegarkan. */
function endBoot() {
  try { document.documentElement.removeAttribute('data-boot'); } catch (e) { /* abaikan */ }
  /* Sabuk + suspender: aturan CSS memakai !important karena style inline
     display:flex pada #bootVeil (index.html) mengalahkan display:none biasa.
     Sembunyikan langsung via DOM agar veil TIDAK PERNAH macet menutupi layar
     walau CSS gagal dimuat / di-cache lama oleh service worker. */
  try {
    var v = document.getElementById('bootVeil');
    if (v) { v.style.display = 'none'; v.setAttribute('aria-hidden', 'true'); }
  } catch (e) { /* abaikan */ }
}

/* Kartu pengguna di kepala aplikasi (tanpa indikator sinkron — sinkron berjalan di latar) */
function renderUserChip() {
  const u = state.currentUser;
  if (!u || !$('userChip')) return;
  $('userChip').innerHTML =
    '<span class="who">' + esc(u.nama) + '</span>' +
    '<span class="role">' + esc(roleName(u.role)) + '</span>';
}

/* ---------- 13. HELPER TAMPILAN ----------------------------------------- */
function statCard(label, value, tone) {
  return '<div class="stat ' + (tone || '') + '">' +
    '<div class="label">' + esc(label) + '</div>' +
    '<div class="value">' + esc(value) + '</div></div>';
}
function cardWrap(iconName, title, body) {
  return '<div class="card"><div class="card-title">' + ic(iconName) + esc(title) + '</div>' + body + '</div>';
}
/* ---------- 14. BERANDA (TAMPILAN MENURUT PERAN) ------------------------ */
function renderHome() {
  /* Penjaga: renderHome() hanya boleh berjalan bila ada pengguna yang masuk
     (dipanggil juga oleh renderActivePage). Tanpa ini, "state.currentUser.id"
     melempar TypeError dan merusak alur tarikan data / boot. */
  if (!state.currentUser) return;
  const box = $('homeStats');
  const feed = $('homeActivity');
  const extra = $('adminHomeExtra');

  /* Aktivitas Terbaru + Log: HANYA ADMIN. Pengurus tidak melihat. */
  const actCard = $('homeActivityCard');
  if (actCard) actCard.classList.toggle('hidden', !isAdmin());
  if (feed && !isAdmin()) { feed.classList.add('hidden'); feed.innerHTML = ''; }

  if (isAdmin()) {
    /* ADMIN: ringkasan seluruh peserta + arus aktivitas sistem */
    setText('homeScope', 'Ringkasan seluruh peserta aktif hari ini.');
    const today = new Date().toDateString();
    const todayPres = state.presensi.filter(p => new Date(p.timestamp).toDateString() === today);
    const peserta = state.users.filter(u => u.role === 'peserta' && u.status === 'aktif');

    box.innerHTML =
      statCard('Peserta Terdaftar', peserta.length, '') +
      statCard('Hadir Hari Ini', todayPres.filter(p => p.status === 'hadir').length, 'hadir') +
      statCard('Belum Presensi', Math.max(0, peserta.length - todayPres.length), 'alpha');

    feed.classList.remove('hidden');
    feed.innerHTML = renderActivityFeed();

    /* Permintaan lupa password + pintasan "Sesi Hari Ini" + jadwal mendatang */
    const mineAdmin = state.presensi.filter(p => p.userId === state.currentUser.id);
    extra.innerHTML = resetRequestCard() + sesiHariIniCard(mineAdmin, true) + jadwalMendatangCard();
    return;
  }

  if (isStaff()) {
    /* PENGURUS: ringkasan seluruh peserta TANPA aktivitas sistem */
    setText('homeScope', 'Ringkasan seluruh peserta aktif hari ini.');
    const today = new Date().toDateString();
    const todayPres = state.presensi.filter(p => new Date(p.timestamp).toDateString() === today);
    const peserta = state.users.filter(u => u.role === 'peserta' && u.status === 'aktif');

    box.innerHTML =
      statCard('Peserta Terdaftar', peserta.length, '') +
      statCard('Hadir Hari Ini', todayPres.filter(p => p.status === 'hadir').length, 'hadir') +
      statCard('Belum Presensi', Math.max(0, peserta.length - todayPres.length), 'alpha');

    /* Pengurus: pintasan acara hari ini (dapat diketuk) + jadwal mendatang */
    const mineStaff = state.presensi.filter(p => p.userId === state.currentUser.id);
    extra.innerHTML = sesiHariIniCard(mineStaff, true) + jadwalMendatangCard();
    return;
  }

  /* PESERTA: ringkasan pribadi — tanpa catatan aktivitas sistem */
  setText('homeScope', 'Ringkasan kehadiran pribadi Anda bulan ini.');
  const mine = state.presensi.filter(p => p.userId === state.currentUser.id);
  const now = new Date();
  const monthSessions = state.jadwal.filter(j => {
    const d = new Date(j.tanggal);
    return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getTime() <= now.getTime();
  });
  const sessionIds = new Set(monthSessions.map(j => j.id));
  const inMonth = mine.filter(p => sessionIds.has(p.jadwalId));
  const hadir = inMonth.filter(p => p.status === 'hadir').length;

  box.innerHTML =
    statCard('Sesi Bulan Ini', monthSessions.length, '') +
    statCard('Hadir', hadir, 'hadir');

  feed.classList.add('hidden');
  feed.innerHTML = '';
  const actCardHide = $('homeActivityCard');
  if (actCardHide) actCardHide.classList.add('hidden');

  const last = mine.slice().sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))[0];

  extra.innerHTML =
    sesiHariIniCard(mine, false) +
    cardWrap('seal', 'Presensi Terakhir Anda', last
      ? `<div class="list-item">${ic('seal')}
          <div class="body">
            <strong>${esc(last.jadwalNama || '-')}</strong>
            <div class="meta">${esc(last.venue || '')} · ${fmtDateTime(last.timestamp)}</div>
            <div class="meta">Metode: Pindai QR</div>
          </div>
          <span class="badge badge-${esc(last.status)}">${esc(last.status)}</span>
        </div>`
      : '<div class="empty">' + ic('scrap', 'ic-lg') + '<div>Anda belum pernah presensi</div></div>');
}

/* ---------- 14b. PINTASAN "SESI HARI INI" ------------------------------- */
/* Setiap acara hari ini dapat diketuk dan memunculkan MODAL konfirmasi berisi
   detail acara (untuk SEMUA peran: Peserta, Pengurus, Administrator). Bila
   menekan "Hadir", acara menjadi TERPILIH dan pengguna langsung dibawa ke
   halaman Presensi untuk melanjutkan pemindaian kode QR. Butlerang "QR"
   tetap khusus Administrator & Pengurus untuk membuat kode QR acara itu.
   Pemilihan acara di sini mencegah presensi tertukar ketika lebih dari satu
   acara berlangsung bersamaan. */
function todayJadwalList() {
  const hariIni = new Date().toDateString();
  return (state.jadwal || [])
    .filter(j => new Date(j.tanggal).toDateString() === hariIni)
    .sort((a, b) => new Date(a.tanggal) - new Date(b.tanggal));
}

function sesiHariIniCard(mineList, withQr) {
  const sesi = todayJadwalList();
  if (!sesi.length) {
    return cardWrap('pilgrim', 'Sesi Hari Ini',
      '<div class="empty">' + ic('horarium', 'ic-lg') + '<div>Tidak ada sesi hari ini</div></div>');
  }
  const now = Date.now();
  const isi = sesi.map(j => {
    const mulai = new Date(j.tanggal).getTime();
    const end = new Date(mulai + (Number(j.durasi) || 60) * 60000);
    const belumMulai = now < mulai - 5 * 60000;
    const selesai = end.getTime() < now;
    const dipilih = state.activeJadwalId && String(state.activeJadwalId) === String(j.id);
    const catatan = mineList ? mineList.find(p => String(p.jadwalId) === String(j.id)) : null;
    const tail = catatan
      ? '<span class="badge badge-' + esc(catatan.status) + '">' + esc(catatan.status) + '</span>'
      : (selesai ? '<span class="badge badge-nonaktif">selesai</span>'
        : (belumMulai ? '<span class="badge badge-gold">' + esc(fmtTime(j.tanggal)) + '</span>'
          : '<span class="badge badge-aktif">berlangsung</span>'));
    const tombolQr = withQr
      ? '<span class="btn btn-outline btn-sm" role="button" onclick="event.stopPropagation();bukaQrSesi(\'' +
        esc(j.id) + '\')">' + ic('matrix') + 'QR</span>'
      : '';
    return `
      <button class="pick-item${dipilih ? ' is-picked' : ''}" type="button" onclick="konfirmasiSesiHariIni('${esc(j.id)}')">
        ${ic('pilgrim')}
        <div class="body">
          <strong>${esc(j.nama)}</strong>
          <div class="meta">${esc(j.venue || '')} · ${fmtTime(j.tanggal)}–${fmtTime(end)}</div>
          <div class="meta">Ketuk untuk melihat detail &amp; lanjut ke presensi</div>
        </div>
        <span class="tail">${tail}${tombolQr}</span>
      </button>`;
  }).join('');
  return cardWrap('pilgrim', 'Sesi Hari Ini',
    '<div>' + isi + '</div>' +
    '<p class="tiny muted">Pintasan ini menyelaraskan acara dengan kode QR-nya, sehingga presensi tidak tertukar ' +
    'bila ada lebih dari satu acara pada waktu yang sama.</p>');
}

function jadwalMendatangCard() {
  const upcoming = (state.jadwal || [])
    .filter(j => new Date(j.tanggal).getTime() > Date.now())
    .sort((a, b) => new Date(a.tanggal) - new Date(b.tanggal))
    .slice(0, 3);
  return cardWrap('horarium', 'Jadwal Mendatang', upcoming.length
    ? '<div class="list">' + upcoming.map(j => `
        <div class="list-item">
          ${ic('horarium')}
          <div class="body">
            <strong>${esc(j.nama)}</strong>
            <div class="meta">${esc(j.venue)} · ${fmtDateTime(j.tanggal)}</div>
          </div>
        </div>`).join('') + '</div>'
    : '<div class="empty">' + ic('horarium', 'ic-lg') + '<div>Belum ada jadwal mendatang</div></div>');
}

/* Catatan aktivitas sistem — HANYA ADMIN (Pengurus tidak melihat).
   SELALU diurutkan dari yang terbaru ke yang terlama. */
function renderActivityFeed() {
  if (!isAdmin()) return '';
  const recent = sortLogs(state.logs).slice(0, 8);
  if (!recent.length) {
    return '<div class="empty">' + ic('ledger', 'ic-lg') + '<div>Belum ada catatan aktivitas</div></div>';
  }
  const iconMap = {
    LOGIN: 'keycross', LOGOUT: 'gate', PRESENSI: 'pilgrim', PRESENSI_GAGAL: 'scrap',
    CREATE_USER: 'quill', CREATE_JADWAL: 'horarium', GENERATE_QR: 'matrix',
    DELETE_JADWAL: 'scrap', DELETE_USER: 'scrap', TOGGLE_USER: 'lamp',
    UPDATE_PROFILE: 'halobust', VIEW_LAPORAN: 'bulla', SCAN_ERROR: 'scrap',
    DELETE_PRESENSI: 'scrap', UPDATE_PRESENSI: 'quill', PRINT_LAPORAN: 'bulla', EXPORT_LAPORAN: 'descend',
    START_SCAN: 'viewfinder', SESSION_TIMEOUT: 'clock', RESET_REQUEST: 'keyring',
    DELETE_LOG: 'scrap', VIEW_PASSWORD: 'eye', RESET_PASSWORD: 'keyring',
    DELETE_REQUEST: 'scrap', OPEN_GATE: 'viewfinder'
  };
  return '<div class="list">' + recent.map(l => `
    <div class="list-item">
      ${ic(iconMap[l.action] || 'cross')}
      <div class="body">
        <strong>${esc(l.userName)}</strong> · ${esc(String(l.action).replace(/_/g, ' '))}
        ${l.details && l.details.username ? '<span class="muted">· @' + esc(l.details.username) + '</span>' : ''}
        ${l.details && l.details.nama ? '<span class="muted">· ' + esc(l.details.nama) + '</span>' : ''}
        <div class="meta">${fmtDateTime(l.timestamp)}</div>
      </div>
    </div>`).join('') + '</div>';
}
/* ---------- 15. LOKASI GPS (dipakai validasi QR saja) ------------------- */
/* Presensi MANUAL (GPS) sudah dihapus sesuai permintaan — presensi hanya via QR. */

function mapOfflineNotice(id) {
  const el = $(id);
  if (el) {
    el.innerHTML = '<div class="map-offline">' + ic('compass', 'ic-lg') +
      '<div>Peta tidak tersedia saat luring. Koordinat GPS tetap dicatat untuk validasi presensi.</div></div>';
  }
}

function initMap() {
  /* Peta presensi manual sudah dihapus (presensi hanya via QR). Stub ini
     dipertahankan agar pemanggil lama tidak error. */
  return;
}

/* Ambil posisi GPS — hanya dipakai validasi QR (tidak ada lagi layar manual) */
function gpsErrorMessage(err) {
  const code = err && err.code;
  const msg = String((err && err.message) || '');
  /* 1 = PERMISSION_DENIED — penyebab "Uncaught (in promise) NotAllowedError"
     yang muncul di console halaman Laporan walau user merasa sudah allow. */
  if (code === 1 || /denied|not allowed|permission/i.test(msg))
    return 'Izin lokasi ditolak. Ketuk ikon lokasi/gembok di address bar, izinkan Lokasi untuk situs ini, lalu muat ulang. Aplikasi tetap berjalan — data tersimpan lokal, sinkron menyusul.';
  if (code === 2 || /unavailable|position/i.test(msg))
    return 'Posisi tidak tersedia (GPS lemah / di dalam gedung). Dekatkan ke jendela / luar ruangan lalu tekan "Perbarui Lokasi".';
  if (code === 3 || /timeout/i.test(msg))
    return 'Pengambilan lokasi kehabisan waktu. Tekan "Perbarui Lokasi" untuk mencoba lagi.';
  return 'Lokasi tidak dapat dibaca: ' + (msg || 'kesalahan tidak dikenal');
}

function locateUser(moveMap) {
  /* Tidak ada lagi elemen gpsInfo/map (layar manual dihapus). Fungsi ini
     dipertahankan sebagai stub agar kode lama tidak error. */
  return Promise.resolve(null);
}

function initMapJadwal() {
  if (!$('mapJadwal')) return;
  if (typeof L === 'undefined') { mapOfflineNotice('mapJadwal'); return; }
  if (state.mapJadwal) { state.mapJadwal.invalidateSize(); return; }

  state.mapJadwal = L.map('mapJadwal').setView([-2.5, 118], 5);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap', maxZoom: 19
  }).addTo(state.mapJadwal);

  state.mapJadwal.on('click', e => {
    $('jadwalLat').value = e.latlng.lat.toFixed(7);
    $('jadwalLng').value = e.latlng.lng.toFixed(7);
    if (state.markerJadwal) state.mapJadwal.removeLayer(state.markerJadwal);
    state.markerJadwal = L.marker(e.latlng).addTo(state.mapJadwal);
  });
}

function pickLocation() {
  if (!navigator.geolocation) { toast('Peranti ini tidak mendukung layanan lokasi', 'error'); return; }
  if (!window.isSecureContext) { toast('Lokasi membutuhkan HTTPS/localhost', 'error'); return; }
  toast('Mengambil titik lokasi…', 'info');
  try {
    navigator.geolocation.getCurrentPosition(pos => {
      $('jadwalLat').value = pos.coords.latitude.toFixed(7);
      $('jadwalLng').value = pos.coords.longitude.toFixed(7);
      if (state.mapJadwal && typeof L !== 'undefined') {
        const ll = [pos.coords.latitude, pos.coords.longitude];
        if (state.markerJadwal) state.mapJadwal.removeLayer(state.markerJadwal);
        state.markerJadwal = L.marker(ll).addTo(state.mapJadwal);
        state.mapJadwal.setView(ll, 17);
      }
      toast('Koordinat venue diambil dari posisi Anda', 'success');
    }, err => toast(gpsErrorMessage(err), 'error'), { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 });
  } catch (e) { toast(gpsErrorMessage(e), 'error'); }
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = x => x * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
/* ---------- 16. SIMPAN PRESENSI (QR) ---------------------------------- */
function savePresensi(pres) {
  state.presensi.push(pres);
  saveLocal();
  enqueue('presensi', pres);
  return pres;
}

/* ---------- 16b. OPEN-GATE (HANYA ADMINISTRATOR) ------------------------
   Presensi QR hanya dibuka setelah Administrator membuat OPEN-GATE pada
   sebuah acara (contoh: acara 19.00, gate diatur 18.30). Sebelum waktu
   gate - dan bila gate belum pernah diatur - pemindai kamera maupun
   pemilihan foto dari galeri DITOLAK. Waktu gate tersimpan pada acara
   (kolom openGate) sehingga berlaku bagi seluruh perangkat. */

function openGateMs(j) {
  if (!j || !j.openGate) return null;
  const t = new Date(j.openGate).getTime();
  return isNaN(t) ? null : t;
}

function openGateInfo(j) {
  const ms = openGateMs(j);
  if (ms === null) return { atur: false, terbuka: false, waktu: null };
  return { atur: true, terbuka: Date.now() >= ms, waktu: ms };
}

/* Mengembalikan null bila BOLEH memindai; berisi kalimat = alasan ditolak. */
function openGatePesan(j) {
  if (!j) return null;
  const g = openGateInfo(j);
  if (!g.atur) {
    return 'Presensi acara "' + j.nama + '" belum dibuka - Administrator harus ' +
      'mengatur OPEN-GATE pada menu Kelola Jadwal terlebih dahulu.';
  }
  if (!g.terbuka) {
    return 'OPEN-GATE acara "' + j.nama + '" dibuka pada ' + fmtDateTime(g.waktu) +
      '. Silakan pindai ulang setelah waktu tersebut.';
  }
  return null;
}

/* Pemeriksaan SEBELUM kamera/foto dibuka: memakai acara yang dipilih bila
   ada; tanpa pilihan, seluruh acara hari ini harus gate-nya sudah terbuka. */
function openGateBlokirScan() {
  const dipilih = state.activeJadwalId
    ? (state.jadwal || []).find(x => String(x.id) === String(state.activeJadwalId))
    : null;
  if (dipilih) return openGatePesan(dipilih);
  const kandidat = todayJadwalList();
  if (!kandidat.length) return null;
  if (kandidat.some(j => openGateInfo(j).terbuka)) return null;
  return openGatePesan(kandidat[0]);
}

/* Nilai input datetime-local (waktu perangkat) dari stempel ISO. */
function waktuInputLokal(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const p = n => (n < 10 ? '0' : '') + n;
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
    'T' + p(d.getHours()) + ':' + p(d.getMinutes());
}

/* ---------- 17. PEMINDAI QR -------------------------------------------- */
/* html5-qrcode butuh <div> (bukan <video>) sebagai wadah — ia membuat
   <video> + <canvas> sendiri. Memakai id <video> sebagai wadah membuat
   kamera tidak pernah tampil (layar hitam seperti laporan). */
function scanErrorMessage(e) {
  const name = (e && e.name) || '';
  const msg = String((e && (e.message || e)) || '');
  if (name === 'NotAllowedError' || /permission|denied|not allowed/i.test(msg))
    return 'Izin kamera ditolak peramban. Ketuk ikon kamera/gembok di address bar, izinkan kamera, lalu muat ulang & coba lagi. Kamera hanya jalan di HTTPS/localhost.';
  if (name === 'NotFoundError' || /no camera|not found/i.test(msg))
    return 'Tidak ada kamera yang ditemukan di peranti ini.';
  if (name === 'NotReadableError' || /in use|busy|track/i.test(msg))
    return 'Kamera sedang dipakai aplikasi lain. Tutup aplikasi itu lalu coba lagi.';
  return 'Kamera tidak dapat diakses: ' + (msg || name || e);
}

function scanHint(txt) {
  const h = $('scanHint');
  if (h) h.textContent = txt;
}

function stopScanTracks() {
  try {
    const r = $('qr-reader');
    if (r) r.querySelectorAll('video').forEach(v => {
      try {
        const s = v.srcObject;
        if (s && s.getTracks) s.getTracks().forEach(t => { try { t.stop(); } catch (e) {} });
        v.srcObject = null;
      } catch (e) {}
    });
  } catch (e) {}
}

async function ensureScannerStopped() {
  if (state.scanner) {
    try { await state.scanner.stop(); } catch (e) {}
    try { await state.scanner.clear(); } catch (e) {}
    state.scanner = null;
  }
  stopScanTracks();
  const r = $('qr-reader');
  if (r) r.innerHTML = '';
}

async function startScanner() {
  /* OPEN-GATE: kamera baru boleh dibuka setelah gate dibuka (lihat 16b). */
  const halangGate = openGateBlokirScan();
  if (halangGate) {
    toast(halangGate, 'error');
    scanHint('Presensi belum dibuka — tunggu OPEN-GATE dari Administrator.');
    try { addLog('PRESENSI_GAGAL', { reason: 'open-gate: kamera' }); } catch (e) {}
    return;
  }
  if (!window.isSecureContext) {
    toast('Buka aplikasi via HTTPS atau localhost — kamera diblokir pada koneksi tidak aman.', 'error');
    return;
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    toast('Peramban ini tidak mendukung kamera. Gunakan Chrome/Edge/Safari terbaru atau "Pindai dari Foto".', 'error');
    return;
  }
  $('scannerContainer').classList.remove('hidden');
  $('btnStartScan').classList.add('hidden');
  $('btnStopScan').classList.remove('hidden');
  /* Tes izin kamera LANGSUNG via getUserMedia sebelum memuat pustaka.
     Ini membedakan 3 kasus yang sebelumnya tercampur jadi "tidak bekerja":
     (a) izin ditolak / belum diklik Izinkan → NotAllowedError, beri instruksi;
     (b) tidak ada kamera / dipakai app lain → beri pesan sesuai;
     (c) kamera OK tapi pustaka CDN belum termuat (luring). */
  let probeStream = null;
  try {
    scanHint('Meminta izin kamera…');
    probeStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment' }, audio: false
    });
  } catch (e) {
    toast(scanErrorMessage(e), 'error');
    try { addLog('SCAN_ERROR', { error: String((e && e.message) || e), stage: 'permission' }); } catch (e2) {}
    await stopScanner();
    return;
  } finally {
    try { if (probeStream && probeStream.getTracks) probeStream.getTracks().forEach(t => { try { t.stop(); } catch (e) {} }); } catch (e) {}
    probeStream = null;
  }
  if (typeof Html5Qrcode === 'undefined') {
    /* Kamera ADA & izin OK, hanya pustaka CDN belum tersimpan (luring).
       Tawarkan jalur yang tetap jalan: BarcodeDetector bawaan bila ada,
       kalau tidak arahkan ke "Pindai dari Foto" / "Ambil Foto". */
    if (typeof BarcodeDetector !== 'undefined') {
      toast('Pustaka pemindai belum termuat — memakai pemindai bawaan peramban…', 'info');
      return startScannerNative();
    }
    toast('Pemindai QR belum termuat (peranti luring). Sambungkan ke internet sekali untuk menyimpannya, atau pakai "Ambil Foto QR dengan Kamera".', 'error');
    return;
  }
  await ensureScannerStopped();
  scanHint('Membuka kamera…');
  /* qrbox lebih besar agar kode QR padat tetap tajam terbaca; BarcodeDetector
     bila tersedia (Android) — jauh lebih andal ketimbang penguraian JS. */
  const config = {
    fps: 12,
    qrbox: { width: 280, height: 280 },
    experimentalFeatures: { useBarCodeDetectorIfSupported: true },
    rememberLastUsedCamera: true
  };
  const onFail = () => {};
  try {
    const devices = await Html5Qrcode.getCameras().catch(() => []);
    const makers = [
      () => {
        state.scanner = new Html5Qrcode('qr-reader');
        return state.scanner.start({ facingMode: 'environment' }, config, onScanSuccess, onFail);
      },
      () => {
        state.scanner = new Html5Qrcode('qr-reader');
        return state.scanner.start({ facingMode: 'user' }, config, onScanSuccess, onFail);
      }
    ];
    (devices || []).forEach(d => {
      if (d && d.id) makers.push(() => {
        state.scanner = new Html5Qrcode('qr-reader');
        return state.scanner.start(d.id, config, onScanSuccess, onFail);
      });
    });
    let lastErr = null;
    for (const run of makers) {
      try {
        await ensureScannerStopped();
        scanHint('Membuka kamera…');
        await run();
        scanHint('Arahkan kamera ke kode QR venue…');
        addLog('START_SCAN', {});
        return;
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('kamera tidak tersedia');
  } catch (e) {
    /* html5-qrcode gagal walau izin kamera OK (kasus umum: "scan kamera tidak
       bekerja sama sekali tapi scan dari galeri berhasil"). Jangan menyerah —
       coba pemindai bawaan peramban yang memakai stream kamera yang sama. */
    try { addLog('SCAN_ERROR', { error: String((e && e.message) || e), stage: 'html5' }); } catch (e2) {}
    if (typeof BarcodeDetector !== 'undefined') {
      toast('Pemindai utama gagal dibuka — mencoba pemindai bawaan…', 'info');
      await ensureScannerStopped();
      return startScannerNative();
    }
    toast(scanErrorMessage(e), 'error');
    await stopScanner();
  }
}

async function stopScanner() {
  await ensureScannerStopped();
  stopScannerNative();
  scanHint('Menyiapkan kamera…');
  if ($('scannerContainer')) {
    $('scannerContainer').classList.add('hidden');
    $('btnStartScan').classList.remove('hidden');
    $('btnStopScan').classList.add('hidden');
  }
}

/* Pemindai bawaan peramban (BarcodeDetector + getUserMedia langsung, tanpa
   pustaka CDN). Dipakai bila html5-qrcode belum termuat (luring) ATAU bila
   html5-qrcode gagal start walau izin kamera OK — kasus "scan kamera tidak
   bekerja sama sekali tapi scan dari galeri berhasil". */
let _nativeScan = null;
function stopScannerNative() {
  try {
    if (_nativeScan && _nativeScan.timer) clearInterval(_nativeScan.timer);
  } catch (e) {}
  try {
    if (_nativeScan && _nativeScan.stream) {
      _nativeScan.stream.getTracks().forEach(t => { try { t.stop(); } catch (e) {} });
    }
  } catch (e) {}
  try {
    if (_nativeScan && _nativeScan.video) _nativeScan.video.srcObject = null;
  } catch (e) {}
  _nativeScan = null;
}

async function startScannerNative() {
  if (!('BarcodeDetector' in window)) {
    toast('Peramban ini tidak mendukung pemindai bawaan. Pakai "Buka Galeri" atau "Ambil Foto QR".', 'error');
    return;
  }
  try {
    let formats = ['qr_code'];
    try {
      const supported = await BarcodeDetector.getSupportedFormats();
      if (Array.isArray(supported) && supported.length) {
        formats = supported.filter(f => /qr/i.test(f));
        if (!formats.length) formats = supported;
      }
    } catch (e) { /* pakai bawaan qr_code */ }
    const detector = new BarcodeDetector({ formats });
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment' }, audio: false
    });
    $('scannerContainer').classList.remove('hidden');
    $('btnStartScan').classList.add('hidden');
    $('btnStopScan').classList.remove('hidden');
    const holder = $('qr-reader');
    holder.innerHTML = '';
    const video = document.createElement('video');
    video.setAttribute('playsinline', 'true');
    video.muted = true;
    video.style.cssText = 'display:block;width:100%;max-height:340px;object-fit:cover;background:#000';
    holder.appendChild(video);
    video.srcObject = stream;
    await video.play().catch(() => {});
    scanHint('Arahkan kamera ke kode QR venue…');
    try { addLog('START_SCAN', { mode: 'native' }); } catch (e) {}
    let busy = false, done = false;
    const timer = setInterval(async () => {
      if (busy || done) return;
      if (video.readyState < 2 || video.videoWidth < 2) return;
      busy = true;
      try {
        const out = await detector.detect(video);
        if (out && out.length && out[0].rawValue) {
          done = true;
          clearInterval(timer);
          stopScannerNative();
          await onScanSuccess(out[0].rawValue);
        }
      } catch (e) { /* bingkai rusak — coba bingkai berikut */ }
      busy = false;
    }, 350);
    _nativeScan = { stream, video, timer };
  } catch (e) {
    toast(scanErrorMessage(e), 'error');
    try { addLog('SCAN_ERROR', { error: String((e && e.message) || e), stage: 'native' }); } catch (e2) {}
    await stopScanner();
  }
}

async function scanFromFile(input) {
  if (!input || !input.files || !input.files.length) return;
  /* OPEN-GATE: foto dari galeri/pengambilan kamera mengikuti aturan sama. */
  const halangGate = openGateBlokirScan();
  if (halangGate) {
    toast(halangGate, 'error');
    try { addLog('PRESENSI_GAGAL', { reason: 'open-gate: galeri' }); } catch (e) {}
    input.value = '';
    return;
  }
  if (typeof Html5Qrcode === 'undefined' && typeof BarcodeDetector === 'undefined') {
    toast('Pemindai QR belum termuat (peranti luring). Sambungkan sekali ke internet, lalu muat ulang.', 'error');
    input.value = '';
    return;
  }
  const file = input.files[0];
  toast('Membaca foto QR…', 'info');
  try {
    const decoded = await bacaQrDariFoto(file);
    input.value = '';
    if (!decoded) {
      addLog('SCAN_ERROR', { error: 'foto tidak terbaca' });
      toast('Foto belum terbaca — pastikan seluruh kode QR terlihat jelas, tidak buram, dan tidak terpotong.', 'error');
      return;
    }
    await onScanSuccess(decoded);
  } catch (e) {
    input.value = '';
    toast('Foto belum terbaca — pastikan seluruh kode QR terlihat jelas, tidak buram, dan tidak terpotong.', 'error');
  }
}

/* Baca kode QR dari berkas gambar — dipakai tombol "Buka Galeri" dan
   "Ambil Foto dengan Kamera". Beberapa cara dicoba berurutan agar foto
   dari galeri pun tetap terbaca. */
async function bacaQrDariFoto(file) {
  /* Cara 1 — pustaka html5-qrcode (sama dengan pemindai kamera) */
  if (typeof Html5Qrcode !== 'undefined') {
    let tmp = document.getElementById('qr-file-reader');
    if (!tmp) {
      tmp = document.createElement('div');
      tmp.id = 'qr-file-reader';
      tmp.style.display = 'none';
      document.body.appendChild(tmp);
    }
    const reader = new Html5Qrcode('qr-file-reader');
    for (const gabungUlang of [true, false]) {
      try {
        const hasil = await reader.scanFile(file, gabungUlang);
        if (hasil) return hasil;
      } catch (e) { /* coba cara berikutnya */ }
    }
    try { await reader.clear(); } catch (e) { /* abaikan */ }
  }

  /* Cara 2 — BarcodeDetector bawaan peramban (Android/Chrome) */
  if (typeof BarcodeDetector !== 'undefined') {
    try {
      const bitmap = await createImageBitmap(file);
      const hasil = await new BarcodeDetector({ formats: ['qr_code'] }).detect(bitmap);
      if (bitmap && bitmap.close) bitmap.close();
      if (hasil && hasil.length && hasil[0].rawValue) return hasil[0].rawValue;
    } catch (e) { /* coba cara berikutnya */ }
  }

  /* Cara 3 — gambar digambar ulang ke kanvas (peramban lama/ukuran besar) */
  if (typeof Html5Qrcode !== 'undefined' && typeof URL !== 'undefined' && URL.createObjectURL) {
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = () => reject(new Error('gambar tidak terbaca'));
        el.src = url;
      });
      const kanvas = document.createElement('canvas');
      kanvas.width = img.naturalWidth || img.width;
      kanvas.height = img.naturalHeight || img.height;
      kanvas.getContext('2d').drawImage(img, 0, 0);
      const hasil = await new Html5Qrcode('qr-file-reader').scanFile(kanvas, false);
      if (hasil) return hasil;
    } catch (e) { /* tidak dapat dibaca */ } finally {
      try { URL.revokeObjectURL(url); } catch (e) { /* abaikan */ }
    }
  }
  return null;
}

async function onScanSuccess(decoded) {
  await stopScanner();
  try {
    /* 1. Terjemahkan isi QR (mendukung format baru & format cetakan lama) */
    const payload = decodeQrText(decoded);

    /* 2. Selaraskan dengan acara yang benar-benar tercatat di perangkat.
          Data acara (waktu, radius, koordinat) menjadi sumber kebenaran. */
    let jadwal = resolveJadwal(payload);
    if (!jadwal && apiReady() && isOnline()) {
      toast('Memeriksa acara pada basis data…', 'info');
      await pullRemote(true);
      jadwal = resolveJadwal(payload);
    }
    if (!jadwal) {
      throw new Error('Acara pada kode QR belum terdaftar. Pastikan acara sudah dibuat pada menu Kelola Jadwal ' +
        'lalu coba pindai ulang.');
    }

    /* 2b. OPEN-GATE: peserta hanya boleh melanjutkan bila gate dibuka */
    const halangGate = openGatePesan(jadwal);
    if (halangGate) {
      addLog('PRESENSI_GAGAL', { reason: 'open-gate', jadwalId: jadwal.id, nama: jadwal.nama });
      throw new Error(halangGate);
    }

    /* 3. Pintasan "Sesi Hari Ini": bila ada acara terpilih, QR harus milik
          acara yang sama — inilah yang mencegah tertukarnya presensi ketika
          lebih dari satu acara berlangsung bersamaan. */
    const sesiHariIni = todayJadwalList();
    if (!state.activeJadwalId && sesiHariIni.length > 1) {
      throw new Error('Hari ini ada ' + sesiHariIni.length + ' acara. Pilih dulu acara yang Anda ikuti pada ' +
        'kartu "Acara yang Dipindai" di atas, agar presensi Anda tidak tertukar dengan acara lain.');
    }
    if (state.activeJadwalId && String(state.activeJadwalId) !== String(jadwal.id)) {
      const dipilih = (state.jadwal || []).find(x => String(x.id) === String(state.activeJadwalId));
      throw new Error('Kode QR ini milik acara "' + (payload.nama || jadwal.nama) + '", sedangkan Anda memilih "' +
        (dipilih ? dipilih.nama : 'acara lain') +
        '". Ketuk acara yang sesuai pada kartu "Acara yang Dipindai", atau ketuk acara lain pada Beranda.');
    }
    if (!state.activeJadwalId) await setActiveJadwal(jadwal.id, true);

    /* 4. Masa aktif sesi — dihitung dari acara, bukan dari isi QR */
    const start = new Date(jadwal.tanggal).getTime();
    const durasi = Number(jadwal.durasi) || Number(payload.durasi) || 60;
    const end = start + durasi * 60000;
    const now = Date.now();
    if (isNaN(start)) throw new Error('Waktu acara belum ditetapkan — hubungi Administrator/Pengurus.');
    if (now < start - 300000 || now > end) {
      throw new Error('Sesi belum dibuka atau sudah berakhir untuk acara "' + jadwal.nama + '" (' +
        fmtDateTime(jadwal.tanggal) + ' – ' + fmtTime(end) + ').');
    }

    /* 5. Cegah duplikasi satu acara per peserta */
    if (state.presensi.some(p => p.userId === state.currentUser.id && String(p.jadwalId) === String(jadwal.id))) {
      throw new Error('Anda sudah presensi pada acara "' + jadwal.nama + '".');
    }

    /* 6. Lokasi wajib untuk pemeriksaan radius */
    if (!navigator.geolocation) throw new Error('Peranti ini tidak mendukung layanan lokasi');
    if (!window.isSecureContext) {
      toast('Lokasi membutuhkan HTTPS/localhost — buka aplikasi via koneksi aman.', 'error');
      addLog('SCAN_ERROR', { error: 'insecure-context' });
      return;
    }
    toast('Membaca titik lokasi…', 'info');
    try {
    navigator.geolocation.getCurrentPosition(pos => {
      const radius = Number(jadwal.radius) || Number(payload.radius) || 50;
      const dist = haversine(pos.coords.latitude, pos.coords.longitude, Number(jadwal.lat), Number(jadwal.lng));
      if (dist > radius) {
        toast('Terlalu jauh dari venue (' + dist.toFixed(0) + ' m > ' + radius + ' m)', 'error');
        addLog('PRESENSI_GAGAL', { reason: 'di luar radius', distance: Math.round(dist), jadwalId: jadwal.id });
        return;
      }

      const nowIso = new Date().toISOString();
      const pres = {
        id: uid(),
        userId: state.currentUser.id,
        userName: state.currentUser.nama,
        jadwalId: jadwal.id,
        jadwalNama: jadwal.nama,
        venue: jadwal.venue,
        status: 'hadir',
        metode: 'qr',
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        accuracy: pos.coords.accuracy,
        distance: dist,
        timestamp: nowIso,
        updatedAt: nowIso
      };
      savePresensi(pres);
      addLog('PRESENSI', { jadwalId: jadwal.id, nama: jadwal.nama, metode: 'qr', distance: Math.round(dist) });

      showModal('Presensi Tercatat',
        '<div class="list-item">' + ic('seal') +
        '<div class="body"><strong>' + esc(jadwal.nama) + '</strong>' +
        '<div class="meta">' + esc(jadwal.venue || '') + '</div>' +
        '<div class="meta">Jarak ' + dist.toFixed(1) + ' m · ' + fmtDateTime(pres.timestamp) + '</div>' +
        '<div class="meta">Tersimpan di perangkat, sinkron menyusul.</div></div></div>' +
        '<div class="modal-actions"><button class="btn btn-primary" onclick="closeModal()">' +
        ic('seal') + 'Selesai</button></div>',
        { icon: 'seal', tone: 'success' });
      renderActivePage();
    }, err => {
      toast(gpsErrorMessage(err), 'error');
      addLog('PRESENSI_GAGAL', { reason: String((err && err.message) || err), jadwalId: jadwal.id });
    }, { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 });
    } catch (e) {
      toast(gpsErrorMessage(e), 'error');
      addLog('SCAN_ERROR', { error: String((e && e.message) || e) });
    }
  } catch (e) {
    const pesan = (e && e.message) ? e.message : 'Kode QR tidak dapat dibaca';
    toast(pesan, 'error');
    addLog('SCAN_ERROR', { error: pesan });
  }
}

/* Ambil JSON bila teks memang berbentuk objek — untuk mendukung QR lama
   yang menyimpan JSON mentah tanpa dibungkus base64. */
function tryJsonText(t) {
  const s = String(t || '').trim();
  if (s.charAt(0) !== '{') return null;
  try { JSON.parse(s); return s; } catch (e) { return null; }
}

/* Terjemahkan isi kode QR menjadi objek payload. Mendukung:
   • format baru (ringkas)  : IGN1|idAcara|mulai|durasi|radius|lat|lng|sig
   • format lama            : JSON mentah, atau base64(JSON) */
function decodeQrText(raw) {
  const text = String(raw == null ? '' : raw).replace(/^\uFEFF/, '').trim();
  if (!text) throw new Error('Kode QR kosong — silakan pindai ulang');

  /* --- Format v2 (ringkas) --- */
  if (text.indexOf('IGN1|') === 0 || text.indexOf('PRESENSI_IGNASIAN|') === 0) {
    const p = text.split('|');
    const mulai = Number(p[2]);
    if (p.length < 7 || !isFinite(mulai)) {
      throw new Error('Format kode QR tidak lengkap — buat ulang QR pada menu Pembuat Kode QR');
    }
    return {
      type: 'PRESENSI_IGNASIAN', v: 2, jadwalId: p[1],
      start: new Date(mulai).toISOString(),
      durasi: Number(p[3]) || 60,
      radius: Number(p[4]) || 50,
      lat: Number(p[5]),
      lng: Number(p[6]),
      sig: p[7] || '',
      nama: '', venue: ''
    };
  }

  let obj = null;

  /* --- Format lama: JSON mentah --- */
  const json = tryJsonText(text);
  if (json) { try { obj = JSON.parse(json); } catch (e) { obj = null; } }

  /* --- Format lama: base64(JSON) --- */
  if (!obj) {
    const b64 = text.replace(/\s+/g, '');
    if (/^[A-Za-z0-9+/=]+$/.test(b64) && b64.length >= 8) {
      const kandidat = [];
      try { kandidat.push(decodeURIComponent(escape(atob(b64)))); } catch (e) { /* abaikan */ }
      try { kandidat.push(atob(b64)); } catch (e) { /* abaikan */ }
      for (let i = 0; i < kandidat.length && !obj; i++) {
        const t = tryJsonText(kandidat[i]);
        if (t) { try { obj = JSON.parse(t); } catch (e) { obj = null; } }
      }
    }
  }

  if (!obj) {
    throw new Error('Bukan kode QR Presensi Ignasian. Pastikan Anda memindai kode QR ' +
      'yang dicetak dari menu Pembuat Kode QR.');
  }
  if (obj.type !== 'PRESENSI_IGNASIAN') throw new Error('Bukan kode QR Presensi Ignasian');
  if (!obj.jadwalId && !obj.nama) {
    throw new Error('Kode QR tidak menyebut acara — buat ulang QR pada menu Pembuat Kode QR');
  }
  return obj;
}

/* Cocokkan isi QR dengan acara. Data acara di perangkat yang menjadi sumber
   kebenaran, sehingga waktu/radius/koordinat selalu mengikuti jadwal terkini
   meskipun QR dicetak lama. */
function resolveJadwal(payload) {
  const list = state.jadwal || [];
  const byId = list.find(j => String(j.id) === String(payload.jadwalId));
  if (byId) return byId;

  /* Cadangan: nama acara + waktu mulai hampir sama (perangkat yang belum
     menarik ulang acara setelah sinkronisasi). */
  const startQr = Date.parse(payload.start || 0) || 0;
  if (payload.nama) {
    const byNama = list.find(j =>
      String(j.nama || '').trim().toLowerCase() === String(payload.nama).trim().toLowerCase() &&
      Math.abs((Date.parse(j.tanggal) || 0) - startQr) <= 12 * 3600 * 1000);
    if (byNama) return byNama;
  }
  /* Cadangan terakhir: hanya ada satu acara yang berjalan pada waktu QR dibuat */
  if (startQr) {
    const berjalan = list.filter(j => {
      const s = Date.parse(j.tanggal) || 0;
      return !!s && startQr >= s - 5 * 60000 && startQr <= s + (Number(j.durasi) || 60) * 60000;
    });
    if (berjalan.length === 1) return berjalan[0];
  }
  return null;
}
/* ---------- 17b. PILIHAN ACARA PADA HALAMAN PRESENSI --------------------
   Pintasan dari Beranda ("Sesi Hari Ini") mendarat di sini dengan acara
   sudah TERPILIH. Pemilihan ini tersimpan agar tetap berlaku setelah
   halaman disegarkan, dan dipakai sebagai pemeriksaan saat memindai QR. */
function namaJadwal(id) {
  const j = (state.jadwal || []).find(x => String(x.id) === String(id));
  return j ? j.nama : '';
}

async function restoreActiveJadwal() {
  const id = await kvGet('activeJadwal', null);
  state.activeJadwalId = (id && (state.jadwal || []).some(j => String(j.id) === String(id)))
    ? String(id) : null;
}

async function setActiveJadwal(id, diam) {
  state.activeJadwalId = id ? String(id) : null;
  await kvSet('activeJadwal', state.activeJadwalId);
  if (state.activePage === 'presensi') renderPresensiSesi();
  if (!diam) {
    const j = (state.jadwal || []).find(x => String(x.id) === state.activeJadwalId);
    toast(j ? 'Acara dipilih: ' + j.nama : 'Pilihan acara dibatalkan', j ? 'success' : 'info');
    renderActivePage();
  }
}

/* Ketuk acara pada "Sesi Hari Ini" → MODAL konfirmasi untuk SEMUA peran.
   Berisi detail acara, lalu dua pilihan: Hadir (pilih acara & langsung ke
   halaman Presensi untuk scan QR) atau Batal (kembali ke Beranda). */
function konfirmasiSesiHariIni(id) {
  if (!state.currentUser) return;
  const j = (state.jadwal || []).find(x => String(x.id) === String(id));
  if (!j) { toast('Acara tidak ditemukan', 'error'); return; }

  const mulai = new Date(j.tanggal).getTime();
  const end = new Date(mulai + (Number(j.durasi) || 60) * 60000);
  const now = Date.now();
  const belumMulai = now < mulai - 5 * 60000;
  const selesai = end.getTime() < now;
  const dipilih = String(state.activeJadwalId) === String(j.id);

  /* Status kehadiran pengguna pada acara ini (jika sudah pernah absen). */
  const sudah = (state.presensi || []).some(p =>
    String(p.jadwalId) === String(j.id) && p.userId === state.currentUser.id);

  const waktu = belumMulai
    ? 'Belum dimulai'
    : (selesai ? 'Sudah selesai' : 'Berlangsung');

  const baris = [
    ['Hari', hariID(j.tanggal) + ', ' + fmtDate(j.tanggal)],
    ['Waktu', fmtTime(j.tanggal) + ' – ' + fmtTime(end)],
    ['Lokasi', j.venue || '-'],
    ['Radius', (j.radius != null ? j.radius : '-') + ' m'],
    ['Status', waktu + (sudah ? ' · Anda sudah tercatat hadir' : '')]
  ].map(r => '<div class="info-row"><span class="k">' + esc(r[0]) +
    '</span><span class="v">' + esc(r[1]) + '</span></div>').join('');

  showModal(j.nama,
    '<p class="small muted">Pilih <strong>Hadir</strong> bila Anda ikut acara ini. ' +
    'Anda akan langsung dibawa ke halaman presensi untuk memindai kode QR di lokasi.</p>' +
    '<div class="info-list">' + baris + '</div>' +
    (dipilih ? '<p class="tiny muted">Acara ini sudah menjadi pilihan presensi Anda.</p>' : '') +
    '<div class="modal-actions">' +
      '<button class="btn btn-ghost" type="button" onclick="closeModal()">Batal</button>' +
      '<button class="btn btn-primary" type="button" onclick="konfirmasiHadirSesi(\'' +
        esc(j.id) + '\')">' + ic('pilgrim') + 'Hadir</button>' +
    '</div>',
    { icon: 'pilgrim', tone: belumMulai ? 'warn' : 'brand' });
}

/* Tombol "Hadir" pada modal sesi hari ini: tetapkan acara sebagai pilihan
   aktif, buka halaman Presensi, lalu lanjutkan ke pemindaian QR. */
function konfirmasiHadirSesi(id) {
  closeModal();
  setActiveJadwal(id, true).then(() => {
    showPage('presensi');
    const j = (state.jadwal || []).find(x => String(x.id) === String(id));
    if (j) toast('Silakan pindai kode QR untuk: ' + j.nama, 'success');
  });
}

/* Pintasan Beranda → halaman Presensi untuk acara yang diketuk */
function bukaPresensiSesi(id) {
  if (!state.currentUser) return;
  setActiveJadwal(id, true).then(() => {
    showPage('presensi');
    const j = (state.jadwal || []).find(x => String(x.id) === String(id));
    if (j) toast('Siap memindai QR untuk: ' + j.nama, 'success');
  });
}

/* Pintasan Beranda → Pembuat Kode QR untuk acara yang diketuk (staff) */
function bukaQrSesi(id) {
  if (!isStaff()) { toast('Hanya Administrator & Pengurus yang dapat membuat QR', 'error'); return; }
  showPage('qr-gen');
  const sel = $('qrJadwal');
  if (sel) sel.value = id;
  generateQR();
}

/* Catatan status OPEN-GATE di halaman Presensi (semua peran). */
function renderScanGateNote() {
  const el = $('scanGateNote');
  if (!el) return;
  const halang = openGateBlokirScan();
  if (halang) { el.textContent = halang; el.classList.remove('hidden'); }
  else { el.textContent = ''; el.classList.add('hidden'); }
}

/* Kartu "Acara yang Dipindai" — daftar acara hari ini yang dapat dipilih */
function renderPresensiSesi() {
  renderScanGateNote();
  const box = $('presensiSesiList');
  if (!box) return;
  const sesi = todayJadwalList();

  if (!sesi.length) {
    box.innerHTML = '<div class="empty">' + ic('horarium', 'ic-lg') + '<div>Tidak ada acara hari ini</div>' +
      (state.activeJadwalId && namaJadwal(state.activeJadwalId)
        ? '<div class="tiny mt-6">Acara terpilih: ' + esc(namaJadwal(state.activeJadwalId)) + '</div>' : '') +
      '</div>';
    return;
  }

  box.innerHTML = sesi.map(j => {
    const dipilih = String(state.activeJadwalId) === String(j.id);
    const end = new Date(new Date(j.tanggal).getTime() + (Number(j.durasi) || 60) * 60000);
    return `
      <button class="pick-item${dipilih ? ' is-picked' : ''}" type="button" onclick="setActiveJadwal('${esc(j.id)}')">
        ${ic(dipilih ? 'seal' : 'horarium')}
        <div class="body">
          <strong>${esc(j.nama)}</strong>
          <div class="meta">${esc(j.venue || '')} · ${fmtTime(j.tanggal)}–${fmtTime(end)}</div>
          <div class="meta">${dipilih ? 'Dipilih — QR milik acara lain akan ditolak' : 'Ketuk untuk memilih acara ini'}</div>
        </div>
      </button>`;
  }).join('') + (state.activeJadwalId
    ? '<button class="btn btn-ghost mt-6" type="button" onclick="setActiveJadwal(null)">Batalkan pilihan acara</button>'
    : '<p class="tiny muted">Pilihan acara wajib diisi bila hari ini ada lebih dari satu acara. ' +
      'Bila hanya satu acara, sistem akan memilihnya otomatis saat Anda memindai.</p>');
}

/* ---------- 18. RIWAYAT PRESENSI --------------------------------------- */
/* Riwayat disajikan sebagai BARIS RINGKAS (bukan kartu/tabel besar) supaya
   hemat tempat di layar HP. Data HANYA ditampilkan untuk acara yang dipilih
   pada "Tampilkan data acara"; belum ada acara dipilih → tampil arahan agar
   pengguna tahu harus memilih lebih dahulu. */
function renderRiwayat() {
  const box = $('riwayatBody');
  const title = $('riwayatTitle');
  const scope = $('riwayatScope');
  const staffView = isStaff();
  const adminView = isAdmin();

  if (title) title.textContent = staffView ? 'Riwayat Presensi (Semua)' : 'Riwayat Presensi Saya';
  if (scope) {
    scope.textContent = adminView
      ? 'Seluruh presensi peserta — Anda dapat menghapus catatan yang keliru.'
      : (staffView ? 'Seluruh presensi peserta — Pengurus hanya dapat melihat (baca saja).'
        : 'Presensi pribadi Anda.');
  }
  if (!box) return;

  /* Pilihan acara: daftar acara terbaru di atas, tanpa pilihan bawaan
     (kosong = belum ada acara dipilih). */
  const sel = $('riwayatAcara');
  if (sel) {
    const prev = sel.value;
    const acara = daftarAcara();
    sel.innerHTML = '<option value="">— pilih acara —</option>' + acara.map(j =>
      '<option value="' + esc(j.id) + '">' + esc(j.nama) + ' · ' + esc(fmtDate(j.tanggal)) + '</option>'
    ).join('');
    sel.value = (prev && acara.some(j => String(j.id) === String(prev))) ? prev : '';
  }

  const id = sel ? sel.value : '';
  if (!id) {
    box.innerHTML = '<div class="empty">' + ic('horarium', 'ic-lg') +
      '<div><strong>Pilih acara terlebih dahulu</strong></div>' +
      '<div class="tiny mt-6">Riwayat hanya menampilkan presensi dari acara yang dipilih. ' +
      'Gunakan daftar <em>Tampilkan data acara</em> di atas.</div></div>';
    return;
  }

  const j = (state.jadwal || []).find(x => String(x.id) === String(id)) || null;
  const mine = (staffView ? state.presensi.slice()
    : state.presensi.filter(p => p.userId === state.currentUser.id))
    .filter(p => String(p.jadwalId || '') === String(id))
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

  const kepala =
    '<div class="dash-title">' + esc(j ? j.nama : 'Acara') +
    (j ? ' · ' + esc(fmtDate(j.tanggal)) : '') +
    ' · ' + mine.length + ' catatan</div>';

  if (!mine.length) {
    box.innerHTML = kepala + '<div class="empty">' + ic('codex', 'ic-lg') +
      '<div>Belum ada presensi pada acara ini</div></div>';
    return;
  }

  box.innerHTML = kepala + '<div class="list">' + mine.map(p => {
    const ket = p.keterangan ? '<span class="tiny muted"> · ' + esc(p.keterangan) + '</span>' : '';
    return '<div class="list-item">' + ic('seal') +
      '<div class="body">' +
        '<strong>' + (staffView ? esc(p.userName || '-') : esc(j ? j.nama : '-')) + '</strong>' +
        '<div class="meta">' + esc(fmtDate(p.timestamp)) + ' · ' + esc(fmtTime(p.timestamp)) +
          ' · Pindai QR' + ket + '</div>' +
        (staffView ? '<div class="meta">' + esc(p.venue || '') + '</div>' : '') +
      '</div>' +
      '<span class="tail-row">' +
        '<span class="badge badge-' + esc(p.status) + '">' + esc(p.status) + '</span>' +
        (adminView
          ? '<button class="btn btn-danger btn-sm" type="button" onclick="deletePresensi(\'' +
            esc(p.id) + '\')">' + ic('scrap') + 'Hapus</button>'
          : '') +
      '</span></div>';
  }).join('') + '</div>';
  applyRoleVisibility();
}

/* ---------- 19. LAPORAN ------------------------------------------------- */
function prepareLaporan() {
  const today = new Date();
  const monthAgo = new Date(today);
  monthAgo.setMonth(monthAgo.getMonth() - 1);
  if (!$('laporanFrom').value) $('laporanFrom').value = monthAgo.toISOString().split('T')[0];
  if (!$('laporanTo').value) $('laporanTo').value = today.toISOString().split('T')[0];

  const note = $('laporanScope');
  if (note) {
    note.textContent = isStaff()
      ? 'Rekapitulasi seluruh peserta dalam rentang tanggal.'
      : 'Rekapitulasi pribadi Anda dalam rentang tanggal.';
  }
  renderLaporanAcaraSelect();
  generateLaporan();
  renderLaporanAcara();
}

function laporanAcaraId() {
  const sel = $('laporanAcara');
  return sel ? sel.value : '';
}

function renderLaporanAcaraSelect() {
  const sel = $('laporanAcara');
  if (!sel) return;
  const cur = sel.value;
  const sorted = (state.jadwal || []).slice()
    .sort((a, b) => new Date(a.tanggal) - new Date(b.tanggal));
  sel.innerHTML = sorted.length
    ? sorted.map(j => `<option value="${esc(j.id)}">${esc(j.nama)} — ${esc(fmtDate(j.tanggal))}</option>`).join('')
    : '<option value="">— belum ada acara —</option>';
  if (cur && sorted.some(j => String(j.id) === String(cur))) sel.value = cur;
}

function laporanAcaraRows() {
  const id = laporanAcaraId();
  if (!id) return { jadwal: null, rows: [] };
  const jadwal = (state.jadwal || []).find(j => String(j.id) === String(id)) || null;
  const rows = state.presensi
    .filter(p => String(p.jadwalId) === String(id))
    .sort((a, b) => String(a.userName || '').localeCompare(String(b.userName || ''), 'id'));
  return { jadwal: jadwal, rows: rows };
}

function hariID(iso) {
  try {
    return new Date(iso).toLocaleDateString('id-ID', { weekday: 'long' });
  } catch (e) { return '-'; }
}

function renderLaporanAcara() {
  const body = $('laporanAcaraBody');
  const info = $('laporanAcaraInfo');
  if (!body) return;
  const r = laporanAcaraRows();
  if (!r.jadwal) {
    if (info) info.textContent = 'Pilih acara untuk melihat daftar hadir.';
    body.innerHTML = '<tr><td colspan="8"><div class="empty">' + ic('bulla', 'ic-lg') +
      '<div>Belum ada acara dipilih</div></div></td></tr>';
    return;
  }
  const j = r.jadwal;
  const nHadir = r.rows.filter(x => x.status === 'hadir').length;
  const pemateri = jadwalPemateriText(j);
  if (info) info.textContent = j.nama + ' · ' + hariID(j.tanggal) + ', ' +
    fmtDateTime(j.tanggal) + ' · ' + j.venue + (pemateri ? ' · Pemateri: ' + pemateri : '') +
    ' · radius ' + j.radius +
    ' m · ' + nHadir + ' hadir / ' + r.rows.length + ' tercatat';
  if (!r.rows.length) {
    body.innerHTML = '<tr><td colspan="8"><div class="empty">' + ic('codex', 'ic-lg') +
      '<div>Belum ada presensi pada acara ini</div></div></td></tr>';
    return;
  }
  body.innerHTML = r.rows.map((p, i) => `<tr>
      <td data-label="No">${i + 1}</td>
      <td data-label="Nama">${esc(p.userName || '-')}</td>
      <td data-label="Status"><span class="badge badge-${esc(p.status)}">${esc(p.status)}</span></td>
      <td data-label="Waktu">${esc(fmtDate(p.timestamp))}<div class="tiny muted">${esc(fmtTime(p.timestamp))}</div></td>
      <td data-label="Metode">Pindai QR</td>
      <td data-label="Jarak">${(p.distance == null || isNaN(p.distance)) ? '-' : Number(p.distance).toFixed(0) + ' m'}</td>
      <td data-label="Ket.">${esc(p.keterangan || '')}</td>
      ${isAdmin() ? `<td data-label="Kelola"><div class="row-tight">
        <button class="btn btn-outline btn-sm" type="button" onclick="editPresensi('${esc(p.id)}')">${ic('quill')}Ubah</button>
        <button class="btn btn-danger btn-sm" type="button" onclick="deletePresensi('${esc(p.id)}')">${ic('scrap')}Hapus</button>
      </div></td>` : ''}
    </tr>`).join('');
  applyRoleVisibility();
}

function csvCell(v) {
  const s = String(v == null ? '' : v);
  return /[",\n;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/* Unduh CSV (delimiter ';' + BOM — langsung rapi dibuka di Excel Indonesia).
   mode 'acara' = daftar hadir satu acara; 'rekap' = rekap rentang tanggal. */
function exportLaporanCSV(mode) {
  let head = [];
  let lines = [];
  let fname = 'laporan.csv';
  if (mode === 'rekap') {
    const from = $('laporanFrom').value || '';
    const to = $('laporanTo').value || '';
    const f = new Date(from); const t = new Date(to); t.setHours(23, 59, 59, 999);
    const people = isStaff()
      ? state.users.filter(u => u.role === 'peserta')
      : state.users.filter(u => u.id === state.currentUser.id);
    head = ['Nama', 'Username', 'Hadir', 'Persentase'];
    lines = people.map(u => {
      const up = state.presensi.filter(p => p.userId === u.id &&
        (!from || !to || (new Date(p.timestamp) >= f && new Date(p.timestamp) <= t)));
      const h = up.filter(p => p.status === 'hadir').length;
      const pct = up.length ? Math.round(h / up.length * 100) + '%' : '0%';
      return [u.nama, u.username, h, pct].map(csvCell).join(';');
    });
    fname = 'rekap_' + (from || 'semua') + '_' + (to || 'semua') + '.csv';
  } else {
    const r = laporanAcaraRows();
    if (!r.jadwal) { toast('Pilih acara terlebih dahulu', 'error'); return; }
    const j = r.jadwal;
    head = ['No', 'Tanggal', 'Hari', 'Acara', 'Pemateri', 'Venue', 'Nama Peserta', 'Status',
      'Waktu Presensi', 'Metode', 'Jarak (m)', 'Keterangan'];
    lines = r.rows.map((p, i) => [i + 1, fmtDate(j.tanggal), hariID(j.tanggal), j.nama,
      jadwalPemateriText(j), j.venue,
      p.userName, p.status, fmtDateTime(p.timestamp), 'Pindai QR',
      (p.distance == null || isNaN(p.distance)) ? '' : Math.round(p.distance),
      p.keterangan || ''].map(csvCell).join(';'));
    fname = 'hadir_' + String(j.nama).replace(/\s+/g, '_') + '_' + String(j.tanggal).slice(0, 10) + '.csv';
  }
  const blob = new Blob(['\ufeff' + head.map(csvCell).join(';') + '\r\n' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = fname;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  try { addLog('EXPORT_LAPORAN', { mode: mode, file: fname }); } catch (e) {}
  toast('Berkas ' + fname + ' diunduh — buka dengan Excel', 'success');
}

/* ---------- 19a. LAYOUT PDF DAFTAR HADIR (ADMIN) ------------------------ */
/* Tata letak cetakan disimpan sebagai SATU pengaturan bersama (id 'pdf-layout')
   di state.settings → IndexedDB (luring) + tabel Supabase app_settings (daring),
   sehingga semua perangkat memakai hasil cetakan yang sama. Nilai bawaan di
   bawah dipakai bila pengaturan belum pernah disimpan. */
const PDF_LAYOUT_DEFAULT = {
  /* Kop & isi */
  judul: 'PRESENSI IGNASIAN — DAFTAR HADIR',
  motto: 'Ad Maiorem Dei Gloriam',
  lembaga: '',
  tampilKop: true, tampilMotto: true, tampilLembaga: true,
  judulAcara: true, tampilInfo: true, tampilPemateri: true, tampilRekap: true,
  /* Kolom tabel */
  kolom: {
    no: true, nama: true, status: true, tanggal: true, jam: true,
    metode: true, jarak: false, ket: true
  },
  /* Kertas & tampilan */
  paper: 'A4',              /* A4 | F4 | Letter */
  orientasi: 'portrait',    /* portrait | landscape */
  margin: 16,               /* mm */
  fontTabel: 11,            /* pt */
  border: 1,                /* px (0 = tanpa garis tabel) */
  kopWarna: '#111111',      /* warna teks kop & judul */
  garisWarna: '#333333',    /* warna garis tabel & garis bawah kop */
  gayaGaris: 'solid',       /* solid | double | none (garis bawah kop) */
  /* Tanda tangan & kaki */
  ttd: true, ttdJumlah: 2, ttdKiri: 'Mengetahui', ttdKanan: 'Petugas',
  footer: ''
};

/* Pengaturan efektif = bawaan + yang tersimpan (baris yang tak dikenal/typenya
   salah diabaikan agar data rusak tidak membuat cetakan gagal). */
function pdfLayout() {
  const rec = (state.settings || []).find(s => s && String(s.id) === 'pdf-layout');
  const data = (rec && rec.data && typeof rec.data === 'object' && !Array.isArray(rec.data)) ? rec.data : {};
  return normalisasiPdfLayout(Object.assign({}, PDF_LAYOUT_DEFAULT, data, {
    kolom: Object.assign({}, PDF_LAYOUT_DEFAULT.kolom, data.kolom || {})
  }));
}

/* Bersihkan nilai dari formulir: batasi angka & pilihan agar hasil cetak
   selalu valid walau isian diketik sendiri atau data lama tidak lengkap. */
function normalisasiPdfLayout(l) {
  const out = Object.assign({}, PDF_LAYOUT_DEFAULT, l || {});
  out.kolom = Object.assign({}, PDF_LAYOUT_DEFAULT.kolom, (l && l.kolom) || {});
  const teks = (v, awal, maks) => {
    const s = String(v == null ? '' : v).trim();
    return s ? s.slice(0, maks) : awal;
  };
  out.judul = teks(out.judul, PDF_LAYOUT_DEFAULT.judul, 120);
  out.motto = teks(out.motto, '', 120);
  out.lembaga = teks(out.lembaga, '', 120);
  out.footer = teks(out.footer, '', 200);
  out.ttdKiri = teks(out.ttdKiri, PDF_LAYOUT_DEFAULT.ttdKiri, 60);
  out.ttdKanan = teks(out.ttdKanan, PDF_LAYOUT_DEFAULT.ttdKanan, 60);
  out.paper = ['A4', 'F4', 'Letter'].indexOf(out.paper) !== -1 ? out.paper : 'A4';
  out.orientasi = out.orientasi === 'landscape' ? 'landscape' : 'portrait';
  out.gayaGaris = ['solid', 'double', 'none'].indexOf(out.gayaGaris) !== -1 ? out.gayaGaris : 'solid';
  out.kopWarna = /^#[0-9a-fA-F]{3,6}$/.test(String(out.kopWarna)) ? out.kopWarna : '#111111';
  out.garisWarna = /^#[0-9a-fA-F]{3,6}$/.test(String(out.garisWarna)) ? out.garisWarna : '#333333';
  const angka = (v, min, max, awal) => {
    const n = Math.round(Number(v));
    return (isFinite(n) && n >= min && n <= max) ? n : awal;
  };
  out.margin = angka(out.margin, 5, 40, PDF_LAYOUT_DEFAULT.margin);
  out.fontTabel = angka(out.fontTabel, 7, 18, PDF_LAYOUT_DEFAULT.fontTabel);
  out.border = angka(out.border, 0, 4, PDF_LAYOUT_DEFAULT.border);
  out.ttdJumlah = angka(out.ttdJumlah, 1, 2, PDF_LAYOUT_DEFAULT.ttdJumlah);
  ['tampilKop', 'tampilMotto', 'tampilLembaga', 'judulAcara', 'tampilInfo',
    'tampilPemateri', 'tampilRekap', 'ttd'].forEach(k => { out[k] = !!out[k]; });
  /* Nama peserta SELALU dicetak — tanpa kolom ini daftar hadir tak berguna. */
  out.kolom.nama = true;
  return out;
}

/* Ukuran kertas untuk aturan @page (CSS tidak mengenal nama "F4"). */
function pdfPaperSize(l) {
  if (l.paper === 'F4') return '215mm 330mm';
  if (l.paper === 'Letter') return 'letter';
  return 'A4';
}

/* Aturan CSS cetakan — mengikuti settings (kertas, margin, font tabel, garis,
   warna). Dipakai oleh cetakan sungguhan DAN pratinjau di halaman Layout PDF. */
function pdfStyle(l) {
  const garis = l.gayaGaris === 'none' ? 'none' : l.gayaGaris;
  return '@page{size:' + pdfPaperSize(l) + ' ' + l.orientasi +
    ';margin:' + l.margin + 'mm}' +
    'body{font-family:Georgia,"Times New Roman",serif;color:#111;margin:0;font-size:11pt}' +
    '.kop{text-align:center;padding-bottom:8px;margin-bottom:12px;border-bottom:3px ' +
    garis + ' ' + l.garisWarna + '}' +
    '.kop .judul{font-family:"Times New Roman",Georgia,serif;font-weight:700;font-size:16pt;' +
    'color:' + l.kopWarna + ';letter-spacing:.04em;margin:0}' +
    '.kop .lembaga{font-size:12pt;font-weight:700;margin:0 0 2px}' +
    '.kop .motto{font-style:italic;font-size:10.5pt;margin:0;color:#333}' +
    '.acara{font-size:14pt;font-weight:700;text-align:center;margin:0 0 6px}' +
    '.info{font-size:10pt;color:#333;margin:0 0 2px}' +
    '.pemateri{font-size:10.5pt;margin:0 0 6px}' +
    '.pemateri b{color:' + l.kopWarna + '}' +
    'table{width:100%;border-collapse:collapse;font-size:' + l.fontTabel + 'pt;margin-top:8px}' +
    'th,td{border:' + l.border + 'px solid ' + l.garisWarna + ';padding:5px 6px;text-align:left;' +
    'vertical-align:top}' +
    'thead th{background:#f1ece4}' +
    '.ttd{display:flex;justify-content:space-between;gap:20px;margin-top:30px;font-size:10.5pt}' +
    '.ttd .kotak{flex:1;text-align:center}' +
    '.ttd .garis{display:inline-block;margin-top:26px;min-width:190px}' +
    '.kaki{margin-top:18px;font-size:9pt;color:#444;text-align:center}';
}
/* Daftar kolom tabel yang dicetak (label + isi per baris presensi).
   Urutan & isi inilah yang diatur pada halaman Layout PDF. */
function pdfKolomDef(l) {
  const k = l.kolom || {};
  const def = [];
  if (k.no) def.push({ key: 'no', label: 'No' });
  if (k.nama) def.push({ key: 'nama', label: 'Nama Peserta' });
  if (k.status) def.push({ key: 'status', label: 'Status' });
  if (k.tanggal) def.push({ key: 'tanggal', label: 'Tanggal' });
  if (k.jam) def.push({ key: 'jam', label: 'Jam' });
  if (k.metode) def.push({ key: 'metode', label: 'Metode' });
  if (k.jarak) def.push({ key: 'jarak', label: 'Jarak' });
  if (k.ket) def.push({ key: 'ket', label: 'Keterangan' });
  return def;
}

function pdfIsiKolom(key, p, i) {
  switch (key) {
    case 'no': return String(i + 1);
    case 'nama': return esc(p.userName || '-');
    case 'status': return esc(p.status || '-');
    case 'tanggal': return esc(fmtDate(p.timestamp));
    case 'jam': return esc(fmtTime(p.timestamp));
    case 'metode': return 'Pindai QR';
    case 'jarak': return (p.distance == null || isNaN(p.distance)) ? '-' : esc(Math.round(p.distance)) + ' m';
    case 'ket': return esc(p.keterangan || '-');
    default: return '';
  }
}

/* Baris pemateri — SELALU ada saat aktif, walau kosong (dicetak sebagai garis
   isian supaya dapat ditulis tangan). Inilah pemecahan masalah "nama pemateri
   tidak tercetak": barisnya tidak pernah hilang, dan bisa diisi langsung dari
   jendela cetak lalu disimpan ke acara. */
function pdfBarisPemateri(pemateri) {
  const isi = pemateri ? esc(pemateri) : '<span style="letter-spacing:.1em">…………………</span>';
  return '<p class="pemateri" id="barisPemateri"><b>Pemateri / Pengisi Materi:</b> ' + isi + '</p>';
}

function pdfTtdHtml(l) {
  if (!l.ttd) return '';
  const kotak = label => '<div class="kotak">' + esc(label) +
    '<br><br><br><span class="garis">(..............................)</span></div>';
  return '<div class="ttd">' + kotak(l.ttdKiri) +
    (l.ttdJumlah >= 2 ? kotak(l.ttdKanan) : '') + '</div>';
}

/* Isi dokumen cetak (tanpa <html>): kop → acara → pemateri → info → tabel →
   tanda tangan → kaki. Fungsi ini yang dipakai cetakan sungguhan maupun
   pratinjau, sehingga pratinjau selalu sama dengan hasil cetak. */
function pdfBadan(j, rows, l, pemateri) {
  const nHadir = rows.filter(x => x.status === 'hadir').length;
  const defs = pdfKolomDef(l);
  const kop = (l.tampilKop || l.tampilLembaga || l.tampilMotto)
    ? '<div class="kop">' +
      (l.tampilLembaga && l.lembaga ? '<div class="lembaga">' + esc(l.lembaga) + '</div>' : '') +
      (l.tampilKop ? '<div class="judul">' + esc(l.judul) + '</div>' : '') +
      (l.tampilMotto && l.motto ? '<div class="motto">' + esc(l.motto) + '</div>' : '') +
      '</div>'
    : '';

  const info = [];
  if (l.tampilInfo) {
    info.push('Hari: ' + esc(hariID(j.tanggal)) + ' · Tanggal: ' + esc(fmtDateTime(j.tanggal)));
    info.push('Lokasi: ' + esc(j.venue || '-') + ' · Radius validasi: ' + esc(j.radius) + ' m');
  }
  if (l.tampilRekap) {
    info.push('Jumlah hadir: ' + nHadir + ' dari ' + rows.length + ' peserta tercatat');
  }

  return kop +
    (l.judulAcara ? '<h1 class="acara">' + esc(j.nama) + '</h1>' : '') +
    (l.tampilPemateri ? pdfBarisPemateri(pemateri) : '') +
    info.map(t => '<p class="info">' + t + '</p>').join('') +
    '<table><thead><tr>' + defs.map(d => '<th>' + d.label + '</th>').join('') + '</tr></thead><tbody>' +
    rows.map((p, i) => '<tr>' + defs.map(d => '<td>' + pdfIsiKolom(d.key, p, i) + '</td>').join('') + '</tr>').join('') +
    '</tbody></table>' +
    pdfTtdHtml(l) +
    (l.footer ? '<p class="kaki">' + esc(l.footer) + '</p>' : '');
}

/* Dokumen HTML lengkap untuk jendela cetak. opts.alat = tampilkan tombol
   cetak di layar (tidak ikut tercetak). Nama pemateri diambil dari acara,
   jadi tidak ada lagi kolom isian manual di jendela ini. */
function pdfDocHtml(j, rows, l, pemateri, opts) {
  const o = opts || {};
  /* Gaya alat DIBATASI @media screen — bila tidak, gaya "tanpa garis" untuk
     tabel di bawah ikut berlaku saat pencetakan dan garis tabel hilang. */
  const alat = o.alat ? '<style>@media screen{body{padding:22px;max-width:900px;margin:0 auto;background:#f7f3ec}' +
    '.noprint{margin:0 0 18px;font-family:system-ui,sans-serif;font-size:13px}' +
    '.noprint button{padding:8px 14px;margin:8px 6px 0 0;border:1px solid #6E2632;background:#6E2632;' +
    'color:#fff;border-radius:6px;cursor:pointer;font-size:13px}' +
    '.noprint small{color:#555}}</style>' +
    '<div class="noprint">' +
    '<div>' +
    ' <button type="button" onclick="window.print()">Cetak / Simpan PDF</button></div></div>' : '';
  return '<!DOCTYPE html><html lang="id"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>Daftar Hadir — ' + esc(j.nama) + '</title>' +
    '<style>' + pdfStyle(l) + '@media print{.noprint{display:none}}</style></head><body>' +
    alat + pdfBadan(j, rows, l, pemateri) +
    '</body></html>';
}


/* ---------- 19b. CETAK DAFTAR HADIR (SEMUA ADMIN & PENGURUS) ----------- */
/* Cetak PDF lewat dialog cetak peramban (pilih "Save as PDF"). Tata letak
   mengikuti pengaturan bersama (lihat 19a) sehingga hasil cetak di semua
   perangkat seragam. */
function printLaporanAcara() {
  const r = laporanAcaraRows();
  if (!r.jadwal) { toast('Pilih acara terlebih dahulu', 'error'); return; }
  if (!r.rows.length) { toast('Belum ada presensi pada acara ini', 'error'); return; }
  const j = r.jadwal;
  const pemateri = jadwalPemateriText(j);
  const w = window.open('', '_blank', 'width=900,height=700');
  if (!w) { toast('Popup diblokir — izinkan popup untuk mencetak', 'error'); return; }
  w.document.open();
  w.document.write(pdfDocHtml(j, r.rows, pdfLayout(), pemateri, { alat: true }));
  w.document.close();
  try { addLog('PRINT_LAPORAN', { jadwalId: j.id, nama: j.nama, pemateri: pemateri }); } catch (e) {}
}

/* Pengurus: READ-ONLY (tombol Kelola disembunyikan). */
/* ---------- 19c. PENGATURAN LAYOUT PDF (HANYA ADMIN) --------------------- */
function renderPdfSettings() {
  if (!isAdmin()) { showPage('lainnya'); return; }
  isiFormPdf(pdfLayout());
  const kapan = (state.settings || []).find(s => s && String(s.id) === 'pdf-layout');
  setText('pdfLayoutStatus', kapan && kapan.updatedAt
    ? 'Terakhir diubah: ' + fmtDateTime(kapan.updatedAt) +
      (kapan.updatedBy ? ' · berlaku untuk semua perangkat' : ' · berlaku di perangkat ini')
    : 'Belum diatur — memakai tampilan bawaan.');
  setText('pdfLayoutSync', apiReady()
    ? 'Tersimpan di perangkat ini dan disinkronkan ke server (tabel app_settings).'
    : 'Tersimpan di perangkat ini. Basis data daring belum siap, jadi belum dibagikan ke perangkat lain.');
  previewPdf();
}

/* Isi formulir layout dengan nilai effective (bawaan + tersimpan). */
function isiFormPdf(l) {
  document.querySelectorAll('#page-pdf [data-pdf]').forEach(el => {
    const v = l[el.getAttribute('data-pdf')];
    if (el.type === 'checkbox') el.checked = !!v;
    else el.value = (v == null ? '' : String(v));
  });
  document.querySelectorAll('#page-pdf [data-pdf-kolom]').forEach(el => {
    el.checked = !!(l.kolom && l.kolom[el.getAttribute('data-pdf-kolom')]);
  });
}

/* Baca formulir layout → objek pengaturan (selalu dibersihkan normalisasi). */
function bacaFormPdf() {
  const l = {};
  document.querySelectorAll('#page-pdf [data-pdf]').forEach(el => {
    l[el.getAttribute('data-pdf')] =
      (el.type === 'checkbox') ? el.checked : el.value;
  });
  l.kolom = {};
  document.querySelectorAll('#page-pdf [data-pdf-kolom]').forEach(el => {
    l.kolom[el.getAttribute('data-pdf-kolom')] = el.checked;
  });
  l.kolom.nama = true;              /* nama peserta selalu dicetak */
  return normalisasiPdfLayout(l);
}

/* Pratinjau memakai DOKUMEN yang sama dengan cetakan sungguhan, jadi tidak
   mungkin "pratinjau berbeda dengan hasil cetak". */
function previewPdf() {
  const frame = $('pdfPreview');
  if (!frame) return;
  const j = {
    nama: 'Nama Acara (contoh)', venue: 'Gereja St. Ignatius — Aula',
    radius: 50, tanggal: new Date().toISOString()
  };
  const skrg = new Date().toISOString();
  const rows = [
    { userName: 'Sanya Adalahah', status: 'hadir', timestamp: skrg, distance: 12, keterangan: '' },
    { userName: 'Budi Santoso', status: 'hadir', timestamp: skrg, distance: 20, keterangan: 'Tepat waktu' },
    { userName: 'Clara Wulandari', status: 'hadir', timestamp: skrg, distance: 8, keterangan: '' }
  ];
  frame.srcdoc = pdfDocHtml(j, rows, bacaFormPdf(), 'Romo Yohanes, SJ', {});
}

function simpanPdfLayout() {
  if (!isAdmin()) { toast('Pengaturan layout PDF hanya untuk Administrator', 'error'); return; }
  const l = bacaFormPdf();
  const now = new Date().toISOString();
  const lama = (state.settings || []).find(s => s && String(s.id) === 'pdf-layout');
  const rec = {
    id: 'pdf-layout', data: l, updatedAt: now,
    updatedBy: state.currentUser ? state.currentUser.id : null,
    createdAt: (lama && lama.createdAt) || now
  };
  const idx = (state.settings || []).findIndex(s => s && String(s.id) === 'pdf-layout');
  if (idx >= 0) state.settings[idx] = rec; else state.settings.push(rec);
  saveLocal();
  enqueue('setting', rec);
  addLog('UPDATE_PDF_LAYOUT', {
    judul: l.judul, paper: l.paper, orientasi: l.orientasi, fontTabel: l.fontTabel
  });
  renderPdfSettings();   /* isi ulang formulir + pratinjau dari nilai tersimpan */
  toast('Layout PDF tersimpan dan langsung dipakai saat pencetakan', 'success');
}

function konfirmasiResetPdfLayout() {
  if (!isAdmin()) { toast('Pengaturan layout PDF hanya untuk Administrator', 'error'); return; }
  showModal('Kembalikan Layout PDF ke Bawaan',
    '<p>Semua pilihan layout (kop, kolom tabel, kertas, tanda tangan) akan kembali ke ' +
    'tampilan bawaan dan langsung berlaku di semua perangkat.</p>' +
    '<div class="modal-actions"><button class="btn btn-ghost" onclick="closeModal()">Batal</button>' +
    '<button class="btn btn-danger" onclick="resetPdfLayout()">' + ic('scrap') + 'Kembalikan</button></div>',
    { icon: 'scrap', tone: 'danger' });
}

function resetPdfLayout() {
  if (!isAdmin()) { toast('Pengaturan layout PDF hanya untuk Administrator', 'error'); return; }
  const l = normalisasiPdfLayout(PDF_LAYOUT_DEFAULT);
  const now = new Date().toISOString();
  const lama = (state.settings || []).find(s => s && String(s.id) === 'pdf-layout');
  const rec = {
    id: 'pdf-layout', data: l, updatedAt: now,
    updatedBy: state.currentUser ? state.currentUser.id : null,
    createdAt: (lama && lama.createdAt) || now
  };
  const idx = (state.settings || []).findIndex(s => s && String(s.id) === 'pdf-layout');
  if (idx >= 0) state.settings[idx] = rec; else state.settings.push(rec);
  saveLocal();
  enqueue('setting', rec);
  addLog('RESET_PDF_LAYOUT', { judul: l.judul });
  closeModal();
  renderPdfSettings();
  toast('Layout PDF dikembalikan ke tampilan bawaan', 'success');
}

/* ---------- 19d. KELOLA PRESENSI PER ACARA (HANYA ADMIN) -------------- */
/* Pengurus: READ-ONLY (tombol Kelola disembunyikan). */
function editPresensi(id) {
  if (!isAdmin()) { toast('Hanya Administrator yang dapat mengubah presensi', 'error'); return; }
  const p = state.presensi.find(x => String(x.id) === String(id));
  if (!p) { toast('Data presensi tidak ditemukan', 'error'); return; }
  showModal('Ubah Presensi',
    /* Status kehadiran hanya 'hadir' — pilihan Izin & Tanpa Keterangan sudah
       dihapus, jadi yang masih dapat disesuaikan Administrator adalah keterangan. */
    '<div class="form-group"><label>Keterangan</label>' +
    '<input type="text" id="editPresKet" class="form-control" value="' + esc(p.keterangan || '') + '" /></div>' +
    '<p class="tiny muted">' + esc(p.userName || '') + ' · ' + esc(fmtDateTime(p.timestamp)) + '</p>' +
    '<div class="modal-actions"><button class="btn btn-ghost" onclick="closeModal()">Batal</button>' +
    '<button class="btn btn-primary" onclick="saveEditPresensi(\'' + esc(p.id) + '\')">' + ic('seal') + 'Simpan</button></div>',
    { icon: 'quill' });
}

function saveEditPresensi(id) {
  if (!isAdmin()) { toast('Hanya Administrator yang dapat mengubah presensi', 'error'); return; }
  const p = state.presensi.find(x => String(x.id) === String(id));
  if (!p) { toast('Data presensi tidak ditemukan', 'error'); return; }
  p.status = 'hadir'; /* satu-satunya status; Izin & Tanpa Keterangan dihapus */
  p.keterangan = $('editPresKet') ? $('editPresKet').value.trim() : p.keterangan;
  p.updatedAt = new Date().toISOString();
  saveLocal();
  enqueue('presensi', p);
  addLog('UPDATE_PRESENSI', { presensiId: p.id, status: p.status });
  closeModal();
  renderActivePage();
  toast('Presensi diperbarui', 'success');
}

function deletePresensi(id) {
  if (!isAdmin()) { toast('Hanya Administrator yang dapat menghapus presensi', 'error'); return; }
  const p = state.presensi.find(x => String(x.id) === String(id));
  if (!p) { toast('Data presensi tidak ditemukan', 'error'); return; }
  showModal('Hapus Presensi',
    '<p>Hapus presensi <strong>' + esc(p.userName || '') + '</strong> pada <strong>' +
    esc(p.jadwalNama || '') + '</strong> (' + esc(fmtDateTime(p.timestamp)) + ')?</p>' +
    '<div class="modal-actions"><button class="btn btn-ghost" onclick="closeModal()">Batal</button>' +
    '<button class="btn btn-danger" onclick="confirmDeletePresensi(\'' + esc(p.id) + '\')">' + ic('scrap') + 'Hapus</button></div>',
    { icon: 'scrap', tone: 'danger' });
}

function confirmDeletePresensi(id) {
  if (!isAdmin()) { toast('Hanya Administrator yang dapat menghapus presensi', 'error'); return; }
  const idx = state.presensi.findIndex(x => String(x.id) === String(id));
  if (idx < 0) { toast('Data presensi tidak ditemukan', 'error'); return; }
  const p = state.presensi[idx];
  state.presensi.splice(idx, 1);
  saveLocal();
  queueDelete('presensi', id);   /* tandai di server agar tidak "hidup kembali" */
  addLog('DELETE_PRESENSI', { presensiId: id, user: p.userName });
  closeModal();
  renderActivePage();
  toast('Presensi dihapus — berlaku di perangkat ini dan di server', 'success');
}

function generateLaporan() {
  const from = new Date($('laporanFrom').value);
  const to = new Date($('laporanTo').value);
  if (isNaN(from) || isNaN(to)) { toast('Pilih rentang tanggal terlebih dahulu', 'error'); return; }
  to.setHours(23, 59, 59, 999);

  /* Peserta hanya melihat rekapitulasi dirinya sendiri */
  const people = isStaff()
    ? state.users.filter(u => u.role === 'peserta')
    : state.users.filter(u => u.id === state.currentUser.id);

  const filtered = state.presensi.filter(p => {
    const t = new Date(p.timestamp);
    return t >= from && t <= to;
  });

  const body = $('laporanBody');
  if (!people.length) {
    body.innerHTML = '<tr><td colspan="3"><div class="empty">' + ic('bulla', 'ic-lg') +
      '<div>Tidak ada data peserta</div></div></td></tr>';
    return;
  }

  body.innerHTML = people.map(u => {
    const up = filtered.filter(p => p.userId === u.id);
    const h = up.filter(p => p.status === 'hadir').length;
    const total = up.length;
    const pct = total > 0 ? Math.round((h / total) * 100) : 0;
    return `<tr>
      <td data-label="Nama">${esc(u.nama)}<div class="tiny muted">@${esc(u.username)}</div></td>
      <td data-label="Hadir"><strong>${h}</strong></td>
      <td data-label="Persentase"><strong>${pct}%</strong></td>
    </tr>`;
  }).join('');

  addLog('VIEW_LAPORAN', { from: from.toISOString(), to: to.toISOString(), scope: isStaff() ? 'semua' : 'pribadi' });
}
/* ---------- 20b. KATA SANDI (HANYA ADMINISTRATOR) ----------------------- */
/* Kata sandi disimpan ganda: passHash (SHA-256) untuk masuk, dan passPlain
   agar Administrator dapat membantu pemilik akun yang lupa. Seluruh
   tindakan melihat/mengubah tercatat pada Log Sistem. */

function acakKarakter(pool) {
  if (window.crypto && crypto.getRandomValues) {
    const a = new Uint32Array(1);
    crypto.getRandomValues(a);
    return pool.charAt(a[0] % pool.length);
  }
  return pool.charAt(Math.floor(Math.random() * pool.length));
}

function passwordAcak() {
  const huruf = 'abcdefghijkmnpqrstuvwxyz';
  const angka = '23456789';
  let hasil = '';
  for (let i = 0; i < 5; i++) hasil += acakKarakter(huruf) + acakKarakter(angka);
  return hasil;
}

function pesanKirimPassword(u) {
  return 'Halo ' + (u.nama || '') + ', berikut password akun Presensi Ignasian Anda (@' +
    (u.username || '') + '): ' + (u.passPlain || '') +
    '. Silakan masuk kembali, dan mohon jaga kerahasiaannya. Terima kasih.';
}

/* Tampilkan/sembunyikan satu kata sandi pada tabel Administrator */
function togglePassword(id) {
  if (!isAdmin()) { toast('Hanya Administrator yang dapat melihat password', 'error'); return; }
  const u = state.users.find(x => String(x.id) === String(id));
  if (!u) return;
  const el = $('pw-' + id);
  if (!el) return;
  const tampil = el.getAttribute('data-shown') === '1';
  if (tampil) {
    el.textContent = '••••••••';
    el.classList.add('pw-hidden');
    el.setAttribute('data-shown', '0');
    return;
  }
  el.textContent = u.passPlain || 'belum tercatat';
  el.classList.remove('pw-hidden');
  el.setAttribute('data-shown', '1');
  try { addLog('VIEW_PASSWORD', { userId: u.id, username: u.username }); } catch (e) { /* abaikan */ }
}

function sidOf(id) { return String(id == null ? '' : id).replace(/[^a-zA-Z0-9_-]/g, ''); }

/* Petakan kembali id yang "disalurkan" (sanitasi DOM) ke id asli —
   uid() hanya memakai [a-z0-9] jadi aman, tapi pemetaan ini membuat
   toggle/hapus/lihat-password tetap benar walau id mengandung spasi,
   @, /, dsb. (mis. data lama / impor manual). */
function findUserBySid(sid) {
  sid = String(sid || '');
  return (state.users || []).find(u => u && (u.id === sid || sidOf(u.id) === sid)) || null;
}

/* ---------- 20. MANAJEMEN PESERTA (ADMIN) ------------------------------ */
function renderUsers() {
  const body = $('usersBody');
  if (!body) return;
  const q = String($('userSearchInput') ? $('userSearchInput').value : '').trim().toLowerCase();
  const cariNomor = normalisasiHp(q);
  const list = !q ? state.users : state.users.filter(u =>
    String(u.nama || '').toLowerCase().includes(q) ||
    String(u.username || '').toLowerCase().includes(q) ||
    String(roleName(u.role) || '').toLowerCase().includes(q) ||
    (cariNomor.length >= 3 && String(normalisasiHp(u.hpPlain)).indexOf(cariNomor) !== -1));
  if (!state.users.length) {
    body.innerHTML = '<tr><td colspan="5"><div class="empty">' + ic('halopair', 'ic-lg') +
      '<div>Belum ada pengguna</div></div></td></tr>';
    return;
  }
  if (!list.length) {
    body.innerHTML = '<tr><td colspan="5"><div class="empty">' + ic('compass', 'ic-lg') +
      '<div>Tidak ada yang cocok dengan pencarian</div></div></td></tr>';
    return;
  }
  body.innerHTML = list.map(u => {
    const sid = sidOf(u.id);
    const hp = normalisasiHp(u.hpPlain) ? hpTampil(u.hpPlain) : '';
    /* Nomor HP + lencana pendaftaran: "belum mendaftar" berarti nomor sudah
       tercatat oleh Admin tetapi orangnya belum mengaktifkan akun. */
    const daftar = sudahTerdaftar(u);
    const lencana = hp
      ? ' <span class="badge ' + (daftar ? 'badge-aktif">terdaftar' : 'badge-gold">belum mendaftar') + '</span>'
      : '';
    return `
    <tr>
      <td data-label="Nama"><div class="u-ident"><span class="u-ava" aria-hidden="true">${esc((u.nama || u.username || '?').trim().charAt(0).toUpperCase())}</span><span class="u-id"><strong class="u-name">${esc(u.nama)}</strong><span class="tiny muted u-user">@${esc(u.username)}${hp ? ' · ' + esc(hp) + lencana : ''}</span></span></div></td>
      <td data-label="Peran"><span class="u-badges"><span class="badge badge-role">${esc(roleName(u.role))}</span></span></td>
      <td data-label="Status"><span class="u-badges"><span class="badge badge-${esc(u.status)}">${esc(u.status)}</span></span></td>
      <td data-label="Password">
        <span class="pw-cell${u.passPlain ? ' pw-hidden' : ''}" id="pw-${sid}">${
          u.passPlain ? '••••••••' : '<span class="tiny muted">belum tercatat</span>'}</span>
        <div class="u-pw-actions mt-6">
          ${u.passPlain ? `<button class="btn btn-outline btn-sm" type="button" data-act="pw" data-id="${sid}">
            ${ic('eye')}<span>Lihat</span>
          </button>` : ''}
          <button class="btn btn-ghost btn-sm" type="button" data-act="reset" data-id="${sid}">
            ${ic('keyring')}Atur Ulang
          </button>
        </div>
      </td>
      <td data-label="Tindakan">
        <div class="u-actions">
          <button class="btn btn-outline btn-sm u-act" type="button" data-act="toggle" data-id="${sid}">
            ${ic(u.status === 'aktif' ? 'lamp' : 'lampoff')}<span>${u.status === 'aktif' ? 'Nonaktifkan' : 'Aktifkan'}</span>
          </button>
          ${u.id !== (state.currentUser && state.currentUser.id)
      ? `<button class="btn btn-danger btn-sm u-act" type="button" data-act="del" data-id="${sid}">${ic('scrap')}<span>Hapus</span></button>`
      : ''}
        </div>
      </td>
    </tr>`;
  }).join('');
  try {
    body.querySelectorAll('button[data-act]').forEach(b => {
      b.addEventListener('click', () => {
        const id = b.getAttribute('data-id');
        const act = b.getAttribute('data-act');
        if (act === 'pw') togglePassword(id);
        else if (act === 'reset') showResetPassword(id);
        else if (act === 'toggle') toggleUser(id);
        else if (act === 'del') deleteUser(id);
      });
    });
  } catch (e) {}
}

async function registerUser() {
  if (!isAdmin()) { toast('Hanya Administrator yang dapat mendaftarkan pengguna', 'error'); return; }
  if (state.users.length >= CONFIG.MAX_USERS) {
    toast('Batas ' + CONFIG.MAX_USERS + ' pengguna tercapai', 'error');
    return;
  }

  const nama = $('regNama').value.trim();
  const username = $('regUser').value.trim().toLowerCase();
  const pass = $('regPass').value;
  const hp = $('regHP').value.trim();
  const role = $('regRole').value;
  const status = $('regStatus').value;

  if (!nama || !username || !pass || !hp) { toast('Lengkapi seluruh data pendaftaran', 'error'); return; }
  if (state.users.some(u => String(u.username || '').toLowerCase() === username)) {
    toast('Username sudah dipakai', 'error');
    return;
  }

  const now = new Date().toISOString();
  const newUser = {
    id: uid(), nama: nama, username: username,
    passHash: await sha256(pass),
    passPlain: pass,      /* salinan untuk pemulihan oleh Administrator */
    hpHash: await sha256(hp),
    hpPlain: hp,
    role: role, status: status, email: '',
    createdAt: now, updatedAt: now
  };
  state.users.push(newUser);
  saveLocal();
  enqueue('user', newUser);
  addLog('CREATE_USER', { userId: newUser.id, username: username, role: role });
  toast('Pengguna terdaftar', 'success');
  ['regNama', 'regUser', 'regPass', 'regHP'].forEach(id => { $(id).value = ''; });
  renderUsers();
}

function toggleUser(id) {
  if (!isAdmin()) { toast('Hanya Administrator', 'error'); return; }
  const u = state.users.find(x => x.id === id);
  if (!u) return;
  u.status = (u.status === 'aktif') ? 'nonaktif' : 'aktif';
  stamp(u);
  saveLocal();
  enqueue('user', u);
  addLog('TOGGLE_USER', { userId: id, status: u.status });
  renderUsers();
  toast('Status ' + u.nama + ' kini ' + u.status, 'success');
}

function deleteUser(id) {
  if (!isAdmin()) { toast('Hanya Administrator', 'error'); return; }
  const u = state.users.find(x => x.id === id);
  if (!u) return;
  if (!confirm('Hapus pengguna ' + u.nama + '? Tindakan ini tidak dapat dibatalkan.')) return;
  state.users = state.users.filter(x => x.id !== id);
  saveLocal();
  queueDelete('users', id);
  addLog('DELETE_USER', { userId: id, username: u.username });
  renderUsers();
  toast('Pengguna dihapus', 'success');
}

/* Buka WhatsApp langsung dengan pesan siap kirim (dipakai pemulihan password) */
function nomorWa(nomor) {
  let n = String(nomor || '').replace(/\D/g, '');
  if (n.charAt(0) === '0') n = '62' + n.slice(1);
  else if (n.charAt(0) === '8') n = '62' + n;
  return n;
}

function waTo(nomor, pesan) {
  const n = nomorWa(nomor);
  if (!n) { toast('Nomor HP tidak tersedia pada akun ini', 'error'); return; }
  const url = 'https://wa.me/' + n + (pesan ? '?text=' + encodeURIComponent(pesan) : '');
  window.open(url, '_blank', 'noopener');
}

/* Daftar seluruh kata sandi akun — khusus Administrator */
function showAllPasswords() {
  if (!isAdmin()) { toast('Hanya Administrator yang dapat melihat semua password', 'error'); return; }
  if (!state.users.length) { toast('Belum ada akun', 'info'); return; }

  const isi = state.users.map(u => `
    <div class="list-item">
      ${ic('keyring')}
      <div class="body">
        <strong>${esc(u.nama)}</strong>
        <div class="meta">@${esc(u.username)} · ${esc(roleName(u.role))} · ${esc(u.status)}${
          u.hpPlain ? ' · ' + esc(u.hpPlain) : ''}</div>
        <div class="wa-box">${u.passPlain ? esc(u.passPlain)
      : '<span class="tiny muted">Belum tercatat — gunakan tombol Atur Ulang</span>'}</div>
        <div class="row-tight mt-6">
          ${u.hpPlain && u.passPlain ? `<button class="btn btn-gold btn-sm" type="button" onclick="waTo('${esc(u.hpPlain)}', '${esc(pesanKirimPassword(u))}')">
              ${ic('wa')}Kirim via WhatsApp
            </button>` : ''}
          <button class="btn btn-outline btn-sm" type="button" onclick="closeModal();showResetPassword('${esc(u.id)}')">
            ${ic('keyring')}Atur Ulang
          </button>
        </div>
      </div>
    </div>`).join('');

  try { addLog('VIEW_PASSWORD', { scope: 'semua-akun', jumlah: state.users.length }); } catch (e) { /* abaikan */ }
  showModal('Semua Password Akun',
    '<p class="tiny muted">Khusus Administrator. Salin seperlunya, lalu tutup jendela ini — ' +
    'tindakan melihat password tercatat pada Log Sistem.</p>' +
    '<div class="list scroll-y mt-10">' + isi + '</div>' +
    '<div class="modal-actions"><button class="btn btn-primary" onclick="closeModal()">' +
    ic('seal') + 'Tutup</button></div>',
    { icon: 'eye' });
}

/* Atur ulang password satu akun (kemudian dikirim ke pemilik via WhatsApp) */
function showResetPassword(id) {
  if (!isAdmin()) { toast('Hanya Administrator yang dapat mengatur ulang password', 'error'); return; }
  const u = state.users.find(x => String(x.id) === String(id));
  if (!u) { toast('Akun tidak ditemukan', 'error'); return; }
  showModal('Atur Ulang Password',
    '<p class="small">Akun: <strong>' + esc(u.nama) + '</strong> (@' + esc(u.username) + ')</p>' +
    '<div class="form-group mt-10"><label for="resetPassBaru">Password baru</label>' +
    '<input type="text" id="resetPassBaru" class="form-control" value="' + esc(passwordAcak()) + '" ' +
    'autocomplete="new-password" autocapitalize="off" spellcheck="false" /></div>' +
    '<div class="row-tight"><button class="btn btn-outline btn-sm" type="button" onclick="isiPasswordAcak()">' +
    ic('sync') + 'Buatkan Lagi</button></div>' +
    '<p class="tiny muted mt-10">Setelah disimpan, bagikan password kepada pemilik akun melalui WhatsApp ' +
    '(tombolnya tersedia di layar berikutnya).</p>' +
    '<div class="modal-actions"><button class="btn btn-ghost" onclick="closeModal()">Batal</button>' +
    '<button class="btn btn-primary" onclick="simpanResetPassword(\'' + esc(u.id) + '\')">' +
    ic('seal') + 'Simpan</button></div>',
    { icon: 'keyring' });
}

function isiPasswordAcak() {
  const el = $('resetPassBaru');
  if (el) { el.value = passwordAcak(); el.focus(); }
}

/* KEAMANAN (H3): dialog kunci untuk login pertama akun bawaan mode mandiri.
   Tanpa tombol Tutup / Batal dan anti-tutup (klik luar & Esc dinonaktifkan
   sementara) sampai pemilik menyimpan kata sandi baru (min 8 karakter).
   Jalur keluar darurat tetap ada: tombol Keluar di dalam dialog. */
let _wajibSandiUserId = null;

function wajibGantiSandi(user) {
  _wajibSandiUserId = user ? user.id : null;
  try {
    document.body.classList.add('modal-lock');
    document.addEventListener('keydown', blokirEscWajibSandi, true);
  } catch (e) { /* abaikan */ }
  showModal('Wajib Ganti Kata Sandi',
    '<p class="small">Akun <strong>' + esc(user.nama) + '</strong> (@' + esc(user.username) + ') ' +
    'masih memakai kata sandi bawaan. Demi keamanan, buat kata sandi baru ' +
    'sekarang (minimal 8 karakter, berbeda dari username).</p>' +
    '<div class="form-group mt-10"><label for="wajibSandiBaru">Kata sandi baru</label>' +
    '<input type="password" id="wajibSandiBaru" class="form-control" value="" ' +
    'autocomplete="new-password" autocapitalize="off" spellcheck="false" /></div>' +
    '<div class="form-group"><label for="wajibSandiUlang">Ulangi kata sandi baru</label>' +
    '<input type="password" id="wajibSandiUlang" class="form-control" value="" ' +
    'autocomplete="new-password" autocapitalize="off" spellcheck="false" /></div>' +
    '<p class="tiny muted" id="wajibSandiInfo"></p>' +
    '<div class="modal-actions"><button class="btn btn-ghost" type="button" onclick="keluarWajibSandi()">' +
    'Keluar</button>' +
    '<button class="btn btn-primary" type="button" onclick="simpanWajibSandi()">' +
    ic('seal') + 'Simpan Kata Sandi Baru</button></div>',
    { icon: 'keyring', tone: 'warn' });
  setTimeout(() => { try { $('wajibSandiBaru').focus(); } catch (e) {} }, 90);
}

function blokirEscWajibSandi(e) {
  if (!document.body.classList.contains('modal-lock')) return;
  if (e && (e.key === 'Escape' || e.key === 'Esc')) {
    try { e.stopPropagation(); e.preventDefault(); } catch (err) {}
  }
}

function keluarWajibSandi() {
  lepasKunciWajibSandi();
  try { doLogout(); } catch (e) { /* abaikan */ }
}

function lepasKunciWajibSandi() {
  _wajibSandiUserId = null;
  try {
    document.body.classList.remove('modal-lock');
    document.removeEventListener('keydown', blokirEscWajibSandi, true);
  } catch (e) { /* abaikan */ }
  try { closeModal(); } catch (e) { /* abaikan */ }
}

async function simpanWajibSandi() {
  const u = state.users.find(x => String(x.id) === String(_wajibSandiUserId));
  if (!u) { lepasKunciWajibSandi(); return; }
  const info = $('wajibSandiInfo');
  const baru = $('wajibSandiBaru') ? String($('wajibSandiBaru').value || '') : '';
  const ulang = $('wajibSandiUlang') ? String($('wajibSandiUlang').value || '') : '';
  const gagal = function (msg) {
    if (info) { info.textContent = msg; info.classList.add('err'); }
    else toast(msg, 'error');
  };
  if (!baru || baru.length < 8) { gagal('Kata sandi minimal 8 karakter.'); return; }
  if (baru !== ulang) { gagal('Ulangi kata sandi tidak sama.'); return; }
  if (baru.toLowerCase() === String(u.username || '').toLowerCase()) {
    gagal('Kata sandi tidak boleh sama dengan username.'); return;
  }
  const hashLama = u.passHash;
  u.passPlain = baru;
  u.passHash = await sha256(baru);
  u.harusGantiSandi = false;
  stamp(u);
  saveLocal();
  enqueue('user', u);
  addLog('GANTI_SANDI_WAJIB', { userId: u.id, username: u.username });
  if (state.currentUser && String(state.currentUser.id) === String(u.id)) state.currentUser = u;
  /* Samakan baris lama di perangkat lain yang masih menyimpan hash lama:
     tanpa ini perangkat kedua tetap meminta ganti sandi walau sudah diganti. */
  try {
    (state.users || []).forEach(x => {
      if (String(x.id) !== String(u.id) && x.passHash === hashLama && x.harusGantiSandi === true) {
        x.harusGantiSandi = false;
        stamp(x);
        saveLocal();
        enqueue('user', x);
      }
    });
  } catch (e) { /* abaikan */ }
  lepasKunciWajibSandi();
  toast('Kata sandi baru tersimpan — selamat memakai aplikasi!', 'success');
}

async function simpanResetPassword(id) {
  if (!isAdmin()) { toast('Hanya Administrator yang dapat mengatur ulang password', 'error'); return; }
  const u = state.users.find(x => String(x.id) === String(id));
  if (!u) { toast('Akun tidak ditemukan', 'error'); return; }
  const baru = $('resetPassBaru') ? $('resetPassBaru').value.trim() : '';
  if (!baru || baru.length < 8) { toast('Password minimal 8 karakter', 'error'); return; }
  if (baru.toLowerCase() === String(u.username || '').toLowerCase()) {
    toast('Password tidak boleh sama dengan username', 'error'); return;
  }

  u.passPlain = baru;
  u.passHash = await sha256(baru);
  stamp(u);
  saveLocal();
  enqueue('user', u);
  addLog('RESET_PASSWORD', { userId: u.id, username: u.username });
  renderUsers();

  showModal('Password Berhasil Diatur Ulang',
    '<p class="small">Password baru untuk <strong>' + esc(u.nama) + '</strong> (@' + esc(u.username) + '):</p>' +
    '<div class="wa-box">' + esc(baru) + '</div>' +
    (u.hpPlain
      ? '<div class="row-tight mt-14"><button class="btn btn-gold" type="button" ' +
        'onclick="waTo(\'' + esc(u.hpPlain) + '\', \'' + esc(pesanKirimPassword(u)) + '\')">' +
        ic('wa') + 'Kirim via WhatsApp ke ' + esc(u.hpPlain) + '</button></div>'
      : '<p class="tiny muted mt-10">Akun ini belum memiliki nomor HP — bagikan password secara langsung.</p>') +
    '<div class="modal-actions"><button class="btn btn-primary" onclick="closeModal()">' +
    ic('seal') + 'Selesai</button></div>',
    { icon: 'keyring', tone: 'success' });
}

/* ---------- 11c. LUPA PASSWORD (LAYAR MASUK) ---------------------------- */
/* Pengurus/Peserta memasukkan nomor HP/WA terdaftar → permintaan masuk ke
   Administrator yang sedang masuk → Administrator menghubungi via WhatsApp. */

function normalisasiHp(input) {
  return String(input || '').replace(/\D/g, '');
}

/* Bentuk pembanding nomor: buang awalan 0 atau 62 sehingga 0812…, 62812…,
   dan 812… menjadi kunci yang sama. Dipakai pencarian nomor (Daftar &
   Lupa Password) sehingga penulisan dalam format apa pun tetap dikenali. */
function kunciHp(input) {
  let n = normalisasiHp(input);
  if (n.slice(0, 2) === '62') n = n.slice(2);
  else if (n.charAt(0) === '0') n = n.slice(1);
  return n;
}

/* Cari akun berdasarkan nomor HP/WA (mendukung awalan 0 / 62 / 8) */
function cariUserByHp(input) {
  const n = normalisasiHp(input);
  if (n.length < 8) return null;
  const kunci = kunciHp(input);
  const inputNomor = periksaNomorHp(input).ok;

  return (state.users || []).find(u => {
    const simpanan = [normalisasiHp(u.hpPlain), normalisasiHp(u.hpHash)];
    return simpanan.some(d => {
      if (!d) return false;
      /* Input berupa nomor → disamakan lewat kunciHp (0 / 62 / 8 satu arti). */
      if (inputNomor) return kunciHp(d) === kunci;
      /* Input lain (mis. hash) → cocokkan persis seperti sebelumnya. */
      return d === n;
    });
  }) || null;
}

/* ---------- 20c. NOMOR HP: VALIDASI & BENTUK TAMPIL ---------------------
   Semua nomor dinormalisasi ke bentuk TANPA tanda baca lalu dicocokkan
   dalam tiga varian (08… / 628… / 8…) supaya penulisan mana pun oleh
   Administrator maupun peserta tetap mengenali akun yang sama. */

/* Hasil pemeriksaan nomor: { ok, angka, lokal, pesan } */
function periksaNomorHp(input) {
  const n = normalisasiHp(input);
  if (!n) return { ok: false, angka: '', pesan: 'Nomor HP/WhatsApp belum diisi.' };
  if (n.length < 8) return { ok: false, angka: n, pesan: 'Nomor terlalu pendek — minimal 8 angka (contoh: 081234567890).' };
  if (n.length > 15) return { ok: false, angka: n, pesan: 'Nomor terlalu panjang — maksimal 15 angka.' };
  const awalan = n.slice(0, 2);
  const Valid = (awalan === '62') || (n.charAt(0) === '0') || (n.charAt(0) === '8');
  if (!Valid) {
    return { ok: false, angka: n, pesan: 'Format nomor belum benar. Gunakan awalan 08 (mis. 081234567890) atau 62 (mis. 6281234567890).' };
  }
  /* Bentuk lokal Indonesia: 628… → 08… agar selalu tampil seragam */
  const lokal = (n.slice(0, 2) === '62') ? '0' + n.slice(2) : (n.charAt(0) === '8' ? '0' + n : n);
  return { ok: true, angka: n, lokal: lokal, pesan: '' };
}

/* Bentuk tampilan baku (08…) — dipakai untuk tampilan & penyimpanan */
function hpTampil(nomor) {
  const c = periksaNomorHp(nomor);
  return c.ok ? c.lokal : String(nomor || '').trim();
}

/* Username sementara untuk akun yang baru dicatat nomornya oleh Admin
   (belum mendaftar). Dipakai sebagai pengganti sampai peserta memilih
   username-nya sendiri. Format: "hp" + nomor tanpa tanda baca. */
function placeholderUsername(nomor) {
  const dasar = 'hp' + normalisasiHp(nomor);
  if (!occupiedUsername(dasar)) return dasar;
  for (let i = 2; i < 1000; i++) {
    const coba = dasar.slice(0, 28) + '-' + i;
    if (!occupiedUsername(coba)) return coba;
  }
  return dasar.slice(0, 28) + '-' + Date.now().toString(36).slice(-5);
}

function occupiedUsername(username) {
  const u = String(username || '').trim().toLowerCase();
  if (!u) return true;
  return (state.users || []).some(x => String(x.username || '').toLowerCase() === u);
}

/* Benar-benar sudah pernah mendaftar? (kolom terdaftar_at diisi saat orang
   Sendiri mengaktifkan akun). Inilah penanda "tidak dapat mendaftar lagi". */
function sudahTerdaftar(u) {
  return !!(u && u.terdaftarAt);
}

/* ---------- 20d. DAFTAR UNTUK UMUM (BERBASIS NOMOR HP/WA) ---------------
   Layar publik (belum login). Aturannya:
   1. Nomor harus SUDAH dicatat oleh Administrator (menu "Input Nomor &
      Peran") — kalau tidak, pendaftaran DITOLAK.
   2. Nomor hanya boleh mendaftar SEKALI: bila baris itu sudah pernah
      didaftarkan (terdaftar_at terisi), pendaftaran ditutup dan
      pengguna diarahkan untuk masuk.
   3. Nomor & peran tampil TERKUNCI (diambil dari database); peserta
      hanya mengisi nama, username, dan password miliknya sendiri.
   4. Berhasil → baris users yang ada diperbarui otomatis (nama,
      username, password, status aktif, terdaftar_at) lalu disinkronkan
      ke server seperti perubahan biasa.
   -------------------------------------------------------------------- */
let _daftarPengguna = null;   /* baris users yang sedang didaftarkan */

function bukaDaftar() {
  const ls = $('loginScreen');
  const ds = $('daftarScreen');
  if (!ds) return;
  if (ls) ls.classList.add('hidden');
  ds.classList.remove('hidden');
  _daftarPengguna = null;
  setDaftarLangkah(1);
  setDaftarInfo('');
  const el = $('daftarHp');
  if (el) { el.value = ''; setTimeout(() => { try { el.focus(); } catch (e) {} }, 120); }
  try { window.scrollTo(0, 0); } catch (e) {}
}

function tutupDaftar() {
  const ls = $('loginScreen');
  const ds = $('daftarScreen');
  if (ds) ds.classList.add('hidden');
  if (ls) ls.classList.remove('hidden');
  _daftarPengguna = null;
}

function setDaftarLangkah(n) {
  const s1 = $('daftarStep1');
  const s2 = $('daftarStep2');
  if (s1) s1.classList.toggle('hidden', n !== 1);
  if (s2) s2.classList.toggle('hidden', n !== 2);
}

/* Kotak pesan di layar Daftar (sukses / gagal / catatan) */
function setDaftarInfo(html, tone) {
  const box = $('daftarInfo');
  if (!box) return;
  if (!html) { box.innerHTML = ''; return; }
  const warna = tone === 'ok' ? 'var(--ok)'
    : (tone === 'err' ? 'var(--bad)' : 'var(--line)');
  box.innerHTML = '<div class="daftar-note" style="border-color:' + warna + '">' + html + '</div>';
}

/* Cari baris users berdasarkan nomor — lok dulu, lalu SERVER bila perlu.
   Penting untuk perangkat yang datanya belum pernah tersinkron: tanpa
   pemeriksaan ke server, nomor yang sah akan salah ditolak. */
async function cariUserNomorUntukDaftar(cek) {
  const lokal = cariUserByHp(cek.angka);
  if (lokal) return { user: lokal, dariServer: false };

  if (apiReady() && isOnline() && typeof supaCariUserByHp === 'function') {
    try {
      const row = await supaCariUserByHp(cek.angka);
      if (row) {
        if (!state.users.some(u => String(u.id) === String(row.id))) {
          state.users.push(row);
          saveLocal();
        }
        return {
          user: state.users.find(u => String(u.id) === String(row.id)) || row,
          dariServer: true
        };
      }
      return { user: null, dariServer: false };
    } catch (e) {
      console.warn('[Daftar] pemeriksaan nomor di server gagal:', e);
      return { user: null, dariServer: false, gagal: true };
    }
  }
  return { user: null, dariServer: false, gagal: true };
}

async function cekNomorDaftar() {
  const input = $('daftarHp');
  const cek = periksaNomorHp(input ? input.value : '');
  if (!cek.ok) { setDaftarInfo(esc(cek.pesan), 'err'); return; }

  const btn = $('btnDaftarPeriksa');
  if (btn) { btn.disabled = true; btn.textContent = 'Memeriksa…'; }
  setDaftarInfo('Mencari nomor <strong>' + esc(cek.lokal) + '</strong> di daftar…');

  try {
    const hasil = await cariUserNomorUntukDaftar(cek);

    if (hasil.gagal) {
      setDaftarInfo('Nomor tidak ditemukan di perangkat ini dan perangkat sedang luring — ' +
        'sambungkan internet agar kami dapat memeriksa daftar di server.', 'err');
      return;
    }
    if (!hasil.user) {
      setDaftarInfo('<strong>Nomor ini belum tercatat.</strong><br>' +
        'Daftar hanya untuk nomor yang sudah dicatat oleh Administrator atau Pengurus. ' +
        'Silakan hubungi mereka agar nomor Anda dicatat terlebih dahulu.', 'err');
      return;
    }
    if (sudahTerdaftar(hasil.user)) {
      /* ATURAN: satu nomor hanya boleh mendaftar SEKALI. */
      setDaftarInfo('<strong>Nomor ini sudah terdaftar.</strong><br>Akun dengan nomor <strong>' +
        esc(hpTampil(hasil.user.hpPlain)) + '</strong> sudah aktif sejak ' +
        esc(fmtDate(hasil.user.terdaftarAt)) + '. Pendaftaran tidak dapat diulang — silakan ' +
        'masuk memakai username &amp; password Anda, atau hubungi Administrator bila lupa.', 'err');
      return;
    }

    _daftarPengguna = hasil.user;
    renderLangkah2Daftar(hasil.user, cek.lokal, hasil.dariServer);
    setDaftarLangkah(2);
    setDaftarInfo('');
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = ic('compass') + 'Periksa Nomor'; }
  }
}

/* Langkah 2: nomor & peran terkunci, sisanya diisi peserta. */
function renderLangkah2Daftar(u, nomorTampil, dariServer) {
  const box = $('daftarStep2');
  if (!box) return;
  const namaAwal = String(u.nama || '').trim();
  box.innerHTML =
    '<div class="daftar-kunci">' +
      '<div class="baris"><span>Nomor HP/WA</span><strong>' + esc(nomorTampil) + '</strong>' +
        '<em>dari daftar — tidak dapat diubah</em></div>' +
      '<div class="baris"><span>Peran</span><strong>' + esc(roleName(u.role)) + '</strong>' +
        '<em>dari daftar — tidak dapat diubah</em></div>' +
    '</div>' +
    (namaAwal ? '<p class="tiny muted">Nama pada daftar: <strong>' + esc(namaAwal) +
      '</strong> — boleh disesuaikan di bawah.</p>' : '') +
    (dariServer ? '<p class="tiny muted">Nomor ditemukan di server, lalu dicocokkan ke perangkat ini.</p>' : '') +
    '<div class="form-group"><label for="daftarNama">Nama Lengkap</label>' +
      '<input type="text" id="daftarNama" class="form-control" value="' + esc(namaAwal) + '" ' +
      'placeholder="Nama sesuai identitas Anda" autocomplete="name" /></div>' +
    '<div class="form-group"><label for="daftarUser">Username (pilihan Anda)</label>' +
      '<input type="text" id="daftarUser" class="form-control" placeholder="mis. andi" ' +
      'autocomplete="username" autocapitalize="none" spellcheck="false" />' +
      '<p class="tiny muted mt-6">Minimal 3 huruf/angka, tanpa spasi. Dipakai untuk masuk bersama password.</p></div>' +
    '<div class="form-group"><label for="daftarPass">Password (pilihan Anda)</label>' +
      '<div class="pw-wrap"><input type="password" id="daftarPass" class="form-control" autocomplete="new-password" />' +
      '<button class="pw-eye" type="button" aria-pressed="false" aria-label="Tampilkan password" ' +
      'title="Tampilkan password" onclick="toggleLihatPassword(this)">' + ic('eye') + '</button></div>' +
      '<p class="tiny muted mt-6">Minimal 6 karakter. Simpan baik-baik — Administrator dapat mengirimkannya lewat WhatsApp bila lupa.</p></div>' +
    '<div class="form-group"><label for="daftarPass2">Ulangi Password</label>' +
      '<div class="pw-wrap"><input type="password" id="daftarPass2" class="form-control" autocomplete="new-password" />' +
      '<button class="pw-eye" type="button" aria-pressed="false" aria-label="Tampilkan password" ' +
      'title="Tampilkan password" onclick="toggleLihatPassword(this)">' + ic('eye') + '</button></div></div>' +
    '<button class="btn btn-primary" type="button" id="btnDaftarSimpan" onclick="submitDaftar()">' +
      ic('seal') + 'Daftar &amp; Aktifkan Akun</button>' +
    '<p class="tiny muted mt-10 center">' +
      '<button class="linklike" type="button" onclick="kembaliKeLangkah1()">Ganti nomor HP/WA</button></p>';
  setTimeout(() => { const n = $('daftarNama'); if (n) { try { n.focus(); } catch (e) {} } }, 120);
}

function kembaliKeLangkah1() {
  _daftarPengguna = null;
  setDaftarLangkah(1);
  setDaftarInfo('');
  const el = $('daftarHp');
  if (el) { el.value = ''; setTimeout(() => { try { el.focus(); } catch (e) {} }, 60); }
}

async function submitDaftar() {
  if (!_daftarPengguna) { setDaftarInfo('Silakan periksa nomor HP/WA terlebih dahulu.', 'err'); return; }
  const btn = $('btnDaftarSimpan');
  if (btn) { btn.disabled = true; btn.textContent = 'Menyimpan…'; }

  try {
    /* Periksa ulang dari state: sementara formulir terbuka, akun bisa saja
       sudah didaftarkan lewat sinkron dari perangkat lain. */
    const u = (state.users || []).find(x => String(x.id) === String(_daftarPengguna.id)) || _daftarPengguna;
    if (sudahTerdaftar(u)) {
      setDaftarInfo('<strong>Nomor ini sudah terdaftar.</strong> Pendaftaran hanya dapat ' +
        'dilakukan sekali — silakan masuk memakai username &amp; password Anda.', 'err');
      setDaftarLangkah(1);
      return;
    }

    /* Daring: pastikan server juga menyatakan nomor ini belum terdaftar.
       Ini menjaga aturan "satu nomor = satu pendaftaran" ketika dua orang
       membuka layar Daftar dari perangkat berbeda. */
    if (apiReady() && isOnline() && typeof supaCariUserByHp === 'function') {
      try {
        const server = await supaCariUserByHp(normalisasiHp(u.hpPlain));
        if (server && server.terdaftarAt) {
          setDaftarInfo('<strong>Nomor ini sudah terdaftar.</strong> Nomor tersebut telah ' +
            'didaftarkan sejak ' + esc(fmtDate(server.terdaftarAt)) +
            '. Pendaftaran hanya dapat dilakukan sekali.', 'err');
          setDaftarLangkah(1);
          return;
        }
      } catch (e) {
        console.warn('[Daftar] verifikasi server gagal — lanjutkan secara lokal:', e);
      }
    }

    const nama = String(($('daftarNama') || {}).value || '').trim();
    const username = String(($('daftarUser') || {}).value || '').trim().toLowerCase();
    const pass = String(($('daftarPass') || {}).value || '');
    const pass2 = String(($('daftarPass2') || {}).value || '');

    if (!nama) { setDaftarInfo('Nama lengkap belum diisi.', 'err'); return; }
    if (username.length < 3) { setDaftarInfo('Username minimal 3 huruf/angka.', 'err'); return; }
    if (!/^[a-z0-9._-]+$/.test(username)) {
      setDaftarInfo('Username hanya boleh huruf kecil, angka, titik, garis, atau garis bawah.', 'err');
      return;
    }
    const dipakai = (state.users || []).some(x =>
      String(x.id) !== String(u.id) && String(x.username || '').toLowerCase() === username);
    if (dipakai) {
      setDaftarInfo('Username <strong>' + esc(username) + '</strong> sudah dipakai akun lain. Pilih yang lain.', 'err');
      return;
    }
    if (pass.length < 8) { setDaftarInfo('Password minimal 8 karakter.', 'err'); return; }
    if (pass !== pass2) { setDaftarInfo('Ulangi password tidak sama.', 'err'); return; }
    if (pass.toLowerCase() === username) {
      setDaftarInfo('Password tidak boleh sama dengan username.', 'err'); return;
    }

    /* UPDATE OTOMATIS baris users yang sudah ada — tidak membuat akun baru,
       tidak mengubah nomor dan peran, hanya mengaktifkan akun miliknya. */
    const now = new Date().toISOString();
    u.nama = nama;
    u.username = username;
    u.passHash = await sha256(pass);
    u.passPlain = pass;
    u.status = 'aktif';
    u.terdaftarAt = now;
    stamp(u);
    saveLocal();
    enqueue('user', u);
    addLog('REGISTER_SELF', {
      userId: u.id, username: u.username, role: u.role,
      hp: hpTampil(u.hpPlain), nama: u.nama
    });

    _daftarPengguna = u;
    const s1 = $('daftarStep1'), s2 = $('daftarStep2');
    if (s1) s1.classList.add('hidden');
    if (s2) s2.classList.add('hidden');
    setDaftarInfo(
      '<strong>Selamat, ' + esc(nama) + '!</strong> Akun Anda aktif dengan peran ' +
      esc(roleName(u.role)) + '.<br>Nomor <strong>' + esc(hpTampil(u.hpPlain)) + '</strong> ' +
      'sudah terdaftar dan tidak dapat didaftarkan lagi.<br>Username: <strong>' +
      esc(username) + '</strong>' +
      (isOnline() ? '' : '<br><span class="tiny muted">Perangkat sedang luring — akun tetap ' +
        'tersimpan dan akan dikirim ke server otomatis begitu ada koneksi.</span>') +
      '<div class="center mt-10">' +
      '<button class="btn btn-primary btn-sm" type="button" onclick="tutupDaftar()">' +
      ic('keycross') + 'Kembali ke Halaman Login</button></div>', 'ok');
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = ic('seal') + 'Daftar &amp; Aktifkan Akun'; }
  }
}

/* ---------- 20e. INPUT NOMOR & PERAN — MULTIPLE CREATE (ADMIN) ---------
   Administrator mencatat nomor HP/WA + peran untuk BANYAK orang sekaligus.
   Baris yang tercatat inilah satu-satunya nomor yang boleh mendaftar lewat
   layar "Daftar". Akun hasil pencatatan ini belum punya password: orangnya
   yang mengisinya sendiri saat mendaftar (pass_hash masih kosong).
   -------------------------------------------------------------------- */
let _bulkRencana = [];

/* Satu baris daftar: { no, aksi, ket, cek, nomor, nama, role, status, user } */
function parseBulkHp(teks, roleBawaan, statusBawaan) {
  const hasil = [];
  const seen = new Set();

  String(teks || '').split(/\r?\n/).forEach((mentah, i) => {
    const isi = mentah.trim();
    if (!isi || isi.charAt(0) === '#') return;          /* kosong / komentar */
    const potong = isi.split(/[;,\t|]+/).map(s => s.trim()).filter(Boolean);
    if (!potong.length) return;

    const cek = periksaNomorHp(potong[0]);
    if (!cek.ok) {
      hasil.push({ no: hasil.length + 1, aksi: 'gagal', ket: cek.pesan,
        nomor: potong[0], nama: '', role: roleBawaan });
      return;
    }
    if (seen.has(cek.angka)) {
      hasil.push({ no: hasil.length + 1, aksi: 'gagal', nomor: cek.lokal, nama: '',
        role: roleBawaan, ket: 'Nomor dobel di dalam daftar ini.' });
      return;
    }
    seen.add(cek.angka);

    /* Nama = sisa kolom; peran boleh ditulis di kolom terakhir */
    let nama = potong.slice(1).join(' ');
    let role = roleBawaan;
    const cocokPeran = nama.match(/^(.*?)\s*[-–—|]?\s*\b(admin|pengurus|peserta)\b\s*$/i);
    if (cocokPeran) {
      nama = cocokPeran[1];
      role = String(cocokPeran[2]).toLowerCase();
    }
    if (['admin', 'pengurus', 'peserta'].indexOf(role) === -1) role = roleBawaan;

    const ada = cariUserByHp(cek.angka);
    hasil.push({
      no: hasil.length + 1, aksi: ada ? 'perbarui' : 'baru', cek: cek,
      nomor: cek.lokal, nama: nama.trim(), role: role, status: statusBawaan, user: ada || null,
      ket: ada
        ? (sudahTerdaftar(ada)
          ? 'Nomor sudah terdaftar — peran/nama diperbarui, pendaftaran tetap tertutup.'
          : 'Nomor sudah tercatat — peran/nama diperbarui.')
        : ''
    });
  });
  return hasil;
}

function periksaBulkHp() {
  if (!isAdmin()) { toast('Hanya Administrator yang dapat menginput nomor & peran', 'error'); return; }
  const roleBawaan = ($('bulkRole') || {}).value || 'peserta';
  const statusBawaan = ($('bulkStatus') || {}).value || 'nonaktif';
  const hasil = parseBulkHp(($('bulkHp') || {}).value, roleBawaan, statusBawaan);

  _bulkRencana = hasil;
  const body = $('bulkPratinjau');
  const btn = $('btnBulkSimpan');
  if (btn) btn.disabled = !hasil.length;

  const baru = hasil.filter(x => x.aksi === 'baru').length;
  const perbarui = hasil.filter(x => x.aksi === 'perbarui').length;
  const gagal = hasil.filter(x => x.aksi === 'gagal').length;
  setText('bulkRingkasan', hasil.length
    ? 'Siap disimpan: ' + baru + ' nomor baru, ' + perbarui + ' diperbarui, ' + gagal + ' gagal.'
    : 'Belum ada daftar yang diperiksa — tempel minimal satu baris.');

  if (!body) return;
  if (!hasil.length) {
    body.innerHTML = '<tr><td colspan="5"><div class="empty">' + ic('compass', 'ic-lg') +
      '<div>Daftar kosong</div></div></td></tr>';
    return;
  }
  body.innerHTML = hasil.map(x => {
    if (x.aksi === 'gagal') {
      return '<tr><td data-label="No">' + x.no + '</td>' +
        '<td data-label="Nomor">' + esc(x.nomor || '-') + '</td>' +
        '<td data-label="Nama">-</td><td data-label="Peran">-</td>' +
        '<td data-label="Keterangan"><span class="badge badge-nonaktif">gagal</span> ' +
        esc(x.ket) + '</td></tr>';
    }
    const badge = x.aksi === 'baru' ? 'badge-aktif">baru' : 'badge-izin">perbarui';
    const peranLama = x.user ? ' · sebelumnya ' + esc(roleName(x.user.role)) : '';
    const namaTampil = x.nama || (x.user && x.user.nama) || '-';
    return '<tr><td data-label="No">' + x.no + '</td>' +
      '<td data-label="Nomor"><strong>' + esc(x.nomor) + '</strong></td>' +
      '<td data-label="Nama">' + esc(namaTampil) + '</td>' +
      '<td data-label="Peran">' + esc(roleName(x.role)) + peranLama + '</td>' +
      '<td data-label="Keterangan"><span class="badge ' + badge + '</span> ' +
      (x.ket || 'siap disimpan') + '</td></tr>';
  }).join('');
}

async function simpanBulkHp() {
  if (!isAdmin()) { toast('Hanya Administrator yang dapat menginput nomor & peran', 'error'); return; }
  const rencana = (_bulkRencana || []).filter(x => x.aksi !== 'gagal');
  if (!rencana.length) { toast('Tidak ada baris yang siap disimpan — tekan Periksa Daftar dahulu', 'error'); return; }
  if (state.users.length + rencana.filter(x => x.aksi === 'baru').length > CONFIG.MAX_USERS) {
    toast('Batas ' + CONFIG.MAX_USERS + ' pengguna akan terlampaui', 'error');
    return;
  }

  const btn = $('btnBulkSimpan');
  if (btn) { btn.disabled = true; btn.textContent = 'Menyimpan…'; }
  const now = new Date().toISOString();
  let baru = 0, perbarui = 0, dilewati = 0;

  try {
    for (const x of rencana) {
      const target = x.user || cariUserByHp(x.cek.angka);
      if (x.aksi === 'perbarui' && target) {
        /* Nomor sudah tercatat → perbarui peran & nama SAJA. Username,
           password, dan terdaftar_at milik pemilik akun tidak disentuh. */
        if (x.role && target.role !== x.role) target.role = x.role;
        if (x.nama && !sudahTerdaftar(target)) target.nama = x.nama;
        stamp(target);
        saveLocal();
        enqueue('user', target);
        addLog('UPDATE_MEMBER', { userId: target.id, hp: x.nomor, role: target.role });
        perbarui++;
        continue;
      }
      if (sudahTerdaftar(target)) { dilewati++; continue; }

      const nama = x.nama || ('Peserta ' + x.nomor.slice(-4));
      const u = {
        id: uid(), nama: nama,
        username: placeholderUsername(x.cek.angka),   /* sementara, diganti saat mendaftar */
        passHash: null, passPlain: null,
        hpHash: await sha256(x.nomor), hpPlain: x.nomor,
        role: x.role, status: x.status, email: '',
        terdaftarAt: null,
        createdAt: now, updatedAt: now
      };
      state.users.push(u);
      saveLocal();
      enqueue('user', u);
      addLog('CREATE_MEMBER', { userId: u.id, hp: x.nomor, role: u.role, nama: nama });
      baru++;
    }

    const el = $('bulkHp');
    if (el) el.value = '';
    _bulkRencana = [];
    renderMemberList();
    renderUsers();
    setText('bulkRingkasan', 'Tersimpan: ' + baru + ' nomor baru, ' + perbarui + ' diperbarui' +
      (dilewati ? ', ' + dilewati + ' dilewati (sudah terdaftar)' : '') + '.');
    const body = $('bulkPratinjau');
    if (body) {
      body.innerHTML = '<tr><td colspan="5"><div class="empty">' + ic('seal', 'ic-lg') +
        '<div>Daftar sudah disimpan. Peserta dapat mendaftar dengan nomornya masing-masing.</div></div></td></tr>';
    }
    toast(baru + ' nomor tercatat, ' + perbarui + ' diperbarui', 'success');
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = ic('seal') + 'Simpan Semua'; }
  }
}

/* Daftar semua nomor tercatat + status pendaftaran */
function renderMemberList() {
  const body = $('memberBody');
  if (!body) return;
  const q = String(($('memberSearch') || {}).value || '').trim().toLowerCase();
  const hanyaBelum = !!($('memberBelum') || {}).checked;
  const semua = (state.users || []).filter(u => normalisasiHp(u.hpPlain));

  const list = semua.filter(u => {
    if (hanyaBelum && sudahTerdaftar(u)) return false;
    if (!q) return true;
    return String(normalisasiHp(u.hpPlain)).indexOf(normalisasiHp(q)) !== -1 ||
      String(u.nama || '').toLowerCase().indexOf(q) !== -1 ||
      String(roleName(u.role) || '').toLowerCase().indexOf(q) !== -1 ||
      String(u.username || '').toLowerCase().indexOf(q) !== -1;
  }).sort((a, b) => String(hpTampil(a.hpPlain)).localeCompare(String(hpTampil(b.hpPlain))));

  if (!semua.length) {
    body.innerHTML = '<tr><td colspan="5"><div class="empty">' + ic('halopair', 'ic-lg') +
      '<div>Belum ada nomor tercatat — tempel daftar di atas lalu tekan Periksa Daftar</div></div></td></tr>';
    return;
  }
  if (!list.length) {
    body.innerHTML = '<tr><td colspan="5"><div class="empty">' + ic('compass', 'ic-lg') +
      '<div>Tidak ada yang cocok dengan pencarian</div></div></td></tr>';
    return;
  }

  body.innerHTML = list.map(u => {
    const daftar = sudahTerdaftar(u);
    const badge = daftar ? 'badge-aktif">terdaftar' : 'badge-gold">belum mendaftar';
    return '<tr>' +
      '<td data-label="Nomor"><strong>' + esc(hpTampil(u.hpPlain)) + '</strong></td>' +
      '<td data-label="Nama">' + esc(u.nama || '-') +
        '<div class="tiny muted">@' + esc(u.username) + '</div></td>' +
      '<td data-label="Peran"><span class="badge badge-role">' + esc(roleName(u.role)) + '</span></td>' +
      '<td data-label="Pendaftaran"><span class="badge ' + badge + '</span>' +
        (daftar ? '<div class="tiny muted">' + esc(fmtDate(u.terdaftarAt)) + '</div>' : '') + '</td>' +
      '<td data-label="Tindakan"><div class="row-tight">' +
        '<button class="btn btn-outline btn-sm" type="button" data-mact="role" data-id="' + esc(u.id) + '">' +
        ic('quill') + 'Ubah Peran</button>' +
        '<button class="btn btn-outline btn-sm" type="button" data-mact="hapus" data-id="' + esc(u.id) + '">' +
        ic('scrap') + 'Hapus</button>' +
      '</div></td></tr>';
  }).join('');

  try {
    body.querySelectorAll('button[data-mact]').forEach(b => {
      b.addEventListener('click', () => {
        const id = b.getAttribute('data-id');
        if (b.getAttribute('data-mact') === 'role') ubahPeranMember(id);
        else hapusNomorMember(id);
      });
    });
  } catch (e) {}
}

/* Ubah peran satu nomor tercatat (Admin) */
function ubahPeranMember(id) {
  if (!isAdmin()) { toast('Hanya Administrator', 'error'); return; }
  const u = (state.users || []).find(x => String(x.id) === String(id));
  if (!u) return;
  showModal('Ubah Peran',
    '<p>Peran untuk <strong>' + esc(u.nama || u.username) + '</strong> — ' +
    esc(hpTampil(u.hpPlain)) + '</p>' +
    '<div class="form-group"><label for="mRole">Peran</label>' +
    '<select id="mRole" class="form-control">' +
      ['peserta', 'pengurus', 'admin'].map(r =>
        '<option value="' + r + '"' + (u.role === r ? ' selected' : '') + '>' +
        esc(roleName(r)) + '</option>').join('') +
    '</select></div>' +
    '<div class="modal-actions"><button class="btn btn-ghost" onclick="closeModal()">Batal</button>' +
    '<button class="btn btn-primary" onclick="simpanPeranMember(\'' + esc(u.id) + '\')">' +
    ic('seal') + 'Simpan</button></div>',
    { icon: 'quill' });
}

function simpanPeranMember(id) {
  if (!isAdmin()) { toast('Hanya Administrator', 'error'); return; }
  const u = (state.users || []).find(x => String(x.id) === String(id));
  if (!u) { closeModal(); return; }
  const role = ($('mRole') || {}).value || u.role;
  if (role !== u.role) {
    u.role = role;
    stamp(u);
    saveLocal();
    enqueue('user', u);
    addLog('UPDATE_MEMBER', { userId: u.id, hp: hpTampil(u.hpPlain), role: role });
  }
  closeModal();
  renderMemberList();
  renderUsers();
  toast('Peran diperbarui: ' + roleName(role), 'success');
}

/* Hapus nomor tercatat: akun BELUM mendaftar → akun dihapus; akun SUDAH
   terdaftar → hanya nomornya dilepas, akun & riwayat presensi tetap utuh. */
function hapusNomorMember(id) {
  if (!isAdmin()) { toast('Hanya Administrator', 'error'); return; }
  const u = (state.users || []).find(x => String(x.id) === String(id));
  if (!u) return;
  const pesan = sudahTerdaftar(u)
    ? 'Lepas nomor ' + hpTampil(u.hpPlain) + ' dari akun <strong>' + esc(u.nama) +
      '</strong>? Akun dan riwayat presensinya tetap ada, tetapi nomor tersebut menjadi tidak bisa mendaftar lagi.'
    : 'Hapus akun <strong>' + esc(u.nama) + '</strong> (' + hpTampil(u.hpPlain) +
      ')? Akun ini belum pernah mendaftar, jadi tidak ada data yang hilang.';
  showModal('Hapus Nomor Tercatat',
    '<p>' + pesan + '</p>' +
    '<div class="modal-actions"><button class="btn btn-ghost" onclick="closeModal()">Batal</button>' +
    '<button class="btn btn-danger" onclick="konfirmasiHapusNomor(\'' + esc(u.id) + '\')">' +
    ic('scrap') + 'Ya, lanjutkan</button></div>',
    { icon: 'scrap', tone: 'danger' });
}

function konfirmasiHapusNomor(id) {
  if (!isAdmin()) { toast('Hanya Administrator', 'error'); return; }
  const idx = (state.users || []).findIndex(x => String(x.id) === String(id));
  if (idx < 0) { closeModal(); return; }
  const u = state.users[idx];
  const sudahPakai = sudahTerdaftar(u);
  if (sudahPakai) {
    u.hpPlain = null;
    u.hpHash = null;
    stamp(u);
    saveLocal();
    enqueue('user', u);
    addLog('DETACH_MEMBER_HP', { userId: u.id, username: u.username });
  } else {
    state.users.splice(idx, 1);
    saveLocal();
    queueDelete('users', u.id);
    addLog('DELETE_USER', { userId: u.id, username: u.username, dari: 'daftar nomor' });
  }
  closeModal();
  renderMemberList();
  renderUsers();
  toast(sudahPakai ? 'Nomor dilepas dari akun' : 'Akun dihapus', 'success');
}

function showForgotPassword() {
  showModal('Lupa Password?',
    '<p class="small">Tidak apa-apa — semuanya bisa dibantu. Masukkan <strong>nomor HP/WA</strong> ' +
    'yang terdaftar pada akun Anda, lalu kirim permintaan.</p>' +
    '<div class="form-group mt-10"><label for="lupaHp">Nomor HP / WhatsApp</label>' +
    '<input type="tel" id="lupaHp" class="form-control" placeholder="08xxxxxxxxxx" ' +
    'autocomplete="tel" inputmode="tel" /></div>' +
    '<p class="tiny muted">Administrator yang sedang masuk akan menerima pemberitahuan di aplikasi ini, ' +
    'lalu menghubungi Anda lewat WhatsApp dengan password Anda.</p>' +
    '<div class="modal-actions"><button class="btn btn-ghost" onclick="closeModal()">Batal</button>' +
    '<button class="btn btn-primary" id="btnLupaKirim" onclick="kirimPermintaanLupa()">' +
    ic('keyring') + 'Kirim Permintaan</button></div>',
    { icon: 'keycross' });
  setTimeout(() => { const el = $('lupaHp'); if (el) el.focus(); }, 120);
}

async function kirimPermintaanLupa() {
  const input = $('lupaHp');
  const hp = normalisasiHp(input ? input.value : '');
  if (hp.length < 8) { toast('Masukkan nomor HP/WA yang terdaftar (minimal 8 angka)', 'error'); return; }

  const btn = $('btnLupaKirim');
  if (btn) { btn.disabled = true; btn.textContent = 'Mengirim…'; }
  try {
    const user = cariUserByHp(hp);
    if (!user) {
      toast('Nomor ini tidak terdaftar pada akun mana pun. Periksa kembali, atau hubungi Administrator.', 'error');
      return;
    }

    /* Jangan duplikat: tutup permintaan lama yang masih menunggu */
    state.requests = (state.requests || []).filter(r =>
      !(String(r.userId) === String(user.id) && r.status === 'menunggu'));

    const now = new Date().toISOString();
    const req = {
      id: uid(),
      userId: user.id,
      nama: user.nama,
      username: user.username,
      role: user.role,
      hp: user.hpPlain || String(input.value).trim(),
      status: 'menunggu',
      ts: now,
      updatedAt: now
    };
    state.requests.push(req);
    saveLocal();
    enqueue('request', req);

    /* Catatan agar Administrator melihatnya pada Log & Aktivitas Terbaru */
    addLog('RESET_REQUEST', { nama: user.nama, username: user.username, hp: req.hp });
    flushQueue();

    showModal('Permintaan Terkirim',
      '<div class="list-item">' + ic('keyring') + '<div class="body">' +
      '<strong>Terima kasih, ' + esc(user.nama) + '.</strong>' +
      '<div class="meta">Permintaan Anda sudah diteruskan ke Administrator.</div>' +
      '<div class="meta">Administrator akan menghubungi Anda melalui WhatsApp di nomor ' +
      esc(req.hp) + ' — mohon ditunggu, ya.</div>' +
      '</div></div>' +
      (isOnline() ? '' : '<p class="tiny muted mt-6">Perangkat sedang luring — permintaan akan ' +
        'terkirim otomatis begitu ada koneksi.</p>') +
      '<div class="modal-actions"><button class="btn btn-primary" onclick="closeModal()">' +
      ic('seal') + 'Siap, Saya Tunggu</button></div>',
      { icon: 'keyring', tone: 'success' });
    if (btn) { btn.disabled = false; }
  } catch (e) {
    toast('Permintaan gagal dikirim — coba lagi', 'error');
    if (btn) btn.disabled = false;
  }
}

/* ---------- 11d. PENANGANAN PERMINTAAN (HANYA ADMIN) -------------------- */
function pendingResetRequests() {
  return (state.requests || [])
    .filter(r => r.status === 'menunggu')
    .sort((a, b) => (Date.parse(b.ts || b.updatedAt || 0) || 0) - (Date.parse(a.ts || a.updatedAt || 0) || 0));
}

/* Pemberitahuan saat permintaan baru masuk (dipanggil setelah sinkronisasi) */
function notifyNewResetRequests() {
  if (!isAdmin()) return;
  const pending = pendingResetRequests();
  const pernah = new Set((state.pendingRequestIds || []).map(String));
  const baru = pending.filter(r => !pernah.has(String(r.id)));
  state.pendingRequestIds = pending.map(r => String(r.id));
  if (pernah.size && baru.length) {
    toast(baru.length + ' permintaan lupa password baru — cek Beranda atau menu Data Peserta', 'info');
    if (state.activePage === 'users') renderResetRequests();
  }
}

/* Kartu permintaan pada Beranda Administrator */
function resetRequestCard() {
  if (!isAdmin()) return '';
  const pending = pendingResetRequests();
  if (!pending.length) return '';
  return cardWrap('keyring', 'Permintaan Lupa Password (' + pending.length + ')',
    '<div class="list">' + pending.slice(0, 5).map(r => `
      <div class="list-item">
        ${ic('keyring')}
        <div class="body">
          <strong>${esc(r.nama || r.username || '-')}</strong>
          <div class="meta">@${esc(r.username || '-')} · ${esc(roleName(r.role))} · ${esc(r.hp || 'tanpa nomor')}</div>
          <div class="meta">diminta ${fmtDateTime(r.ts || r.updatedAt)}</div>
          <div class="row-tight mt-6">
            <button class="btn btn-gold btn-sm" type="button" onclick="bukaWaPermintaan('${esc(r.id)}')">
              ${ic('wa')}Hubungi via WhatsApp
            </button>
            <button class="btn btn-outline btn-sm" type="button" onclick="tandaiRequestSelesai('${esc(r.id)}')">
              ${ic('seal')}Selesai
            </button>
          </div>
        </div>
      </div>`).join('') + '</div>' +
    '<p class="tiny muted mt-10">Seluruh permintaan tersedia pada menu <strong>Lainnya → Data Peserta</strong>.</p>');
}

/* Daftar permintaan pada halaman Data Peserta (Administrator) */
function renderResetRequests() {
  const box = $('resetRequestList');
  if (!box) return;
  if (!isAdmin()) { box.innerHTML = ''; return; }

  const menunggu = pendingResetRequests();
  const selesai = (state.requests || [])
    .filter(r => r.status !== 'menunggu')
    .sort((a, b) => (Date.parse(b.handledAt || b.updatedAt || 0) || 0) - (Date.parse(a.handledAt || a.updatedAt || 0) || 0))
    .slice(0, 10);

  if (!menunggu.length && !selesai.length) {
    box.innerHTML = '<div class="empty">' + ic('keyring', 'ic-lg') +
      '<div>Belum ada permintaan lupa password</div></div>';
    return;
  }

  box.innerHTML = (menunggu.length
    ? '<div class="list">' + menunggu.map(r => `
      <div class="list-item">
        ${ic('keyring')}
        <div class="body">
          <strong>${esc(r.nama || r.username || '-')}</strong> <span class="badge badge-izin">menunggu</span>
          <div class="meta">@${esc(r.username || '-')} · ${esc(roleName(r.role))} · ${esc(r.hp || 'tanpa nomor')}</div>
          <div class="meta">diminta ${fmtDateTime(r.ts || r.updatedAt)}</div>
          <div class="row-tight mt-6">
            <button class="btn btn-gold btn-sm" type="button" onclick="bukaWaPermintaan('${esc(r.id)}')">
              ${ic('wa')}Hubungi via WhatsApp
            </button>
            <button class="btn btn-outline btn-sm" type="button" onclick="tandaiRequestSelesai('${esc(r.id)}')">
              ${ic('seal')}Tandai Selesai
            </button>
            <button class="btn btn-ghost btn-sm" type="button" onclick="hapusRequest('${esc(r.id)}')">
              ${ic('scrap')}Hapus
            </button>
          </div>
        </div>
      </div>`).join('') + '</div>'
    : '') +
    (selesai.length
      ? '<p class="tiny muted mt-10">Riwayat terakhir:</p><div class="list">' + selesai.map(r => `
          <div class="list-item">
            ${ic('seal')}
            <div class="body">
              <strong>${esc(r.nama || r.username || '-')}</strong> <span class="badge badge-hadir">selesai</span>
              <div class="meta">@${esc(r.username || '-')} · ditindak ${fmtDateTime(r.handledAt || r.updatedAt)}</div>
              <div class="row-tight mt-6">
                <button class="btn btn-ghost btn-sm" type="button" onclick="hapusRequest('${esc(r.id)}')">
                  ${ic('scrap')}Hapus
                </button>
              </div>
            </div>
          </div>`).join('') + '</div>'
      : '');
}

/* Buka WhatsApp dengan pesan berisi password akun pemohon */
function bukaWaPermintaan(id) {
  if (!isAdmin()) { toast('Hanya Administrator', 'error'); return; }
  const r = (state.requests || []).find(x => String(x.id) === String(id));
  if (!r) { toast('Permintaan tidak ditemukan', 'error'); return; }
  if (!r.hp) { toast('Permintaan ini tidak memiliki nomor HP', 'error'); return; }

  const u = (state.users || []).find(x => String(x.id) === String(r.userId)) || null;
  const nama = (u && u.nama) || r.nama || '';
  const username = (u && u.username) || r.username || '';
  const pass = (u && u.passPlain) || '';

  let pesan;
  if (pass) {
    pesan = 'Halo ' + nama + ', mengenai permintaan lupa password Anda (@' + username + '), ' +
      'berikut password akun Presensi Ignasian Anda: ' + pass + '. ' +
      'Silakan masuk kembali, dan mohon dijaga kerahasiaannya. Terima kasih.';
  } else {
    pesan = 'Halo ' + nama + ', mengenai permintaan lupa password Anda (@' + username + '), ' +
      'mohon maaf password akun tidak tersimpan pada aplikasi. ' +
      'Saya akan membantu membuatkan password baru segera. Terima kasih.';
  }
  waTo(r.hp, pesan);
  if (!pass) {
    toast('Password akun belum tercatat — gunakan tombol Atur Ulang pada tabel Data Peserta', 'info');
  }
}

function tandaiRequestSelesai(id) {
  if (!isAdmin()) { toast('Hanya Administrator', 'error'); return; }
  const r = (state.requests || []).find(x => String(x.id) === String(id));
  if (!r) { toast('Permintaan tidak ditemukan', 'error'); return; }
  r.status = 'selesai';
  r.handledBy = state.currentUser ? state.currentUser.id : null;
  r.handledAt = new Date().toISOString();
  stamp(r);
  saveLocal();
  enqueue('request', r);
  addLog('REQUEST_DONE', { nama: r.nama, username: r.username });
  renderResetRequests();
  if (state.activePage === 'home') renderHome();
  toast('Permintaan ditandai selesai', 'success');
}

function hapusRequest(id) {
  if (!isAdmin()) { toast('Hanya Administrator', 'error'); return; }
  const idx = (state.requests || []).findIndex(x => String(x.id) === String(id));
  if (idx < 0) { toast('Permintaan tidak ditemukan', 'error'); return; }
  state.requests.splice(idx, 1);
  saveLocal();
  queueDelete('requests', id);
  addLog('DELETE_REQUEST', { requestId: id });
  renderResetRequests();
  if (state.activePage === 'home') renderHome();
  toast('Permintaan dihapus', 'success');
}

/* ---------- 21. PROFIL -------------------------------------------------- */
function loadProfil() {
  $('profilNama').value = state.currentUser.nama || '';
  $('profilEmail').value = state.currentUser.email || '';
  $('profilHP').value = state.currentUser.hpPlain || '••••••••';
  $('profilPeran').textContent = roleName(state.currentUser.role);
  $('profilUsername').textContent = '@' + state.currentUser.username;
  $('profilSejak').textContent = state.currentUser.createdAt ? fmtDate(state.currentUser.createdAt) : '-';
}

function saveProfil() {
  const nama = $('profilNama').value.trim();
  if (!nama) { toast('Nama tidak boleh kosong', 'error'); return; }
  state.currentUser.nama = nama;
  state.currentUser.email = $('profilEmail').value.trim();
  stamp(state.currentUser);

  const idx = state.users.findIndex(u => u.id === state.currentUser.id);
  if (idx >= 0) state.users[idx] = state.currentUser;

  saveLocal();
  enqueue('user', state.currentUser);
  addLog('UPDATE_PROFILE', {});
  renderUserChip();
  updateSyncUI();
  toast('Profil tersimpan', 'success');
}
/* ---------- 22. JADWAL & VENUE (ADMIN & PENGURUS) ---------------------- */
/* Tanggal & jam: dipilih pada kolom datetime, lalu DITEGASKAN dengan tombol
   OK (atau dibatalkan) — sehingga waktu yang tersimpan selalu sudah jelas
   bagi pembuat jadwal, bukan langsung terpakai begitu tanggal diketuk. */
function pilihJadwalTgl() {
  const el = $('jadwalTgl');
  if (!el) return;
  const box = $('jadwalTglConfirm');
  const fixed = $('jadwalTglFixed');
  if (fixed) fixed.classList.add('hidden');
  setJadwalTglOK(false);
  if (!el.value) { if (box) box.classList.add('hidden'); return; }
  const preview = $('jadwalTglPreview');
  if (preview) preview.textContent = 'Pilihan: ' + fmtDateTime(el.value);
  if (box) box.classList.remove('hidden');
}

function konfirmasiJadwalTgl() {
  const el = $('jadwalTgl');
  if (!el || !el.value) { toast('Pilih tanggal & waktu terlebih dahulu', 'error'); return; }
  const box = $('jadwalTglConfirm');
  const fixed = $('jadwalTglFixed');
  if (box) box.classList.add('hidden');
  if (fixed) {
    fixed.innerHTML = ic('check', 'ic-sm') + '<span>Terpilih: ' + esc(fmtDateTime(el.value)) + '</span>';
    fixed.classList.remove('hidden');
  }
  setJadwalTglOK(true);
  toast('Tanggal & waktu dikonfirmasi', 'success');
}

function batalJadwalTgl() {
  const el = $('jadwalTgl');
  if (el) el.value = '';
  ['jadwalTglConfirm', 'jadwalTglFixed'].forEach(id => {
    const n = $(id);
    if (n) n.classList.add('hidden');
  });
  setJadwalTglOK(false);
  toast('Pilihan tanggal & waktu dibatalkan');
}

function setJadwalTglOK(ok) {
  const el = $('jadwalTgl');
  if (el) el.setAttribute('data-ok', ok ? '1' : '0');
}

/* Tanggal & waktu sudah dipilih DAN ditegaskan dengan tombol OK? */
function jadwalTglSiap() {
  const el = $('jadwalTgl');
  return !!(el && el.value && el.getAttribute('data-ok') === '1');
}

/* Pemateri ke-2: hanya muncul bila kotak centang di samping kolom pemateri
   pertama dicentang (untuk acara dengan lebih dari satu pemateri). */
function togglePemateri2(checked) {
  const wrap = $('jadwalPemateri2Wrap');
  const inp = $('jadwalPemateri2');
  if (wrap) wrap.classList.toggle('hidden', !checked);
  if (inp) {
    if (checked) { try { inp.focus(); } catch (e) {} } else { inp.value = ''; }
  }
}

/* Nama pemateri (satu atau dua) sebagai satu kalimat untuk daftar, laporan,
   cetak, dan berkas CSV. */
function jadwalPemateriText(j) {
  if (!j) return '';
  return [j.pemateri, j.pemateri2]
    .map(v => String(v == null ? '' : v).trim())
    .filter(Boolean).join(' & ');
}

/* Kosongkan kembali formulir jadwal setelah tersimpan */
function resetJadwalForm() {
  ['jadwalNama', 'jadwalTgl', 'jadwalVenue', 'jadwalLat', 'jadwalLng',
    'jadwalPemateri', 'jadwalPemateri2'].forEach(id => {
    const el = $(id);
    if (el) el.value = '';
  });
  const cb = $('jadwalPemateri2Toggle');
  if (cb) cb.checked = false;
  const wrap = $('jadwalPemateri2Wrap');
  if (wrap) wrap.classList.add('hidden');
  ['jadwalTglConfirm', 'jadwalTglFixed'].forEach(id => {
    const n = $(id);
    if (n) n.classList.add('hidden');
  });
  setJadwalTglOK(false);
}

function saveJadwal() {
  if (!isStaff()) { toast('Hanya Administrator & Pengurus yang dapat membuat jadwal', 'error'); return; }

  const nama = $('jadwalNama').value.trim();
  const tgl = $('jadwalTgl').value;
  const venue = $('jadwalVenue').value.trim();
  const pemateri = $('jadwalPemateri') ? $('jadwalPemateri').value.trim() : '';
  const cbPemateri2 = $('jadwalPemateri2Toggle');
  const pemateri2 = (cbPemateri2 && cbPemateri2.checked && $('jadwalPemateri2'))
    ? $('jadwalPemateri2').value.trim() : '';
  const durasi = parseInt($('jadwalDurasi').value, 10) || 60;
  const radius = parseInt($('jadwalRadius').value, 10) || 50;
  const lat = parseFloat($('jadwalLat').value);
  const lng = parseFloat($('jadwalLng').value);

  if (!nama || !tgl || !venue || isNaN(lat) || isNaN(lng)) {
    toast('Lengkapi nama, waktu, venue, dan koordinat lokasi', 'error');
    return;
  }
  /* Tanggal & jam harus sudah ditegaskan lewat tombol OK pada kolomnya */
  if (!jadwalTglSiap()) {
    toast('Tekan OK pada kolom Tanggal & Waktu untuk menegaskan pilihan', 'error');
    return;
  }

  const now = new Date().toISOString();
  const j = {
    id: uid(), nama: nama, venue: venue, durasi: durasi, radius: radius,
    pemateri: pemateri, pemateri2: pemateri2,
    lat: lat, lng: lng,
    tanggal: new Date(tgl).toISOString(),
    createdAt: now, updatedAt: now,
    createdBy: state.currentUser.id
  };
  state.jadwal.push(j);
  saveLocal();
  enqueue('jadwal', j);
  addLog('CREATE_JADWAL', {
    jadwalId: j.id, nama: nama, venue: venue, pemateri: jadwalPemateriText(j)
  });
  toast('Jadwal tersimpan di perangkat', 'success');

  resetJadwalForm();
  renderJadwal();
}

function renderJadwal() {
  const list = $('jadwalList');
  if (!state.jadwal.length) {
    list.innerHTML = '<div class="empty">' + ic('horarium', 'ic-lg') + '<div>Belum ada jadwal acara</div></div>';
    return;
  }

  const sorted = state.jadwal.slice().sort((a, b) => new Date(b.tanggal) - new Date(a.tanggal));
  list.innerHTML = sorted.map(j => {
    const end = new Date(new Date(j.tanggal).getTime() + j.durasi * 60000);
    const active = end.getTime() > Date.now();
    const pemateri = jadwalPemateriText(j);
    const g = openGateInfo(j);
    const gateTeks = g.atur
      ? (g.terbuka ? 'gate terbuka' : 'gate ' + fmtTime(g.waktu))
      : 'gate belum diatur';
    return `
      <div class="entry ${active ? 'is-active' : 'is-done'}">
        <div class="entry-head">
          <div class="body">
            <div class="entry-title">${esc(j.nama)}</div>
            <div class="entry-meta">
              <span>${ic('compass', 'ic-sm')} ${esc(j.venue)}</span>
              ${pemateri ? `<span>${ic('quill', 'ic-sm')} Pemateri: ${esc(pemateri)}</span>` : ''}
              <span>${ic('horarium', 'ic-sm')} ${fmtDateTime(j.tanggal)}–${fmtTime(end)}</span>
              <span>radius ${esc(j.radius)} m · ${esc(j.durasi)} menit</span>
              <span>${ic('viewfinder', 'ic-sm')} ${gateTeks}</span>
            </div>
          </div>
          <span class="badge ${active ? 'badge-aktif' : 'badge-nonaktif'}">${active ? 'aktif' : 'selesai'}</span>
        </div>
        <div class="entry-actions">
          ${tombolOpenGate(j.id)}
          <button class="btn btn-outline btn-sm" onclick="ubahJadwal('${esc(j.id)}')">${ic('quill')}Ubah</button>
          <button class="btn btn-outline btn-sm" onclick="deleteJadwal('${esc(j.id)}')">${ic('scrap')}Hapus</button>
        </div>
      </div>`;
  }).join('');
}

/* Tombol OPEN-GATE pada kartu jadwal - hanya Administrator. */
function tombolOpenGate(id) {
  if (!isAdmin()) return '';
  return `<button class="btn btn-outline btn-sm" onclick="bukaOpenGate('${esc(id)}')">${ic('viewfinder')}OPEN-GATE</button>`;
}
function deleteJadwal(id) {
  if (!isStaff()) { toast('Hanya Administrator & Pengurus', 'error'); return; }
  const j = state.jadwal.find(x => x.id === id);
  if (!j) return;
  if (!confirm('Hapus jadwal ' + j.nama + '?')) return;
  state.jadwal = state.jadwal.filter(x => x.id !== id);
  saveLocal();
  queueDelete('jadwal', id);
  addLog('DELETE_JADWAL', { jadwalId: id, nama: j.nama });
  renderJadwal();
  toast('Jadwal dihapus', 'success');
}

/* UBAH JADWAL (ADMIN & PENGURUS) — dipakai untuk melengkap/koreksi nama acara,
   venue, dan terutama NAMA PEMATERI pada acara lama yang dibuat sebelum kolom
   pemateri ada. Waktu & koordinat sengaja tidak diubah di sini karena sudah
   terikat pada kode QR dan catatan presensi yang tercatat. */
function ubahJadwal(id) {
  if (!isStaff()) { toast('Hanya Administrator & Pengurus', 'error'); return; }
  const j = state.jadwal.find(x => String(x.id) === String(id));
  if (!j) { toast('Jadwal tidak ditemukan', 'error'); return; }
  showModal('Ubah Jadwal',
    '<p class="tiny muted">' + esc(fmtDateTime(j.tanggal)) + ' · ' + esc(j.venue || '-') + '</p>' +
    '<div class="form-group"><label for="ujNama">Nama Acara</label>' +
    '<input type="text" id="ujNama" class="form-control" value="' + esc(j.nama || '') + '" /></div>' +
    '<div class="form-group"><label for="ujVenue">Nama Lokasi / Sesi</label>' +
    '<input type="text" id="ujVenue" class="form-control" value="' + esc(j.venue || '') + '" /></div>' +
    '<div class="form-group"><div class="label-row">' +
    '<label for="ujPemateri">Pemateri / Pengisi Materi</label>' +
    '<label class="check-inline" for="ujPemateri2Toggle">' +
    '<input type="checkbox" id="ujPemateri2Toggle"' + (ada2 ? ' checked' : '') +
    ' onchange="toggleUbahPemateri2(this.checked)" /><span>Pemateri ke-2</span></label></div>' +
    '<input type="text" id="ujPemateri" class="form-control" value="' + esc(j.pemateri || '') + '" ' +
    'placeholder="Contoh: Romo Yohanes, SJ" />' +
    '<div class="field-extra' + (ada2 ? '' : ' hidden') + '" id="ujPemateri2Wrap">' +
    '<input type="text" id="ujPemateri2" class="form-control" value="' + esc(j.pemateri2 || '') + '" ' +
    'placeholder="Nama pemateri ke-2" /></div></div>' +
    '<div class="form-row"><div class="form-group"><label for="ujDurasi">Durasi (menit)</label>' +
    '<input type="number" id="ujDurasi" class="form-control" min="5" step="5" value="' +
    esc(j.durasi || 60) + '" /></div>' +
    '<div class="form-group"><label for="ujRadius">Radius Validasi (meter)</label>' +
    '<input type="number" id="ujRadius" class="form-control" min="10" step="5" value="' +
    esc(j.radius || 50) + '" /></div></div>' +
    gerbangUbahField(j) +
    '<p class="tiny muted">Waktu & koordinat acara tidak diubah di sini (sudah terikat pada QR dan ' +
    'presensi yang tercatat). Hapus & buat ulang bila salah.</p>' +
    '<div class="modal-actions"><button class="btn btn-ghost" onclick="closeModal()">Batal</button>' +
    '<button class="btn btn-primary" onclick="simpanUbahJadwal(\'' + esc(j.id) + '\')">' +
    ic('seal') + 'Simpan Perubahan</button></div>',
    { icon: 'quill' });
}

function toggleUbahPemateri2(checked) {
  const wrap = $('ujPemateri2Wrap');
  const inp = $('ujPemateri2');
  if (wrap) wrap.classList.toggle('hidden', !checked);
  if (inp && !checked) inp.value = '';
  if (inp && checked) { try { inp.focus(); } catch (e) {} }
}

/* Field OPEN-GATE pada modal Ubah Jadwal (hanya Administrator). */
function gerbangUbahField(j) {
  if (isAdmin()) {
    const nilai = waktuInputLokal(j.openGate);
    return '<div class="form-group"><label for="ujOpenGate">OPEN-GATE - Waktu Buka Presensi (QR)</label>' +
      '<input type="datetime-local" id="ujOpenGate" class="form-control" value="' + nilai + '" />' +
      '<p class="tiny muted mt-6">Peserta baru boleh memindai QR setelah waktu ini. Kosongkan bila presensi belum dibuka. ' +
      '<button type="button" class="linklike" onclick="ogDariSekarang()">Atur ke sekarang</button></p></div>';
  }
  return '<p class="tiny muted">OPEN-GATE hanya dapat diatur Administrator - minta Admin mengaturnya di menu ini.</p>';
}

function simpanUbahJadwal(id) {
  if (!isStaff()) { toast('Hanya Administrator & Pengurus', 'error'); return; }
  const j = state.jadwal.find(x => String(x.id) === String(id));
  if (!j) { toast('Jadwal tidak ditemukan', 'error'); return; }
  const nama = $('ujNama').value.trim();
  if (!nama) { toast('Nama acara tidak boleh kosong', 'error'); return; }
  j.nama = nama;
  j.venue = $('ujVenue') ? $('ujVenue').value.trim() : j.venue;
  j.pemateri = $('ujPemateri') ? $('ujPemateri').value.trim() : '';
  const cb = $('ujPemateri2Toggle');
  j.pemateri2 = (cb && cb.checked && $('ujPemateri2')) ? $('ujPemateri2').value.trim() : '';
  j.durasi = parseInt(($('ujDurasi') || {}).value, 10) || j.durasi || 60;
  j.radius = parseInt(($('ujRadius') || {}).value, 10) || j.radius || 50;
  if (isAdmin()) {
    const inpGate = $('ujOpenGate');
    const nilaiGate = inpGate ? String(inpGate.value || '').trim() : '';
    j.openGate = nilaiGate ? new Date(nilaiGate).toISOString() : null;
  }
  stamp(j);
  saveLocal();
  enqueue('jadwal', j);
  addLog('UPDATE_JADWAL', { jadwalId: j.id, nama: j.nama, pemateri: jadwalPemateriText(j) });
  closeModal();
  renderJadwal();
  renderLaporanAcaraSelect();
  if (state.activePage === 'laporan') renderLaporanAcara();
  toast('Jadwal diperbarui — nama pemateri langsung dipakai pada cetakan', 'success');
}

/* ---------- 22b. OPEN-GATE (HANYA ADMIN) --------------------------------
   Modal pengaturan gate pada menu Kelola Jadwal: tentukan jam peserta
   mulai boleh memindai QR, buka cepat sekarang, atau tutup kembali. */
let _ogId = '';

function bukaOpenGate(id) {
  if (!isAdmin()) { toast('Hanya Administrator yang dapat mengatur OPEN-GATE', 'error'); return; }
  const j = state.jadwal.find(x => String(x.id) === String(id));
  if (!j) { toast('Jadwal tidak ditemukan', 'error'); return; }
  const g = openGateInfo(j);
  _ogId = String(j.id);
  const status = !g.atur
    ? 'BELUM DIATUR - peserta belum dapat memindai QR.'
    : (g.terbuka ? 'TERBUKA sejak ' + fmtDateTime(g.waktu) + '.' : 'TERKUNCI - terbuka pada ' + fmtDateTime(g.waktu) + '.');
  showModal('OPEN-GATE - ' + j.nama,
    '<p class="tiny muted">Acara mulai ' + esc(fmtDateTime(j.tanggal)) + '. Contoh: acara 19.00, gate 18.30 - ' +
    'peserta baru boleh memindai QR setelah waktu gate terbuka.</p>' +
    '<div class="list-item">' + ic('viewfinder') + '<div class="body"><strong>' + esc(status) + '</strong></div></div>' +
    '<div class="form-group"><label for="ogWaktu">Waktu Buka Presensi</label>' +
    '<input type="datetime-local" id="ogWaktu" class="form-control" value="' + waktuInputLokal(j.openGate) + '" /></div>' +
    '<div class="modal-actions modal-actions-wrap">' +
    '<button class="btn btn-ghost" onclick="closeModal()">Batal</button>' +
    '<button class="btn btn-outline" onclick="ogDariSekarang()">Buka sekarang</button>' +
    '<button class="btn btn-outline" onclick="ogTutup()">Tutup Gate</button>' +
    '<button class="btn btn-primary" onclick="ogSimpan()">' + ic('seal') + 'Simpan</button>' +
    '</div>',
    { icon: 'viewfinder', tone: g.terbuka ? 'success' : 'warn' });
}

function ogDariSekarang() {
  const inp = $('ogWaktu') || $('ujOpenGate');
  if (!inp) return;
  inp.value = waktuInputLokal(new Date().toISOString());
  toast('Waktu gate diisi waktu sekarang - tekan Simpan untuk menyimpan', 'info');
}

function ogSimpan() {
  if (!isAdmin()) { toast('Hanya Administrator', 'error'); return; }
  const j = state.jadwal.find(x => String(x.id) === _ogId);
  if (!j) { toast('Jadwal tidak ditemukan', 'error'); return; }
  const inp = $('ogWaktu');
  const nilai = inp ? String(inp.value || '').trim() : '';
  if (!nilai) { toast('Isi waktu gate dahulu, atau pakai Tutup Gate', 'error'); return; }
  const ms = new Date(nilai).getTime();
  if (isNaN(ms)) { toast('Waktu gate tidak valid', 'error'); return; }
  j.openGate = new Date(ms).toISOString();
  stamp(j); saveLocal(); enqueue('jadwal', j);
  addLog('OPEN_GATE', { jadwalId: j.id, nama: j.nama, openGate: j.openGate });
  closeModal(); renderJadwal();
  toast('OPEN-GATE aktif pada ' + fmtDateTime(ms), 'success');
}

function ogTutup() {
  if (!isAdmin()) { toast('Hanya Administrator', 'error'); return; }
  const j = state.jadwal.find(x => String(x.id) === _ogId);
  if (!j) return;
  if (!j.openGate) { toast('Gate memang belum diatur', 'info'); closeModal(); return; }
  j.openGate = null;
  stamp(j); saveLocal(); enqueue('jadwal', j);
  addLog('OPEN_GATE', { jadwalId: j.id, nama: j.nama, openGate: null, aksi: 'tutup' });
  closeModal(); renderJadwal();
  toast('OPEN-GATE ditutup - peserta belum dapat memindai QR', 'success');
}

/* ---------- 23. PEMBUAT QR (ADMIN & PENGURUS) -------------------------- */
function renderQrJadwalSelect() {
  const sel = $('qrJadwal');
  if (!sel) return;
  if (!state.jadwal.length) {
    sel.innerHTML = '<option value="">Belum ada jadwal — buat dahulu di menu Jadwal</option>';
    return;
  }
  /* SEMUA jadwal tampil (termasuk yang akan datang) agar QR bisa dicetak
     sebelum acara. Jadwal yang sedang aktif diberi penanda. */
  const now = Date.now();
  const sorted = state.jadwal.slice().sort((a, b) => new Date(a.tanggal) - new Date(b.tanggal));
  sel.innerHTML = sorted
    .map(j => {
      const t = new Date(j.tanggal).getTime();
      const end = t + (j.durasi || 60) * 60000;
      const aktif = now >= t - 3600000 && now <= end + 3600000;
      const label = j.nama + ' — ' + fmtDateTime(j.tanggal) + (aktif ? ' ● AKTIF' : '');
      return `<option value="${esc(j.id)}">${esc(label)}</option>`;
    })
    .join('');
}

/* Tanda tangan kode QR — dibuat TETAP dari isi acara sehingga satu acara
   selalu menghasilkan kode QR yang sama, dan perubahan acara (waktu/lokasi)
   dapat terdeteksi ketika QR lama dipindai. */
function qrSignature(j) {
  return fallbackHash([String(j.id), String(j.tanggal), String(j.durasi),
    String(j.radius), String(j.lat), String(j.lng)].join('|')).slice(0, 10);
}

function qrPayload(j) {
  return {
    type: 'PRESENSI_IGNASIAN',
    v: 2,
    jadwalId: j.id,
    nama: j.nama,
    venue: j.venue,
    lat: j.lat,
    lng: j.lng,
    radius: j.radius,
    start: j.tanggal,
    durasi: j.durasi,
    sig: qrSignature(j)
  };
}

/* Isi teks QR versi 2 — ringkas (± 100 karakter) agar hasil cetak tidak terlalu
   padat dan tetap dapat dipindai dari jarak jauh, namun tetap mengikat QR
   pada satu acara tertentu. */
function qrText(j) {
  const p = qrPayload(j);
  const mulai = Date.parse(p.start) || 0;
  if (!p.jadwalId || !isFinite(mulai)) return '';
  return ['IGN1', p.jadwalId, mulai, Number(p.durasi) || 60, Number(p.radius) || 50,
    Number(p.lat).toFixed(6), Number(p.lng).toFixed(6), p.sig].join('|');
}

function generateQR() {
  if (!isStaff()) { toast('Hanya Administrator & Pengurus yang dapat membuat QR', 'error'); return; }

  const sel = $('qrJadwal');
  const id = sel ? sel.value : '';
  if (!id) { toast('Pilih jadwal terlebih dahulu', 'error'); return; }
  const j = state.jadwal.find(x => String(x.id) === String(id));
  if (!j) { toast('Jadwal tidak ditemukan', 'error'); return; }

  if (typeof QRCode === 'undefined') {
    toast('Pustaka QR belum termuat (peranti luring). Sambungkan sekali ke internet, lalu muat ulang.', 'error');
    return;
  }

  /* Isi QR versi 2 (ringkas) — format lama tetap didukung pemindai. */
  const qrData = qrText(j);
  if (!qrData) {
    toast('Data jadwal tidak dapat dikodekan — periksa kembali waktu & koordinat acara', 'error');
    return;
  }
  addLog('GENERATE_QR', { jadwalId: j.id, nama: j.nama });

  $('qrResult').innerHTML = `
    <div class="qr-box">
      <div id="qrCanvas" style="min-height:280px;display:flex;align-items:center;justify-content:center"></div>
      <h3 class="mt-14">${esc(j.nama)}</h3>
      <p class="small muted">${esc(j.venue)}<br>${fmtDateTime(j.tanggal)} · radius ${esc(j.radius)} m</p>
      <div class="btn-row mt-14">
        <button class="btn btn-gold btn-sm" onclick="downloadQR('${esc(j.nama)}')">${ic('descend')}Unduh</button>
        <button class="btn btn-outline btn-sm" onclick="printQR()">${ic('seal')}Cetak</button>
      </div>
    </div>`;

  const box = $('qrCanvas');
  box.innerHTML = '<p class="small muted">Membuat QR…</p>';

  /* Cabang 1 — pustaka node-qrcode (soldair): QRCode.toCanvas(canvas, text, ...) */
  if (QRCode && typeof QRCode.toCanvas === 'function') {
    const holder = document.createElement('canvas');
    try {
      /* 480 px — hasil unduh/cetak tetap tajam walau ditampilkan lebih kecil */
      QRCode.toCanvas(holder, qrData, {
        width: 480, margin: 2,
        color: { dark: '#6E2632', light: '#FAF7F2' }
      }, (err, canvas) => {
        if (err || !canvas) { toast('QR gagal dibuat', 'error'); box.innerHTML = ''; return; }
        canvas.id = 'qrFinalCanvas';
        canvas.style.width = '300px';
        canvas.style.height = '300px';
        box.innerHTML = '';
        box.appendChild(canvas);
      });
    } catch (e) {
      box.innerHTML = '';
      toast('QR gagal dibuat: ' + e.message, 'error');
    }
    return;
  }

  /* Cabang 2 — pustaka qrcodejs (davidshimjs, yang dipakai di index.html):
     new QRCode(el, {text,width,height,...}) — TIDAK punya .toCanvas */
  if (typeof QRCode === 'function') {
    try {
      box.innerHTML = '';
      new QRCode(box, {
        text: qrData,
        width: 480, height: 480,
        colorDark: '#6E2632', colorLight: '#FAF7F2',
        correctLevel: (QRCode.CorrectLevel ? QRCode.CorrectLevel.M : 0)
      });
      /* qrcodejs membuat <canvas> + <img> (async). Keduanya ditandai agar
         downloadQR()/printQR() dapat memakai salah satu. Tampilan ditahan
         300 px namun data piksel 480 px agar hasil cetak tetap tajam. */
      const tagCanvas = box.querySelector('canvas');
      if (tagCanvas) {
        tagCanvas.id = 'qrFinalCanvas';
        tagCanvas.style.width = '300px';
        tagCanvas.style.height = '300px';
      }
      const tagImg = box.querySelector('img');
      if (tagImg) {
        tagImg.id = 'qrFinalImg';
        tagImg.style.width = '300px';
        tagImg.style.height = '300px';
        /* Sebagian peramban menunda pengisian src — tunggu hingga terisi. */
        if (!tagImg.src && tagCanvas && typeof tagCanvas.toDataURL === 'function') {
          try { tagImg.src = tagCanvas.toDataURL('image/png'); } catch (e) { /* abaikan */ }
        }
      }
      /* Fallback tabel (mode lama qrcodejs tanpa canvas): beri id agar
         downloadQR bisa merendernya ke canvas. */
      const tagTable = box.querySelector('table');
      if (!tagCanvas && !tagImg && tagTable) tagTable.id = 'qrFallbackTable';
      if (!box.children.length) throw new Error('pustaka QR tidak merender apa pun');
    } catch (e) {
      box.innerHTML = '';
      toast('QR gagal dibuat: ' + e.message, 'error');
    }
    return;
  }

  box.innerHTML = '';
  toast('Pustaka QR tidak dikenali', 'error');
}

function qrImageSrc() {
  const canvas = $('qrFinalCanvas');
  if (canvas && canvas.tagName === 'CANVAS' && typeof canvas.toDataURL === 'function') {
    try { return canvas.toDataURL('image/png'); } catch (e) { /* lanjut ke img */ }
  }
  const img = $('qrFinalImg');
  if (img && img.src) return img.src;
  /* qrcodejs kadang hanya merender <img> tanpa id — ambil yang pertama. */
  const box = $('qrCanvas');
  if (box) {
    const anyImg = box.querySelector('img');
    if (anyImg && anyImg.src) return anyImg.src;
    const anyCanvas = box.querySelector('canvas');
    if (anyCanvas && typeof anyCanvas.toDataURL === 'function') {
      try { return anyCanvas.toDataURL('image/png'); } catch (e) { /* abaikan */ }
    }
  }
  return null;
}

function downloadQR(nama) {
  const src = qrImageSrc();
  if (!src) { toast('Belum ada QR untuk diunduh', 'error'); return; }
  const a = document.createElement('a');
  a.download = 'QR_' + String(nama || 'presensi').replace(/\s+/g, '_') + '.png';
  a.href = src;
  document.body.appendChild(a);
  a.click();
  a.remove();
  toast('QR diunduh', 'success');
}

function printQR() {
  const src = qrImageSrc();
  if (!src) { toast('Belum ada QR untuk dicetak', 'error'); return; }
  const w = window.open('', '', 'width=420,height=560');
  if (!w) { toast('Jendela cetak diblokir peramban', 'error'); return; }
  w.document.write(
    '<html><head><title>QR Presensi Ignasian</title></head>' +
    '<body style="text-align:center;font-family:Cinzel,Georgia,serif;padding:24px">' +
    '<h2 style="color:#6E2632;letter-spacing:.08em">PRESENSI IGNASIAN</h2>' +
    '<img src="' + src + '" style="width:300px"/>' +
    '<p style="font-family:Georgia,serif;font-size:13px;color:#5a4a3a">' +
    'Pindai kode ini untuk mencatat kehadiran. Ad Maiorem Dei Gloriam.</p>' +
    '</body></html>');
  w.document.close();
  setTimeout(() => w.print(), 350);
}

/* ---------- 24. CATATAN AKTIVITAS (HANYA ADMIN) ------------------------ */
function renderLog() {
  if (!isAdmin()) {
    const list = $('logList');
    if (list) list.innerHTML = '<div class="empty">' + ic('ledger', 'ic-lg') +
      '<div>Hanya Administrator yang dapat membuka log</div></div>';
    return;
  }
  const list = $('logList');
  const terurut = sortLogs(state.logs);       /* terbaru selalu di atas */
  if (!terurut.length) {
    list.innerHTML = '<div class="empty">' + ic('ledger', 'ic-lg') + '<div>Belum ada catatan aktivitas</div></div>';
    return;
  }
  const jumlah = terurut.length;
  list.innerHTML = '<p class="tiny muted mb-8">Menampilkan ' + Math.min(100, jumlah) +
    ' catatan terbaru dari ' + jumlah + ' catatan — urut terbaru di atas.</p>' +
    '<div class="list">' + terurut.slice(0, 100).map(l => `
    <div class="list-item">
      ${ic('ledger')}
      <div class="body">
        <strong>${esc(l.userName)}</strong> <span class="tiny muted">(${esc(roleName(l.userRole))})</span>
        <div>${esc(String(l.action).replace(/_/g, ' '))}
          ${l.details && l.details.username ? '<span class="muted">· @' + esc(l.details.username) + '</span>' : ''}
          ${l.details && l.details.nama ? '<span class="muted">· ' + esc(l.details.nama) + '</span>' : ''}
        </div>
        <div class="meta">${fmtDateTime(l.timestamp)}</div>
        <div class="row-tight mt-6">
          <button class="btn btn-danger btn-sm" type="button" onclick="deleteLog('${esc(l.id)}')">${ic('scrap')}Hapus</button>
        </div>
      </div>
    </div>`).join('') + '</div>';
}

/* Hapus satu catatan aktivitas — berlaku di perangkat DAN di server.
   Tanda kubur (tombstone) mencegah catatan kembali dari Supabase pada
   sinkronisasi berikutnya; operasi hapus ikut masuk antrean. */
function deleteLog(id) {
  if (!isAdmin()) { toast('Hanya Administrator yang dapat menghapus log', 'error'); return; }
  const idx = state.logs.findIndex(l => String(l.id) === String(id));
  if (idx < 0) { toast('Catatan tidak ditemukan — mungkin sudah dihapus', 'error'); return; }
  state.logs.splice(idx, 1);
  saveLocal();
  queueDelete('logs', id);
  renderLog();
  if (state.activePage === 'home') renderHome();
  toast('Catatan aktivitas dihapus dari perangkat ini dan antre untuk dihapus dari server', 'success');
}

function clearLogs(all) {
  if (!isAdmin()) { toast('Hanya Administrator yang dapat menghapus log', 'error'); return; }
  if (!state.logs.length) { toast('Log sudah kosong', 'info'); return; }
  const jumlah = state.logs.length;
  showModal('Hapus Log',
    '<p>Hapus <strong>seluruh ' + jumlah + ' catatan log</strong>?</p>' +
    '<p class="tiny muted">Catatan akan dihapus dari perangkat ini dan dari server ' +
    '(maksimal 200 catatan terbaru agar antrean sinkron tetap ringan), sehingga tidak kembali muncul.</p>' +
    '<div class="modal-actions"><button class="btn btn-ghost" onclick="closeModal()">Batal</button>' +
    '<button class="btn btn-danger" onclick="confirmClearLogs()">' + ic('scrap') + 'Hapus Semua</button></div>',
    { icon: 'ledger', tone: 'danger' });
}

function confirmClearLogs() {
  if (!isAdmin()) { toast('Hanya Administrator yang dapat menghapus log', 'error'); return; }
  if (!state.logs.length) { toast('Log sudah kosong', 'info'); return; }
  const total = state.logs.length;
  const dihapus = sortLogs(state.logs).slice(0, 200);     /* terbaru lebih dahulu */
  const idHapus = dihapus.map(l => l.id);
  const set = new Set(idHapus.map(String));
  state.logs = state.logs.filter(l => !set.has(String(l.id)));
  saveLocal();
  queueDeleteMany('logs', idHapus);   /* tanda kubur + operasi hapus ke server */
  closeModal();
  renderLog();
  if (state.activePage === 'home') renderHome();
  toast(dihapus.length + ' dari ' + total + ' catatan aktivitas dihapus', 'success');
}
/* ---------- 25. PENGATURAN -------------------------------------------- */
function setText(id, txt) { const el = $(id); if (el) el.textContent = txt; }

function renderSettingsSync() {
  /* Panel Sinkronisasi & Penyimpanan Luring bersifat khusus Administrator. */
  if (!isAdmin()) return;
  const on = isOnline();
  setText('setNet', on ? 'Daring — perangkat terhubung' : 'Luring — perangkat tanpa sambungan');
  setText('setDb', typeof supaStatusText === 'function'
    ? supaStatusText()
    : 'Basis data belum diatur');
  setText('setApi', apiReady()
    ? (state.apiHint ? 'Perlu perhatian: ' + state.apiHint : 'Supabase tersambung — sinkronisasi otomatis aktif')
    : 'Mode mandiri — isi SUPABASE_URL & SUPABASE_ANON_KEY pada js/config.js');
  setText('setQueue', state.outbox.length
    ? state.outbox.length + ' perubahan menunggu dikirim'
    : 'Tidak ada perubahan menunggu');
  /* Status tarik/kirim terpisah + saluran realtime — alat diagnosis utama
     bila satu peramban terlihat lebih lambat dari yang lain. */
  const tarik = state.meta.lastPull || state.meta.lastSync;
  const kirim = state.meta.lastPush || state.meta.lastSync;
  const rt = typeof supaRealtimeStatus === 'function' ? supaRealtimeStatus() : '—';
  setText('setLastSync',
    'Tarik: ' + (tarik ? fmtDateTime(tarik) : 'belum pernah') +
    ' · Kirim: ' + (kirim ? fmtDateTime(kirim) : 'belum pernah') +
    ' · Realtime: ' + rt);
  setText('setData', state.users.length + ' pengguna · ' + state.jadwal.length + ' jadwal · ' +
    state.presensi.length + ' presensi · ' + state.materi.length + ' materi · ' +
    state.dokumentasi.length + ' dokumentasi · ' + state.logs.length + ' catatan');

  /* Tombol sinkron manual sudah dihapus (mode cloud-first sepenuhnya
     otomatis), jadi tidak ada lagi tombol yang perlu diaktifkan/nonaktifkan
     di sini. */
}

/* Uji koneksi basis data — untuk memastikan deploy berhasil sebelum dipakai.
   Dibuka dari menu Pengaturan → "Uji Koneksi Database" (HANYA ADMIN). */
async function testSupabase() {
  if (!isAdmin()) { toast('Uji koneksi basis data hanya untuk Administrator', 'error'); return; }
  if (typeof supaDiagnose !== 'function') { toast('Lapisan data Supabase tidak termuat', 'error'); return; }
  showModal('Uji Koneksi Basis Data',
    '<p class="small muted">Memeriksa Supabase… mohon tunggu sejenak.</p>', { icon: 'dial' });
  let report;
  try {
    report = await supaDiagnose();
  } catch (e) {
    report = { ready: false, host: '', tables: [], ok: false, error: String((e && e.message) || e) };
  }

  let body = '<div class="list">' +
    '<div class="list-item">' + ic('compass') +
    '<div class="body"><strong>Alamat proyek</strong>' +
    '<div class="meta">' + esc(report.host || 'belum diatur pada js/config.js') + '</div></div></div>';

  const kurang = [];
  (report.tables || []).forEach(t => {
    body += '<div class="list-item">' + ic(t.ok ? 'seal' : 'scrap') +
      '<div class="body"><strong>Tabel ' + esc(t.name) + '</strong>' +
      '<div class="meta">' + (t.ok
        ? (t.count == null ? 'terbaca' : esc(String(t.count)) + ' baris')
        : esc(t.error || 'gagal dibaca')) +
      '</div></div></div>';
    (t.missing || []).forEach(c => { if (kurang.indexOf(c) === -1) kurang.push(c); });
  });
  body += '</div>';

  body += report.ok
    ? '<p class="small mt-14">Basis data siap dipakai: seluruh tabel & kolom terbaca dengan kunci anon. ' +
      'Presensi, jadwal, akun, materi, dan dokumentasi akan disinkronkan otomatis.</p>'
    : '<p class="small mt-14">' + esc(report.error || 'Sebagian tabel belum siap dipakai.') + '</p>';

  /* Penyebab paling umum "data hanya muncul di satu peramban": kolom baru
     (mis. pemateri) belum ada karena schema.sql belum dijalankan ulang. */
  if (kurang.length) {
    body += '<p class="small mt-6">Tindakan: jalankan ulang <strong>supabase/schema.sql</strong> pada ' +
      'SQL Editor Supabase, lalu tekan <strong>Uji Koneksi</strong> lagi. Selama skema belum diperbarui, ' +
      'kolom di atas dilewati saat sinkron (data lain tetap terkirim) dan kolom itu akan ikut tersinkron ' +
      'otomatis begitu skema diperbarui.</p>';
  }

  body += '<div class="modal-actions">' +
    '<button class="btn btn-primary" onclick="closeModal()">' + ic('seal') + 'Tutup</button></div>';
  showModal('Uji Koneksi Basis Data', body, { icon: 'dial', tone: report.ok ? 'success' : 'warn' });
}

/* Tidak lagi punya tombol di antarmuka (mode cloud-first otomatis), tetapi
   tetap dipakai bila perlu memuat ulang data perangkat secara programatik. */
async function reloadLocalData() {
  if (!isAdmin()) { toast('Panel Penyimpanan Luring hanya untuk Administrator', 'error'); return; }
  await loadLocal();
  if (state.currentUser) {
    const fresh = state.users.find(u => u.id === state.currentUser.id);
    if (fresh) state.currentUser = fresh;
  }
  applyRoleVisibility();
  renderActivePage();
  updateSyncUI();
  toast('Data perangkat dimuat ulang', 'success');
}

/* ---------- 26. MENU LAINNYA ------------------------------------------ */
function renderLainnya() {
  const u = state.currentUser;
  setText('lainnyaWho', u.nama + ' · ' + roleName(u.role) + ' (@' + u.username + ')');
  const note = $('lainnyaRoleNote');
  if (note) {
    note.textContent = isStaff()
      ? 'Sebagai ' + roleName(u.role) + ' Anda dapat membuat jadwal & kode QR.' +
        (u.role === 'admin' ? ' Sebagai Administrator Anda juga membuka catatan aktivitas & mengelola presensi.' : '')
      : 'Sebagai Peserta Anda memindai QR venue, melihat riwayat, dan mengelola profil pribadi.';
  }
  /* Segarkan penanda tombol ukuran tulisan (pilihan tersimpan di perangkat) */
  applyFontSize(_fontSizeCache || 'normal', false);
}

/* ---------- 26b. MATERI & DOKUMENTASI (BERKAS GOOGLE DRIVE) ---------------
   Kedua submenu ini terlihat untuk SEMUA PERAN; hanya Administrator &
   Pengurus (data-role="staff") yang dapat menambah/menghapus.

   Cara kerja penyimpanan (pilihan: Google Drive — Tautan):
   • Aplikasi HANYA menyimpan metadata + TAUTAN Google Drive di tabel
     Supabase (materi/dokumentasi) — berkasnya tetap berada di kuota
     Google Drive (15 GB), tanpa OAuth dan tanpa backend tambahan.
   • Alur Admin/Pengurus:
       1. Upload file/foto ke folder Drive bersama, lalu Bagikan dengan hak
          "Siapa saja yang punya link dapat melihat".
       2. Salin tautan file (atau folder) → tempel pada Tambah Materi /
          Tambah Foto di aplikasi, sertai acara & tanggalnya.
   • Seluruh anggota memilih acara pada filter, lalu melihat & mengunduh
     (tautan langsung mengunduh / membuka foto di tab baru).
   • Metadata ikut sinkron seperti data lain: outbox → Supabase, tarik +
     Realtime → semua perangkat sejajar. */
let _materiFilter = '';   /* acara terpilih pada halaman Materi */
let _dokFilter = '';      /* acara terpilih pada halaman Dokumentasi */

/* Acara terbaru di atas — dipakai filter & pemilih acara */
function daftarAcara() {
  return (state.jadwal || []).slice().sort((a, b) =>
    (Date.parse(b.tanggal || 0) || 0) - (Date.parse(a.tanggal || 0) || 0));
}

/* Isi <select> pilihan acara; nilai lama dipertahankan bila masih tersedia */
function isiSelectAcara(selId, semuaLabel) {
  const sel = $(selId);
  if (!sel) return '';
  const prev = sel.value;
  const ops = daftarAcara().map(j =>
    '<option value="' + esc(j.id) + '">' + esc(j.nama) + ' · ' + esc(fmtDate(j.tanggal)) + '</option>'
  ).join('');
  sel.innerHTML = (semuaLabel ? '<option value="">' + esc(semuaLabel) + '</option>' : '') + ops;
  if (prev) {
    const ada = Array.prototype.some.call(sel.options, o => o.value === prev);
    if (ada) sel.value = prev;
  }
  return sel.value;
}
/* Kenali tautan Google Drive (file / folder / dokumen Google / tautan lain)
   → menghasilkan view (buka), download (unduh), dan thumb (pratinjau).
   Mengembalikan null bila bukan tautan yang valid. */
function driveFileInfo(url) {
  const raw = String(url || '').trim();
  if (!raw) return null;
  let u;
  try { u = new URL(raw); } catch (e) { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const host = u.host.replace(/^www\./, '');

  /* Dokumen Google asli (Docs/Spreadsheet/Slide) → tautan ekspor berkas */
  if (host === 'docs.google.com') {
    const m = u.pathname.match(/\/(document|spreadsheets|presentation|forms)\/d\/([^/]+)/);
    if (m) {
      const id = m[2];
      const dasar = 'https://docs.google.com/' + m[1] + '/d/' + id;
      const fmt = { document: 'pdf', spreadsheets: 'xlsx', presentation: 'pptx' }[m[1]];
      return {
        raw: raw, id: id, kind: 'native', view: raw,
        download: fmt ? dasar + '/export?format=' + fmt : raw,
        thumb: 'https://drive.google.com/thumbnail?id=' + id + '&sz=w800'
      };
    }
    return { raw: raw, id: '', kind: 'external', view: raw, download: raw, thumb: '' };
  }

  /* Google Drive: file, folder, atau tautan dengan ?id= */
  if (host === 'drive.google.com') {
    const mFile = u.pathname.match(/\/file\/d\/([^/]+)/);
    const mFolder = u.pathname.match(/\/folders\/([^/]+)/);
    const id = mFile ? mFile[1] : (mFolder ? mFolder[1] : (u.searchParams.get('id') || ''));
    if (id) {
      const kind = (mFolder && !mFile) ? 'folder' : 'file';
      const view = kind === 'folder'
        ? 'https://drive.google.com/drive/folders/' + id
        : 'https://drive.google.com/file/d/' + id + '/view';
      return {
        raw: raw, id: id, kind: kind, view: view,
        download: kind === 'folder' ? view : 'https://drive.google.com/uc?export=download&id=' + id,
        thumb: kind === 'folder' ? '' : 'https://drive.google.com/thumbnail?id=' + id + '&sz=w800'
      };
    }
    return { raw: raw, id: '', kind: 'external', view: raw, download: raw, thumb: '' };
  }

  /* Tautan lain (layanan berbagi non-Google) — buka apa adanya */
  return { raw: raw, id: '', kind: 'external', view: raw, download: raw, thumb: '' };
}

/* Ubah hasil tempelan (paste) dari Google Drive menjadi daftar tautan.
   Google Drive sering menyalin BANYAK berkas sekaligus: setiap tautan
   didahului nama berkas yang dipisah TAB (foto1.jpg<TAB>https://drive.google
   .com/file/d/AAA/view), dan seluruh daftar dapat tersalin dalam SATU baris.
   Ada pula yang memakai koma, titik-koma, atau spasi sebagai pemisah.
   Karena itu tautan TIDAK dipecah per baris saja, melainkan dikenali dari
   polanya (http/https) sehingga format tempelan apa pun tetap terbaca dan
   SETIAP berkas menghasilkan satu entri. Tautan kembar dibuang.
   Mengembalikan: [{ url, nama, kind }] — nama boleh string kosong. */
function parseDriveLinks(text) {
  const isi = String(text == null ? '' : text);
  const pola = /https?:\/\/[^\s<>"'`,;|]+/gi;
  const hasil = [];
  const sudah = {};
  let posisi = 0;
  let m;
  while ((m = pola.exec(isi)) !== null) {
    /* Nama berkas = teks pada baris yang sama sebelum tautan (kolom "nama
       berkas" pada tempelan Google Drive), dibersihkan dari pemisah. */
    const sebelum = isi.slice(posisi, m.index).split(/[\r\n]+/).pop() || '';
    let nama = sebelum.replace(/[\t|;,]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (nama.length > 120) nama = '';
    posisi = m.index + m[0].length;

    const bersih = m[0].replace(/[)\]>.,;:'"!]+$/, '');
    const info = driveFileInfo(bersih);        /* hanya tautan yang sah dipakai */
    if (!info) continue;
    const kunci = info.id || info.raw;
    if (sudah[kunci]) continue;                /* tautan kembar — cukup sekali */
    sudah[kunci] = true;
    hasil.push({ url: info.raw, nama: nama, kind: info.kind });
  }
  return hasil;
}

/* Penghitung langsung di bawah kotak tempelan: pengguna tahu berapa berkas
   yang benar-benar terbaca SEBELUM menekan "Bagikan". */
function updateJumlahTautan() {
  const el = $('dkJumlah');
  if (!el) return;
  const n = parseDriveLinks($('dkUrl') ? $('dkUrl').value : '').length;
  el.textContent = n
    ? n + ' tautan Drive terdeteksi — setiap tautan menjadi satu entri.'
    : 'Belum ada tautan Drive yang terdeteksi.';
}

/* Kelompokkan entri per acara (tanggal acara) — grup tanpa acara di bawah */
function kelompokPerAcara(list) {
  const peta = new Map();
  (list || []).forEach(r => {
    const key = r.jadwalId ? String(r.jadwalId) : '';
    if (!peta.has(key)) {
      peta.set(key, {
        id: key, nama: r.jadwalNama || 'Tanpa acara',
        tanggal: r.tanggal || null, items: []
      });
    }
    peta.get(key).items.push(r);
  });
  const grup = Array.from(peta.values());
  grup.sort((a, b) => (Date.parse(b.tanggal || 0) || 0) - (Date.parse(a.tanggal || 0) || 0));
  return grup;
}
/* ---------- 26b-1. MATERI ------------------------------------------------- */
function openAddMateri() {
  if (!isStaff()) { toast('Hanya Administrator & Pengurus yang dapat menambah materi', 'error'); return; }
  const acara = daftarAcara();
  if (!acara.length) { toast('Belum ada acara — buat acara pada menu Kelola Jadwal', 'error'); return; }
  showModal('Tambah Materi',
    '<div class="form-group"><label for="mtJadwal">Acara / Tanggal</label>' +
    '<select id="mtJadwal" class="form-control">' + acara.map(j =>
      '<option value="' + esc(j.id) + '">' + esc(j.nama) + ' · ' + esc(fmtDate(j.tanggal)) + '</option>').join('') +
    '</select></div>' +
    '<div class="form-group"><label for="mtJudul">Judul materi</label>' +
    '<input type="text" id="mtJudul" class="form-control" placeholder="Mis. Lembaran Retret" /></div>' +
    '<div class="form-group"><label for="mtDesk">Keterangan (opsional)</label>' +
    '<input type="text" id="mtDesk" class="form-control" placeholder="Mis. Untuk latihan dasar" /></div>' +
    '<div class="form-group"><label for="mtUrl">Tautan Google Drive</label>' +
    '<input type="url" id="mtUrl" class="form-control" placeholder="https://drive.google.com/file/d/..." />' +
    '<p class="tiny muted mt-6">Di Google Drive: bagikan berkas dengan hak <strong>&ldquo;Siapa saja yang punya link dapat melihat&rdquo;</strong> agar semua anggota bisa mengunduh.</p></div>' +
    '<div class="form-group"><label for="mtNama">Nama berkas (opsional)</label>' +
    '<input type="text" id="mtNama" class="form-control" placeholder="lembaran-retret.pdf" /></div>' +
    '<div class="modal-actions"><button class="btn btn-ghost" type="button" onclick="closeModal()">Batal</button>' +
    '<button class="btn btn-primary" type="button" onclick="saveAddMateri()">' + ic('seal') + 'Bagikan</button></div>',
    { icon: 'dossier' });
}

function saveAddMateri() {
  if (!isStaff()) { toast('Hanya Administrator & Pengurus yang dapat menambah materi', 'error'); return; }
  const judul = $('mtJudul') ? $('mtJudul').value.trim() : '';
  const deskripsi = $('mtDesk') ? $('mtDesk').value.trim() : '';
  /* Tempelan dari Google Drive boleh berbentuk "nama berkas + tautan";
     tautan pertama yang sah dipakai (banyak berkas → pakai form Tambah Foto). */
  const daftarTautan = parseDriveLinks($('mtUrl') ? $('mtUrl').value : '');
  const url = daftarTautan.length
    ? daftarTautan[0].url
    : ($('mtUrl') ? $('mtUrl').value.trim() : '');
  const fileName = $('mtNama') ? $('mtNama').value.trim() : '';
  if (!judul) { toast('Judul materi wajib diisi', 'error'); return; }
  const info = driveFileInfo(url);
  if (!info) { toast('Tautan tidak valid — tempelkan tautan Google Drive', 'error'); return; }
  const j = daftarAcara().find(x => String(x.id) === String($('mtJadwal') ? $('mtJadwal').value : ''));
  const now = new Date().toISOString();
  const rec = {
    id: uid(),
    jadwalId: j ? String(j.id) : '',
    jadwalNama: j ? j.nama : '',
    tanggal: j ? (j.tanggal || null) : null,
    judul: judul,
    deskripsi: deskripsi,
    fileUrl: info.raw,
    fileName: fileName || (daftarTautan[0] ? daftarTautan[0].nama : '') ||
      (info.kind === 'folder' ? 'Folder Google Drive' : ''),
    uploadedBy: state.currentUser.id,
    uploader: state.currentUser.nama,
    createdAt: now,
    updatedAt: now
  };
  state.materi.unshift(rec);
  saveLocal();
  enqueue('materi', rec);
  addLog('CREATE_MATERI', { judul: rec.judul, acara: rec.jadwalNama, tautan: rec.fileUrl });
  closeModal();
  renderMateri();
  toast('Materi dibagikan ke seluruh anggota' + (daftarTautan.length > 1
    ? ' (hanya tautan pertama dipakai — banyak berkas lewat Tambah Foto)'
    : ''), 'success');
}
function materiItemHtml(m) {
  const info = driveFileInfo(m.fileUrl);
  const aksiUnduh = info
    ? '<a class="btn btn-outline btn-sm" href="' + esc(info.download) + '" target="_blank" rel="noopener">' +
      ic('descend') + (info.kind === 'folder' ? 'Buka di Drive' : 'Unduh') + '</a>'
    : '<span class="tiny muted">Tautan tidak dikenal</span>';
  const aksiHapus = isStaff()
    ? '<button class="btn btn-danger btn-sm" type="button" onclick="hapusMateri(\'' + esc(m.id) + '\')">' +
      ic('scrap') + 'Hapus</button>'
    : '';
  return '<div class="list-item">' + ic('dossier') +
    '<div class="body"><strong>' + esc(m.judul || '-') + '</strong>' +
    (m.deskripsi ? '<div class="meta">' + esc(m.deskripsi) + '</div>' : '') +
    '<div class="meta">' + esc(m.fileName || (info && info.kind === 'folder' ? 'Folder Google Drive' : 'Berkas Google Drive')) +
    ' · dibagikan ' + esc(fmtDate(m.createdAt || m.updatedAt)) +
    (m.uploader ? ' oleh ' + esc(m.uploader) : '') + '</div>' +
    '<div class="row-tight mt-6">' + aksiUnduh + aksiHapus + '</div>' +
    '</div></div>';
}

function renderMateri() {
  const box = $('materiList');
  if (!box) return;
  _materiFilter = isiSelectAcara('materiAcara', 'Semua acara');
  const semua = (state.materi || []).slice().sort((a, b) =>
    (Date.parse(b.createdAt || b.updatedAt || 0) || 0) - (Date.parse(a.createdAt || a.updatedAt || 0) || 0));
  const list = _materiFilter
    ? semua.filter(m => String(m.jadwalId || '') === _materiFilter)
    : semua;
  if (!list.length) {
    box.innerHTML = '<div class="empty">' + ic('dossier', 'ic-lg') +
      '<div>Belum ada materi' + (_materiFilter ? ' untuk acara ini' : '') + '</div>' +
      '<div class="tiny mt-6">' + (isStaff()
        ? 'Tekan Tambah Materi untuk membagikan berkas dari Google Drive.'
        : 'Materi akan dibagikan oleh Administrator / Pengurus.') + '</div></div>';
    return;
  }
  box.innerHTML = kelompokPerAcara(list).map((g, i) =>
    (i ? '<div class="mt-14">' : '<div>') +
    '<h3 class="mb-8">' + esc(g.nama) + (g.tanggal ? ' · ' + esc(fmtDate(g.tanggal)) : '') + '</h3>' +
    '<div class="list">' + g.items.map(materiItemHtml).join('') + '</div></div>'
  ).join('');
  applyRoleVisibility();
}

function hapusMateri(id) {
  if (!isStaff()) { toast('Hanya Administrator & Pengurus yang dapat menghapus materi', 'error'); return; }
  const m = state.materi.find(x => String(x.id) === String(id));
  if (!m) { toast('Materi tidak ditemukan', 'error'); return; }
  showModal('Hapus Materi',
    '<p>Hapus materi <strong>' + esc(m.judul || '-') + '</strong>' +
    (m.jadwalNama ? ' pada <strong>' + esc(m.jadwalNama) + '</strong>' : '') + '?</p>' +
    '<p class="tiny muted mt-6">Berkas di Google Drive tidak ikut terhapus — hanya catatan pada aplikasi ini.</p>' +
    '<div class="modal-actions"><button class="btn btn-ghost" type="button" onclick="closeModal()">Batal</button>' +
    '<button class="btn btn-danger" type="button" onclick="konfirmasiHapusMateri(\'' + esc(m.id) + '\')">' +
    ic('scrap') + 'Hapus</button></div>',
    { icon: 'dossier', tone: 'danger' });
}

function konfirmasiHapusMateri(id) {
  if (!isStaff()) { toast('Hanya Administrator & Pengurus yang dapat menghapus materi', 'error'); return; }
  const idx = state.materi.findIndex(x => String(x.id) === String(id));
  if (idx < 0) { closeModal(); return; }
  const m = state.materi[idx];
  state.materi.splice(idx, 1);
  saveLocal();
  queueDelete('materi', id);
  addLog('DELETE_MATERI', { judul: m.judul, acara: m.jadwalNama });
  closeModal();
  renderMateri();
  toast('Materi dihapus — berlaku di perangkat ini dan di server', 'success');
}
/* ---------- 26b-2. DOKUMENTASI -------------------------------------------- */
function openAddDokumentasi() {
  if (!isStaff()) { toast('Hanya Administrator & Pengurus yang dapat menambah dokumentasi', 'error'); return; }
  const acara = daftarAcara();
  if (!acara.length) { toast('Belum ada acara — buat acara pada menu Kelola Jadwal', 'error'); return; }
  showModal('Tambah Dokumentasi',
    '<div class="form-group"><label for="dkJadwal">Acara / Tanggal</label>' +
    '<select id="dkJadwal" class="form-control">' + acara.map(j =>
      '<option value="' + esc(j.id) + '">' + esc(j.nama) + ' · ' + esc(fmtDate(j.tanggal)) + '</option>').join('') +
    '</select></div>' +
    '<div class="form-group"><label for="dkKet">Keterangan (opsional)</label>' +
    '<input type="text" id="dkKet" class="form-control" placeholder="Mis. Liputan retret" /></div>' +
    '<div class="form-group"><label for="dkUrl">Tautan Google Drive (boleh banyak sekaligus)</label>' +
    '<textarea id="dkUrl" class="form-control" rows="6" oninput="updateJumlahTautan()" placeholder="https://drive.google.com/file/d/AAA/view&#10;https://drive.google.com/drive/folders/BBB&#10;foto3.jpg  https://drive.google.com/file/d/CCC/view"></textarea>' +
    '<p class="tiny muted mt-6" id="dkJumlah">Belum ada tautan Drive yang terdeteksi.</p>' +
    '<p class="tiny muted mt-6">Tempel sekaligus banyak tautan: hasil <strong>Salin tautan</strong> atau <strong>Ctrl+C</strong> dari Google Drive (nama berkas + tautan) maupun daftar biasa (satu tautan per baris) sama-sama terbaca &mdash; setiap tautan menjadi satu entri. Boleh tautan per foto maupun satu tautan <strong>folder</strong> berisi banyak foto. ' +
    'Di Google Drive, bagikan dengan hak <strong>&ldquo;Siapa saja yang punya link dapat melihat&rdquo;</strong>.</p></div>' +
    '<div class="modal-actions"><button class="btn btn-ghost" type="button" onclick="closeModal()">Batal</button>' +
    '<button class="btn btn-primary" type="button" onclick="saveAddDokumentasi()">' + ic('seal') + 'Bagikan</button></div>',
    { icon: 'photo' });
}

function saveAddDokumentasi() {
  if (!isStaff()) { toast('Hanya Administrator & Pengurus yang dapat menambah dokumentasi', 'error'); return; }
  /* Tempelan Google Drive bisa berupa satu tautan per baris, daftar
     "nama berkas + tautan", atau banyak tautan dalam satu baris — semuanya
     dikenali parseDriveLinks sehingga setiap berkas jadi satu entri. */
  const daftar = parseDriveLinks($('dkUrl') ? $('dkUrl').value : '');
  if (!daftar.length) {
    toast('Tidak ada tautan Google Drive yang dikenali — tempelkan tautan berkas atau foldernya', 'error');
    return;
  }
  const keterangan = $('dkKet') ? $('dkKet').value.trim() : '';
  const j = daftarAcara().find(x => String(x.id) === String($('dkJadwal') ? $('dkJadwal').value : ''));
  const now = new Date().toISOString();
  const user = state.currentUser;
  const baru = daftar.map(t => ({
    id: uid(),
    jadwalId: j ? String(j.id) : '',
    jadwalNama: j ? j.nama : '',
    tanggal: j ? (j.tanggal || null) : null,
    keterangan: keterangan,
    fileUrl: t.url,
    fileName: t.nama || (t.kind === 'folder' ? 'Folder Google Drive' : ''),
    uploadedBy: user.id,
    uploader: user.nama,
    createdAt: now,
    updatedAt: now
  }));
  state.dokumentasi = baru.concat(state.dokumentasi);
  saveLocal();
  baru.forEach(r => enqueue('dokumentasi', r));
  addLog('CREATE_DOKUMENTASI', { jumlah: baru.length, acara: j ? j.nama : '', keterangan: keterangan });
  closeModal();
  renderDokumentasi();
  toast(baru.length + ' entri dokumentasi ditambahkan', 'success');
}

/* Pratinjau gagal dimuat → coba tautan cadangan sekali (data-cadangan),
   lalu lepas gambarnya agar ikon pengganti tetap terlihat rapi. */
function fotoCadangan(img) {
  let alt = '';
  try { alt = img.getAttribute('data-cadangan') || ''; } catch (e) { alt = ''; }
  if (alt) {
    try { img.removeAttribute('data-cadangan'); } catch (e) { /* abaikan */ }
    img.src = alt;
    return;
  }
  if (img.parentNode) img.parentNode.removeChild(img);
}

function dokItemHtml(r) {
  const info = driveFileInfo(r.fileUrl);
  let foto;
  if (info) {
    const sumber = info.thumb || (info.kind === 'external' ? info.view : '');
    /* Cadangan: pratinjau ?id= Drive kadang ditolak (berkas belum dibagikan
       "siapa saja dapat melihat", batas kuota pratinjau, dsb.) → coba tautan
       berkas sekali sebelum gambar dilepas dan ikon pengganti ditampilkan. */
    const cadangan = (info.kind === 'file' && info.id)
      ? 'https://drive.google.com/uc?export=view&id=' + info.id : '';
    foto = '<a class="dok-shot" href="' + esc(info.view) + '" target="_blank" rel="noopener" title="Buka foto asli">' +
      ic('photo') +
      (sumber ? '<img src="' + esc(sumber) + '" alt="' + esc(r.keterangan || 'Foto kegiatan') +
        '" loading="lazy" referrerpolicy="no-referrer" data-cadangan="' + esc(cadangan) +
        '" onerror="fotoCadangan(this)" />' : '') +
      '</a>';
  } else {
    foto = '<div class="dok-shot">' + ic('scrap') + '</div>';
  }
  const aksiUnduh = info
    ? '<a class="btn btn-outline btn-sm" href="' + esc(info.download) + '" target="_blank" rel="noopener">' +
      ic('descend') + (info.kind === 'folder' ? 'Buka di Drive' : 'Unduh') + '</a>'
    : '';
  const aksiHapus = isStaff()
    ? '<button class="btn btn-danger btn-sm" type="button" onclick="hapusDokumentasi(\'' + esc(r.id) + '\')">' +
      ic('scrap') + 'Hapus</button>'
    : '';
  const namaBerkas = r.fileName || (info && info.kind === 'folder' ? 'Folder Google Drive' : '');
  return '<div class="dok-item">' + foto +
    (r.keterangan ? '<div class="dok-cap"><strong>' + esc(r.keterangan) + '</strong></div>' : '') +
    (namaBerkas ? '<div class="dok-cap">' + esc(namaBerkas) + '</div>' : '') +
    '<div class="dok-cap">' + esc(fmtDate(r.createdAt || r.updatedAt)) +
    (r.uploader ? ' · ' + esc(r.uploader) : '') + '</div>' +
    '<div class="row-tight mt-6">' + aksiUnduh + aksiHapus + '</div></div>';
}

function renderDokumentasi() {
  const box = $('dokList');
  if (!box) return;
  _dokFilter = isiSelectAcara('dokAcara', 'Semua acara');
  const semua = (state.dokumentasi || []).slice().sort((a, b) =>
    (Date.parse(b.createdAt || b.updatedAt || 0) || 0) - (Date.parse(a.createdAt || a.updatedAt || 0) || 0));
  const list = _dokFilter
    ? semua.filter(r => String(r.jadwalId || '') === _dokFilter)
    : semua;
  if (!list.length) {
    box.innerHTML = '<div class="empty">' + ic('photo', 'ic-lg') +
      '<div>Belum ada foto dokumentasi' + (_dokFilter ? ' untuk acara ini' : '') + '</div>' +
      '<div class="tiny mt-6">' + (isStaff()
        ? 'Tekan Tambah Foto lalu tempel tautan Drive berisi hasil kegiatan.'
        : 'Foto kegiatan akan dibagikan oleh Administrator / Pengurus.') + '</div></div>';
    return;
  }
  box.innerHTML = kelompokPerAcara(list).map((g, i) =>
    (i ? '<div class="mt-14">' : '<div>') +
    '<h3 class="mb-8">' + esc(g.nama) + (g.tanggal ? ' · ' + esc(fmtDate(g.tanggal)) : '') + '</h3>' +
    '<div class="dok-grid">' + g.items.map(dokItemHtml).join('') + '</div></div>'
  ).join('');
  applyRoleVisibility();
}
function hapusDokumentasi(id) {
  if (!isStaff()) { toast('Hanya Administrator & Pengurus yang dapat menghapus dokumentasi', 'error'); return; }
  const r = state.dokumentasi.find(x => String(x.id) === String(id));
  if (!r) { toast('Entri dokumentasi tidak ditemukan', 'error'); return; }
  showModal('Hapus Dokumentasi',
    '<p>Hapus ' + (r.keterangan ? 'foto <strong>' + esc(r.keterangan) + '</strong>' : 'entri foto ini') +
    (r.jadwalNama ? ' pada <strong>' + esc(r.jadwalNama) + '</strong>' : '') + '?</p>' +
    '<p class="tiny muted mt-6">Foto di Google Drive tidak ikut terhapus — hanya catatan pada aplikasi ini.</p>' +
    '<div class="modal-actions"><button class="btn btn-ghost" type="button" onclick="closeModal()">Batal</button>' +
    '<button class="btn btn-danger" type="button" onclick="konfirmasiHapusDokumentasi(\'' + esc(r.id) + '\')">' +
    ic('scrap') + 'Hapus</button></div>',
    { icon: 'photo', tone: 'danger' });
}

function konfirmasiHapusDokumentasi(id) {
  if (!isStaff()) { toast('Hanya Administrator & Pengurus yang dapat menghapus dokumentasi', 'error'); return; }
  const idx = state.dokumentasi.findIndex(x => String(x.id) === String(id));
  if (idx < 0) { closeModal(); return; }
  const r = state.dokumentasi[idx];
  state.dokumentasi.splice(idx, 1);
  saveLocal();
  queueDelete('dokumentasi', id);
  addLog('DELETE_DOKUMENTASI', { keterangan: r.keterangan, acara: r.jadwalNama });
  closeModal();
  renderDokumentasi();
  toast('Entri dokumentasi dihapus — berlaku di perangkat ini dan di server', 'success');
}

/* ---------- 27. BANTUAN -------------------------------------------------- */
function renderBantuan() {
  /* Panduan disaring sesuai peran: blok bertanda data-role pada index.html
     hanya tampil untuk peran yang bersangkutan. */
  applyRoleVisibility();
  setText('bantuanVersi', versiLabel());
  const role = state.currentUser ? state.currentUser.role : '';
  setText('bantuanPeran', roleName(role));
  setText('bantuanLuring', apiReady()
    ? (isOnline()
      ? 'Peranti daring — data disinkronkan otomatis ke Supabase.'
      : 'Peranti luring — data ditahan di perangkat lalu dikirim otomatis ke Supabase saat kembali daring.')
    : 'Mode mandiri: seluruh data tersimpan di peranti ini (Supabase belum dikonfigurasi).');
}

/* ---------- 28. MODAL --------------------------------------------------
   Modal notifikasi bergaya "dialog" modern namun ringan: selalu muncul di
   TENGAH layar, dapat ditutup dengan Esc / ketukan latar / tombol Batal,
   fokus langsung berpindah ke tombol utama, dan gulir latar dikunci selama
   terbuka (tanpa pustaka tambahan — hanya CSS + beberapa baris JS).
   showModal(judul, isi, opsi) — opsi boleh berupa nama ikon (string) atau
     { icon: 'seal', tone: 'success' | 'danger' | 'warn' | 'brand' } */
let _modalCloseTimer = 0;

function showModal(title, content, opts) {
  const o = (typeof opts === 'string') ? { icon: opts } : (opts || {});
  const overlay = $('modal');
  const box = $('modalContent');
  if (!overlay || !box) return;

  const head = o.icon
    ? '<div class="modal-head">' + ic(o.icon, 'modal-ic') + '<h3>' + esc(title) + '</h3></div>'
    : '<h3>' + esc(title) + '</h3>';
  box.className = 'modal tone-' + (o.tone || 'brand');
  box.innerHTML = head + '<div class="modal-body">' + content + '</div>';

  if (_modalCloseTimer) { clearTimeout(_modalCloseTimer); _modalCloseTimer = 0; }
  overlay.classList.remove('closing');
  overlay.classList.add('show');
  document.body.classList.add('modal-open');

  /* Fokus ke tombol utama agar bisa langsung ditekan dengan Enter / spasi */
  setTimeout(() => {
    try {
      const btn = box.querySelector('.modal-actions .btn-primary') ||
        box.querySelector('.modal-actions .btn');
      (btn || box).focus({ preventScroll: true });
    } catch (e) { /* abaikan */ }
  }, 70);
}

function closeModal() {
  const overlay = $('modal');
  const box = $('modalContent');
  document.body.classList.remove('modal-open');
  if (!overlay || !overlay.classList.contains('show')) return;
  overlay.classList.add('closing');           /* animasi tutup singkat */
  if (box) box.classList.add('closing');
  if (_modalCloseTimer) clearTimeout(_modalCloseTimer);
  _modalCloseTimer = setTimeout(() => {
    overlay.classList.remove('show', 'closing');
    if (box) box.classList.remove('closing');
    _modalCloseTimer = 0;
  }, 160);
}

/* ---------- 29. PEMASANGAN AWAL --------------------------------------- */
function bindEvents() {
  const modal = $('modal');
  /* Kunci wajib-sandi: klik luar lapisan modal tidak boleh menutup dialog. */
  if (modal) modal.addEventListener('click', e => {
    if (document.body.classList.contains('modal-lock')) return;
    if (e.target.id === 'modal') closeModal();
  });
  /* Esc menutup modal — pintasan papan ketik (dialog modern) */
  document.addEventListener('keydown', e => {
    if (document.body.classList.contains('modal-lock')) return;
    if (e.key === 'Escape' && modal && modal.classList.contains('show')) closeModal();
  });
  ['loginUser', 'loginPass'].forEach(id => {
    const el = $(id);
    if (el) el.addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
  });
  window.addEventListener('hashchange', () => {
    const h = (location.hash || '').replace('#', '');
    if (state.currentUser && h && canAccess(h) && h !== state.activePage) showPage(h);
  });
}

async function init() {
  /* Pengaman terakhir: SELALU lepas selubung walau init() gagal di tengah
     (IndexedDB diblokir, Supabase timeout, dsb.) — tanpa ini layar IHS macet. */
  var _bootReleased = false;
  var _cloudSynced = false;     /* jalur sesi sudah menarik data + mengirim antrean */
  function _releaseBootOnce() {
    if (_bootReleased) return;
    _bootReleased = true;
    try { endBoot(); } catch (e) {
      try { document.documentElement.removeAttribute('data-boot'); } catch (e2) {}
    }
  }
  /* Jika init() macet > 8 detik (mis. IndexedDB diblokir), paksa lepas. */
  try { setTimeout(_releaseBootOnce, 8000); } catch (e) {}
  try {
  if (window.Icon) { Icon.mount(); Icon.hydrate(); }

  /* Muat database lebih dahulu: tema, sesi, dan seluruh data koleksi */
  try {
    await openDB();
    await migrateLegacyKV();
    _themeCache = await kvGet('theme', null);
    _fontSizeCache = await kvGet('fontSize', null);
  } catch (e) { console.warn('Database tidak tersedia', e); }
  applyTheme(_themeCache || systemTheme(), false);
  applyFontSize(_fontSizeCache || 'normal', false);
  watchSystemTheme();

  await loadLocal();
  /* Status 'izin' & 'alpha' (tanpa keterangan) telah dihapus — samakan baris
     lama di perangkat, dan bila Supabase tersambung kirim juga ke server. */
  try {
    const statusLama = normalizePresensiStatus();
    if (statusLama.length) {
      if (apiReady()) statusLama.forEach(p => enqueue('presensi', p));
      saveLocal();
    }
  } catch (e) { console.warn('Migrasi status presensi dilewati:', e); }
  /* Akun contoh hanya untuk pemakaian mandiri; pada mode Supabase akun dibuat
     lewat menu Registrasi atau supabase/seed.sql. */
  if (!state.users.length && !apiReady()) await seedDefaultUsers();

  bindEvents();
  applyRoleVisibility();
  terapkanVersi();              /* layar masuk & Tentang Aplikasi: nomor versi */
  updateSyncUI();
  setupConnectivity();
  startSessionWatch();          /* pengawas time-out login: 30/45/60 menit */
  await restoreActiveJadwal();  /* pintasan "Sesi Hari Ini" tetap tersimpan */

  /* Halaman terakhir (dari #hash) DIPERTAHANKAN ketika halaman disegarkan —
     pengguna tetap berada di halaman yang sama, tanpa kedipan ke layar masuk.
     Hanya sesudah LOGIN penuh pengguna diarahkan ke Beranda. */
  const bootPage = (location.hash || '').replace('#', '').trim();

  if (await checkSession()) {
    /* CLOUD-FIRST: daring → tarik basis data sebagai acuan SEBELUM layar utama
       tampil; dibatasi 4 detik agar selubung boot tidak pernah tertahan lama.
       Gagal/luring → lanjut memakai cadangan perangkat (titik "baru offline"). */
    if (apiReady() && isOnline()) {
      try {
        await Promise.race([
          pullRemote(true),
          new Promise(res => setTimeout(res, 4000))
        ]);
      } catch (e) { /* abaikan — pakai cadangan lokal */ }
    }
    showMainApp(bootPage || 'home');
    flushQueue();                    /* kirim antrean lokal di atas acuan cloud */
    _cloudSynced = true;
  } else {
    showLoginScreen();
    if (_sessionExpiredAtBoot) {
      showModal('Sesi Berakhir',
        '<p>Sesi Anda sudah habis, silakan login kembali.</p>' +
        '<div class="modal-actions"><button class="btn btn-primary" onclick="closeModal()">' +
        ic('keycross') + 'Masuk Kembali</button></div>',
        { icon: 'keycross', tone: 'warn' });
    }
  }
  } catch (fatalErr) {
    console.warn('init() gagal sebagian — tetap tampil agar tidak macet:', fatalErr);
    try { showLoginScreen(); } catch (e2) {}
  } finally {
    _releaseBootOnce();
  }

  /* Sinkron di latar (CLOUD-FIRST): tarik basis data sebagai acuan LEBIH
     DAHULU, lalu kirim antrean lokal di atasnya. Jalur sesi yang sudah
     melakukan tarikan di atas tidak mengulang (tanda _cloudSynced).
     Tidak menahan tampilan — aplikasi tetap dapat dipakai saat luring.
     Wajib .catch() agar kegagalan jaringan/izin tidak muncul sebagai
     "Uncaught (in promise)" di console. */
  if (!_cloudSynced && apiReady() && isOnline()) {
    try {
      var _p = pullRemote(true).then(() => flushQueue());
      if (_p && _p.catch) _p.catch(() => { /* luring / server menolak — coba lagi nanti */ });
    } catch (e) { /* abaikan */ }
  }
}

init().catch(function (e) {
  console.warn('init() gagal — paksa lepas selubung:', e);
  try { document.documentElement.removeAttribute('data-boot'); } catch (e2) {}
  try {
    var v = document.getElementById('bootVeil');
    if (v) v.style.display = 'none';
  } catch (e3) {}
});













// Test edit
