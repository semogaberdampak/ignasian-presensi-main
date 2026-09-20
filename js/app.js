/* ============================================================
   PRESENSI IGNASIAN — Aplikasi Inti
   ------------------------------------------------------------
   Prinsip: OFFLINE FIRST, sinkron daring menyusul.
   1) Setiap perubahan langsung ditulis ke penyimpanan perangkat.
   2) Perubahan masuk ke antrean (outbox) yang dikirim ke server
      saat perangkat kembali daring (berurutan, tanpa kehilangan data).
   3) Data server DIGABUNG (merge) — tidak menimpa perubahan lokal
      yang belum terkirim.
   ============================================================ */

/* ---------- 1. KONFIGURASI ------------------------------------------------ */
const CONFIG = {
  APP_NAME: 'Presensi Ignasian',
  VERSION: '4.0.1',
  // Ganti dengan URL Google Apps Script Web App Anda setelah deploy
  API_URL: 'https://script.google.com/macros/s/AKfycbyIVir8J18Am5ZW9Q8NdMimXgUvvFnAihv2f6YfATwzgVDfGTJB-iSLpEjjNv-Hm2jA/exec',
  SYNC_INTERVAL: 60000,   // 60 detik saat daring
  MAX_USERS: 50,
  MAX_QUEUE: 500,
  MAX_LOG: 500
};

const STORE_KEYS = {
  users: 'ign_users', jadwal: 'ign_jadwal', presensi: 'ign_presensi',
  logs: 'ign_logs', session: 'ign_session', outbox: 'ign_outbox',
  tomb: 'ign_tombstones', meta: 'ign_meta', theme: 'ign_theme'
};

const STAFF_ROLES = ['admin', 'pengurus'];
/* Halaman yang dikunci per peran — JADWAL & BUAT QR hanya ADMIN/PENGURUS */
const PAGE_ACCESS = {
  jadwal: 'staff', 'qr-gen': 'staff', log: 'staff',
  users: 'admin', registrasi: 'admin'
};
const ROLE_LABEL = { admin: 'Administrator', pengurus: 'Pengurus', peserta: 'Peserta' };

/* ---------- 2. STATE ----------------------------------------------------- */
let state = {
  currentUser: null,
  users: [], jadwal: [], presensi: [], logs: [],
  outbox: [], tombstones: [],
  meta: { lastSync: null, mountedAt: new Date().toISOString() },
  scanner: null,
  map: null, mapJadwal: null, markerJadwal: null,
  userLat: null, userLng: null,
  syncing: false, activePage: 'home'
};

/* ---------- 3. UTILITAS -------------------------------------------------- */
const $ = id => document.getElementById(id);

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

function systemTheme() {
  return (window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
}
function storedTheme() {
  try {
    const v = localStorage.getItem(STORE_KEYS.theme);
    return (v === 'dark' || v === 'light') ? v : null;
  } catch (e) { return null; }
}
function currentTheme() { return storedTheme() || systemTheme(); }

/* Terapkan tema ke <html data-theme>; perbarui sakelar, label, dan warna bilah */
function applyTheme(mode, persist) {
  const m = (mode === 'dark') ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', m);
  if (persist) { try { localStorage.setItem(STORE_KEYS.theme, m); } catch (e) { /* luring */ } }

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
/* ---------- 5. PENYIMPANAN PERANGKAT (OFFLINE FIRST) --------------------- */
function readJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const val = JSON.parse(raw);
    return (val === null || val === undefined) ? fallback : val;
  } catch (e) { return fallback; }
}

