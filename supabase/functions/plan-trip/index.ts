// Flâneur — natural-language trip planner (Supabase Edge Function)
//
// Deploy (HARDENED — audit P0.3): verify_jwt ON, so callers must send a valid
// Supabase token (the client already has the publishable/anon key):
//   supabase functions deploy plan-trip          # (NOT --no-verify-jwt)
//   supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
//   # optional origin allowlist override:
//   supabase secrets set ALLOWED_ORIGINS="https://your.site,http://localhost:8080"
//   # run supabase/migrations/2026_api_rate.sql for the rate-limit table
//   # set a HARD monthly spend cap + alert in the Anthropic console
// Client (src/app.template.html): send `Authorization: Bearer <supabase session
// or anon key>` with the POST.
//
// Request  (POST JSON): { city, days, prompt, spots:[{id,n,c,a}] }
// Response (JSON):      { ids:[spotId,...], note:"one sentence" }
//
// Guards: origin-lock + required bearer + per-IP & per-user rate limit + 64KB
// body cap + <=150 spots server-side. The Origin header alone is forgeable, so
// the rate limit + spend cap are the real protection against credit abuse.
import { corsFor, json, rateLimited, bearerSub, clientIp, ALLOWED_ORIGINS } from "../_shared/guard.ts";

const KEY = Deno.env.get("ANTHROPIC_API_KEY");
const MODEL = Deno.env.get("ANTHROPIC_MODEL") || "claude-haiku-4-5";
const MAX_BODY = 64 * 1024;
const IP_LIMIT = 15;    // requests / hour / IP
const USER_LIMIT = 30;  // requests / hour / signed-in user

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsFor(origin) });
  if (req.method !== "POST") return json({ error: "POST only", ids: [] }, 405, origin);
  if (!origin || !ALLOWED_ORIGINS.includes(origin)) return json({ error: "forbidden", ids: [] }, 403, origin);
  // Require a bearer token (the Supabase gateway verifies its signature when the
  // function is deployed without --no-verify-jwt). No token → no spend.
  if (!(req.headers.get("authorization") || "").toLowerCase().startsWith("bearer "))
    return json({ error: "unauthorized", ids: [] }, 401, origin);

  const clen = +(req.headers.get("content-length") || "0");
  if (clen > MAX_BODY) return json({ error: "payload too large", ids: [] }, 413, origin);

  // Rate limit: per IP and per user (rolling hour). 429 on excess.
  const ip = clientIp(req), sub = bearerSub(req);
  if (await rateLimited("plan-trip", "ip:" + ip, IP_LIMIT)) return json({ error: "rate limited", ids: [] }, 429, origin);
  if (sub && await rateLimited("plan-trip", "u:" + sub, USER_LIMIT)) return json({ error: "rate limited", ids: [] }, 429, origin);

  try {
    if (!KEY) return json({ error: "ANTHROPIC_API_KEY not set", ids: [] }, 500, origin);
    const raw = await req.text();
    if (raw.length > MAX_BODY) return json({ error: "payload too large", ids: [] }, 413, origin);
    const { city, days, prompt, spots } = JSON.parse(raw || "{}");
    if (!Array.isArray(spots) || !spots.length) return json({ ids: [] }, 200, origin);
    const capped = spots.slice(0, 150);                         // was 300 — cap server-side
    const valid = new Set(capped.map((s: any) => s.id));
    const perDay = 5;
    const target = Math.min(perDay * (days || 2), 14);
    const list = capped.map((s: any) => `${s.id}\t${s.n}\t${s.c}\t${s.a || ""}`).join("\n");
    const system =
      `You are a concierge for Flâneur, a guide to offbeat, storied places. ` +
      `From the PLACES list ONLY, choose places matching the traveller's request. RULES: ` +
      `(1) Honour explicit quantities — "a coffee"/"a coffee break" means exactly ONE cafe, not several. ` +
      `(2) Keep the set geographically TIGHT and walkable — strongly prefer places in the same or adjacent areas (the 4th column); never mix far-apart neighbourhoods in a single day. ` +
      `(3) Choose a relaxed number — about ${perDay} per day (${days || 2} day(s) total, ~${target} max); fewer is better than cramming. ` +
      `(4) Bias toward the most distinctive/storied. ` +
      `Reply with STRICT JSON: {"ids":["<id>",...],"note":"one short sentence"}. Use ids from the list only; no prose.`;
    const user =
      `City: ${city}\nDays: ${days || 2}\nTraveller wants: ${prompt || "a curious wander"}\n\n` +
      `PLACES (id<TAB>name<TAB>category<TAB>area):\n${list}`;
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: MODEL, max_tokens: 1024, system, messages: [{ role: "user", content: user }] }),
    });
    const d = await r.json();
    if (!r.ok || d?.type === "error") {
      const msg = d?.error?.message || `Anthropic HTTP ${r.status}`;
      return json({ ids: [], error: msg }, 502, origin);
    }
    const txt = (d?.content?.[0]?.text) || "{}";
    const m = txt.match(/\{[\s\S]*\}/);
    let out: any = {};
    try { out = m ? JSON.parse(m[0]) : {}; } catch { out = {}; }
    const ids = Array.isArray(out.ids) ? out.ids.filter((id: string) => valid.has(id)) : [];
    return json({ ids, note: typeof out.note === "string" ? out.note : "" }, 200, origin);
  } catch (e) {
    return json({ error: String(e), ids: [] }, 500, origin);
  }
});
