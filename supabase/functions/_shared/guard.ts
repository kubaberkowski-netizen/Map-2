// Shared hardening helpers for the edge functions (audit P0.3 / P0.4).
// Imported by plan-trip and parse-link. Supabase bundles relative imports on
// deploy, so this file ships with each function.

const SB_URL = Deno.env.get("SUPABASE_URL") || "";
const SB_SR = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

export const ALLOWED_ORIGINS = (Deno.env.get("ALLOWED_ORIGINS") ||
  "https://kubaberkowski-netizen.github.io,http://localhost:8080,http://localhost:3000,http://127.0.0.1:8080")
  .split(",").map((s) => s.trim()).filter(Boolean);

export function corsFor(origin: string | null) {
  const allow = origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
    "Access-Control-Allow-Methods": "POST,OPTIONS",
    "Vary": "Origin",
  };
}
export function json(o: unknown, status = 200, origin: string | null = null) {
  return new Response(JSON.stringify(o), { status, headers: { ...corsFor(origin), "content-type": "application/json" } });
}

// Bearer subject (Supabase user id). The gateway verifies the JWT signature when
// the function is deployed WITHOUT --no-verify-jwt; here we just read `sub` for
// per-user keying. Presence of the header is required by the caller.
export function bearerSub(req: Request): string {
  const t = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  try { return JSON.parse(atob((t.split(".")[1] || "").replace(/-/g, "+").replace(/_/g, "/"))).sub || ""; }
  catch { return ""; }
}
export function clientIp(req: Request): string {
  return (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() ||
    req.headers.get("cf-connecting-ip") || "noip";
}

// Rolling-window rate limiter backed by public.api_rate (see migration).
// Records the hit and returns true if the key already exceeded `limit` in the
// window. Fails OPEN on limiter errors so a limiter outage never breaks the app.
export async function rateLimited(fn: string, key: string, limit: number, windowSec = 3600): Promise<boolean> {
  if (!SB_URL || !SB_SR) return false;
  try {
    const since = new Date(Date.now() - windowSec * 1000).toISOString();
    const q = `${SB_URL}/rest/v1/api_rate?select=id&fn=eq.${encodeURIComponent(fn)}&key=eq.${encodeURIComponent(key)}&ts=gt.${since}`;
    const r = await fetch(q, { headers: { apikey: SB_SR, Authorization: "Bearer " + SB_SR, Prefer: "count=exact", Range: "0-0" } });
    const cr = r.headers.get("content-range") || "";           // "0-0/<total>"
    const count = parseInt(cr.split("/")[1] || "0", 10) || 0;
    // best-effort record of this hit
    fetch(`${SB_URL}/rest/v1/api_rate`, {
      method: "POST",
      headers: { apikey: SB_SR, Authorization: "Bearer " + SB_SR, "content-type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ fn, key: key.slice(0, 200) }),
    }).catch(() => {});
    return count >= limit;
  } catch { return false; }
}

// --- SSRF guard (parse-link) ---
export function isPrivateIp(ip: string): boolean {
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = +m[1], b = +m[2];
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;   // link-local + cloud metadata (169.254.169.254)
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    return false;
  }
  const l = ip.toLowerCase();
  return l === "::1" || l === "::" || l.startsWith("fc") || l.startsWith("fd") || l.startsWith("fe80") ||
    l.startsWith("::ffff:127.") || l.startsWith("::ffff:10.") || l.startsWith("::ffff:169.254.");
}
// Resolve a host and confirm none of its addresses are private/loopback/metadata.
export async function hostIsPublic(host: string): Promise<boolean> {
  if (!host) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":")) return !isPrivateIp(host); // literal IP
  try {
    const [a4, a6] = await Promise.all([
      Deno.resolveDns(host, "A").catch(() => [] as string[]),
      Deno.resolveDns(host, "AAAA").catch(() => [] as string[]),
    ]);
    const ips = [...a4, ...a6];
    if (!ips.length) return false;               // unresolvable → reject
    return ips.every((ip) => !isPrivateIp(ip));
  } catch { return false; }
}
// Read a response body up to `cap` bytes, then abort (memory-DoS guard).
export async function readCapped(res: Response, cap: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  let received = 0;
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (received >= cap) { try { await reader.cancel(); } catch { /* ignore */ } break; }
  }
  const buf = new Uint8Array(received);
  let off = 0;
  for (const c of chunks) { buf.set(c.subarray(0, Math.min(c.length, cap - off)), off); off += c.length; if (off >= cap) break; }
  return new TextDecoder().decode(buf).slice(0, cap);
}
