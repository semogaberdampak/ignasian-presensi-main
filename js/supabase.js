/* ==========================================================================
   PRESENSI IGNASIAN — Lapisan Data Supabase
   --------------------------------------------------------------------------
   Menghubungkan aplikasi (cloud-first: basis data daring menjadi ACUAN,
   cadangan luring tetap tersimpan di IndexedDB) dengan basis data Supabase
   melalui REST API bawaan Supabase (PostgREST).

   Mengapa REST langsung, bukan pustaka supabase-js dari CDN:
   • Tanpa dependensi CDN tambahan → app shell tetap ringan dan utuh luring.
   • Permukaan API kecil dan mudah diaudit: pilih / simpan / hapus.
   • IndexedDB tetap menjadi penyimpanan utama & cadangan luring; Supabase
     adalah acuan (cloud-first);
     sehingga tidak ada data yang hilang saat sambungan putus.

   Peta koleksi aplikasi → tabel Supabase (lihat supabase/schema.sql):
     users    → public.users
     jadwal   → public.jadwal
     presensi → public.presensi
     logs     → public.logs
      materi      → public.materi        (tautan berkas Google Drive)
      dokumentasi → public.dokumentasi   (tautan foto kegiatan)
   ========================================================================== */

/* Nilai bawaan bila js/config.js belum lengkap */
const SUPA_DEFAULTS = {
  SUPABASE_URL: '',
  SUPABASE_ANON_KEY: '',
  SUPABASE_SCHEMA: 'public',
  PAGE_SIZE: 1000,
  MAX_ROWS: 20000,
  TIMEOUT_MS: 15000,
  LOG_PULL_LIMIT: 200,
  /* Jendela "coba kirim lengkap lagi" (ms): setelah kolom yang hilang terdeteksi,
     pengiriman dikirim tanpa kolom itu; setelah jendela ini lewat, aplikasi
     mencoba mengirim lengkap kembali — bila schema.sql sudah dijalankan ulang,
     kolom itu langsung ikut tersinkron. */
  SCHEMA_RETRY_MS: 5 * 60 * 1000
};

/* Peta kolom: nama variabel aplikasi (camelCase) → nama kolom Postgres
   (snake_case). Dipakai dua arah agar data dari peranti mana pun seragam. */
const SUPA_TABLES = {
  users: {
    table: 'users',
    fields: {
      id: 'id', nama: 'nama', username: 'username', passHash: 'pass_hash',
      passPlain: 'pass_plain', hpHash: 'hp_hash', hpPlain: 'hp_plain',
      role: 'role', status: 'status',
      email: 'email', terdaftarAt: 'terdaftar_at',
      harusGantiSandi: 'harus_ganti_sandi',
      createdAt: 'created_at', updatedAt: 'updated_at'
    },
    numeric: []
  },
  jadwal: {
    table: 'jadwal',
    fields: {
      id: 'id', nama: 'nama', venue: 'venue', durasi: 'durasi', radius: 'radius',
      pemateri: 'pemateri', pemateri2: 'pemateri_2',
      openGate: 'open_gate',
      lat: 'lat', lng: 'lng', tanggal: 'tanggal', createdBy: 'created_by',
      createdAt: 'created_at', updatedAt: 'updated_at'
    },
    numeric: ['durasi', 'radius', 'lat', 'lng']
  },
  presensi: {
    table: 'presensi',
    fields: {
      id: 'id', userId: 'user_id', userName: 'user_name', jadwalId: 'jadwal_id',
      jadwalNama: 'jadwal_nama', venue: 'venue', status: 'status', metode: 'metode',
      lat: 'lat', lng: 'lng', accuracy: 'accuracy', distance: 'distance',
      keterangan: 'keterangan', timestamp: 'timestamp', updatedAt: 'updated_at'
    },
    numeric: ['lat', 'lng', 'accuracy', 'distance']
  },
  logs: {
    table: 'logs',
    fields: {
      id: 'id', timestamp: 'timestamp', updatedAt: 'updated_at', action: 'action',
      details: 'details', userId: 'user_id', userName: 'user_name',
      userRole: 'user_role', userAgent: 'user_agent', url: 'url'
    },
    numeric: [],
    json: ['details']
  },
  /* Permintaan pemulihan kata sandi ("Lupa password?") — dibuat perangkat
     pengguna saat keluar, dibaca & ditindaklanjuti Administrator. */
  requests: {
    table: 'password_requests',
    fields: {
      id: 'id', userId: 'user_id', nama: 'nama', username: 'username',
      role: 'role', hp: 'hp', status: 'status', ts: 'requested_at',
      handledBy: 'handled_by', handledAt: 'handled_at', updatedAt: 'updated_at'
    },
    numeric: []
  },
  /* Materi kegiatan — hanya menyimpan TAUTAN Google Drive (bukan berkasnya) */
  materi: {
    table: 'materi',
    fields: {
      id: 'id', jadwalId: 'jadwal_id', jadwalNama: 'jadwal_nama', tanggal: 'tanggal',
      judul: 'judul', deskripsi: 'deskripsi', fileUrl: 'file_url', fileName: 'file_name',
      uploadedBy: 'uploaded_by', uploader: 'uploader',
      createdAt: 'created_at', updatedAt: 'updated_at'
    },
    numeric: []
  },
  /* Dokumentasi foto kegiatan — tautan per foto atau folder berisi foto */
  dokumentasi: {
    table: 'dokumentasi',
    fields: {
      id: 'id', jadwalId: 'jadwal_id', jadwalNama: 'jadwal_nama', tanggal: 'tanggal',
      keterangan: 'keterangan', fileUrl: 'file_url', fileName: 'file_name',
      uploadedBy: 'uploaded_by', uploader: 'uploader',
      createdAt: 'created_at', updatedAt: 'updated_at'
    },
    numeric: []
  },
  /* Pengaturan bersama seluruh perangkat (mis. layout PDF daftar hadir).
     Satu baris per pengaturan: id = kunci (mis. 'pdf-layout'), data = isinya. */
  settings: {
    table: 'app_settings',
    fields: {
      id: 'id', data: 'data',
      updatedBy: 'updated_by', updatedAt: 'updated_at'
    },
    numeric: [],
    json: ['data']
  }
};

