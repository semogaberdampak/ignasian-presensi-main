// `presensi-submit` — util kecil: header, pesan galat, log server.
export function corsHeaders(req: Request): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": req.headers.get("origin") || "*",
    "Access-Control-Allow-Headers": "authorization, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
  };
}

export function sbBase(): string {
  return Deno.env.get("SUPABASE_URL") || "";
}

export function sbHeaders() {
  return {
    apikey: Deno.env.get("SUPABASE_ANON_KEY") || "",
    Authorization: "Bearer " + (Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || ""),
    "Content-Type": "application/json",
  };
}

/* Catat kegagalan ke tabel logs (best-effort, tanpa user agent/URL). */
export async function failReason(reason: string, info: Record<string, unknown>): Promise<void> {
  try {
    await fetch(sbBase() + "/rest/v1/logs", {
      method: "POST",
      headers: sbHeaders(),
      body: JSON.stringify({
        id: "srv-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
        action: "PRESENSI_GAGAL",
        details: { reason, ...info },
        user_id: (info.userId as string) || "system",
        user_name: "Sistem",
        user_role: "system",
      }),
    });
  } catch {
    /* abaikan */
  }
}
