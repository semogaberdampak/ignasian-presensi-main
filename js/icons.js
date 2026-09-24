/* ==========================================================================
   PRESENSI IGNASIAN — Perangkat Ikon (sprite SVG kustom)
   --------------------------------------------------------------------------
   Seluruh ikon digambar sendiri dengan satu bahasa rupa: kotak 24x24,
   guratan 1.6px, ujung membulat, tanpa isian pekat. Motifnya diambil dari
   khazanah Katolik/Ignatian (kapel, penanda ziarah, codex, bulla, rose
   window, kompas ziarah, segel lilin, lampada) — bukan ikon generik/emoji.
   Dipakai: <span class="ic" data-ic="chapel"></span>  atau  ic('chapel')
   ========================================================================== */
(function () {
  'use strict';

  var SYMBOLS = {
    /* Kapel beratap pelana dengan salib — Beranda */
    chapel:
      '<path d="M12 5.6V1.6M9.9 3.1h4.2"/>' +
      '<path d="M4.6 11.2 12 5.2l7.4 6"/>' +
      '<path d="M6.6 11v8.4h10.8V11"/>' +
      '<path d="M3.4 19.4h17.2"/>' +
      '<path d="M10.7 19.4v-3.6a1.3 1.3 0 0 1 2.6 0v3.6"/>' +
      '<circle cx="12" cy="14" r="1"/>',

    /* Penanda ziarah bersalib — Presensi */
    pilgrim:
      '<path d="M12 21.6c0 0 7-6.8 7-12.1a7 7 0 0 0-14 0c0 5.3 7 12.1 7 12.1Z"/>' +
      '<path d="M12 5.4v5.2M9.7 7.6h4.6"/>',

    /* Codex terbuka — Riwayat */
    codex:
      '<path d="M3.2 6.2c2.6-1.6 5.6-1.6 8.8 0 3.2-1.6 6.2-1.6 8.8 0v12.2c-2.6-1.6-5.6-1.6-8.8 0-3.2-1.6-6.2-1.6-8.8 0Z"/>' +
      '<path d="M12 6.2v12.2"/>' +
      '<path d="M5.8 9.6h3.4M5.8 12.4h3.4M14.8 9.6h3.4M14.8 12.4h3.4"/>',

    /* Bulla bersegel — Laporan */
    bulla:
      '<rect x="4.6" y="3.4" width="14.8" height="17.2" rx="1.8"/>' +
      '<circle cx="12" cy="7.6" r="1.6"/>' +
      '<path d="M12 6.6v2M11 7.6h2"/>' +
      '<path d="M8.4 17.8v-3.4M12 17.8v-5.6M15.6 17.8v-7.6"/>',

    /* Rose window — Lainnya */
    rosette:
      '<circle cx="12" cy="12" r="8.7"/>' +
      '<path d="M12 12c2.4-2.4 2.4-5.2 0-8.4-2.4 3.2-2.4 6 0 8.4Z"/>' +
      '<path d="M12 12c2.4 2.4 5.2 2.4 8.4 0-3.2-2.4-6-2.4-8.4 0Z"/>' +
      '<path d="M12 12c-2.4 2.4-2.4 5.2 0 8.4 2.4-3.2 2.4-6 0-8.4Z"/>' +
      '<path d="M12 12c-2.4-2.4-5.2-2.4-8.4 0 3.2 2.4 6 2.4 8.4 0Z"/>',

    /* Kunci bergagang salib — Masuk */
    keycross:
      '<circle cx="7.4" cy="15.8" r="4.1"/>' +
      '<path d="M7.4 13.3v5M4.9 15.8h5"/>' +
      '<path d="M11.4 12.1 20.6 3"/>' +
      '<path d="M16.4 7.1v3.2M18.4 5.1v3.2"/>',

    /* Gapura biara — Keluar */
    gate:
      '<path d="M12 1.6v2.6M10.7 2.4h2.6"/>' +
      '<path d="M4.6 20.4V11.6a7.4 7.4 0 0 1 14.8 0v8.8"/>' +
      '<path d="M2.6 20.4h18.8"/>' +
      '<path d="M12 20.4v-7.2"/>' +
      '<circle cx="14.2" cy="16.4" r=".9" fill="currentColor" stroke="none"/>',

    /* Tokoh dengan halo — Profil */
    halobust:
      '<path d="M6.4 7.4a5.6 5.6 0 0 1 11.2 0"/>' +
      '<circle cx="12" cy="10.4" r="3.1"/>' +
      '<path d="M5.6 20.6c0-4 2.9-6.3 6.4-6.3s6.4 2.3 6.4 6.3"/>',

    /* Dua tokoh berhalo — Manajemen peserta */
    halopair:
      '<path d="M4.4 8.2a4.9 4.9 0 0 1 9.8 0"/>' +
      '<circle cx="9.3" cy="10.8" r="2.8"/>' +
      '<path d="M3.4 20.6c0-3.6 2.6-5.6 5.9-5.6s5.9 2 5.9 5.6"/>' +
      '<path d="M17.3 9.6a2.3 2.3 0 0 1 3.4 0"/>' +
      '<circle cx="19" cy="11.6" r="2.2"/>' +
      '<path d="M16 20.6c0-3.1 1.3-5 3.4-5.4"/>',

    /* Perkamen & pena — Registrasi */
    quill:
      '<rect x="4.2" y="3.6" width="10.6" height="16.8" rx="1.6"/>' +
      '<path d="M7 8h5M7 11.4h5M7 14.8h3"/>' +
      '<path d="M14.6 18.4 21.4 2.8"/>' +
      '<path d="M21.4 2.8c-2.7.4-4.6 1.6-5.6 3.3"/>',

    /* Jam ibadat (horarium) — Jadwal */
    horarium:
      '<circle cx="12" cy="12" r="8.6"/>' +
      '<path d="M12 3.4v2.2M20.6 12h-2.2M12 20.6v-2.2M3.4 12h2.2"/>' +
      '<path d="M12 12V7.4M12 12l3.4 2.2"/>',

    /* Buku besar berkancing — Log */
    ledger:
      '<rect x="4.4" y="3.6" width="15.2" height="16.8" rx="1.6"/>' +
      '<path d="M7.6 7.6h8.8M7.6 11.2h8.8M7.6 14.8h5.6"/>' +
      '<path d="M19.6 9.6v4.8"/>',

    /* Matriks berkode — Buat QR */
    matrix:
      '<rect x="3.6" y="3.6" width="6.2" height="6.2" rx="1.4"/>' +
      '<rect x="14.2" y="3.6" width="6.2" height="6.2" rx="1.4"/>' +
      '<rect x="3.6" y="14.2" width="6.2" height="6.2" rx="1.4"/>' +
      '<path d="M12 10v4M10 12h4"/>' +
      '<circle cx="12.4" cy="17.1" r="1" fill="currentColor" stroke="none"/>' +
      '<circle cx="17.1" cy="12.4" r="1" fill="currentColor" stroke="none"/>' +
      '<circle cx="17.1" cy="17.1" r="1" fill="currentColor" stroke="none"/>',

    /* Bingkai bidik — Pindai */
    viewfinder:
      '<path d="M3.4 8.6V5A1.6 1.6 0 0 1 5 3.4h3.6"/>' +
      '<path d="M15.4 3.4H19A1.6 1.6 0 0 1 20.6 5v3.6"/>' +
      '<path d="M20.6 15.4V19a1.6 1.6 0 0 1-1.6 1.6h-3.6"/>' +
      '<path d="M8.6 20.6H5A1.6 1.6 0 0 1 3.4 19v-3.6"/>' +
      '<rect x="9.4" y="9.4" width="5.2" height="5.2" rx="1"/>' +
      '<circle cx="12" cy="12" r=".9" fill="currentColor" stroke="none"/>',

    /* Kompas ziarah — Lokasi */
    compass:
      '<circle cx="12" cy="12" r="8.6"/>' +
      '<path d="M12 3.4 13.7 10.3 20.6 12 13.7 13.7 12 20.6 10.3 13.7 3.4 12 10.3 10.3Z"/>' +
      '<circle cx="12" cy="12" r=".9" fill="currentColor" stroke="none"/>',

    /* Segel lilin — Simpan / Tetapkan */
    seal:
      '<circle cx="12" cy="9.4" r="5.6"/>' +
      '<path d="M12 6.6v5.6M9.6 8.6h4.8"/>' +
      '<path d="M8.8 13.9 7 21.2l5-2.4 5 2.4-1.8-7.3"/>',

    /* Matahari gilap — Tema terang */
    sunray:
      '<circle cx="12" cy="12" r="4.2"/>' +
      '<path d="M12 2.2v3.2M12 18.6v3.2M2.2 12h3.2M18.6 12h3.2"/>' +
      '<path d="M5.2 5.2l2.3 2.3M16.5 16.5l2.3 2.3M18.8 5.2l-2.3 2.3M7.5 16.5l-2.3 2.3"/>',

    /* Bulan sabit berbintang salib — Tema gelap */
    moonstar:
      '<path d="M20.2 15.6A8.8 8.8 0 0 1 8.6 4 8.8 8.8 0 1 0 20.2 15.6Z"/>' +
      '<path d="M17.8 4.2v3.6M16 6h3.6"/>',

    /* Dua panah melingkar — Sinkronisasi */
    sync:
      '<path d="M20.4 12A8.4 8.4 0 0 0 5.8 6.3"/>' +
      '<path d="M3.6 12a8.4 8.4 0 0 0 14.6 5.7"/>' +
      '<path d="M5.8 2.6v4h4"/>' +
      '<path d="M18.2 21.4v-4h-4"/>',

    /* Lampada bernyala — Aktif */
    lamp:
      '<path d="M4.8 13.4h14.4l-1.5 5.6a1.8 1.8 0 0 1-1.7 1.3H8a1.8 1.8 0 0 1-1.7-1.3Z"/>' +
      '<path d="M12 13.4v-2"/>' +
      '<path d="M12 11.4c1.7-1.4 1.4-3.8 0-5.4-1.4 1.6-1.7 4 0 5.4Z"/>',

    /* Lampada tertutup — Nonaktif */
    lampoff:
      '<path d="M4.8 13.4h14.4l-1.5 5.6a1.8 1.8 0 0 1-1.7 1.3H8a1.8 1.8 0 0 1-1.7-1.3Z"/>' +
      '<path d="M7.6 13.4a4.4 4.4 0 0 1 8.8 0"/>' +
      '<path d="M12 9v-1.6"/>',

    /* Lembaran dibatalkan — Hapus */
    scrap:
      '<rect x="4.8" y="3.6" width="14.4" height="16.8" rx="1.6"/>' +
      '<path d="M8.4 8.2l7.2 7.6M15.6 8.2l-7.2 7.6"/>',

    /* Turun ke arsip — Unduh */
    descend:
      '<path d="M12 3.4v10.2M7.6 9.6 12 14l4.4-4.4"/>' +
      '<path d="M4.6 17.4v1.6a1.8 1.8 0 0 0 1.8 1.8h11.2a1.8 1.8 0 0 0 1.8-1.8v-1.6"/>',

    /* Salib latin — lambang utama */
    cross: '<path d="M12 3.2v17.6M6.6 9.4h10.8"/>',

    /* Lilin votif — Bantuan */
    candle:
      '<path d="M12 3.6c1.6 1.9 1.6 3.8 0 5.6-1.6-1.8-1.6-3.7 0-5.6Z"/>' +
      '<path d="M12 9.2v1.4"/>' +
      '<path d="M8.6 10.6h6.8l-.7 8.4a1.6 1.6 0 0 1-1.6 1.4H10.9a1.6 1.6 0 0 1-1.6-1.4Z"/>' +
      '<path d="M7.6 20.4h8.8"/>',

    /* Astrolab — Pengaturan */
    dial:
      '<circle cx="12" cy="12" r="8.6"/>' +
      '<circle cx="12" cy="12" r="1.1" fill="currentColor" stroke="none"/>' +
      '<path d="M12 12 16.8 8.2"/>' +
      '<path d="M12 3.4v1.8M20.6 12h-1.8M12 20.6v-1.8M3.4 12h1.8"/>',

    /* Gantungan kunci — Lupa password */
    keyring:
      '<circle cx="8.4" cy="16.4" r="3.6"/>' +
      '<path d="M11 14 19.6 5.4"/>' +
      '<path d="M14.4 9.2l2.2 2.2M16.8 6.8l2.2 2.2"/>' +
      '<path d="M5.2 16.4h1M7.3 14.7h1"/>',

    /* Mata terbuka — lihat kata sandi */
    eye:
      '<path d="M2.8 12S6.4 5.8 12 5.8 21.2 12 21.2 12 17.6 18.2 12 18.2 2.8 12 2.8 12Z"/>' +
      '<circle cx="12" cy="12" r="3"/>',

    /* Gelembung obrolan dengan gagang telepon — hubungi via WhatsApp */
    wa:
      '<path d="M20.4 11.4a8.4 8.4 0 0 1-12.6 7.3L3.6 20.4l1.7-4.2A8.4 8.4 0 1 1 20.4 11.4Z"/>' +
      '<path d="M9.2 9.4c0 3 2.4 5.4 5.4 5.4v-1.9l-1.6-.7a4.6 4.6 0 0 1-1.2-1.2l-.7-1.6Z"/>',

    /* Jam dinding — masa berlaku sesi masuk */
    clock:
      '<circle cx="12" cy="12" r="8.8"/>' +
      '<path d="M12 6.8V12l3.4 2.2"/>'
  };


  var DEFAULT = 'cross';

  function useEl(name) {
    var key = Object.prototype.hasOwnProperty.call(SYMBOLS, name) ? name : DEFAULT;
    return '<use href="#ic-' + key + '" xlink:href="#ic-' + key + '"></use>';
  }

  /* <svg> mandiri (dipakai pada template JS): ic('seal','ic-lg') */
  function ic(name, cls) {
    return '<svg class="ic' + (cls ? ' ' + cls : '') + '" viewBox="0 0 24 24"' +
      ' aria-hidden="true" focusable="false">' + useEl(name) + '</svg>';
  }

  /* Sematkan sprite ke dokumen (aman dipanggil berkali-kali) */
  function mount() {
    if (document.getElementById('ign-icon-sprite')) return;
    var markup = '<svg id="ign-icon-sprite" xmlns="http://www.w3.org/2000/svg" ' +
      'style="position:absolute;width:0;height:0;overflow:hidden" aria-hidden="true" focusable="false"><defs>';
    Object.keys(SYMBOLS).forEach(function (k) {
      markup += '<symbol id="ic-' + k + '" viewBox="0 0 24 24" fill="none" ' +
        'stroke="currentColor" stroke-width="1.6" stroke-linecap="round" ' +
        'stroke-linejoin="round">' + SYMBOLS[k] + '</symbol>';
    });
    markup += '</defs></svg>';

    var holder = document.createElement('div');
    holder.id = 'ign-icon-holder';
    holder.setAttribute('aria-hidden', 'true');
    holder.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden';
    holder.innerHTML = markup;
    document.body.insertBefore(holder, document.body.firstChild);
  }

  /* Isi setiap <span class="ic" data-ic="nama"> dengan lambangnya */
  function hydrate(root) {
    var scope = root || document;
    var nodes = scope.querySelectorAll('[data-ic]');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var name = el.getAttribute('data-ic');
      if (el.getAttribute('data-ic-done') === name) continue;
      el.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
        useEl(name) + '</svg>';
      el.setAttribute('data-ic-done', name);
    }
  }

  window.Icon = { sprite: SYMBOLS, names: Object.keys(SYMBOLS), mount: mount, hydrate: hydrate };
  window.ic = ic;

  var boot = function () { mount(); hydrate(); };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();