/* Jenis operasi pada antrean (outbox) → nama koleksi/tabel Supabase */
const SUPA_OUTBOX_TABLES = {
  user: 'users', jadwal: 'jadwal', presensi: 'presensi', log: 'logs',
  request: 'requests', materi: 'materi', dokumentasi: 'dokumentasi',
  setting: 'settings'
};

/* Realtime dinyalakan dari js/app.js (scheduleRealtimeCatchup) agar hanya
   SATU saluran per perangkat walau Supabase dipakai dari banyak tempat.
   Modul ini hanya menyediakan pemicu + pengatur waktu debounce. */

/* ---------- Konfigurasi & kesiapan ---------------------------------------- */

function supaConfig() {
  return Object.assign({}, SUPA_DEFAULTS, window.IGN_CONFIG || {});
}

function supaReady() {
  const c = supaConfig();
  return !!c.SUPABASE_URL && !!c.SUPABASE_ANON_KEY &&
    /^https?:\/\//i.test(String(c.SUPABASE_URL)) &&
    String(c.SUPABASE_ANON_KEY).length > 20;
}

function supaHost() {
  try { return new URL(supaConfig().SUPABASE_URL).host; } catch (e) { return ''; }
}

/* Kalimat status singkat untuk menu Pengaturan */
function supaStatusText() {
  if (!supaReady()) {
    return 'Mode mandiri — SUPABASE_URL & SUPABASE_ANON_KEY belum diisi (js/config.js)';
  }
  return 'Supabase · ' + supaHost();
}

/* ---------- Penerjemahan baris (record ↔ row) ----------------------------- */

function supaClean(value, jsKey, meta) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (meta.numeric && meta.numeric.indexOf(jsKey) !== -1) {
    const n = Number(value);
    return isFinite(n) ? n : null;                 /* NaN/Infinity → NULL */
  }
  if (meta.json && meta.json.indexOf(jsKey) !== -1) {
    return (value && typeof value === 'object') ? value : { value: value };
  }
  if (typeof value === 'object') return value;     /* kolom jsonb */
  return value;
}

/* Record aplikasi → baris tabel. Kolom yang tidak dikirim tidak disertakan,
   sehingga pembaruan sebagian tidak menimpa kolom lain dengan NULL. */
function supaToRow(coll, rec) {
  const meta = SUPA_TABLES[coll];
  if (!meta || !rec) return null;
  const row = {};
  Object.keys(meta.fields).forEach(jsKey => {
    if (rec[jsKey] === undefined) return;
    const v = supaClean(rec[jsKey], jsKey, meta);
    if (v === undefined) return;
    row[meta.fields[jsKey]] = v;
  });
  return row;
}

