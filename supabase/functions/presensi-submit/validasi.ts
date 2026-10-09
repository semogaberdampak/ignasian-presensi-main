// ============================================================================
//  PRESENSI IGNASIAN — Edge Function `presensi-submit`, bagian 1/2: validasi
// ----------------------------------------------------------------------------
//  POST { token, jadwalId, lat, lng, accuracy, qrSig } (+nama/venue cadangan).
//  Aturan server (cerminkan klien onScanSuccess, tapi TAK BISA dilewati):
//   1. JWT valid (JWT_SECRET) -> uid + role.
//   2. Jadwal ada; open_gate lewat (bila diset).
//   3. now dalam [tanggal-5 mnt, tanggal+durasi].
//   4. qrSig = HMAC-SHA256(QR_HMAC_SECRET, jadwal|tanggal|durasi|radius|
//      lat|lng)[0:10] — cocokkan dgn jadwal ATAU masa tenggang QR lama.
//   5. Jarak haversine(peserta, venue) <= radius.
//   6. Belum ada baris (user_id, jadwal_id) -> 409 ramah bila duplikat.
//  Insert memakai service_role (bypass RLS) SETELAH semua cek lolos.
// ============================================================================

import { getSecret, haversine, hmacSha256Hex } from "../_shared/util.ts";
import { verifyJwt } from "../_shared/auth.ts";
import { corsHeaders, failReason, sbBase, sbHeaders } from "./bantu.ts";

/* Tanda tangan HMAC resmi untuk satu jadwal. */
export async function sigResmi(j: Record<string, unknown>, secret: string): Promise<string> {
  const msg = [String(j.id), String(j.tanggal), String(j.durasi), String(j.radius),
    String(j.lat), String(j.lng)].join("|");
  return (await hmacSha256Hex(secret, msg)).slice(0, 10);
}

/* Tanda tangan FNV lama (kompatibilitas klien qrSignature saat ini).
   Cerminkan js/app.js fallbackHash persis agar QR cetakan lama tetap
   terbaca selama masa tenggang. */
export function sigLama(j: Record<string, unknown>): string {
  const text = [String(j.id), String(j.tanggal), String(j.durasi),
    String(j.radius), String(j.lat), String(j.lng)].join("|");
  let h1 = 0x811c9dc5, h2 = 0x1000193;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = (h1 ^ c) * 16777619 >>> 0;
    h2 = (h2 + c * (i + 7)) >>> 0;
  }
  return (h1.toString(16) + h2.toString(16)).slice(0, 10);
}

/* Ambil jadwal berdasarkan id; null bila tidak ada / galat DB. */
export async function ambilJadwal(jadwalId: string): Promise<Record<string, unknown> | null> {
  const r = await fetch(
    sbBase() + "/rest/v1/jadwal?id=eq." + encodeURIComponent(jadwalId) + "&select=*",
    { headers: sbHeaders() },
  );
  if (!r.ok) return null;
  const list = await r.json();
  return (list && list[0]) || null;
}

export { corsHeaders, failReason, getSecret, haversine, sbBase, sbHeaders, verifyJwt };
