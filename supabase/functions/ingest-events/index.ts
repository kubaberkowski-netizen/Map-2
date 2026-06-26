// ingest-events — seed the events feed from the Ticketmaster Discovery API,
// one geo-query per Flâneur city. Runs on a cron (see EVENTS.md §Ingest).
// Deploy:  supabase functions deploy ingest-events
// Secrets: TICKETMASTER_KEY  (+ optional INGEST_STATUS=pending to review first)
//          SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are injected automatically.
import cities from "./cities.json" with { type: "json" };
import { createClient } from "npm:@supabase/supabase-js@2";

const TM = Deno.env.get("TICKETMASTER_KEY")!;
const STATUS = Deno.env.get("INGEST_STATUS") || "approved"; // 'approved' | 'pending'
const RADIUS = 15; // km around each city centre
const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

function category(seg?: string) {
  const s = (seg || "").toLowerCase();
  if (s.includes("music")) return "Music";
  if (s.includes("sport")) return "Sport";
  if (s.includes("arts") || s.includes("theatre") || s.includes("theater")) return "Arts";
  if (s.includes("film")) return "Film";
  return "Event";
}

Deno.serve(async () => {
  if (!TM) return new Response(JSON.stringify({ error: "TICKETMASTER_KEY not set" }), { status: 500 });
  let upserted = 0, cityHits = 0;
  for (const c of cities as Array<{ slug: string; lat: number; lng: number }>) {
    const u = `https://app.ticketmaster.com/discovery/v2/events.json?apikey=${TM}` +
      `&latlong=${c.lat},${c.lng}&radius=${RADIUS}&unit=km&size=50&sort=date,asc`;
    let data: any;
    try { const r = await fetch(u); if (!r.ok) { await sleep(220); continue; } data = await r.json(); }
    catch { await sleep(220); continue; }

    const evs = data?._embedded?.events || [];
    const rows = evs.map((e: any) => {
      const v = e._embedded?.venues?.[0];
      const start = e.dates?.start?.dateTime || (e.dates?.start?.localDate ? `${e.dates.start.localDate}T19:00:00Z` : null);
      return {
        ext_id: "tm:" + e.id,
        name: e.name,
        category: category(e.classifications?.[0]?.segment?.name),
        venue: v?.name || null,
        lat: v?.location ? +v.location.latitude : null,
        lng: v?.location ? +v.location.longitude : null,
        city: c.slug,
        start_at: start,
        end_at: e.dates?.end?.dateTime || start,
        url: e.url || null,
        image: e.images?.find((i: any) => i.width >= 640)?.url || e.images?.[0]?.url || null,
        source: "ticketmaster",
        status: STATUS,
      };
    }).filter((x: any) => x.name && isFinite(x.lat) && isFinite(x.lng) && x.start_at);

    if (rows.length) {
      const { error } = await sb.from("events").upsert(rows, { onConflict: "ext_id" });
      if (!error) { upserted += rows.length; cityHits++; }
    }
    await sleep(220); // stay under Ticketmaster's 5 req/s
  }
  return new Response(JSON.stringify({ upserted, cities_with_events: cityHits }), {
    headers: { "Content-Type": "application/json" },
  });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
