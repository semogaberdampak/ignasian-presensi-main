// ============================================================================
//  PRESENSI IGNASIAN — Edge Function `login` (Fase B, tahap 1), bagian 1/2
// ----------------------------------------------------------------------------
//  POST { username, password } -> { ok, token, user } / { ok:false, error }.
//  Throttle server (login_attempts): 5 gagal -> 30 dtk, ganda s.d. 15 mnt.
//  Verifikasi PBKDF2 baru; fallback SHA-256 lama + upgrade otomatis.
//  JWT HS256 (JWT_SECRET), TTL per peran 30/45/60 mnt. Pesan galat generik.
// ============================================================================

import { getSecret } from "../_shared/util.ts";
import { hashPassword, sha256Hex, signJwt, verifyPassword } from "../_shared/auth.ts";

const BATAS = 5;
const JEDA_AWAL_MS = 30000;
const JEDA_MAKS_MS = 900000;

const TTL: Record<string, number> = { admin: 3600, pengurus: 2700, peserta: 1800 };

export function corsHeaders(req: Request): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": req.headers.get("origin") || "*",
    "Access-Control-Allow-Headers": "authorization, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
  };
}

export function sbHeaders() {
  return {
    apikey: Deno.env.get("SUPABASE_ANON_KEY") || "",
    Authorization: "Bearer " + (Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || ""),
    "Content-Type": "application/json",
  };
}

export function sbBase(): string {
  return Deno.env.get("SUPABASE_URL") || "";
}

/* Kunci throttle + sisa detik bila masih dikunci (0 = boleh mencoba). */
export async function cekKunci(kunci: string): Promise<number> {
  const cek = await fetch(
    sbBase() + "/rest/v1/login_attempts?kunci=eq." + encodeURIComponent(kunci) + "&select=*",
    { headers: sbHeaders() },
  );
  if (!cek.ok) return 0;
  const rows = await cek.json();
  const s = rows && rows[0];
  if (s && s.kunci_sampai && Date.parse(s.kunci_sampai) > Date.now()) {
    return Math.ceil((Date.parse(s.kunci_sampai) - Date.now()) / 1000);
  }
  return 0;
}

/* Catat satu kegagalan; aktifkan/panjangkan kunci bila ambang terlampaui. */
export async function catatGagal(kunci: string, username: string): Promise<void> {
  try {
    const baca = await fetch(
      sbBase() + "/rest/v1/login_attempts?kunci=eq." + encodeURIComponent(kunci) + "&select=gagal",
      { headers: sbHeaders() },
    );
    let jumlah = 1;
    if (baca.ok) {
      const r = await baca.json();
      jumlah = Number((r && r[0] && r[0].gagal) || 0) + 1;
    }
    let sampai: string | null = null;
    if (jumlah >= BATAS) {
      const pangkat = Math.min(jumlah - BATAS, 10);
      const jeda = Math.min(JEDA_AWAL_MS * 2 ** pangkat, JEDA_MAKS_MS);
      sampai = new Date(Date.now() + jeda).toISOString();
    }
    await fetch(sbBase() + "/rest/v1/login_attempts", {
      method: "POST",
      headers: { ...sbHeaders(), Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify({ kunci, gagal: jumlah, kunci_sampai: sampai }),
    });
  } catch {
    /* throttle best-effort */
  }
  try {
    await fetch(sbBase() + "/rest/v1/logs", {
      method: "POST",
      headers: sbHeaders(),
      body: JSON.stringify({
        id: "srv-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
        action: "LOGIN_FAILED",
        details: { username },
        user_id: "system",
        user_name: "Sistem",
        user_role: "system",
      }),
    });
  } catch {
    /* abaikan */
  }
}

export async function bersihkanKunci(kunci: string): Promise<void> {
  try {
    await fetch(sbBase() + "/rest/v1/login_attempts?kunci=eq." + encodeURIComponent(kunci), {
      method: "DELETE",
      headers: sbHeaders(),
    });
  } catch {
    /* abaikan */
  }
}

export async function upgradeHash(userId: string, password: string): Promise<void> {
  try {
    await fetch(sbBase() + "/rest/v1/users?id=eq." + encodeURIComponent(userId), {
      method: "PATCH",
      headers: sbHeaders(),
      body: JSON.stringify({ pass_bcrypt: await hashPassword(password) }),
    });
  } catch {
    /* upgrade best-effort */
  }
}

export { getSecret, hashPassword, sha256Hex, signJwt, verifyPassword, TTL };
