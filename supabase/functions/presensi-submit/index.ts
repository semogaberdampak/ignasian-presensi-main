// `presensi-submit` — penangan HTTP (bagian 2/2; aturan di validasi.ts).
import { ambilJadwal, corsHeaders, failReason, getSecret, haversine, sbBase, sbHeaders, sigLama, sigResmi, verifyJwt } from "./validasi.ts";

/* Masa tenggang QR cetakan lama (sig FNV): 14 hari sejak deploy. */
const TENGGANG_MS = 14 * 24 * 3600 * 1000;
const DEPLOY_AT = 1791440000000; /* 2026-10-08: sesuaikan bila deploy mundur */

function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

Deno.serve(async (req: Request) => {
  const cors = corsHeaders(req);
  const json = (body: unknown, status = 200) =>
    Response.json(body, { status, headers: cors });
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  let jwtSecret: string, qrSecret: string;
  try {
    jwtSecret = getSecret("JWT_SECRET");
    qrSecret = getSecret("QR_HMAC_SECRET");
  } catch {
    console.error("[presensi-submit] secret belum di-set");
    return json({ ok: false, error: "server-belum-dikonfigurasi" }, 500);
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "permintaan-tidak-valid" }, 400);
  }

  try {
    const auth = req.headers.get("authorization") || "";
    const token = (auth.startsWith("Bearer ") ? auth.slice(7) : String(body.token || "")).trim();
    const klaim = await verifyJwt(token, jwtSecret);
    if (!klaim || !klaim.uid) return json({ ok: false, error: "sesi-berakhir" }, 401);
    const userId = String(klaim.uid);

    const jadwalId = String(body.jadwalId || "");
    const lat = Number(body.lat), lng = Number(body.lng);
    if (!jadwalId || !Number.isFinite(lat) || !Number.isFinite(lng)) {
      return json({ ok: false, error: "parameter-tidak-lengkap" }, 400);
    }
    const j = await ambilJadwal(jadwalId);
    if (!j) return json({ ok: false, error: "acara-tidak-ditemukan" }, 404);

    if (j.open_gate && Date.now() < Date.parse(String(j.open_gate))) {
      await failReason("open-gate", { userId, jadwalId });
      return json({ ok: false, error: "gate-belum-dibuka" }, 403);
    }

    const start = Date.parse(String(j.tanggal));
    const durasi = Number(j.durasi) || 60;
    const end = start + durasi * 60000;
    const now = Date.now();
    if (!Number.isFinite(start)) return json({ ok: false, error: "waktu-acara-belum-ditetapkan" }, 422);
    if (now < start - 300000 || now > end) {
      await failReason("di-luar-sesi", { userId, jadwalId });
      return json({ ok: false, error: "sesi-belum-dibuka-atau-sudah-berakhir" }, 403);
    }

    const kiriman = String(body.qrSig || "");
    const resmi = await sigResmi(j, qrSecret);
    let sigOk = kiriman !== "" && kiriman === resmi;
    let viaLama = false;
    if (!sigOk && Date.now() - DEPLOY_AT < TENGGANG_MS && kiriman === sigLama(j)) {
      sigOk = true;
      viaLama = true;
    }
    if (!sigOk) {
      await failReason("qr-tidak-sah", { userId, jadwalId });
      return json({ ok: false, error: "qr-tidak-sah" }, 403);
    }

    const radius = Number(j.radius) || 50;
    const dist = haversine(lat, lng, Number(j.lat), Number(j.lng));
    if (!(dist <= radius)) {
      await failReason("di-luar-radius", { userId, jadwalId, distance: Math.round(dist) });
      return json({ ok: false, error: "terlalu-jauh", jarakM: Math.round(dist), radiusM: radius }, 403);
    }
    let nama = "Peserta";
    try {
      const uq = await fetch(
        sbBase() + "/rest/v1/users?id=eq." + encodeURIComponent(userId) + "&select=nama,status",
        { headers: sbHeaders() },
      );
      if (uq.ok) {
        const ul = await uq.json();
        if (ul && ul[0]) {
          if (ul[0].status !== "aktif") return json({ ok: false, error: "akun-nonaktif" }, 403);
          nama = String(ul[0].nama || nama);
        }
      }
    } catch { /* nama cadangan dipakai */ }

    const pres = {
      id: uid(),
      user_id: userId,
      user_name: nama,
      jadwal_id: String(j.id),
      jadwal_nama: String(j.nama || ""),
      venue: String(j.venue || ""),
      status: "hadir",
      metode: "qr",
      lat,
      lng,
      accuracy: Number(body.accuracy) || null,
      distance: Math.round(dist * 10) / 10,
      timestamp: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    const ins = await fetch(sbBase() + "/rest/v1/presensi", {
      method: "POST",
      headers: { ...sbHeaders(), Prefer: "return=representation" },
      body: JSON.stringify(pres),
    });
    if (ins.status === 409) {
      return json({ ok: true, sudahTercatat: true, jarakM: Math.round(dist) });
    }
    if (!ins.ok) throw new Error("db-insert-gagal:" + ins.status);



    const tersimpan = await ins.json();
    try {
      await fetch(sbBase() + "/rest/v1/logs", {
        method: "POST",
        headers: sbHeaders(),
        body: JSON.stringify({
          id: uid(),
          action: "PRESENSI",
          details: {
            jadwalId: String(j.id),
            nama: String(j.nama || ""),
            metode: "qr",
            distance: Math.round(dist),
            viaQrLama: viaLama,
          },
          user_id: userId,
          user_name: nama,
          user_role: String(klaim.role || "peserta"),
        }),
      });
    } catch { /* abaikan */ }
    return json({ ok: true, presensi: (tersimpan && tersimpan[0]) || pres, viaQrLama: viaLama });
  } catch (e) {
    if (String((e as Error).message || "").startsWith("SECRET_MISSING")) {
      console.error("[presensi-submit]", (e as Error).message);
      return json({ ok: false, error: "server-belum-dikonfigurasi" }, 500);
    }
    console.error("[presensi-submit] galat:", e);
    return json({ ok: false, error: "kesalahan-server" }, 500);
  }
});