/* Baris tabel → record aplikasi (bentuk sama seperti versi IndexedDB) */
function supaFromRow(coll, row) {
  const meta = SUPA_TABLES[coll];
  if (!meta || !row) return null;
  const rec = {};
  Object.keys(meta.fields).forEach(jsKey => {
    const v = row[meta.fields[jsKey]];
    if (v === undefined || v === null) return;
    rec[jsKey] = v;
  });
  return rec.id ? rec : null;
}

/* ---------- Galat & petunjuk ramah pengguna ------------------------------- */

/* Tabel/skema belum ada? Galat seperti ini HANYA berlaku untuk tabel yang
   bersangkutan (mis. supabase/schema.sql belum dijalankan pada proyek lama):
   data jangan dibuang, tetapi juga jangan menahan antrean tabel lain. */
function supaNeedsSchema(err) {
  if (!err || err.network) return false;
  const code = err.code || '';
  if (code === 'PGRST205' || code === 'PGRST202' || code === '42P01' || code === '3F000') return true;
  /* PostgREST kadang hanya mengirim status 404 tanpa kode. */
  return err.status === 404 &&
    /schema cache|does not exist|not find the table/i.test(String(err.detail || err.message || ''));
}

function supaIsPermanent(err) {
  if (!err || err.network) return false;
  const code = err.code || '';
  /* Tabel/skema belum dibuat → JANGAN buang data, cukup tunggu sampai
     Administrator menjalankan supabase/schema.sql. */
  if (supaNeedsSchema(err)) return false;
  const s = err.status;
  if (!s || s === 401 || s === 403 || s === 429 || s >= 500) return false;
  return s === 400 || s === 404 || s === 406 || s === 409 || s === 413 || s === 422;
}

function supaError(message, res, body) {
  const err = new Error(message);
  err.status = res ? res.status : 0;
  err.network = !res;
  err.code = (body && body.code) ? String(body.code) : null;
  err.detail = (body && (body.message || body.hint || body.details))
    ? String(body.message || body.hint || body.details) : '';
  err.body = body || null;
  err.permanent = supaIsPermanent(err);
  return err;
}

/* Terjemahkan galat menjadi kalimat yang dapat ditindaklanjuti */
function supaErrorHint(err) {
  if (!err) return 'Kesalahan tidak dikenal';
  const code = err.code || '';
  if (err.network) return 'Tidak dapat menghubungi Supabase — periksa sambungan internet lalu coba lagi.';
  if (code === 'PGRST205' || code === 'PGRST202' || code === '42P01') {
    return 'Tabel belum ada di Supabase — jalankan supabase/schema.sql pada SQL Editor.';
  }
  if (code === 'PGRST204' || code === '42703') {
    return 'Sebagian kolom tabel belum ada di Supabase — jalankan ulang supabase/schema.sql pada SQL Editor.';
  }
  if (err.status === 401 || err.status === 403) {
    return 'Kunci anon Supabase ditolak — periksa SUPABASE_ANON_KEY pada js/config.js.';
  }
  if (err.status === 429) return 'Permintaan terlalu sering (batas Supabase) — sinkron dicoba lagi otomatis.';
  if (err.status >= 500) return 'Server Supabase sedang bermasalah — data tetap aman di perangkat ini.';
  const detail = err.detail || err.message || '';
  return 'Supabase menolak permintaan (' + (err.status || '-') + '): ' + detail;
}

/* ---------- Permintaan HTTP ---------------------------------------------- */

async function supaFetch(path, opts) {
  const c = supaConfig();
  if (!supaReady()) throw supaError('Supabase belum dikonfigurasi (js/config.js)', null, null);

  const url = String(c.SUPABASE_URL).replace(/\/+$/, '') + '/rest/v1/' + path;
  const headers = Object.assign({
    'apikey': c.SUPABASE_ANON_KEY,
    'Authorization': 'Bearer ' + c.SUPABASE_ANON_KEY,
    'Accept': 'application/json',
    'Accept-Profile': c.SUPABASE_SCHEMA,
    'Content-Profile': c.SUPABASE_SCHEMA
  }, (opts && opts.headers) || {});
  if (opts && opts.body !== undefined) headers['Content-Type'] = 'application/json';

  const hasAbort = (typeof AbortController !== 'undefined');
  const ctrl = hasAbort ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), Number(c.TIMEOUT_MS) || 15000) : null;

  let res = null;
  try {
    res = await fetch(url, {
      method: (opts && opts.method) || 'GET',
      headers: headers,
      body: (opts && opts.body !== undefined) ? JSON.stringify(opts.body) : undefined,
      cache: 'no-store',
      signal: ctrl ? ctrl.signal : undefined
    });
  } catch (e) {
    if (timer) clearTimeout(timer);
    const err = supaError('Tidak dapat menghubungi Supabase', null, null);
    err.cause = e;
    throw err;
  }
  if (timer) clearTimeout(timer);

  const text = await res.text().catch(() => '');
  let body = null;
  if (text) {
    try { body = JSON.parse(text); } catch (e) { body = { message: text.slice(0, 300) }; }
  }

  if (!res.ok) {
    const msg = (body && (body.message || body.hint)) ? String(body.message || body.hint) : ('HTTP ' + res.status);
    throw supaError('Supabase: ' + msg, res, body);
  }
  return { res: res, body: body };
}