function saveLocal() {
  try {
    localStorage.setItem(STORE_KEYS.users, JSON.stringify(state.users));
    localStorage.setItem(STORE_KEYS.jadwal, JSON.stringify(state.jadwal));
    localStorage.setItem(STORE_KEYS.presensi, JSON.stringify(state.presensi));
    localStorage.setItem(STORE_KEYS.logs, JSON.stringify(state.logs));
    localStorage.setItem(STORE_KEYS.outbox, JSON.stringify(state.outbox));
    localStorage.setItem(STORE_KEYS.tomb, JSON.stringify(state.tombstones));
    localStorage.setItem(STORE_KEYS.meta, JSON.stringify(state.meta));
    return true;
  } catch (e) {
    toast('Penyimpanan perangkat penuh — mohon sinkronkan lalu bersihkan', 'error');
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

function loadLocal() {
  state.users = stampAll(readJson(STORE_KEYS.users, []), 'createdAt');
  state.jadwal = stampAll(readJson(STORE_KEYS.jadwal, []), 'createdAt');
  state.presensi = stampAll(readJson(STORE_KEYS.presensi, []), 'timestamp');
  state.logs = stampAll(readJson(STORE_KEYS.logs, []), 'timestamp');
  state.outbox = readJson(STORE_KEYS.outbox, []);
  state.tombstones = readJson(STORE_KEYS.tomb, []);
  state.meta = Object.assign({ lastSync: null }, readJson(STORE_KEYS.meta, {}));
}

/* ---------- 6. ANTREAN SINKRON (OUTBOX) --------------------------------- */
function apiReady() {
  return !!CONFIG.API_URL && CONFIG.API_URL.indexOf('YOUR_DEPLOYMENT_ID') === -1;
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

function queueDelete(collection, id) {
  state.tombstones.push({ c: collection, id: id, ts: Date.now() });
  if (state.tombstones.length > 300) state.tombstones = state.tombstones.slice(-300);
  state.outbox = state.outbox.filter(o =>
    !(o.data && o.data.id === id && (o.type === collection || o.type === 'delete')));
  return enqueue('delete', { collection: collection, id: id });
}

function isTombstoned(coll, id) {
  return state.tombstones.some(t => t.c === coll && t.id === id);
}
function pendingIds(coll) {
  const ids = new Set();
  state.outbox.forEach(o => { if (o.type === coll && o.data && o.data.id) ids.add(o.data.id); });
  return ids;
}

async function postToServer(op) {
  try {
    await fetch(CONFIG.API_URL, {
      method: 'POST',
      mode: 'no-cors',                       // respons opaque: cukup tahu terkirim
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({
        type: op.type, data: op.data, ts: op.ts, opId: op.opId,
        user: state.currentUser ? state.currentUser.username : null
      })
    });
    return true;
  } catch (e) {
    return false;
  }
}

async function flushQueue() {
  if (state.syncing || !apiReady() || !isOnline() || state.outbox.length === 0) {
    updateSyncUI();
    return;
  }
  state.syncing = true;
  updateSyncUI();
  let sent = 0;
  try {
    while (state.outbox.length) {
      const op = state.outbox[0];
      const ok = await postToServer(op);
      if (!ok) {
        op.tries = (op.tries || 0) + 1;
        op.lastTry = new Date().toISOString();
        break;                               // coba lagi pada pemicu berikutnya
      }
      state.outbox.shift();
      sent++;
      saveLocal();
      updateSyncUI();
    }
    if (sent) state.meta.lastSync = new Date().toISOString();
  } finally {
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
  ['users', 'jadwal', 'presensi', 'logs'].forEach(key => {
    if (!Array.isArray(data[key])) return;
    const before = sig(state[key]);
    state[key] = mergeList(state[key], data[key], key);
    if (sig(state[key]) !== before) changed = true;
  });
  return changed;
}

async function pullRemote(silent) {
  if (!apiReady() || !isOnline()) { updateSyncUI(); return false; }
  /* Jangan spam server yang URL-nya salah/404: jeda 5 menit setelah gagal,
     agar console tidak penuh "GET ... 404" seperti di laporan. */
  if (state.backoffUntil && Date.now() < state.backoffUntil) { updateSyncUI('error'); return false; }
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    let res;
    try {
      res = await fetch(CONFIG.API_URL + '?action=getAll&t=' + Date.now(), { cache: 'no-store', signal: ctrl.signal });
    } finally { clearTimeout(timer); }
    if (res.status === 404) {
      state.backoffUntil = Date.now() + 5 * 60 * 1000;
      state.apiHint = 'URL Apps Script 404 — deploy ulang GAS sebagai Web App (akses: Anyone) lalu ganti CONFIG.API_URL. Data tetap aman lokal.';
      console.warn('Sinkron getAll: HTTP 404 — URL Web App salah / belum deploy Anyone. Backoff 5 menit.');
      updateSyncUI('error');
      return false;
    }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    let data;
    try {
      data = await res.json();
    } catch (e) {
      /* GAS kadang mengembalikan HTML (mis. halaman izin / redirect login).
         Itu bukan kegagalan jaringan — abaikan diam-diam agar tidak dianggap luring. */
      updateSyncUI('ok-local');
      return false;
    }
    state.apiHint = null;
    const changed = mergeRemote(data);
    state.meta.lastSync = new Date().toISOString();
    saveLocal();
    if (changed) {
      renderActivePage();
      if (!silent) toast('Data diperbarui dari server', 'success');
    }
    updateSyncUI();
    return true;
  } catch (e) {
    if (e && e.name === 'AbortError') updateSyncUI('error');
    else updateSyncUI('error');
    return false;
  }
}

/* Urutan: kirim antrean dahulu, lalu ambil pembaruan dari server */
function syncNow(manual) {
  if (!apiReady()) {
    if (manual) toast('Alamat API server belum diatur pada CONFIG.API_URL', 'error');
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
      toast(left ? left + ' data belum terkirim, akan dicoba lagi' : 'Sinkronisasi selesai · data terbaru',
        left ? 'error' : 'success');
    }
    return true;
  })();
}

/* ---------- 8. INDIKATOR STATUS SINKRON --------------------------------- */
function updateSyncUI(stateOverride) {
  const pend = state.outbox.length;
  let msg = null;

  /* stateOverride dipakai agar kegagalan server tidak dikira luring —
     data lokal tetap aman di perangkat. */
  if (!apiReady()) msg = 'Mode mandiri · seluruh data tersimpan di perangkat ini';
  else if (!isOnline()) msg = 'Luring · ' + (pend ? pend + ' data menunggu sinkron' : 'data tersimpan lokal, sinkron otomatis saat daring');
  else if (stateOverride === 'error') msg = state.apiHint || ('Sinkron gagal · data tetap aman di perangkat ini' + (pend ? ' · ' + pend + ' antre' : ''));
  else if (state.syncing) msg = 'Menyinkronkan data…';
  else if (pend) msg = pend + ' data menunggu sinkron';

  const bar = $('syncBar');
  if (bar) bar.classList.toggle('show', !!msg);
  const text = $('syncBarText');
  if (text && msg) text.textContent = msg;
  const btn = $('syncBarBtn');
  if (btn) btn.classList.toggle('hidden', !apiReady() || !isOnline());
  const chip = $('userSync');
  if (chip) chip.textContent = !apiReady() ? 'Mandiri' : (!isOnline() ? 'Luring' : (state.syncing ? 'Sinkron…' : (pend ? pend + ' antre' : (state.meta.lastSync ? 'Sinkron' : 'Daring'))));

  if ($('page-pengaturan') && !$('page-pengaturan').classList.contains('hidden')) renderSettingsSync();
}

/* Pemicu sinkron: kembali daring, kembali ke aplikasi, berkala, dan dari SW */
function setupConnectivity() {
  window.addEventListener('online', () => {
    toast('Kembali daring — menyinkronkan…', 'success');
    syncNow(false);
  });
  window.addEventListener('offline', () => {
    toast('Mode luring aktif — presensi tetap tersimpan di perangkat', 'info');
    updateSyncUI();
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.currentUser) syncNow(false);
  });
  setInterval(() => { if (state.currentUser) syncNow(false); }, CONFIG.SYNC_INTERVAL);

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', ev => {
      if (ev.data && ev.data.type === 'flush-outbox') syncNow(false);
    });
    navigator.serviceWorker.register('sw.js').then(reg => {
      if ('sync' in reg) { try { reg.sync.register('ign-outbox'); } catch (e) { /* opsional */ } }
    }).catch(e => console.warn('Service worker gagal didaftarkan', e));
  }
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
}

