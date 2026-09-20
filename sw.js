/* ==========================================================================
   PRESENSI IGNASIAN — Service Worker (offline-first)
   --------------------------------------------------------------------------
   • App shell (HTML/CSS/JS) disimpan lebih dahulu ke cache satu per satu,
     sehingga satu berkas gagal tidak menggagalkan seluruh pemasangan.
   • Dokumen   : network-first, jatuh ke cache saat luring.
   • Aset lokal: cache-first + perbarui di latar.
   • CDN luar  : stale-while-revalidate (peta, font, pustaka QR).
   • Data ke Google Apps Script tidak pernah di-cache (selalu daring).
   ========================================================================== */
const VERSION = 'v5';
const SHELL_CACHE = 'ign-shell-' + VERSION;
const RUNTIME_CACHE = 'ign-runtime-' + VERSION;

const SHELL = [
  './',
  './index.html',
  './manifest.json',
  './css/variables.css',
  './css/base.css',
  './css/layout.css',
  './css/components.css',
  './css/pages.css',
  './css/utilities.css',
  './js/icons.js',
  './js/app.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-512.png',
  './icons/apple-touch-icon.png'
];

const RUNTIME = [
  'https://fonts.googleapis.com/css2?family=Cinzel:wght@500;600;700&family=EB+Garamond:ital,wght@0,400;0,500;0,600;1,400&display=swap',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  'https://cdn.jsdelivr.net/npm/qrcode@1.5.3/build/qrcode.min.js',
  'https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js'
];

async function precache(cacheName, urls) {
  const cache = await caches.open(cacheName);
  await Promise.all(urls.map(async url => {
    try {
      await cache.add(new Request(url, { cache: 'reload' }));
    } catch (err) {
      console.warn('[SW] gagal menyimpan', url, err);
    }
  }));
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    await precache(SHELL_CACHE, SHELL);
    await precache(RUNTIME_CACHE, RUNTIME);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter(k => k !== SHELL_CACHE && k !== RUNTIME_CACHE).map(k => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

async function networkFirst(req) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const res = await fetch(req);
    if (res && res.ok) cache.put('./index.html', res.clone());
    return res;
  } catch (err) {
    const hit = (await caches.match(req, { ignoreSearch: true })) || (await cache.match('./index.html'));
    if (hit) return hit;
    return new Response(
      '<!DOCTYPE html><meta charset="utf-8"><title>Luring</title>' +
      '<p style="font-family:Georgia,serif;padding:24px">Aplikasi belum tersimpan di perangkat ini. ' +
      'Buka sekali saat daring, lalu dapat digunakan sepenuhnya secara luring.</p>',
      { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    );
  }
}

async function cacheFirst(req) {
  const hit = await caches.match(req, { ignoreSearch: true });
  if (hit) {
    revalidate(SHELL_CACHE, req);
    return hit;
  }
  const cache = await caches.open(SHELL_CACHE);
  try {
    const res = await fetch(req);
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  } catch (err) {
    return new Response('', { status: 504, statusText: 'Luring' });
  }
}

async function staleWhileRevalidate(req) {
  const cache = await caches.open(RUNTIME_CACHE);
  const hit = await caches.match(req, { ignoreSearch: true });
  const network = fetch(req).then(res => {
    if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
    return res;
  }).catch(() => null);
  if (hit) return hit;
  const res = await network;
  return res || new Response('', { status: 504, statusText: 'Luring' });
}

function revalidate(cacheName, req) {
  caches.open(cacheName).then(cache =>
    fetch(req).then(res => { if (res && res.ok) cache.put(req, res.clone()); }).catch(() => {})
  );
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch (e) { return; }
  if (url.hostname.indexOf('script.google.com') !== -1) return;   // data: selalu daring

  if (req.mode === 'navigate' || req.destination === 'document') {
    event.respondWith(networkFirst(req));
    return;
  }
  if (url.origin === self.location.origin) {
    event.respondWith(cacheFirst(req));
    return;
  }
  if (url.protocol === 'http:' || url.protocol === 'https:') {
    event.respondWith(staleWhileRevalidate(req));
  }
});

/* Sinkronisasi latar: pengingat bagi aplikasi untuk mengirim antrean */
async function pingClients() {
  const all = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' });
  all.forEach(client => client.postMessage({ type: 'flush-outbox' }));
}

self.addEventListener('sync', event => {
  if (event.tag === 'ign-outbox') event.waitUntil(pingClients());
});

self.addEventListener('message', event => {
  const data = event.data || {};
  if (data.type === 'SKIP_WAITING') self.skipWaiting();
  if (data.type === 'SYNC_NOW') event.waitUntil(pingClients());
});