/* ---------- Operasi data -------------------------------------------------- */

/* Ambil seluruh baris satu koleksi (dengan penomoran halaman) */
async function supaSelect(coll, opts) {
  const meta = SUPA_TABLES[coll];
  if (!meta) throw supaError('Tabel tidak dikenal: ' + coll);
  const c = supaConfig();
  const pageSize = Math.max(1, Math.min(Number(c.PAGE_SIZE) || 1000, 1000));
  const cap = Math.max(pageSize, Number(c.MAX_ROWS) || 20000);
  const hardLimit = (opts && opts.maxRows) ? Math.min(Number(opts.maxRows) || cap, cap) : cap;
  const order = (opts && opts.order) ? '&order=' + opts.order : '';
  const rows = [];

  for (let offset = 0; offset < hardLimit; offset += pageSize) {
    const size = Math.min(pageSize, hardLimit - offset);
    const query = 'select=*&limit=' + size + '&offset=' + offset + order;
    const out = await supaFetch(meta.table + '?' + query, { method: 'GET' });
    const batch = Array.isArray(out.body) ? out.body : [];
    batch.forEach(r => { const rec = supaFromRow(coll, r); if (rec) rows.push(rec); });
    if (batch.length < size) break;                 /* halaman terakhir */
  }
  return rows;
}

/* Simpan (tambah/perbarui) satu catatan — upsert berdasarkan id.

   KOMPATIBILITAS SKEMA LAMA (penyebab "data hanya ada di satu peramban"):
   Bila basis data belum dijalankan ulang dengan supabase/schema.sql, kolom
   baru (mis. `pemateri` & `pemateri_2`) belum ada sehingga PostgREST MENOLAK
   pengiriman (PGRST204 / 42703). Tanpa penanganan, SELURUH pengiriman tabel
   itu gagal terus → data hanya ada di perangkat pembuatnya.
   Karena itu setiap kolom yang dilaporkan belum ada DILEWATI sementara lalu
   pengiriman DIULANG (PostgREST menyebut satu kolom per galat, jadi perlu
   beberapa putaran). Kolom yang pernah hilang dicatat PER TABEL (agar kolom
   hilang pada satu tabel tidak ikut melewatkan kolom bernama sama di tabel
   lain), dan setiap SCHEMA_RETRY_MS aplikasi mencoba MENGIRIM LENGKAP lagi —
   begitu Administrator menjalankan ulang schema.sql, kolom itu ikut
   tersinkron otomatis tanpa menutup aplikasi. */
let _supaMissingCols = {};        /* peta: nama tabel → daftar kolom belum ada */
let _supaMissingAt = 0;           /* kapan kolom hilang terakhir terdeteksi */

/* Gabungan seluruh kolom yang belum ada (untuk peringatan & UI Uji Koneksi) */
function supaMissingColumns() {
  const all = [];
  Object.keys(_supaMissingCols).forEach(t => {
    _supaMissingCols[t].forEach(c => { if (all.indexOf(c) === -1) all.push(c); });
  });
  return all;
}

/* Jendela "coba kirim lengkap lagi" (ms) — dapat diatur di js/config.js */
function supaSchemaRetryMs() {
  const n = Number(supaConfig().SCHEMA_RETRY_MS);
  return (isFinite(n) && n >= 0) ? n : 5 * 60 * 1000;
}

/* Nama kolom yang belum ada menurut galat PostgREST/Postgres (null bila bukan):
   • PGRST204 (saat menyimpan) : Could not find the 'pemateri' column of 'jadwal' in the schema cache
   • 42703 (saat membaca)      : column jadwal.pemateri does not exist
                                 column "pemateri" of relation "jadwal" does not exist */
