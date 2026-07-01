// parse-link — extract event details from a pasted URL (OpenGraph + JSON-LD).
// Returns { title, venue, start, lat, lng, image, category } for the submit form.
//
// Deploy (HARDENED — audit P0.4): verify_jwt ON.
//   supabase functions deploy parse-link          # (NOT --no-verify-jwt)
//   # run supabase/migrations/2026_api_rate.sql
// Client: send `Authorization: Bearer <supabase token>`.
//
// Guards (was a no-auth open proxy / SSRF): required bearer + origin allowlist,
// https-only, DNS-resolve + reject private/loopback/link-local/metadata ranges
// (re-checked on every redirect hop), 10s timeout, and a streamed 600KB read cap.
import { corsFor, json, rateLimited, clientIp, bearerSub, hostIsPublic, readCapped, ALLOWED_ORIGINS } from "../_shared/guard.ts";

const MAX_BYTES = 600_000;
const TIMEOUT_MS = 10_000;
const MAX_HOPS = 4;
const IP_LIMIT = 30; // requests / hour / IP

function decode(s: string) {
  return s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim();
}
function meta(html: string, prop: string): string | null {
  const pats = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']+)["']`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${prop}["']`, "i"),
  ];
  for (const p of pats) { const m = html.match(p); if (m) return decode(m[1]); }
  return null;
}
const dl = (v?: string) => (v && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v) ? v.slice(0, 16) : null);

// Fetch with manual redirect handling: validate every hop's host is public https.
async function safeFetch(startUrl: string): Promise<Response | null> {
  let url = startUrl;
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    let u: URL;
    try { u = new URL(url); } catch { return null; }
    if (u.protocol !== "https:") return null;
    if (!(await hostIsPublic(u.hostname))) return null;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(u.toString(), { headers: { "User-Agent": "FlaneurBot/1.0" }, redirect: "manual", signal: ctrl.signal });
    } catch { clearTimeout(timer); return null; }
    clearTimeout(timer);
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) return res;
      url = new URL(loc, u).toString();     // resolve relative, re-validate next loop
      continue;
    }
    return res;
  }
  return null; // too many redirects
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsFor(origin) });
  if (req.method !== "POST") return json({ error: "POST only" }, 405, origin);
  if (!origin || !ALLOWED_ORIGINS.includes(origin)) return json({ error: "forbidden" }, 403, origin);
  if (!(req.headers.get("authorization") || "").toLowerCase().startsWith("bearer "))
    return json({ error: "unauthorized" }, 401, origin);

  const ip = clientIp(req), sub = bearerSub(req);
  if (await rateLimited("parse-link", "ip:" + ip, IP_LIMIT)) return json({ error: "rate limited" }, 429, origin);
  if (sub && await rateLimited("parse-link", "u:" + sub, IP_LIMIT * 2)) return json({ error: "rate limited" }, 429, origin);

  try {
    const { url } = await req.json();
    if (!url || typeof url !== "string" || !/^https:\/\//i.test(url)) return json({ error: "https url required" }, 400, origin);

    const res = await safeFetch(url);
    if (!res || !res.ok) return json({ error: "could not fetch (blocked or unreachable)" }, 400, origin);
    const html = await readCapped(res, MAX_BYTES);

    const out: Record<string, unknown> = {};
    out.title = meta(html, "og:title") || html.match(/<title[^>]*>([^<]+)/i)?.[1]?.trim() || null;
    out.image = meta(html, "og:image") || null;

    for (const b of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
      try {
        const data = JSON.parse(b[1].trim());
        const arr = Array.isArray(data) ? data : (data["@graph"] || [data]);
        const ev = arr.find((x: any) => /event/i.test([].concat(x?.["@type"] || []).join(" ")));
        if (!ev) continue;
        out.title = ev.name || out.title;
        out.start = dl(ev.startDate) || out.start;
        const loc = Array.isArray(ev.location) ? ev.location[0] : ev.location;
        if (loc) {
          out.venue = loc.name || out.venue;
          const g = loc.geo;
          if (g && isFinite(+g.latitude) && isFinite(+g.longitude)) { out.lat = +g.latitude; out.lng = +g.longitude; }
        }
        break;
      } catch (_) { /* skip bad block */ }
    }
    return json(out, 200, origin);
  } catch (e) {
    return json({ error: String(e) }, 500, origin);
  }
});