/* ---------- 11. MASUK / KELUAR ------------------------------------------ */
async function doLogin() {
  const u = $('loginUser').value.trim();
  const p = $('loginPass').value;
  if (!u || !p) { toast('Lengkapi username & password', 'error'); return; }

  if (state.users.length === 0) await seedDefaultUsers();

  const btn = $('btnLogin');
  if (btn) { btn.disabled = true; btn.dataset.label = btn.innerHTML; btn.textContent = 'Memeriksa…'; }

  try {
    const passHash = await sha256(p);
    const needle = u.toLowerCase();
    const user = state.users.find(x =>
      String(x.username || '').toLowerCase() === needle && x.passHash === passHash && x.status === 'aktif');

    if (!user) { toast('Username/password salah atau akun nonaktif', 'error'); return; }

    state.currentUser = user;
    try { localStorage.setItem(STORE_KEYS.session, JSON.stringify({ id: user.id, t: Date.now() })); } catch (e) { /* abaikan */ }
    addLog('LOGIN', { username: user.username });
    toast('Selamat datang, ' + user.nama + '!', 'success');
    showMainApp();
  } finally {
    if (btn) { btn.disabled = false; if (btn.dataset.label) btn.innerHTML = btn.dataset.label; }
  }
}

function doLogout() {
  if (state.currentUser) addLog('LOGOUT', { username: state.currentUser.username });
  state.currentUser = null;
  try { localStorage.removeItem(STORE_KEYS.session); } catch (e) { /* abaikan */ }
  stopScanner();
  $('mainApp').classList.add('hidden');
  $('loginScreen').classList.remove('hidden');
  $('loginUser').value = '';
  $('loginPass').value = '';
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
}

/* Pengguna contoh untuk pemakaian pertama (ganti password di produksi) */
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

function checkSession() {
  const s = readJson(STORE_KEYS.session, null);
  if (!s || !s.id) return false;
  const user = state.users.find(u => u.id === s.id && u.status === 'aktif');
  if (!user) return false;
  state.currentUser = user;
  return true;
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
    case 'presensi':
      renderManualSesi();
      if (!$('presensi-manual').classList.contains('hidden')) setTimeout(initMap, 120);
      break;
    case 'riwayat': renderRiwayat(); break;
    case 'laporan': prepareLaporan(); break;
    case 'lainnya': renderLainnya(); break;
    case 'profil': loadProfil(); break;
    case 'pengaturan': applyTheme(currentTheme(), false); renderSettingsSync(); break;
    case 'users': renderUsers(); break;
    case 'jadwal': renderJadwal(); setTimeout(initMapJadwal, 120); break;
    case 'qr-gen': renderQrJadwalSelect(); break;
    case 'log': renderLog(); break;
    case 'bantuan': renderBantuan(); break;
    default: break;
  }
}
function renderActivePage() { renderPage(state.activePage); }