function supaMissingColumnOf(err) {
  if (!err || err.network) return null;
  const code = String(err.code || '');
  if (code !== '42703' && code !== 'PGRST204') return null;
  const text = String(err.detail || err.message || '');
  return (text.match(/could not find the '?([A-Za-z0-9_]+)'? column/i) || [])[1] ||
    (text.match(/column\s+(?:[A-Za-z0-9_]+\.)?"?([A-Za-z0-9_]+)"?\s+does not exist/i) || [])[1] ||
    (text.match(/column\s+"([^"]+)"/) || [])[1] ||
    (text.match(/'([A-Za-z0-9_]+)'/) || [])[1] || null;
}

/* Catat sekali kolom yang belum ada pada SATU TABEL (peringatan console +
   dasar penyaringan saat mengirim ulang) */
function supaNoteMissingColumn(col, table, err) {
  if (!col) return;
  _supaMissingAt = Date.now();
  const daftar = _supaMissingCols[table] || (_supaMissingCols[table] = []);
  if (daftar.indexOf(col) !== -1) return;
  daftar.push(col);
  console.warn('[Supabase] kolom "' + col + '" belum ada pada tabel ' + table +
    ' — jalankan ulang supabase/schema.sql agar fitur baru (mis. pemateri) ikut tersinkron. ' +
    'Kolom itu dilewati sementara; data lain pada catatan yang sama tetap dikirim.', err);
}

async function supaPush(coll, rec) {
  const meta = SUPA_TABLES[coll];
  if (!meta) throw supaError('Tabel tidak dikenal: ' + coll);
  const row = supaToRow(coll, rec);
  if (!row || !row.id) throw supaError('Catatan tanpa id tidak dapat dikirim');
  const path = meta.table + '?on_conflict=id';
  const headers = { 'Prefer': 'resolution=merge-duplicates,return=minimal' };

  /* Kolom yang BELUM ADA pada tabel ini (bukan gabungan antar tabel).
     Diambil ulang SETIAP putaran — galat pertama menambah daftar itu. */
  const kolomHilang = () => _supaMissingCols[meta.table] || [];

  /* Kirim LENGKAP bila tabel ini belum pernah kehilangan kolom, atau bila
     jendela coba-ulang sudah lewat (skema mungkin sudah diperbarui di server). */
  const cobaLengkap = !kolomHilang().length ||
    (Date.now() - _supaMissingAt) > supaSchemaRetryMs();

  let terakhir = null;
  for (let putaran = 0; putaran < 8; putaran++) {
    const lengkap = cobaLengkap && putaran === 0;
    const hilang = kolomHilang();
    const body = Object.assign({}, row);
    if (!lengkap) hilang.forEach(c => { delete body[c]; });
    try {
      await supaFetch(path, { method: 'POST', headers: headers, body: body });
      /* Skema sudah lengkap kembali → lupakan kolom yang pernah hilang. */
      if (lengkap && hilang.length) { _supaMissingCols = {}; _supaMissingAt = 0; }
      return true;
    } catch (e) {
      terakhir = e;
      const col = supaMissingColumnOf(e);
      if (!col || !(col in row)) throw e;      /* galat lain → diteruskan */
      supaNoteMissingColumn(col, meta.table, e);
    }
  }
  throw terakhir || supaError('Gagal mengirim catatan ke tabel ' + meta.table);
}

/* ---------- Pencarian nomor HP langsung ke server ------------------------
   Dipakai layar "Daftar": perangkat yang datanya belum pernah tersinkron
   tetap dapat mengenali nomor yang sah. Seluruh varian penulisan
   (08…, 628…, 8…) diperiksa dalam satu permintaan. */
async function supaCariUserByHp(nomor) {
  const meta = SUPA_TABLES.users;
  if (!meta) return null;
  const n = String(nomor || '').replace(/\D/g, '');
  if (n.length < 8) return null;

  const set = new Set([n]);
  if (n.slice(0, 2) === '62') { set.add('0' + n.slice(2)); set.add(n.slice(2)); }
  else if (n.charAt(0) === '0') { set.add('62' + n.slice(1)); set.add(n.slice(1)); }
  else if (n.charAt(0) === '8') { set.add('0' + n); set.add('62' + n); }

  const or = Array.from(set).map(v => 'hp_plain.eq.' + v).join(',');
  const out = await supaFetch(meta.table + '?select=*&limit=1&or=(' + or + ')', { method: 'GET' });
  const rows = Array.isArray(out.body) ? out.body : [];
  return rows.length ? supaFromRow('users', rows[0]) : null;
}

