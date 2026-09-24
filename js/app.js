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
  VERSION: '4.6.0',
  SYNC_INTERVAL: 60000,   // 60 detik saat daring
  MAX_USERS: 50,
  MAX_QUEUE: 500,
  MAX_LOG: 500,
  MAX_SYNC_TRIES: 5,
  /* Masa berlaku sesi masuk (mili-detik) demi keamanan akun.
     Pengurus & Peserta 6 jam, Administrator 12 jam. */
  SESSION_TTL_STAFF: 6 * 60 * 60 * 1000,
  SESSION_TTL_ADMIN: 12 * 60 * 60 * 1000,
  SESSION_WARN_MS: 5 * 60 * 1000   // peringatan ramah 5 menit sebelum sesi berakhir
}, window.IGN_CONFIG || {});

const STORE_KEYS = {
  users: 'ign_users', jadwal: 'ign_jadwal', presensi: 'ign_presensi',
  logs: 'ign_logs', session: 'ign_session', outbox: 'ign_outbox',
  tomb: 'ign_tombstones', meta: 'ign_meta', theme: 'ign_theme',
  requests: 'ign_requests'
};

const STAFF_ROLES = ['admin', 'pengurus'];
/* Halaman yang dikunci per peran — JADWAL & BUAT QR hanya ADMIN/PENGURUS */
const PAGE_ACCESS = {
  jadwal: 'staff', 'qr-gen': 'staff',
  users: 'admin', registrasi: 'admin', log: 'admin'
};
const ROLE_LABEL = { admin: 'Administrator', pengurus: 'Pengurus', peserta: 'Peserta' };

/* ---------- 2. STATE ----------------------------------------------------- */
let state = {
  currentUser: null,
  users: [], jadwal: [], presensi: [], logs: [], requests: [],
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
  state.outbox = dbRows('outbox');
  state.tombstones = dbRows('tombstones');
  state.meta = Object.assign({ lastSync: null }, await kvGet('meta', {}));
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

/* Simpan dahulu di perangkat, baru kirim ke server (offline-first) */
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
  if (state.syncing || !apiReady() || !isOnline() || state.outbox.length === 0) {
    updateSyncUI();
    return;
  }
  state.syncing = true;
  updateSyncUI();

  const total = state.outbox.length;
  let sent = 0;
  let postponed = 0;

  try {
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

        /* Galat tetap (data tidak sah, mis. 400/409) tidak boleh menahan antrean:
           geser ke belakang dan beri jeda bertambah, lalu lanjut ke operasi lain. */
        if (supaIsPermanent(err)) {
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
      saveLocal();
      updateSyncUI();
    }
    if (sent) state.meta.lastSync = new Date().toISOString();
  } finally {
    state.outbox.forEach(o => { delete o._postponed; });
    state.syncing = false;
    saveLocal();
    updateSyncUI();
  }
}
/* ---------- 7. SINKRONISASI DARING (MENYUSUL, TANPA MENIMPA LOKAL) ------- */
function sig(list) {
  return (list || []).map(r => r.id + ':' + (r.updatedAt || r.createdAt || r.timestamp || '')).sort().join('|');
}

/* Gabungkan data server dengan data lokal:
   perubahan lokal yang belum terkirim SELALU menang. */
function mergeList(local, remote, coll) {
  const locked = pendingIds(coll);
  const byId = new Map();
  (local || []).forEach(r => { if (r && r.id) byId.set(r.id, r); });
  (remote || []).forEach(r => {
    if (!r || !r.id) return;
    if (isTombstoned(coll, r.id) || locked.has(r.id)) return;
    const mine = byId.get(r.id);
    if (!mine) { byId.set(r.id, r); return; }
    const rt = Date.parse(r.updatedAt || r.createdAt || r.timestamp || 0) || 0;
    const lt = Date.parse(mine.updatedAt || mine.createdAt || mine.timestamp || 0) || 0;
    if (rt > lt) byId.set(r.id, r);
  });
  return Array.from(byId.values());
}

