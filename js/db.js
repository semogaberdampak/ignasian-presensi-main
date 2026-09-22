/* ============================================================
   PRESENSI IGNASIAN — Database (IndexedDB)
   ------------------------------------------------------------
   Seluruh data aplikasi (pengguna, jadwal, presensi, log,
   antrean sinkron, sesi, tema, dsb.) disimpan di IndexedDB —
   basis data peramban yang sesungguhnya — BUKAN localStorage
   dan BUKAN berkas .js. Setiap koleksi menjadi object store
   tersendiri dan setiap catatan disimpan per-baris (per id).
   ============================================================ */

const DB_NAME = 'ign_presensi_db';
const DB_VERSION = 1;

/* Object store database: koleksi data + kv (key-value) untuk
   sesi, tema, dan metadata. */
const DB_COLLECTION_STORES = ['users', 'jadwal', 'presensi', 'logs', 'outbox', 'tombstones'];
const DB_ALL_STORES = DB_COLLECTION_STORES.concat(['kv']);

let _dbPromise = null;

function openDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) {
      reject(new Error('IndexedDB tidak didukung peramban ini'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      DB_ALL_STORES.forEach(name => {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
      });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('Gagal membuka database'));
  });
  return _dbPromise;
}

function _txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Transaksi database dibatalkan'));
  });
}

/* Ambil satu catatan */
async function dbGet(store, key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result === undefined ? null : req.result);
    req.onerror = () => reject(req.error);
  });
}

/* Simpan satu catatan */
async function dbPut(store, key, value) {
  const db = await openDB();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).put(value, key);
  return _txDone(tx);
}

/* Hapus satu catatan */
async function dbDel(store, key) {
  const db = await openDB();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).delete(key);
  return _txDone(tx);
}

/* Ambil seluruh catatan dalam satu store */
async function dbAll(store) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

/* Ganti seluruh isi satu store dengan daftar catatan (satu transaksi).
   keyFn menentukan kunci tiap catatan (fungsi menerima catatan). */
async function dbReplaceAll(store, list, keyFn) {
  const db = await openDB();
  const tx = db.transaction(store, 'readwrite');
  const st = tx.objectStore(store);
  st.clear();
  (list || []).forEach((rec, i) => { try { st.put(rec, keyFn(rec, i)); } catch (e) { /* lewati catatan rusak */ } });
  return _txDone(tx);
}

/* Hapus seluruh database lokal (dipakai fitur bersihkan data) */
async function dbWipe() {
  const db = await openDB();
  const tx = db.transaction(DB_ALL_STORES, 'readwrite');
  DB_ALL_STORES.forEach(name => tx.objectStore(name).clear());
  return _txDone(tx);
}

/* ---------- Penyimpanan per record (pengganti localStorage) ---------- */

const _dbCache = {}; /* cache memori: store -> Map(id -> record) */

/* Muat seluruh koleksi dari database ke memori saat aplikasi mulai.
   Data lama di localStorage dimigrasikan sekali, lalu dihapus. */
async function dbLoadAll() {
  await openDB();
  for (const name of DB_COLLECTION_STORES) {
    const rows = await dbAll(name);
    const map = new Map();
    rows.forEach(r => { if (r && r.id != null) map.set(String(r.id), r); });

    /* Migrasi satu kali dari localStorage (aplikasi versi lama) */
    try {
      const legacyKey = STORE_KEYS[name === 'tombstones' ? 'tomb' : name];
      const raw = localStorage.getItem(legacyKey);
      if (raw) {
        const legacy = JSON.parse(raw);
        if (Array.isArray(legacy)) {
          legacy.forEach(rec => {
            if (rec && rec.id != null && !map.has(String(rec.id))) {
              map.set(String(rec.id), rec);
              dbPut(name, String(rec.id), rec).catch(() => {});
            }
          });
          localStorage.removeItem(legacyKey); /* localStorage tidak lagi dipakai */
        }
      }
    } catch (e) { /* luring / tanpa localStorage — abaikan */ }

    _dbCache[name] = map;
  }
  return _dbCache;
}

function dbRows(name) {
  return _dbCache[name] ? Array.from(_dbCache[name].values()) : [];
}

function dbRecord(name, id) {
  return _dbCache[name] ? (_dbCache[name].get(String(id)) || null) : null;
}

/* Tulis satu catatan ke memori + database */
function dbSave(name, rec, extraKey) {
  if (!rec) return Promise.resolve(false);
  const key = String(extraKey != null ? extraKey : rec.id);
  if (!_dbCache[name]) _dbCache[name] = new Map();
  _dbCache[name].set(key, rec);
  return dbPut(name, key, rec).then(() => true).catch(() => false);
}

/* Hapus satu catatan dari memori + database */
function dbRemove(name, id) {
  const key = String(id);
  if (_dbCache[name]) _dbCache[name].delete(key);
  return dbDel(name, key).then(() => true).catch(() => false);
}

/* ---------- Key-value kecil (sesi, tema, meta) ---------- */
async function kvGet(key, fallback) {
  try {
    const v = await dbGet('kv', key);
    return (v === null || v === undefined) ? fallback : v;
  } catch (e) { return fallback; }
}

async function kvSet(key, value) {
  try { await dbPut('kv', key, value); return true; } catch (e) { return false; }
}

/* Migrasi sisa nilai kecil dari localStorage (tema & sesi versi lama) */
async function migrateLegacyKV() {
  try {
    if (localStorage.getItem(STORE_KEYS.theme) && (await kvGet('theme', null)) === null) {
      await kvSet('theme', localStorage.getItem(STORE_KEYS.theme));
    }
    localStorage.removeItem(STORE_KEYS.theme);
  } catch (e) {}
  try {
    if (localStorage.getItem(STORE_KEYS.session) && (await kvGet('session', null)) === null) {
      await kvSet('session', JSON.parse(localStorage.getItem(STORE_KEYS.session)));
    }
    localStorage.removeItem(STORE_KEYS.session);
  } catch (e) {}
  try { localStorage.removeItem(STORE_KEYS.meta); localStorage.removeItem(STORE_KEYS.outbox); } catch (e) {}
}
