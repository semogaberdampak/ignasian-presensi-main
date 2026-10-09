/* Jaring pengaman yang harus aktif SEBELUM js/app.js:
   1) penanda pemindai baku bila pustaka CDN gagal termuat;
   2) penangkal unhandledrejection yang takoineksial;
   3) pelepas selubung paksa bila app.js gagal total (parse error / 404).
   Dipisah dari inline (Fase 4A) demi CSP ketat. */

/* Bila CDN html5-qrcode gagal dimuat (luring / unpkg diblokir) tapi
     BarcodeDetector bawaan ada (Chrome/Edge Android), pemindai kamera tetap
     jalan via jalur native — jadi scan kamera tidak "mati total". */
window.addEventListener('load', function () {
    if (typeof Html5Qrcode === 'undefined' && ('BarcodeDetector' in window)) {
      try {
        var h = document.getElementById('scanHint');
        if (h) h.textContent = 'Mode pemindai bawaan siap (pustaka luring tidak termuat).';
      } catch (e) {}
    }
});

(function () {
function isIgnorable(r) {
    try {
      var name = r && r.name;
      var msg = String((r && (r.message || r)) || '');
      return name === 'NotAllowedError' || name === 'SecurityError' ||
        name === 'NotSupportedError' || /permission denied|not allowed/i.test(msg);
    } catch (e) { return false; }
}
window.addEventListener('unhandledrejection', function (ev) {
    if (isIgnorable(ev && ev.reason)) {
      try { ev.preventDefault(); } catch (e) {}
    }
});
/* Paksa lepas selubung dari luar app.js: bila app.js gagal total (parse
     error / 404 dari cache), timer ini tetap melepas layar IHS. */
setTimeout(function () {
    try { document.documentElement.removeAttribute('data-boot'); } catch (e) {}
    try {
      var v = document.getElementById('bootVeil');
      if (v) { v.style.display = 'none'; v.setAttribute('aria-hidden', 'true'); }
    } catch (e2) {}
}, 5000);
})();
