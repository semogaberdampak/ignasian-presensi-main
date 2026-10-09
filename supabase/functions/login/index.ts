// Edge Function `login` — penangan HTTP (bagian 2/2; logika di bantu.ts).
import { bersihkanKunci, catatGagal, cekKunci, corsHeaders, getSecret, sbBase, sbHeaders, sha256Hex, signJwt, TTL, upgradeHash, verifyPassword } from "./bantu.ts";

Deno.serve(async (req: Request) => {
  const cors = corsHeaders(req);
  const json = (body: unknown, status = 200) =>
    Response.json(body, { status, headers: cors });
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "method-tidak-didukung" }, 405);

  let secret: string;
  try {
    secret = getSecret("JWT_SECRET");
  } catch {
    console.error("[login] JWT_SECRET belum di-set");
    return json({ ok: false, error: "server-belum-dikonfigurasi" }, 500);
  }

  let body: { username?: unknown; password?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "permintaan-tidak-valid" }, 400);
  }
  const username = String(body.username || "").trim().toLowerCase();
  const password = String(body.password || "");
  if (!username || !password) return json({ ok: false, error: "username-password-salah" }, 401);

  const kunci = "login:" + username;

  try {
    const sisa = await cekKunci(kunci);
    if (sisa > 0) {
      return json({ ok: false, error: "terlalu-banyak-percobaan", cobaLagiDalamDetik: sisa }, 429);
    }

    const q = await fetch(
      sbBase() + "/rest/v1/users?username=ilike." + encodeURIComponent(username) +
        "&select=id,nama,username,pass_hash,pass_bcrypt,role,status,harus_ganti_sandi",
      { headers: sbHeaders() },
    );
    if (!q.ok) throw new Error("db-baca-gagal:" + q.status);
    const list = await q.json();
    const u = list && list[0];

    let cocok = false;
    let perluUpgrade = false;
    if (u && u.status === "aktif" && password) {
      if (u.pass_bcrypt) {
        cocok = await verifyPassword(password, String(u.pass_bcrypt));
      } else if (u.pass_hash) {
        const h = await sha256Hex(password);
        cocok = h === String(u.pass_hash) || ("v1:" + h) === String(u.pass_hash);
        perluUpgrade = cocok;
      }
    }

    if (!cocok) {
      await catatGagal(kunci, username);
      return json({ ok: false, error: "username-password-salah" }, 401);
    }

    if (perluUpgrade) await upgradeHash(String(u.id), password);
    await bersihkanKunci(kunci);

    const ttl = TTL[String(u.role)] || TTL.peserta;
    const now = Math.floor(Date.now() / 1000);
    const token = await signJwt(
      { uid: String(u.id), role: String(u.role), iat: now, exp: now + ttl },
      secret,
    );
    return json({
      ok: true,
      token,
      user: {
        id: String(u.id),
        nama: u.nama,
        username: u.username,
        role: u.role,
        harusGantiSandi: u.harus_ganti_sandi === true,
      },
      perluGantiSandi: u.harus_ganti_sandi === true,
    });
  } catch (e) {
    if (String((e as Error).message || "").startsWith("SECRET_MISSING")) {
      console.error("[login]", (e as Error).message);
      return json({ ok: false, error: "server-belum-dikonfigurasi" }, 500);
    }
    console.error("[login] galat:", e);
    return json({ ok: false, error: "kesalahan-server" }, 500);
  }
});