function showMainApp() {
  $('loginScreen').classList.add('hidden');
  $('mainApp').classList.remove('hidden');

  renderUserChip();
  applyRoleVisibility();
  updateSyncUI();

  const hash = (location.hash || '').replace('#', '');
  showPage(hash && canAccess(hash) ? hash : 'home');
}

/* Kartu pengguna di kepala aplikasi (memuat indikator sinkron) */
function renderUserChip() {
  const u = state.currentUser;
  if (!u || !$('userChip')) return;
  $('userChip').innerHTML =
    '<span class="who">' + esc(u.nama) + '</span>' +
    '<span class="role">' + esc(roleName(u.role)) + '</span>' +
    '<span class="sync-mini" id="userSync">Sinkron</span>';
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

  if (isStaff()) {
    /* ADMIN & PENGURUS: ringkasan seluruh peserta + arus aktivitas sistem */
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
    const actCard = $('homeActivityCard');
    if (actCard) actCard.classList.remove('hidden');

    const upcoming = state.jadwal
      .filter(j => new Date(j.tanggal).getTime() > Date.now())
      .sort((a, b) => new Date(a.tanggal) - new Date(b.tanggal))
      .slice(0, 3);
    extra.innerHTML = cardWrap('horarium', 'Jadwal Mendatang', upcoming.length
      ? '<div class="list">' + upcoming.map(j => `
          <div class="list-item">
            ${ic('horarium')}
            <div class="body">
              <strong>${esc(j.nama)}</strong>
              <div class="meta">${esc(j.venue)} · ${fmtDateTime(j.tanggal)}</div>
            </div>
          </div>`).join('') + '</div>'
      : '<div class="empty">' + ic('horarium', 'ic-lg') + '<div>Belum ada jadwal mendatang</div></div>');
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

  const todaySessions = state.jadwal
    .filter(j => new Date(j.tanggal).toDateString() === now.toDateString())
    .sort((a, b) => new Date(a.tanggal) - new Date(b.tanggal));

  const last = mine.slice().sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))[0];

  extra.innerHTML =
    cardWrap('pilgrim', 'Sesi Hari Ini', todaySessions.length
      ? '<div class="list">' + todaySessions.map(j => {
        const done = mine.find(p => p.jadwalId === j.id);
        const end = new Date(new Date(j.tanggal).getTime() + j.durasi * 60000);
        return `
          <div class="list-item">
            ${ic('pilgrim')}
            <div class="body">
              <strong>${esc(j.nama)}</strong>
              <div class="meta">${esc(j.venue)} · ${fmtTime(j.tanggal)}–${fmtTime(end)}</div>
            </div>
            <span class="badge ${done ? 'badge-' + esc(done.status) : 'badge-role'}">${done ? esc(done.status) : 'belum'}</span>
          </div>`;
      }).join('') + '</div>'
      : '<div class="empty">' + ic('horarium', 'ic-lg') + '<div>Tidak ada sesi hari ini</div></div>') +
    cardWrap('seal', 'Presensi Terakhir Anda', last
      ? `<div class="list-item">${ic('seal')}
          <div class="body">
            <strong>${esc(last.jadwalNama || '-')}</strong>
            <div class="meta">${esc(last.venue || '')} · ${fmtDateTime(last.timestamp)}</div>
            <div class="meta">Metode: ${last.metode === 'qr' ? 'Pindai QR' : 'Presensi GPS'}</div>
          </div>
          <span class="badge badge-${esc(last.status)}">${esc(last.status)}</span>
        </div>`
      : '<div class="empty">' + ic('scrap', 'ic-lg') + '<div>Anda belum pernah presensi</div></div>');
}