/* Hapus satu catatan berdasarkan id */
async function supaDelete(coll, id) {
  const meta = SUPA_TABLES[coll];
  if (!meta) throw supaError('Tabel tidak dikenal: ' + coll);
  if (!id) throw supaError('Hapus tanpa id tidak dapat dikirim');
  await supaFetch(meta.table + '?id=eq.' + encodeURIComponent(id), {
    method: 'DELETE',
    headers: { 'Prefer': 'return=minimal' }
  });
  return true;
}

/* Tarik seluruh koleksi yang dipakai aplikasi.
   Koleksi yang gagal tidak menggagalkan keseluruhan (kecuali semuanya gagal). */
async function supaPullAll(opts) {
  const c = supaConfig();
  /* Kapasitas tarikan per koleksi → penanda `__complete`: baris dianggap
     "SELURUHNYA sampai" hanya bila jumlahnya DI BAWAH batas ini. Mode
     cloud-first (mergeList di js/app.js) memakainya untuk membedakan baris
     yang "sudah dihapus di perangkat lain" dari yang "terpotong batas tarikan". */
  const halaman = Math.max(1, Math.min(Number(c.PAGE_SIZE) || 1000, 1000));
  const batasUmum = Math.max(halaman, Number(c.MAX_ROWS) || 20000);
  const batas = n => Math.min(n, batasUmum);
  const limLog = Math.max(10, Number(c.LOG_PULL_LIMIT) || 200);

  const jobs = [
    ['users', supaSelect('users'), batasUmum],
    ['jadwal', supaSelect('jadwal'), batasUmum],
    ['presensi', supaSelect('presensi'), batasUmum],
    /* Materi & dokumentasi dibutuhkan SEMUA peran — tarik selalu (bila tabel
       belum dibuat, gambarnya hanya warning dan data lain tetap masuk). */
    ['materi', supaSelect('materi', { order: 'created_at.desc', maxRows: 2000 }), batas(2000)],
    ['dokumentasi', supaSelect('dokumentasi', { order: 'created_at.desc', maxRows: 5000 }), batas(5000)],
    /* Pengaturan bersama (layout PDF) — berukuran sangat kecil & dipakai SEMUA
       peran, jadi selalu ditarik. */
    ['settings', supaSelect('settings', { maxRows: 200 }), batas(200)]
  ];
  if (opts && opts.includeLogs) {
    jobs.push(['logs', supaSelect('logs', {
      order: 'timestamp.desc',
      maxRows: limLog
    }), batas(limLog)]);
  }
  /* Permintaan pemulihan kata sandi hanya relevan (dan hanya patut dibaca)
     oleh Administrator yang akan menindaklanjutinya. */
  if (opts && opts.includeRequests) {
    jobs.push(['requests', supaSelect('requests', { order: 'requested_at.desc', maxRows: 300 }), batas(300)]);
  }

  const settled = await Promise.allSettled(jobs.map(j => j[1]));
  const data = {};
  const lengkap = {};
  const errors = [];
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      data[jobs[i][0]] = r.value || [];
      lengkap[jobs[i][0]] = (r.value || []).length < jobs[i][2];
    } else errors.push({ collection: jobs[i][0], error: r.reason });
  });
  data.__complete = lengkap;

  errors.forEach(e => console.warn('[Supabase] gagal menarik ' + e.collection +
    (supaNeedsSchema(e.error) ? ' — ' + supaErrorHint(e.error) : ''), e.error));
  if (!Object.keys(data).length) throw (errors[0] ? errors[0].error : new Error('Tarikan data gagal'));
  return data;
}

/* ---------- Diagnostik (menu Pengaturan) --------------------------------- */

/* ---------- Sinkron otomatis antar pengguna (Supabase Realtime) --------------
   Tanpa ini setiap perangkat hanya menarik data tiap SYNC_INTERVAL / saat
   aplikasi dibuka. Dengan Realtime, begitu ADA
   perubahan di tabel mana pun (dari pengguna lain), server mendorong
   peristiwa ke semua perangkat yang daring → perangkat langsung
   menarik ulang (debounce) sehingga "setiap ada perubahan dari semua user"
   tersinkron otomatis. Bila Realtime tidak tersedia / gagal, aplikasi
   tetap memakai polling lama — tidak ada yang rusak.

   Cara kerja: memakai protokol Phoenix (websocket Supabase Realtime v1)
   dengan benar — access_token + postgres_changes binding. Tanpa binding,
   server tidak akan mengirim peristiwa perubahan baris. */
