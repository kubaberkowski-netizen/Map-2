// Flâneur — natural-language trip planner (Supabase Edge Function)
//
// Deploy:
//   supabase functions deploy plan-trip --no-verify-jwt
//   supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
//   # optional — override the origin allowlist if the site moves:
//   supabase secrets set ALLOWED_ORIGINS="https://your.site,http://localhost:8080"
// Then in src/app.template.html set  AIFN = "https://<project>.functions.supabase.co/plan-trip"
//   and add that origin to the CSP connect-src, then `npm run build`.
//
// Request  (POST JSON): { city, days, prompt, spots:[{id,n,c}] }
// Response (JSON):      { ids:[spotId,...], note:"one sentence" }   // ids are a subset of the input
//
// NOTE: this function spends the OWNER's Anthropic credits, so it is locked to
// the app's own origin(s) (see ALLOWED below). A browser fetch from the site
// sends an Origin header we check; calls without an allowed Origin get 403.
// This stops casual abuse from other sites / naive scripts, but Origin can be
// forged by a non-browser client — for stronger guarantees add Supabase
// rate-limiting or a per-user auth token.

const KEY = Deno.env.get("ANTHROPIC_API_KEY");
const MODEL = Deno.env.get("ANTHROPIC_MODEL") || "claude-haiku-4-5";
const ALLOWED = (Deno.env.get("ALLOWED_ORIGINS") ||
  "https://kubaberkowski-netizen.github.io,http://localhost:8080,http://localhost:3000,http://127.0.0.1:8080")
  .split(",").map((s) => s.trim()).filter(Boolean);

function corsFor(origin: string | null) {
  const allow = origin && ALLOWED.includes(origin) ? origin : ALLOWED[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Allow-Methods": "POST,OPTIONS",
    "Vary": "Origin",
  };
}
function json(o: unknown, status = 200, origin: string | null = null) {
  return new Response(JSON.stringify(o), { status, headers: { ...corsFor(origin), "content-type": "application/json" } });
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsFor(origin) });
  if (req.method !== "POST") return json({ error: "POST only", ids: [] }, 405, origin);
  // Origin-lock: only the app's own pages may spend the owner's API credits.
  if (!origin || !ALLOWED.includes(origin)) return json({ error: "forbidden", ids: [] }, 403, origin);
  try {
    if (!KEY) return json({ error: "ANTHROPIC_API_KEY not set", ids: [] }, 500, origin);
    const { city, days, prompt, spots } = await req.json();
    if (!Array.isArray(spots) || !spots.length) return json({ ids: [] }, 200, origin);
    const valid = new Set(spots.map((s: any) => s.id));
    const perDay = 5;
    const target = Math.min(perDay * (days || 2), 14);
    const list = spots.slice(0, 300).map((s: any) => `${s.id}\t${s.n}\t${s.c}\t${s.a || ""}`).join("\n");
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
    // Surface upstream Anthropic failures instead of silently returning empty —
    // e.g. "credit balance is too low", invalid key, unknown model.
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