/* Catatan aktivitas sistem — khusus ADMIN & PENGURUS */
function renderActivityFeed() {
  const recent = state.logs.slice(0, 8);
  if (!recent.length) {
    return '<div class="empty">' + ic('ledger', 'ic-lg') + '<div>Belum ada catatan aktivitas</div></div>';
  }
  const iconMap = {
    LOGIN: 'keycross', LOGOUT: 'gate', PRESENSI: 'pilgrim', PRESENSI_GAGAL: 'scrap',
    CREATE_USER: 'quill', CREATE_JADWAL: 'horarium', GENERATE_QR: 'matrix',
    DELETE_JADWAL: 'scrap', DELETE_USER: 'scrap', TOGGLE_USER: 'lamp',
    UPDATE_PROFILE: 'halobust', VIEW_LAPORAN: 'bulla', SCAN_ERROR: 'scrap'
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
/* ---------- 15. PRESENSI: TAB, SESI, PETA, LOKASI ---------------------- */
function switchPresensiTab(tab, btn) {
  document.querySelectorAll('#page-presensi .tab').forEach(t => t.classList.remove('active'));
  if (btn) btn.classList.add('active');
  $('presensi-scan').classList.toggle('hidden', tab !== 'scan');
  $('presensi-manual').classList.toggle('hidden', tab !== 'manual');
  if (tab === 'manual') setTimeout(initMap, 120);
}

/* Sesi yang boleh dipresensi: ±1 jam dari jadwal */
function activeSessions() {
  const now = Date.now();
  return state.jadwal.filter(j => {
    const t = new Date(j.tanggal).getTime();
    const end = t + (j.durasi || 60) * 60000;
    return now >= t - 3600000 && now <= end + 3600000;
  });
}

function renderManualSesi() {
  const sel = $('manualSesi');
  const active = activeSessions();
  if (!active.length) {
    sel.innerHTML = '<option value="">Tidak ada sesi aktif saat ini</option>';
    return;
  }
  sel.innerHTML = active
    .map(j => '<option value="' + esc(j.id) + '">' + esc(j.nama) + ' — ' + esc(j.venue) + '</option>')
    .join('');
}

function mapOfflineNotice(id) {
  const el = $(id);
  if (el) {
    el.innerHTML = '<div class="map-offline">' + ic('compass', 'ic-lg') +
      '<div>Peta tidak tersedia saat luring. Koordinat GPS tetap dicatat untuk validasi presensi.</div></div>';
  }
}

function initMap() {
  if (!$('map')) return;
  if (typeof L === 'undefined') { mapOfflineNotice('map'); return; }
  if (state.map) { state.map.invalidateSize(); return; }

  state.map = L.map('map').setView([-2.5, 118], 5);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap', maxZoom: 19
  }).addTo(state.map);

  locateUser(true);
}

/* Ambil posisi GPS — dipakai layar presensi manual */
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
  const info = $('gpsInfo');
  if (!navigator.geolocation) {
    if (info) info.textContent = 'Peranti ini tidak mendukung layanan lokasi.';
    return Promise.resolve(null);
  }
  if (!window.isSecureContext) {
    if (info) info.textContent = 'Lokasi membutuhkan HTTPS/localhost — buka aplikasi via koneksi aman agar GPS aktif.';
    return Promise.resolve(null);
  }
  if (info) info.textContent = 'Mengambil titik lokasi…';
  return new Promise(resolve => {
    try {
      navigator.geolocation.getCurrentPosition(pos => {
        state.userLat = pos.coords.latitude;
        state.userLng = pos.coords.longitude;
    if (info) {
      info.textContent = 'Lokasi: ' + state.userLat.toFixed(6) + ', ' + state.userLng.toFixed(6) +
        ' (±' + Math.round(pos.coords.accuracy || 0) + ' m)';
    }
    if (state.map && typeof L !== 'undefined') {
      if (!state.markerUser) {
        state.markerUser = L.marker([state.userLat, state.userLng]).addTo(state.map).bindPopup('Posisi Anda');
      } else {
        state.markerUser.setLatLng([state.userLat, state.userLng]);
      }
      if (moveMap) state.map.setView([state.userLat, state.userLng], 16);
    }
    resolve(pos);
  }, err => {
    /* Jangan biarkan promise menggantung / uncaught — ini sumber error console. */
    const msg = gpsErrorMessage(err);
    if (info) info.textContent = msg;
    resolve(null);
  }, { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 });
    } catch (e) {
      if (info) info.textContent = gpsErrorMessage(e);
      resolve(null);
    }
  });
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
/* ---------- 16. PRESENSI MANUAL (GPS) ---------------------------------- */
function savePresensi(pres) {
  state.presensi.push(pres);
  saveLocal();
  enqueue('presensi', pres);
  return pres;
}

function submitManual() {
  const sesiId = $('manualSesi').value;
  const status = $('manualStatus').value;
  const ket = $('manualKeterangan').value.trim();

  if (!sesiId) { toast('Pilih sesi acara terlebih dahulu', 'error'); return; }
  const j = state.jadwal.find(x => x.id === sesiId);
  if (!j) { toast('Sesi tidak ditemukan', 'error'); return; }

  if (state.presensi.some(p => p.userId === state.currentUser.id && p.jadwalId === sesiId)) {
    toast('Anda sudah presensi pada sesi ini', 'error');
    return;
  }
  if (state.userLat == null) {
    toast('Titik GPS belum siap — tekan "Perbarui Lokasi" lalu coba lagi', 'error');
    return;
  }

  const dist = haversine(state.userLat, state.userLng, j.lat, j.lng);
  const now = new Date().toISOString();
  savePresensi({
    id: uid(),
    userId: state.currentUser.id,
    userName: state.currentUser.nama,
    jadwalId: j.id,
    jadwalNama: j.nama,
    venue: j.venue,
    status: status,
    keterangan: ket,
    metode: 'manual',
    lat: state.userLat,
    lng: state.userLng,
    distance: dist,
    timestamp: now,
    updatedAt: now
  });
  addLog('PRESENSI', { jadwalId: j.id, metode: 'manual', status: status, distance: Math.round(dist) });
  $('manualKeterangan').value = '';
  toast('Presensi tersimpan di perangkat — sinkron menyusul otomatis', 'success');
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
  if (typeof Html5Qrcode === 'undefined') {
    toast('Pemindai QR belum termuat (peranti luring). Sambungkan ke internet sekali untuk menyimpannya.', 'error');
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
  scanHint('Meminta izin kamera…');
  await ensureScannerStopped();
  const config = { fps: 10, qrbox: { width: 250, height: 250 } };
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
    toast(scanErrorMessage(e), 'error');
    try { addLog('SCAN_ERROR', { error: String((e && e.message) || e) }); } catch (e2) {}
    await stopScanner();
  }
}

