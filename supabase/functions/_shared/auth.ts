// ============================================================================
//  PRESENSI IGNASIAN — utilitas bersama Edge Functions (Fase B), bagian 2/2
// ----------------------------------------------------------------------------
//  JWT HS256 minimal + PBKDF2-SHA256 (format "$pbkdf2-sha256$") + haversine
//  + tanda tangan QR. Semua tanpa dependensi npm (hanya WebCrypto + fetch).
// ============================================================================

import { b64urlDecode, b64urlEncode, hmacSha256Hex } from "./util.ts";

const enc = new TextEncoder();

/* ---------- JWT HS256 minimal ---------- */

export async function signJwt(payload: Record<string, unknown>, secret: string): Promise<string> {
  const head = b64urlEncode(enc.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const body = b64urlEncode(enc.encode(JSON.stringify(payload)));
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(head + "." + body));
  return head + "." + body + "." + b64urlEncode(new Uint8Array(sig));
}

/* Payload bila tanda tangan + exp valid; null bila tidak. Banding waktu
   konstan agar tidak bocor via timing. */
export async function verifyJwt(token: string, secret: string): Promise<Record<string, unknown> | null> {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) return null;
  const expect = await hmacSha256Hex(secret, parts[0] + "." + parts[1]);
  let actual: string;
  try {
    actual = Array.from(b64urlDecode(parts[2])).map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    return null;
  }
  if (actual.length !== expect.length) return null;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual.charCodeAt(i) ^ expect.charCodeAt(i);
  if (diff !== 0) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[1])));
    if (payload.exp && Date.now() > Number(payload.exp) * 1000) return null;
    return payload;
  } catch {
    return null;
  }
}

/* ---------- SHA-256 hex (kompatibilitas hash lama klien) ---------- */

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(text));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/* ---------- Kata sandi: PBKDF2-SHA256 120.000 iterasi ---------- */

const PW_PREFIX = "$pbkdf2-sha256$";

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: salt.buffer as ArrayBuffer, iterations: 120000, hash: "SHA-256" },
    key, 256,
  );
  return PW_PREFIX + "120000$" + b64urlEncode(salt) + "$" + b64urlEncode(new Uint8Array(bits));
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (!stored || !stored.startsWith(PW_PREFIX)) return false;
  const parts = stored.split("$");
  if (parts.length !== 5) return false;
  const iter = Number(parts[2]);
  if (!Number.isFinite(iter) || iter < 10000 || iter > 1000000) return false;
  let salt: Uint8Array, want: Uint8Array;
  try {
    salt = b64urlDecode(parts[3]);
    want = b64urlDecode(parts[4]);
  } catch {
    return false;
  }
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = new Uint8Array(await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: salt.buffer as ArrayBuffer, iterations: iter, hash: "SHA-256" },
    key, want.length * 8,
  ));
  if (bits.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < bits.length; i++) diff |= bits[i] ^ want[i];
  return diff === 0;
}

/* ---------- Haversine (meter) — validasi radius di server ---------- */

export function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const a =
    Math.sin(toRad(lat2 - lat1) / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(toRad(lon2 - lon1) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