function mergeRemote(data) {
  let changed = false;
  ['users', 'jadwal', 'presensi', 'logs', 'requests'].forEach(key => {
    if (!Array.isArray(data[key])) return;
    const before = sig(state[key]);
    state[key] = mergeList(state[key], data[key], key);
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
    state.apiHint = null;
    state.backoffUntil = 0;
    state.meta.lastSync = new Date().toISOString();
    saveLocal();
    if (changed) {
      notifyNewResetRequests();       /* pemberitahuan permintaan lupa password (ADMIN) */
      renderActivePage();
      if (!silent) toast('Data diperbarui dari Supabase', 'success');
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

/* Urutan: kirim antrean dahulu, lalu ambil pembaruan dari basis data.
   HANYA ADMIN yang boleh memicu sinkronisasi MANUAL (tombol "Sinkron sekarang").
   Sinkron latar belakang (manual kosong) tetap berjalan untuk semua peran agar
   presensi Pengurus & Peserta tidak tertahan di perangkat. */
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
    await flushQueue();
    await pullRemote(!manual);
    if (manual) {
      const left = state.outbox.length;
      if (left) toast(left + ' data belum terkirim, akan dicoba lagi', 'error');
      else if (state.apiHint) toast(state.apiHint, 'error');
      else toast('Sinkronisasi selesai · data terbaru dari Supabase', 'success');
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

/* Pemicu sinkron: kembali daring, kembali ke aplikasi, berkala, realtime
   antar-pengguna, dan dari SW. Semua berjalan senyap di latar belakang —
   tanpa toast & tanpa bilah. */
function setupConnectivity() {
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
    navigator.serviceWorker.register('sw.js').then(reg => {
      try {
        if (reg && reg.sync && typeof reg.sync.register === 'function') {
          const p = reg.sync.register('ign-outbox');
          if (p && typeof p.then === 'function') {
            p.then(() => {}, () => { /* izin sync ditolak — abaikan, sinkron manual tetap jalan */ });
          }
        }
      } catch (e) { /* izin ditolak sinkron — abaikan */ }
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
       agar pengguna baru dapat langsung masuk pada peranti ini. */
    if (!user && apiReady() && isOnline() &&
      !state.users.some(x => String(x.username || '').toLowerCase() === needle)) {
      const pulled = await pullRemote(true);
      if (pulled) user = findUser();
    }

    if (!user) {
      if (apiReady() && !isOnline() && state.users.length === 0) {
        toast('Akun belum tersimpan di peranti ini dan perangkat sedang luring — sambungkan internet lalu coba lagi', 'error');
      } else if (apiReady() && !state.users.length) {
        toast('Belum ada akun pada basis data. Minta Administrator membuat akun pertama (supabase/seed.sql atau menu Registrasi).', 'error');
      } else if (state.apiHint) {
        toast(state.apiHint, 'error');
      } else {
        toast('Username/password salah atau akun nonaktif', 'error');
      }
      return;
    }

    state.currentUser = user;
    startSession(user);   /* catat masa berlaku sesi + pengawas waktu (6/12 jam) */
    addLog('LOGIN', { username: user.username, masaBerlaku: fmtDurasi(sessionTtlMs(user)) });
    toast('Selamat datang, ' + user.nama + '!', 'success');
    showMainApp('home');
    try { scheduleRealtimeCatchup(); } catch (e) {}
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
  $('loginPass').value = '';
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  endBoot();
}

/* ---------- 11b. MASA BERLAKU SESI (TIME-OUT LOGIN) --------------------- */
/* Demi keamanan akun: sesi Pengurus & Peserta berakhir setelah 6 jam,
   Administrator setelah 12 jam. Ketika berakhir, pengguna otomatis keluar
   dan diberi tahu dengan bahasa yang santai namun tetap sopan. */
function sessionTtlMs(user) {
  const role = (user && user.role) || 'peserta';
  return role === 'admin'
    ? (Number(CONFIG.SESSION_TTL_ADMIN) || 12 * 60 * 60 * 1000)
    : (Number(CONFIG.SESSION_TTL_STAFF) || 6 * 60 * 60 * 1000);
}

function fmtDurasi(ms) {
  const jam = Math.max(1, Math.round(Number(ms) / 3600000));
  return jam + ' jam';
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
  const durasi = fmtDurasi(sessionTtlMs(user));
  addLog('SESSION_TIMEOUT', { username: user ? user.username : '-' });
  state.sessionExp = 0;
  try { stopScanner(); } catch (e) { /* abaikan */ }
  doLogout({ keepUsername: true });
  showModal('Sesi Anda Berakhir',
    '<p>Terima kasih atas kesetiaan Anda melayani hari ini.</p>' +
    '<p class="small mt-6">Demi keamanan akun, aplikasi mengeluarkan sesi secara otomatis setelah ' +
    esc(durasi) + ' pemakaian. Tidak ada data yang hilang — semuanya sudah tersimpan' +
    (apiReady() ? ' dan akan dikirim ke server saat Anda masuk kembali' : ' di perangkat ini') + '.</p>' +
    '<p class="small mt-6">Silakan masuk kembali untuk melanjutkan, tetap semangat, dan selamat berkarya.</p>' +
    '<div class="modal-actions"><button class="btn btn-primary" onclick="closeModal()">' +
    ic('keycross') + 'Masuk Kembali</button></div>');
}

/* Pengguna contoh untuk pemakaian mandiri (tanpa Supabase).
   Pada mode Supabase gunakan supabase/seed.sql — lihat README.md. */
async function seedDefaultUsers() {
  const defaults = [
    { nama: 'Administrator', username: 'admin', pass: 'admin123', hp: '081234567890', role: 'admin', email: 'admin@ignasian.id' },
    { nama: 'Pengurus Umum', username: 'pengurus', pass: 'pengurus123', hp: '081234567891', role: 'pengurus', email: 'pengurus@ignasian.id' },
    { nama: 'Peserta Contoh', username: 'peserta', pass: 'peserta123', hp: '081234567892', role: 'peserta', email: 'peserta@ignasian.id' }
  ];
  const created = [];
  for (const d of defaults) {
    const now = new Date().toISOString();
    created.push({
      id: uid(),
      nama: d.nama,
      username: d.username,
      passHash: await sha256(d.pass),
      passPlain: d.pass,        /* disimpan demi pemulihan oleh Administrator */
      hpHash: await sha256(d.hp),
      hpPlain: d.hp,          // disimpan demi kompatibilitas skema lama
      role: d.role,
      status: 'aktif',
      email: d.email,
      createdAt: now,
      updatedAt: now
    });
  }
  state.users = state.users.concat(created);
  saveLocal();
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
  state.sessionExp = Number(s.exp) || ((Number(s.t) || Date.now()) + sessionTtlMs(user));
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
  users: 'lainnya', registrasi: 'lainnya', jadwal: 'lainnya', 'qr-gen': 'lainnya', log: 'lainnya'
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
    case 'profil': loadProfil(); break;
    case 'pengaturan': applyTheme(currentTheme(), false); renderSettingsSync(); break;
    case 'users': renderUsers(); renderResetRequests(); break;
    case 'jadwal': renderJadwal(); setTimeout(initMapJadwal, 120); break;
    case 'qr-gen': renderQrJadwalSelect(); break;
    case 'log': renderLog(); break;
    case 'bantuan': renderBantuan(); break;
    default: break;
  }
}
function renderActivePage() { renderPage(state.activePage); }

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
      statCard('Izin Hari Ini', todayPres.filter(p => p.status === 'izin').length, 'izin') +
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
      statCard('Izin Hari Ini', todayPres.filter(p => p.status === 'izin').length, 'izin') +
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
  const izin = inMonth.filter(p => p.status === 'izin').length;

  box.innerHTML =
    statCard('Sesi Bulan Ini', monthSessions.length, '') +
    statCard('Hadir', hadir, 'hadir') +
    statCard('Izin', izin, 'izin') +
    statCard('Tanpa Keterangan', Math.max(0, monthSessions.length - hadir - izin), 'alpha');

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
/* Setiap acara hari ini dapat diketuk dan langsung membuka halaman Presensi
   dengan acara tersebut TERPILIH, sehingga kode QR yang dipindai wajib milik
   acara itu. Ini mencegah tertukarnya presensi bila ada lebih dari satu acara
   berlangsung pada waktu yang sama. Administrator & Pengurus juga mendapat
   tombol QR agar dapat langsung membuat kode QR acara tersebut. */
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
      <button class="pick-item${dipilih ? ' is-picked' : ''}" type="button" onclick="bukaPresensiSesi('${esc(j.id)}')">
        ${ic('pilgrim')}
        <div class="body">
          <strong>${esc(j.nama)}</strong>
          <div class="meta">${esc(j.venue || '')} · ${fmtTime(j.tanggal)}–${fmtTime(end)}</div>
          <div class="meta">${dipilih ? 'Acara ini sedang dipilih untuk presensi' : 'Ketuk untuk membuka presensi acara ini'}</div>
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
    DELETE_REQUEST: 'scrap'
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
        ic('seal') + 'Selesai</button></div>');
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

/* Kartu "Acara yang Dipindai" — daftar acara hari ini yang dapat dipilih */
function renderPresensiSesi() {
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
function renderRiwayat() {
  const body = $('riwayatBody');
  const title = $('riwayatTitle');
  const scope = $('riwayatScope');
  const staffView = isStaff();
  const adminView = isAdmin();
  const mine = (staffView ? state.presensi.slice() : state.presensi.filter(p => p.userId === state.currentUser.id))
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  const kolom = adminView ? 6 : 5;
  if (title) title.textContent = staffView ? 'Riwayat Presensi (Semua)' : 'Riwayat Presensi Saya';
  if (scope) {
    scope.textContent = adminView
      ? 'Seluruh presensi peserta — Anda dapat menghapus catatan yang keliru.'
      : (staffView ? 'Seluruh presensi peserta — Pengurus hanya dapat melihat (baca saja).'
        : 'Presensi pribadi Anda.');
  }

  if (!mine.length) {
    body.innerHTML = '<tr><td colspan="' + kolom + '"><div class="empty">' + ic('codex', 'ic-lg') +
      '<div>Belum ada riwayat presensi</div></div></td></tr>';
    return;
  }

  body.innerHTML = mine.map(p => `
    <tr>
      <td data-label="Tanggal">${fmtDate(p.timestamp)}
        <div class="tiny muted">${fmtTime(p.timestamp)}</div></td>
      <td data-label="Sesi">${esc(p.jadwalNama || '-')}
        <div class="tiny muted">${esc(p.venue || '')}</div></td>
      <td data-label="Status"><span class="badge badge-${esc(p.status)}">${esc(p.status)}</span></td>
      <td data-label="Nama">${esc(p.userName || '-')}</td>
      <td data-label="Metode">Pindai QR</td>${adminView ? `
      <td data-label="Kelola">
        <button class="btn btn-danger btn-sm" type="button" onclick="deletePresensi('${esc(p.id)}')">
          ${ic('scrap')}Hapus
        </button>
      </td>` : ''}
    </tr>`).join('');
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
  if (info) info.textContent = j.nama + ' · ' + hariID(j.tanggal) + ', ' +
    fmtDateTime(j.tanggal) + ' · ' + j.venue + ' · radius ' + j.radius +
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
    head = ['Nama', 'Username', 'Hadir', 'Izin', 'Tanpa Ket.', 'Persentase'];
    lines = people.map(u => {
      const up = state.presensi.filter(p => p.userId === u.id &&
        (!from || !to || (new Date(p.timestamp) >= f && new Date(p.timestamp) <= t)));
      const h = up.filter(p => p.status === 'hadir').length;
      const iz = up.filter(p => p.status === 'izin').length;
      const pct = up.length ? Math.round(h / up.length * 100) + '%' : '0%';
      return [u.nama, u.username, h, iz, Math.max(0, up.length - h - iz), pct].map(csvCell).join(';');
    });
    fname = 'rekap_' + (from || 'semua') + '_' + (to || 'semua') + '.csv';
  } else {
    const r = laporanAcaraRows();
    if (!r.jadwal) { toast('Pilih acara terlebih dahulu', 'error'); return; }
    const j = r.jadwal;
    head = ['No', 'Tanggal', 'Hari', 'Acara', 'Venue', 'Nama Peserta', 'Status',
      'Waktu Presensi', 'Metode', 'Jarak (m)', 'Keterangan'];
    lines = r.rows.map((p, i) => [i + 1, fmtDate(j.tanggal), hariID(j.tanggal), j.nama, j.venue,
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

/* Cetak PDF via dialog cetak browser (pilih "Save as PDF").
   Hanya kop + tabel acara yang dicetak agar rapi di kertas. */
function printLaporanAcara() {
  const r = laporanAcaraRows();
  if (!r.jadwal) { toast('Pilih acara terlebih dahulu', 'error'); return; }
  if (!r.rows.length) { toast('Belum ada presensi pada acara ini', 'error'); return; }
  const j = r.jadwal;
  const nHadir = r.rows.filter(x => x.status === 'hadir').length;
  const nIzin = r.rows.filter(x => x.status === 'izin').length;
  const rowsHtml = r.rows.map((p, i) =>
    '<tr><td>' + (i + 1) + '</td><td>' + esc(p.userName || '-') + '</td>' +
    '<td>' + esc(p.status) + '</td><td>' + esc(fmtDateTime(p.timestamp)) + '</td>' +
    '<td>Pindai QR</td>' +
    '<td>' + esc(p.keterangan || '-') + '</td></tr>').join('');
  const w = window.open('', '_blank', 'width=900,height=700');
  if (!w) { toast('Popup diblokir — izinkan popup untuk mencetak', 'error'); return; }
  w.document.write('<!DOCTYPE html><html lang="id"><head><meta charset="utf-8">' +
    '<title>Daftar Hadir — ' + esc(j.nama) + '</title>' +
    '<style>body{font-family:Georgia,serif;color:#111;margin:28px}' +
    'h1{font-size:20px;margin:0}.sub{color:#555;font-size:13px;margin:4px 0 14px}' +
    'table{width:100%;border-collapse:collapse;font-size:13px}' +
    'th,td{border:1px solid #999;padding:6px 8px;text-align:left}th{background:#eee}' +
    '.kop{text-align:center;border-bottom:3px double #333;padding-bottom:10px;margin-bottom:14px}' +
    '.sig{display:flex;justify-content:space-between;margin-top:34px;font-size:13px}' +
    '@media print{.noprint{display:none}}</style></head><body>' +
    '<div class="kop"><h1>PRESENSI IGNASIAN — DAFTAR HADIR</h1><div>Ad Maiorem Dei Gloriam</div></div>' +
    '<h1>' + esc(j.nama) + '</h1>' +
    '<p class="sub">Hari: ' + esc(hariID(j.tanggal)) + ' · Tanggal: ' + esc(fmtDateTime(j.tanggal)) +
    ' · Venue: ' + esc(j.venue) + ' · Radius: ' + esc(j.radius) + ' m<br>Hadir: ' + nHadir +
    ' · Izin: ' + nIzin + ' · Total tercatat: ' + r.rows.length + '</p>' +
    '<table><thead><tr><th>No</th><th>Nama Peserta</th><th>Status</th>' +
    '<th>Waktu</th><th>Metode</th><th>Keterangan</th></tr></thead><tbody>' +
    rowsHtml + '</tbody></table>' +
    '<div class="sig"><div>Mengetahui,<br><br><br>(___________________)</div>' +
    '<div>Petugas,<br><br><br>(___________________)</div></div>' +
    '<p class="noprint"><button onclick="window.print()">Cetak / Simpan PDF</button></p>' +
    '</body></html>');
  w.document.close();
  try { addLog('PRINT_LAPORAN', { jadwalId: j.id, nama: j.nama }); } catch (e) {}
}

/* ---------- 19b. KELOLA PRESENSI PER ACARA (HANYA ADMIN) -------------- */
/* Pengurus: READ-ONLY (tombol Kelola disembunyikan). */
function editPresensi(id) {
  if (!isAdmin()) { toast('Hanya Administrator yang dapat mengubah presensi', 'error'); return; }
  const p = state.presensi.find(x => String(x.id) === String(id));
  if (!p) { toast('Data presensi tidak ditemukan', 'error'); return; }
  showModal('Ubah Presensi',
    '<div class="form-group"><label>Status kehadiran</label>' +
    '<select id="editPresStatus" class="form-control">' +
    '<option value="hadir"' + (p.status === 'hadir' ? ' selected' : '') + '>Hadir</option>' +
    '<option value="izin"' + (p.status === 'izin' ? ' selected' : '') + '>Izin</option>' +
    '</select></div>' +
    '<div class="form-group"><label>Keterangan</label>' +
    '<input type="text" id="editPresKet" class="form-control" value="' + esc(p.keterangan || '') + '" /></div>' +
    '<p class="tiny muted">' + esc(p.userName || '') + ' · ' + esc(fmtDateTime(p.timestamp)) + '</p>' +
    '<div class="modal-actions"><button class="btn btn-ghost" onclick="closeModal()">Batal</button>' +
    '<button class="btn btn-primary" onclick="saveEditPresensi(\'' + esc(p.id) + '\')">' + ic('seal') + 'Simpan</button></div>');
}

function saveEditPresensi(id) {
  if (!isAdmin()) { toast('Hanya Administrator yang dapat mengubah presensi', 'error'); return; }
  const p = state.presensi.find(x => String(x.id) === String(id));
  if (!p) { toast('Data presensi tidak ditemukan', 'error'); return; }
  p.status = $('editPresStatus') ? $('editPresStatus').value : p.status;
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
    '<button class="btn btn-danger" onclick="confirmDeletePresensi(\'' + esc(p.id) + '\')">' + ic('scrap') + 'Hapus</button></div>');
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
    body.innerHTML = '<tr><td colspan="5"><div class="empty">' + ic('bulla', 'ic-lg') +
      '<div>Tidak ada data peserta</div></div></td></tr>';
    return;
  }

  body.innerHTML = people.map(u => {
    const up = filtered.filter(p => p.userId === u.id);
    const h = up.filter(p => p.status === 'hadir').length;
    const i = up.filter(p => p.status === 'izin').length;
    const total = up.length;
    const pct = total > 0 ? Math.round((h / total) * 100) : 0;
    return `<tr>
      <td data-label="Nama">${esc(u.nama)}<div class="tiny muted">@${esc(u.username)}</div></td>
      <td data-label="Hadir"><strong>${h}</strong></td>
      <td data-label="Izin">${i}</td>
      <td data-label="Tanpa Ket.">${Math.max(0, total - h - i)}</td>
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
  const list = !q ? state.users : state.users.filter(u =>
    String(u.nama || '').toLowerCase().includes(q) ||
    String(u.username || '').toLowerCase().includes(q) ||
    String(roleName(u.role) || '').toLowerCase().includes(q));
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
    return `
    <tr>
      <td data-label="Nama"><div class="u-ident"><span class="u-ava" aria-hidden="true">${esc((u.nama || u.username || '?').trim().charAt(0).toUpperCase())}</span><span class="u-id"><strong class="u-name">${esc(u.nama)}</strong><span class="tiny muted u-user">@${esc(u.username)}</span></span></div></td>
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
    ic('seal') + 'Tutup</button></div>');
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
    ic('seal') + 'Simpan</button></div>');
}

function isiPasswordAcak() {
  const el = $('resetPassBaru');
  if (el) { el.value = passwordAcak(); el.focus(); }
}

async function simpanResetPassword(id) {
  if (!isAdmin()) { toast('Hanya Administrator yang dapat mengatur ulang password', 'error'); return; }
  const u = state.users.find(x => String(x.id) === String(id));
  if (!u) { toast('Akun tidak ditemukan', 'error'); return; }
  const baru = $('resetPassBaru') ? $('resetPassBaru').value.trim() : '';
  if (!baru || baru.length < 6) { toast('Password minimal 6 karakter', 'error'); return; }

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
    ic('seal') + 'Selesai</button></div>');
}

/* ---------- 11c. LUPA PASSWORD (LAYAR MASUK) ---------------------------- */
/* Pengurus/Peserta memasukkan nomor HP/WA terdaftar → permintaan masuk ke
   Administrator yang sedang masuk → Administrator menghubungi via WhatsApp. */

function normalisasiHp(input) {
  return String(input || '').replace(/\D/g, '');
}

/* Cari akun berdasarkan nomor HP/WA (mendukung awalan 0 / 62 / 8) */
function cariUserByHp(input) {
  const n = normalisasiHp(input);
  if (n.length < 8) return null;
  const kandidat = new Set([n]);
  if (n.slice(0, 2) === '62') kandidat.add('0' + n.slice(2));
  else if (n.charAt(0) === '0') kandidat.add('62' + n.slice(1));
  if (n.charAt(0) === '0') kandidat.add(n.slice(1));
  else if (n.charAt(0) === '6') kandidat.add(n.slice(2));   /* 62812… → 812… */

  return (state.users || []).find(u => {
    const simpanan = [
      normalisasiHp(u.hpPlain),
      normalisasiHp(u.hpHash)     /* pencocokan hash hanya bila input = hash (tidak lazim) */
    ];
    return simpanan.some(s => s && kandidat.has(s));
  }) || null;
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
    ic('keyring') + 'Kirim Permintaan</button></div>');
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
      ic('seal') + 'Siap, Saya Tunggu</button></div>');
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
function saveJadwal() {
  if (!isStaff()) { toast('Hanya Administrator & Pengurus yang dapat membuat jadwal', 'error'); return; }

  const nama = $('jadwalNama').value.trim();
  const tgl = $('jadwalTgl').value;
  const venue = $('jadwalVenue').value.trim();
  const durasi = parseInt($('jadwalDurasi').value, 10) || 60;
  const radius = parseInt($('jadwalRadius').value, 10) || 50;
  const lat = parseFloat($('jadwalLat').value);
  const lng = parseFloat($('jadwalLng').value);

  if (!nama || !tgl || !venue || isNaN(lat) || isNaN(lng)) {
    toast('Lengkapi nama, waktu, venue, dan koordinat lokasi', 'error');
    return;
  }

  const now = new Date().toISOString();
  const j = {
    id: uid(), nama: nama, venue: venue, durasi: durasi, radius: radius,
    lat: lat, lng: lng,
    tanggal: new Date(tgl).toISOString(),
    createdAt: now, updatedAt: now,
    createdBy: state.currentUser.id
  };
  state.jadwal.push(j);
  saveLocal();
  enqueue('jadwal', j);
  addLog('CREATE_JADWAL', { jadwalId: j.id, nama: nama, venue: venue });
  toast('Jadwal tersimpan di perangkat', 'success');

  ['jadwalNama', 'jadwalTgl', 'jadwalVenue'].forEach(id => { $(id).value = ''; });
  $('jadwalLat').value = '';
  $('jadwalLng').value = '';
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
    return `
      <div class="entry ${active ? 'is-active' : 'is-done'}">
        <div class="entry-head">
          <div class="body">
            <div class="entry-title">${esc(j.nama)}</div>
            <div class="entry-meta">
              <span>${ic('compass', 'ic-sm')} ${esc(j.venue)}</span>
              <span>${ic('horarium', 'ic-sm')} ${fmtDateTime(j.tanggal)}–${fmtTime(end)}</span>
              <span>radius ${esc(j.radius)} m · ${esc(j.durasi)} menit</span>
            </div>
          </div>
          <span class="badge ${active ? 'badge-aktif' : 'badge-nonaktif'}">${active ? 'aktif' : 'selesai'}</span>
        </div>
        <div class="entry-actions">
          <button class="btn btn-outline btn-sm" onclick="deleteJadwal('${esc(j.id)}')">${ic('scrap')}Hapus</button>
        </div>
      </div>`;
  }).join('');
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
    '<button class="btn btn-danger" onclick="confirmClearLogs()">' + ic('scrap') + 'Hapus Semua</button></div>');
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
  setText('setNet', on ? 'Daring — peranti terhubung' : 'Luring — peranti tanpa sambungan');
  setText('setDb', typeof supaStatusText === 'function'
    ? supaStatusText()
    : 'Basis data belum diatur');
  setText('setApi', apiReady()
    ? (state.apiHint ? 'Perlu perhatian: ' + state.apiHint : 'Supabase tersambung — sinkronisasi otomatis aktif')
    : 'Mode mandiri — isi SUPABASE_URL & SUPABASE_ANON_KEY pada js/config.js');
  setText('setQueue', state.outbox.length
    ? state.outbox.length + ' perubahan menunggu dikirim'
    : 'Tidak ada perubahan menunggu');
  setText('setLastSync', state.meta.lastSync ? fmtDateTime(state.meta.lastSync) : 'Belum pernah tersinkron');
  setText('setData', state.users.length + ' pengguna · ' + state.jadwal.length + ' jadwal · ' +
    state.presensi.length + ' presensi · ' + state.logs.length + ' catatan');

  const btn = $('btnSyncNow');
  if (btn) btn.disabled = !apiReady() || !on || state.syncing;
}

/* Uji koneksi basis data — untuk memastikan deploy berhasil sebelum dipakai.
   Dibuka dari menu Pengaturan → "Uji Koneksi Database" (HANYA ADMIN). */
async function testSupabase() {
  if (!isAdmin()) { toast('Uji koneksi basis data hanya untuk Administrator', 'error'); return; }
  if (typeof supaDiagnose !== 'function') { toast('Lapisan data Supabase tidak termuat', 'error'); return; }
  showModal('Uji Koneksi Basis Data',
    '<p class="small muted">Memeriksa Supabase… mohon tunggu sejenak.</p>');
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

  (report.tables || []).forEach(t => {
    body += '<div class="list-item">' + ic(t.ok ? 'seal' : 'scrap') +
      '<div class="body"><strong>Tabel ' + esc(t.name) + '</strong>' +
      '<div class="meta">' + (t.ok
        ? (t.count == null ? 'terbaca' : esc(String(t.count)) + ' baris')
        : esc(t.error || 'gagal dibaca')) +
      '</div></div></div>';
  });
  body += '</div>';

  body += report.ok
    ? '<p class="small mt-14">Basis data siap dipakai: keempat tabel terbaca dengan kunci anon. ' +
      'Presensi, jadwal, dan akun akan disinkronkan otomatis.</p>'
    : '<p class="small mt-14">' + esc(report.error || 'Sebagian tabel belum siap dipakai.') + '</p>';

  body += '<div class="modal-actions">' +
    '<button class="btn btn-primary" onclick="closeModal()">' + ic('seal') + 'Tutup</button></div>';
  showModal('Uji Koneksi Basis Data', body);
}

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
  toast('Data peranti dimuat ulang', 'success');
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
}

/* ---------- 27. BANTUAN -------------------------------------------------- */
function renderBantuan() {
  /* Panduan disaring sesuai peran: blok bertanda data-role pada index.html
     hanya tampil untuk peran yang bersangkutan. */
  applyRoleVisibility();
  setText('bantuanVersi', 'Versi ' + CONFIG.VERSION);
  const role = state.currentUser ? state.currentUser.role : '';
  setText('bantuanPeran', roleName(role));
  setText('bantuanLuring', apiReady()
    ? (isOnline()
      ? 'Peranti daring — data disinkronkan otomatis ke Supabase.'
      : 'Peranti luring — data ditahan di perangkat lalu dikirim otomatis ke Supabase saat kembali daring.')
    : 'Mode mandiri: seluruh data tersimpan di peranti ini (Supabase belum dikonfigurasi).');
}

/* ---------- 28. MODAL -------------------------------------------------- */
function showModal(title, content) {
  $('modalContent').innerHTML = '<h3>' + esc(title) + '</h3>' + content;
  $('modal').classList.add('show');
}
function closeModal() { $('modal').classList.remove('show'); }

/* ---------- 29. PEMASANGAN AWAL --------------------------------------- */
function bindEvents() {
  const modal = $('modal');
  if (modal) modal.addEventListener('click', e => { if (e.target.id === 'modal') closeModal(); });
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
  } catch (e) { console.warn('Database tidak tersedia', e); }
  applyTheme(_themeCache || systemTheme(), false);
  watchSystemTheme();

  await loadLocal();
  /* Akun contoh hanya untuk pemakaian mandiri; pada mode Supabase akun dibuat
     lewat menu Registrasi atau supabase/seed.sql. */
  if (!state.users.length && !apiReady()) await seedDefaultUsers();

  bindEvents();
  applyRoleVisibility();
  updateSyncUI();
  setupConnectivity();
  startSessionWatch();          /* pengawas time-out login: 6 jam / 12 jam */
  await restoreActiveJadwal();  /* pintasan "Sesi Hari Ini" tetap tersimpan */

  /* Halaman terakhir (dari #hash) DIPERTAHANKAN ketika halaman disegarkan —
     pengguna tetap berada di halaman yang sama, tanpa kedipan ke layar masuk.
     Hanya sesudah LOGIN penuh pengguna diarahkan ke Beranda. */
  const bootPage = (location.hash || '').replace('#', '').trim();

  if (await checkSession()) {
    showMainApp(bootPage || 'home');
  } else {
    showLoginScreen();
    if (_sessionExpiredAtBoot) {
      showModal('Sesi Anda Berakhir',
        '<p>Terima kasih atas kesetiaan Anda melayani hari ini.</p>' +
        '<p class="small mt-6">Demi keamanan akun, sesi sebelumnya ditutup otomatis karena masa berlakunya habis. ' +
        'Tidak ada data yang hilang — semuanya sudah tersimpan dan akan dikirim saat Anda masuk kembali.</p>' +
        '<div class="modal-actions"><button class="btn btn-primary" onclick="closeModal()">' +
        ic('keycross') + 'Mengerti, Masuk Kembali</button></div>');
    }
  }
  } catch (fatalErr) {
    console.warn('init() gagal sebagian — tetap tampil agar tidak macet:', fatalErr);
    try { showLoginScreen(); } catch (e2) {}
  } finally {
    _releaseBootOnce();
  }

  /* Sinkron di latar: kirim antrean lebih dahulu, lalu tarik data baru.
     Tidak menahan tampilan — aplikasi sudah dapat dipakai saat luring.
     Wajib .catch() agar kegagalan jaringan/izin tidak muncul sebagai
     "Uncaught (in promise)" di console. */
  if (apiReady() && isOnline()) {
    try {
      var _p = flushQueue().then(() => pullRemote(true));
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