async function stopScanner() {
  await ensureScannerStopped();
  scanHint('Menyiapkan kamera…');
  if ($('scannerContainer')) {
    $('scannerContainer').classList.add('hidden');
    $('btnStartScan').classList.remove('hidden');
    $('btnStopScan').classList.add('hidden');
  }
}

async function scanFromFile(input) {
  if (!input || !input.files || !input.files.length) return;
  if (typeof Html5Qrcode === 'undefined') {
    toast('Pemindai QR belum termuat (peranti luring).', 'error');
    input.value = '';
    return;
  }
  const file = input.files[0];
  try {
    toast('Membaca foto QR…', 'info');
    let tmp = document.getElementById('qr-file-reader');
    if (!tmp) {
      tmp = document.createElement('div');
      tmp.id = 'qr-file-reader';
      tmp.style.display = 'none';
      document.body.appendChild(tmp);
    }
    const reader = new Html5Qrcode('qr-file-reader');
    const decoded = await reader.scanFile(file, true);
    try { await reader.clear(); } catch (e) {}
    input.value = '';
    await onScanSuccess(decoded);
  } catch (e) {
    input.value = '';
    toast('Foto tidak mengandung QR yang valid.', 'error');
  }
}

async function onScanSuccess(decoded) {
  await stopScanner();
  try {
    let payload;
    try {
      payload = JSON.parse(decodeURIComponent(escape(atob(decoded))));
    } catch (e2) {
      payload = JSON.parse(atob(decoded));
    }
    if (payload.type !== 'PRESENSI_IGNASIAN') throw new Error('Kode QR bukan milik Presensi Ignasian');

    const start = new Date(payload.start).getTime();
    const end = start + payload.durasi * 60000;
    const now = Date.now();
    if (now < start - 300000 || now > end) throw new Error('Sesi tidak aktif atau sudah berakhir');

    if (state.presensi.some(p => p.userId === state.currentUser.id && p.jadwalId === payload.jadwalId)) {
      throw new Error('Anda sudah presensi pada sesi ini');
    }
    if (!navigator.geolocation) throw new Error('Peranti ini tidak mendukung layanan lokasi');

    toast('Membaca titik lokasi…', 'info');
    if (!window.isSecureContext) {
      toast('Lokasi membutuhkan HTTPS/localhost — buka aplikasi via koneksi aman.', 'error');
      addLog('SCAN_ERROR', { error: 'insecure-context' });
      return;
    }
    try {
    navigator.geolocation.getCurrentPosition(pos => {
      const dist = haversine(pos.coords.latitude, pos.coords.longitude, payload.lat, payload.lng);
      if (dist > payload.radius) {
        toast('Terlalu jauh dari venue (' + dist.toFixed(0) + ' m > ' + payload.radius + ' m)', 'error');
        addLog('PRESENSI_GAGAL', { reason: 'di luar radius', distance: Math.round(dist), jadwalId: payload.jadwalId });
        return;
      }

      const nowIso = new Date().toISOString();
      const pres = {
        id: uid(),
        userId: state.currentUser.id,
        userName: state.currentUser.nama,
        jadwalId: payload.jadwalId,
        jadwalNama: payload.nama,
        venue: payload.venue,
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
      addLog('PRESENSI', { jadwalId: payload.jadwalId, metode: 'qr', distance: Math.round(dist) });

      showModal('Presensi Tercatat',
        '<div class="list-item">' + ic('seal') +
        '<div class="body"><strong>' + esc(payload.nama) + '</strong>' +
        '<div class="meta">' + esc(payload.venue) + '</div>' +
        '<div class="meta">Jarak ' + dist.toFixed(1) + ' m · ' + fmtDateTime(pres.timestamp) + '</div>' +
        '<div class="meta">Tersimpan di perangkat, sinkron menyusul.</div></div></div>' +
        '<div class="modal-actions"><button class="btn btn-primary" onclick="closeModal()">' +
        ic('seal') + 'Selesai</button></div>');
    }, err => {
      toast(gpsErrorMessage(err), 'error');
      addLog('PRESENSI_GAGAL', { reason: String((err && err.message) || err), jadwalId: payload.jadwalId });
    }, { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 });
    } catch (e) {
      toast(gpsErrorMessage(e), 'error');
      addLog('SCAN_ERROR', { error: String((e && e.message) || e) });
    }
  } catch (e) {
    toast(e.message, 'error');
    addLog('SCAN_ERROR', { error: e.message });
  }
}
/* ---------- 18. RIWAYAT PRESENSI --------------------------------------- */
function renderRiwayat() {
  const body = $('riwayatBody');
  const mine = state.presensi
    .filter(p => p.userId === state.currentUser.id)
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

  if (!mine.length) {
    body.innerHTML = '<tr><td colspan="4"><div class="empty">' + ic('codex', 'ic-lg') +
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
      <td data-label="Metode">${p.metode === 'qr' ? 'Pindai QR' : 'Presensi GPS'}</td>
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
    body.innerHTML = '<tr><td colspan="7"><div class="empty">' + ic('bulla', 'ic-lg') +
      '<div>Belum ada acara dipilih</div></div></td></tr>';
    return;
  }
  const j = r.jadwal;
  const nHadir = r.rows.filter(x => x.status === 'hadir').length;
  if (info) info.textContent = j.nama + ' · ' + hariID(j.tanggal) + ', ' +
    fmtDateTime(j.tanggal) + ' · ' + j.venue + ' · radius ' + j.radius +
    ' m · ' + nHadir + ' hadir / ' + r.rows.length + ' tercatat';
  if (!r.rows.length) {
    body.innerHTML = '<tr><td colspan="7"><div class="empty">' + ic('codex', 'ic-lg') +
      '<div>Belum ada presensi pada acara ini</div></div></td></tr>';
    return;
  }
  body.innerHTML = r.rows.map((p, i) => `<tr>
      <td data-label="No">${i + 1}</td>
      <td data-label="Nama">${esc(p.userName || '-')}</td>
      <td data-label="Status"><span class="badge badge-${esc(p.status)}">${esc(p.status)}</span></td>
      <td data-label="Waktu">${esc(fmtDate(p.timestamp))}<div class="tiny muted">${esc(fmtTime(p.timestamp))}</div></td>
      <td data-label="Metode">${p.metode === 'qr' ? 'Pindai QR' : 'GPS'}</td>
      <td data-label="Jarak">${(p.distance == null || isNaN(p.distance)) ? '-' : Number(p.distance).toFixed(0) + ' m'}</td>
      <td data-label="Ket.">${esc(p.keterangan || '')}</td>
    </tr>`).join('');
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
      p.userName, p.status, fmtDateTime(p.timestamp), p.metode === 'qr' ? 'Pindai QR' : 'GPS',
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
    '<td>' + (p.metode === 'qr' ? 'Pindai QR' : 'GPS') + '</td>' +
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
/* ---------- 20. MANAJEMEN PESERTA (ADMIN) ------------------------------ */
function renderUsers() {
  const body = $('usersBody');
  if (!state.users.length) {
    body.innerHTML = '<tr><td colspan="4"><div class="empty">' + ic('halopair', 'ic-lg') +
      '<div>Belum ada pengguna</div></div></td></tr>';
    return;
  }
  body.innerHTML = state.users.map(u => `
    <tr>
      <td data-label="Nama">${esc(u.nama)}
        <div class="tiny muted">@${esc(u.username)}</div></td>
      <td data-label="Peran"><span class="badge badge-role">${esc(roleName(u.role))}</span></td>
      <td data-label="Status"><span class="badge badge-${esc(u.status)}">${esc(u.status)}</span></td>
      <td data-label="Tindakan">
        <div class="row-tight">
          <button class="btn btn-outline btn-sm" onclick="toggleUser('${esc(u.id)}')">
            ${ic(u.status === 'aktif' ? 'lamp' : 'lampoff')}${u.status === 'aktif' ? 'Nonaktifkan' : 'Aktifkan'}
          </button>
          ${u.id !== state.currentUser.id
      ? `<button class="btn btn-danger btn-sm" onclick="deleteUser('${esc(u.id)}')">${ic('scrap')}Hapus</button>`
      : ''}
        </div>
      </td>
    </tr>`).join('');
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

function qrPayload(j) {
  return {
    type: 'PRESENSI_IGNASIAN',
    v: 1,
    jadwalId: j.id,
    nama: j.nama,
    venue: j.venue,
    lat: j.lat,
    lng: j.lng,
    radius: j.radius,
    start: j.tanggal,
    durasi: j.durasi,
    sig: uid()
  };
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

  let qrData;
  try {
    qrData = btoa(unescape(encodeURIComponent(JSON.stringify(qrPayload(j)))));
  } catch (e) {
    toast('Data jadwal tidak dapat dikodekan: ' + e.message, 'error');
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
      QRCode.toCanvas(holder, qrData, {
        width: 280, margin: 2,
        color: { dark: '#6E2632', light: '#FAF7F2' }
      }, (err, canvas) => {
        if (err || !canvas) { toast('QR gagal dibuat', 'error'); box.innerHTML = ''; return; }
        canvas.id = 'qrFinalCanvas';
        canvas.style.width = '280px';
        canvas.style.height = '280px';
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
        width: 280, height: 280,
        colorDark: '#6E2632', colorLight: '#FAF7F2',
        correctLevel: (QRCode.CorrectLevel ? QRCode.CorrectLevel.M : 0)
      });
      /* qrcodejs membuat <canvas> + <img> (async). Tandai keduanya agar
         downloadQR()/printQR() bisa memakai salah satu. */
      const tagCanvas = box.querySelector('canvas');
      if (tagCanvas) {
        tagCanvas.id = 'qrFinalCanvas';
        tagCanvas.style.width = '280px';
        tagCanvas.style.height = '280px';
      }
      const tagImg = box.querySelector('img');
      if (tagImg) {
        tagImg.id = 'qrFinalImg';
        tagImg.style.width = '280px';
        tagImg.style.height = '280px';
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

/* ---------- 24. CATATAN AKTIVITAS (ADMIN & PENGURUS) ------------------- */
function renderLog() {
  const list = $('logList');
  if (!state.logs.length) {
    list.innerHTML = '<div class="empty">' + ic('ledger', 'ic-lg') + '<div>Belum ada catatan aktivitas</div></div>';
    return;
  }
  list.innerHTML = '<div class="list">' + state.logs.slice(0, 100).map(l => `
    <div class="list-item">
      ${ic('ledger')}
      <div class="body">
        <strong>${esc(l.userName)}</strong> <span class="tiny muted">(${esc(roleName(l.userRole))})</span>
        <div>${esc(String(l.action).replace(/_/g, ' '))}
          ${l.details && l.details.username ? '<span class="muted">· @' + esc(l.details.username) + '</span>' : ''}
          ${l.details && l.details.nama ? '<span class="muted">· ' + esc(l.details.nama) + '</span>' : ''}
        </div>
        <div class="meta">${fmtDateTime(l.timestamp)}</div>
      </div>
    </div>`).join('') + '</div>';
}
/* ---------- 25. PENGATURAN -------------------------------------------- */
function setText(id, txt) { const el = $(id); if (el) el.textContent = txt; }

function renderSettingsSync() {
  const on = isOnline();
  setText('setNet', on ? 'Daring — peranti terhubung' : 'Luring — peranti tanpa sambungan');
  setText('setApi', apiReady()
    ? 'Server sinkronisasi aktif'
    : 'Mode mandiri — CONFIG.API_URL belum diatur (data hanya di peranti ini)');
  setText('setQueue', state.outbox.length
    ? state.outbox.length + ' perubahan menunggu dikirim'
    : 'Tidak ada perubahan menunggu');
  setText('setLastSync', state.meta.lastSync ? fmtDateTime(state.meta.lastSync) : 'Belum pernah tersinkron');
  setText('setData', state.users.length + ' pengguna · ' + state.jadwal.length + ' jadwal · ' +
    state.presensi.length + ' presensi · ' + state.logs.length + ' catatan');

  const btn = $('btnSyncNow');
  if (btn) btn.disabled = !apiReady() || !on || state.syncing;
}

function reloadLocalData() {
  loadLocal();
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
      ? 'Sebagai ' + roleName(u.role) + ' Anda dapat membuat jadwal & kode QR, serta membuka catatan aktivitas.'
      : 'Sebagai Peserta Anda memindai QR / mempresensi GPS, melihat riwayat, dan mengelola profil pribadi.';
  }
}

/* ---------- 27. BANTUAN ------------------------------------------------ */
function renderBantuan() {
  setText('bantuanVersi', 'Versi ' + CONFIG.VERSION);
  setText('bantuanPeran', roleName(state.currentUser.role));
  setText('bantuanLuring', apiReady()
    ? (isOnline() ? 'Peranti daring — data disinkronkan otomatis.' : 'Peranti luring — data ditahan lalu dikirim otomatis saat kembali daring.')
    : 'Mode mandiri: seluruh data tersimpan di peranti ini (tanpa server).');
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
  if (window.Icon) { Icon.mount(); Icon.hydrate(); }
  applyTheme(currentTheme(), false);
  watchSystemTheme();

  loadLocal();
  if (!state.users.length) await seedDefaultUsers();

  bindEvents();
  applyRoleVisibility();
  updateSyncUI();
  setupConnectivity();

  if (checkSession()) showMainApp();

  /* Sinkron di latar: kirim antrean lebih dahulu, lalu tarik data baru.
     Tidak menahan tampilan — aplikasi sudah dapat dipakai saat luring. */
  if (apiReady() && isOnline()) {
    flushQueue().then(() => pullRemote(true));
  }
}

init();