let _supaRt = { ws: null, timer: 0, backoff: 1000, started: false, ref: 0, hb: 0 };
function scheduleRealtimePull(reason, immediate) {
  try {
    if (_supaRt.timer) clearTimeout(_supaRt.timer);
  } catch (e) {}
  _supaRt.timer = setTimeout(() => {
    _supaRt.timer = 0;
    try {
      if (!state.currentUser || !isOnline()) return;
      syncNow(false);
    } catch (e) {}
  }, immediate ? 300 : 1200);
  try {
    const el = document.getElementById('usersSyncNote');
    if (el && reason) el.textContent = 'Perubahan baru diterima — memperbarui…';
  } catch (e) {}
}
function stopSupaRealtime() {
  try {
    if (_supaRt.timer) clearTimeout(_supaRt.timer);
  } catch (e) {}
  _supaRt.timer = 0;
  try {
    if (_supaRt.hb) clearInterval(_supaRt.hb);
  } catch (e) {}
  _supaRt.hb = 0;
  try {
    if (_supaRt.ws) _supaRt.ws.close();
  } catch (e) {}
  _supaRt.ws = null;
}
function startSupaRealtime() {
  if (_supaRt.started) return;
  _supaRt.started = true;
  const nextRef = () => String(++_supaRt.ref);
  const loop = () => {
    setTimeout(connect, _supaRt.backoff);
  };
  const joinTable = (ws, table) =>
    ws.send(JSON.stringify({
      topic: 'realtime:' + table,
      event: 'phx_join',
      payload: {
        access_token: supaConfig().SUPABASE_ANON_KEY,
        config: {
          broadcast: { ack: false, self: false },
          presence: { key: '' },
          postgres_changes: [{ event: '*', schema: supaConfig().SUPABASE_SCHEMA || 'public', table: table }]
        }
      },
      ref: nextRef()
    }));
  const connect = async () => {
    try {
      if (!supaReady() || !isOnline() || typeof WebSocket === 'undefined') return loop();
      if (_supaRt.ws) return loop();
      const c = supaConfig();
      const base = String(c.SUPABASE_URL).replace(/\/+$/, '').replace(/^http/, 'ws');
      const url = base + '/realtime/v1/websocket?apikey=' + encodeURIComponent(c.SUPABASE_ANON_KEY) +
        '&vsn=1.0.0';
      const ws = new WebSocket(url);
      _supaRt.ws = ws;
      const tables = ['users', 'jadwal', 'presensi', 'password_requests', 'materi', 'dokumentasi', 'app_settings'];
      ws.onopen = () => {
        _supaRt.backoff = 1000;
        try { tables.forEach(t => joinTable(ws, t)); } catch (e) {}
        try {
          if (_supaRt.hb) clearInterval(_supaRt.hb);
          _supaRt.hb = setInterval(() => {
            try {
              if (ws.readyState === 1) {
                ws.send(JSON.stringify({
                  topic: 'phoenix', event: 'heartbeat', payload: {}, ref: nextRef()
                }));
              }
            } catch (e) {}
          }, 25000);
        } catch (e) {}
      };
      ws.onmessage = ev => {
        let msg = null;
        try { msg = JSON.parse(ev.data); } catch (e) { return; }
        const evt = msg && msg.event ? String(msg.event) : '';
        const topic = msg && msg.topic ? String(msg.topic) : '';
        if (evt === 'postgres_changes' || evt === 'INSERT' || evt === 'UPDATE' || evt === 'DELETE') {
          scheduleRealtimePull(topic || evt, false);
        } else if (evt === 'phx_reply' && msg.payload && msg.payload.status === 'ok' &&
                   topic.indexOf('realtime:') === 0) {
          /* Berhasil gabung — tarik sekali agar langsung sejajar dengan server. */
          scheduleRealtimePull('', true);
        }
      };
      ws.onerror = () => { try { ws.close(); } catch (e) {} };
      ws.onclose = () => {
        try { if (_supaRt.hb) clearInterval(_supaRt.hb); } catch (e) {}
        _supaRt.hb = 0;
        _supaRt.ws = null;
        _supaRt.backoff = Math.min(60000, (_supaRt.backoff || 1000) * 2);
        loop();
      };
    } catch (e) { loop(); }
  };
  try { window.addEventListener('online', () => { _supaRt.backoff = 1000; connect(); }); } catch (e) {}
  try { window.addEventListener('offline', () => stopSupaRealtime()); } catch (e) {}
  connect();
}

