// Flâneur — natural-language trip planner (Supabase Edge Function)
//
// Deploy:
//   supabase functions deploy plan-trip --no-verify-jwt
//   supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
// Then in src/app.template.html set  AIFN = "https://<project>.functions.supabase.co/plan-trip"
//   and add that origin to the CSP connect-src, then `npm run build`.
//
// Request  (POST JSON): { city, days, prompt, spots:[{id,n,c}] }
// Response (JSON):      { ids:[spotId,...], note:"one sentence" }   // ids are a subset of the input

const KEY = Deno.env.get("ANTHROPIC_API_KEY");
const MODEL = Deno.env.get("ANTHROPIC_MODEL") || "claude-3-5-haiku-latest";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
};
function json(o: unknown, status = 200) {
  return new Response(JSON.stringify(o), { status, headers: { ...CORS, "content-type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only", ids: [] }, 405);
  try {
    if (!KEY) return json({ error: "ANTHROPIC_API_KEY not set", ids: [] }, 500);
    const { city, days, prompt, spots } = await req.json();
    if (!Array.isArray(spots) || !spots.length) return json({ ids: [] });
    const valid = new Set(spots.map((s: any) => s.id));
    const target = Math.min(8 * (days || 2), 16);
    const list = spots.slice(0, 300).map((s: any) => `${s.id}\t${s.n}\t${s.c}`).join("\n");
    const system =
      `You are a concierge for Flâneur, a guide to offbeat, storied places. ` +
      `From the PLACES list ONLY, choose about ${target} places that best match the traveller's request — ` +
      `bias toward the most distinctive/storied and a walkable, coherent set. ` +
      `Reply with STRICT JSON: {"ids":["<id>",...],"note":"one short sentence"}. Use ids from the list only; no prose.`;
    const user =
      `City: ${city}\nDays: ${days || 2}\nTraveller wants: ${prompt || "a curious wander"}\n\n` +
      `PLACES (id<TAB>name<TAB>category):\n${list}`;
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
      return json({ ids: [], error: msg }, 502);
    }
    const txt = (d?.content?.[0]?.text) || "{}";
    const m = txt.match(/\{[\s\S]*\}/);
    let out: any = {};
    try { out = m ? JSON.parse(m[0]) : {}; } catch { out = {}; }
    const ids = Array.isArray(out.ids) ? out.ids.filter((id: string) => valid.has(id)) : [];
    return json({ ids, note: typeof out.note === "string" ? out.note : "" });
  } catch (e) {
    return json({ error: String(e), ids: [] });
  }
});
