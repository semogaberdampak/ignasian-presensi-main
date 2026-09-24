/* ==========================================================================
   PRESENSI IGNASIAN — Lapisan Data Supabase
   --------------------------------------------------------------------------
   Menghubungkan aplikasi (tetap "luring lebih dahulu / offline-first")
   dengan basis data Supabase melalui REST API bawaan Supabase (PostgREST).

   Mengapa REST langsung, bukan pustaka supabase-js dari CDN:
   • Tanpa dependensi CDN tambahan → app shell tetap ringan dan utuh luring.
   • Permukaan API kecil dan mudah diaudit: pilih / simpan / hapus.
   • IndexedDB tetap menjadi penyimpanan utama; Supabase hanya tujuan sinkron,
     sehingga tidak ada data yang hilang saat sambungan putus.

   Peta koleksi aplikasi → tabel Supabase (lihat supabase/schema.sql):
     users    → public.users
     jadwal   → public.jadwal
     presensi → public.presensi
     logs     → public.logs
   ========================================================================== */

/* Nilai bawaan bila js/config.js belum lengkap */
const SUPA_DEFAULTS = {
  SUPABASE_URL: '',
  SUPABASE_ANON_KEY: '',
  SUPABASE_SCHEMA: 'public',
  PAGE_SIZE: 1000,
  MAX_ROWS: 20000,
  TIMEOUT_MS: 15000,
  LOG_PULL_LIMIT: 200
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
      email: 'email', createdAt: 'created_at', updatedAt: 'updated_at'
    },
    numeric: []
  },
  jadwal: {
    table: 'jadwal',
    fields: {
      id: 'id', nama: 'nama', venue: 'venue', durasi: 'durasi', radius: 'radius',
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
  }
};

/* Jenis operasi pada antrean (outbox) → nama koleksi/tabel Supabase */
const SUPA_OUTBOX_TABLES = {
  user: 'users', jadwal: 'jadwal', presensi: 'presensi', log: 'logs',
  request: 'requests'
};

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

function supaIsPermanent(err) {
  if (!err || err.network) return false;
  const code = err.code || '';
  /* Tabel/skema belum dibuat → JANGAN buang data, cukup tunggu sampai
     Administrator menjalankan supabase/schema.sql. */
  if (code === 'PGRST205' || code === 'PGRST202' || code === '42P01' || code === '3F000') return false;
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

/* Simpan (tambah/perbarui) satu catatan — upsert berdasarkan id */
async function supaPush(coll, rec) {
  const meta = SUPA_TABLES[coll];
  if (!meta) throw supaError('Tabel tidak dikenal: ' + coll);
  const row = supaToRow(coll, rec);
  if (!row || !row.id) throw supaError('Catatan tanpa id tidak dapat dikirim');
  await supaFetch(meta.table + '?on_conflict=id', {
    method: 'POST',
    headers: { 'Prefer': 'resolution=merge-duplicates,return=minimal' },
    body: row
  });
  return true;
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
  const jobs = [
    ['users', supaSelect('users')],
    ['jadwal', supaSelect('jadwal')],
    ['presensi', supaSelect('presensi')]
  ];
  if (opts && opts.includeLogs) {
    jobs.push(['logs', supaSelect('logs', {
      order: 'timestamp.desc',
      maxRows: Math.max(10, Number(supaConfig().LOG_PULL_LIMIT) || 200)
    })]);
  }
  /* Permintaan pemulihan kata sandi hanya relevan (dan hanya patut dibaca)
     oleh Administrator yang akan menindaklanjutinya. */
  if (opts && opts.includeRequests) {
    jobs.push(['requests', supaSelect('requests', { order: 'requested_at.desc', maxRows: 300 })]);
  }

  const settled = await Promise.allSettled(jobs.map(j => j[1]));
  const data = {};
  const errors = [];
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') data[jobs[i][0]] = r.value || [];
    else errors.push({ collection: jobs[i][0], error: r.reason });
  });

  errors.forEach(e => console.warn('[Supabase] gagal menarik ' + e.collection + ':', e.error));
  if (!Object.keys(data).length) throw (errors[0] ? errors[0].error : new Error('Tarikan data gagal'));
  return data;
}

/* ---------- Diagnostik (menu Pengaturan) --------------------------------- */

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

/* Uji kesiapan: konfigurasi + akses empat tabel */
async function supaDiagnose() {
  const report = { ready: supaReady(), host: supaHost(), tables: [], ok: false, error: null };
  if (!report.ready) {
    report.error = 'SUPABASE_URL dan SUPABASE_ANON_KEY belum diisi pada js/config.js';
    return report;
  }
  const names = ['users', 'jadwal', 'presensi', 'logs'];
  const settled = await Promise.allSettled(names.map(n => supaCount(n)));
  settled.forEach((r, i) => {
    report.tables.push({
      name: names[i],
      ok: r.status === 'fulfilled',
      count: r.status === 'fulfilled' ? r.value : null,
      error: r.status === 'rejected' ? supaErrorHint(r.reason) : null
    });
  });
  report.ok = report.tables.every(t => t.ok);
  if (!report.ok) {
    const bad = report.tables.filter(t => !t.ok)[0];
    report.error = bad && bad.error ? bad.error : 'Sebagian tabel belum dapat dibaca';
  }
  return report;
}

