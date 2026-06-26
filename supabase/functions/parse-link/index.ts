// parse-link — extract event details from a pasted URL (OpenGraph + JSON-LD).
// Returns { title, venue, start, lat, lng, image, category } for the submit form.
// Deploy:  supabase functions deploy parse-link
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

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
// normalise an ISO date to the datetime-local format the form expects
const dl = (v?: string) => (v && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v) ? v.slice(0, 16) : null);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const { url } = await req.json();
    if (!url || !/^https?:\/\//i.test(url)) return json({ error: "invalid url" }, 400);
    const res = await fetch(url, { headers: { "User-Agent": "FlaneurBot/1.0" }, redirect: "follow" });
    const html = (await res.text()).slice(0, 600_000);

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
    return json(out);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
