// ============================================================================
//  PRESENSI IGNASIAN — utilitas bersama Edge Functions (Fase B), bagian 1/2
// ----------------------------------------------------------------------------
//  Rahasia server (Vault secrets): JWT_SECRET (token sesi HS256) dan
//  QR_HMAC_SECRET (tanda tangan isi QR). Tanpa keduanya function menolak
//  berjalan (fail-closed).
// ============================================================================

const enc = new TextEncoder();

export function fail(message: string, status = 400, extra?: Record<string, unknown>) {
  return Response.json({ ok: false, error: message, ...(extra || {}) }, { status });
}

export function ok(data: Record<string, unknown> = {}) {
  return Response.json({ ok: true, ...data });
}

export function getSecret(name: string): string {
  const v = (Deno.env.get(name) || "").trim();
  if (!v) throw new Error("SECRET_MISSING:" + name);
  return v;
}

/* ---------- base64url (tanpa dependensi) ---------- */

export function b64urlEncode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(s: string): Uint8Array {
  const pad = (4 - (s.length % 4)) % 4;
  const b64 = (s + "=".repeat(pad)).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/* ---------- HMAC-SHA256 hex ---------- */

export async function hmacSha256Hex(key: string, msg: string): Promise<string> {
  const k = await crypto.subtle.importKey(
    "raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", k, enc.encode(msg));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