/* Status saluran Realtime untuk kartu Pengaturan — membantu diagnosis bila
   satu peramban menerima perubahan lebih cepat daripada yang lain (tanpa
   realtime, perangkat tetap mengejar lewat tarikan berkala tiap SYNC_INTERVAL). */
function supaRealtimeStatus() {
  try {
    if (typeof WebSocket === 'undefined') return 'tidak didukung';
    if (!_supaRt.started) return 'nonaktif';
    const ws = _supaRt.ws;
    if (ws && ws.readyState === 1) return 'tersambung';
    if (ws && ws.readyState === 0) return 'menghubungkan';
    return 'terputus';
  } catch (e) { return 'tidak diketahui'; }
}

/* Hitung jumlah baris satu tabel memakai tajuk Content-Range */
async function supaCount(coll) {
  const meta = SUPA_TABLES[coll];
  if (!meta) throw supaError('Tabel tidak dikenal: ' + coll);
  const out = await supaFetch(meta.table + '?select=id&limit=1', {
    method: 'GET',
    headers: { 'Prefer': 'count=exact' }
  });
  const range = out.res.headers.get('content-range') || '';
  if (range.indexOf('/') === -1) return null;
  const total = range.split('/')[1];
  if (!total || total === '*') return null;
  const n = Number(total);
  return isFinite(n) ? n : null;
}

/* Nama kolom yang diharapkan APLIKASI ada pada satu koleksi (urut peta kolom) */
function supaExpectedColumns(coll) {
  const meta = SUPA_TABLES[coll];
  if (!meta) return [];
  return Object.keys(meta.fields).map(k => meta.fields[k]);
}

/* Kolom aplikasi yang BELUM ADA pada basis data (kadang dipakai kolom baru
   tanpa menjalankan ulang schema.sql). PostgREST menyebut satu kolom per galat,
   jadi dicek berulang sampai bersih (maks. 10 putaran).
   Mengembalikan daftar nama kolom basis data yang belum ada. */
async function supaMissingColumnsOf(coll) {
  const meta = SUPA_TABLES[coll];
  if (!meta) return [];
  const belum = [];
  for (let putaran = 0; putaran < 10; putaran++) {
    const coba = supaExpectedColumns(coll).filter(c => belum.indexOf(c) === -1);
    if (!coba.length) break;
    try {
      await supaFetch(meta.table + '?select=' + coba.join(',') + '&limit=1', { method: 'GET' });
      return belum;                                   /* semua kolom terbaca */
    } catch (e) {
      const col = supaMissingColumnOf(e);
      if (!col || belum.indexOf(col) !== -1) return belum;   /* galat lain / berhenti */
      belum.push(col);
    }
  }
  return belum;
}

/* Uji kesiapan: konfigurasi + akses tabel + kelengkapan kolom */
async function supaDiagnose() {
  const report = { ready: supaReady(), host: supaHost(), tables: [], ok: false, error: null };
  if (!report.ready) {
    report.error = 'SUPABASE_URL dan SUPABASE_ANON_KEY belum diisi pada js/config.js';
    return report;
  }
  const names = ['users', 'jadwal', 'presensi', 'logs', 'materi', 'dokumentasi', 'requests', 'settings'];
  const settled = await Promise.allSettled(names.map(n => supaCount(n)));
  const kurang = await Promise.allSettled(names.map(n => supaMissingColumnsOf(n)));
  names.forEach((n, i) => {
    const r = settled[i];
    const k = kurang[i];
    const hilang = (k.status === 'fulfilled') ? k.value : [];
    const bacaOk = r.status === 'fulfilled';
    const jumlah = bacaOk ? r.value : null;
    const galat = r.status === 'rejected' ? supaErrorHint(r.reason) : null;
    report.tables.push({
      name: n,
      ok: bacaOk && !hilang.length,
      count: jumlah,
      missing: hilang,
      error: hilang.length
        ? 'Kolom belum ada: ' + hilang.join(', ') + ' — jalankan ulang supabase/schema.sql'
        : galat
    });
  });
  report.ok = report.tables.every(t => t.ok);
  if (!report.ok) {
    const bad = report.tables.filter(t => !t.ok)[0];
    report.error = bad && bad.error ? bad.error : 'Sebagian tabel belum dapat dibaca';
  }
  return report;
}

