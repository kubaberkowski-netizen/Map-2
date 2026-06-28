// ingest-seatgeek — seed the events feed from the SeatGeek API, one geo-query
// per Flâneur city. Mirrors ingest-events (Ticketmaster) and upserts into the
// same `events` table (deduped by ext_id), so both sources feed one feed.
// Runs on a cron (see EVENTS.md §Ingest).
// Deploy:  supabase functions deploy ingest-seatgeek
// Secrets: SEATGEEK_CLIENT_ID  (+ optional SEATGEEK_CLIENT_SECRET for higher
//          rate limits, + optional INGEST_STATUS=pending to review first)
//          SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are injected automatically.
import cities from "./cities.json" with { type: "json" };
import { createClient } from "npm:@supabase/supabase-js@2";

const CLIENT_ID = Deno.env.get("SEATGEEK_CLIENT_ID")!;
const CLIENT_SECRET = Deno.env.get("SEATGEEK_CLIENT_SECRET") || "";
const STATUS = Deno.env.get("INGEST_STATUS") || "approved"; // 'approved' | 'pending'
const RADIUS = 15; // km around each city centre
const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

// Map SeatGeek's event `type` (and taxonomy) onto the app's category set,
// preferring values that have an emoji in the client's flEVI map.
function category(type?: string, taxo?: string): string {
  const s = (type || "").toLowerCase();
  const t = (taxo || "").toLowerCase();
  const any = s + " " + t;
  if (/concert|music_festival|classical|cmt|dance_performance/.test(any) && /festival/.test(any)) return "Festival";
  if (/concert|classical|cmt|opera/.test(any)) return "Music";
  if (/comedy/.test(any)) return "Comedy";
  if (/theater|theatre|broadway|musical/.test(any)) return "Theatre";
  if (/dance_performance|ballet|art|exhibit/.test(any)) return "Arts";
  if (/family|circus|disney/.test(any)) return "Family";
  if (/festival/.test(any)) return "Festival";
  // sports leagues + generic sports taxonomy
  if (/sport|nba|nfl|mlb|nhl|mls|ncaa|soccer|football|baseball|basketball|hockey|tennis|golf|boxing|mma|ufc|rugby|cricket|wrestling|racing|motor/.test(any)) return "Sport";
  return "Event";
}

// SeatGeek datetime_utc is UTC without a trailing 'Z' — normalise to ISO.
function toIso(dt?: string | null): string | null {
  if (!dt) return null;
  if (/[zZ]|[+-]\d\d:?\d\d$/.test(dt)) return dt;
  return dt + "Z";
}

function image(e: any): string | null {
  const p = (e.performers || []).find((x: any) => x.image) || e.performers?.[0];
  return (p && (p.image || (p.images && (p.images.huge || p.images.large || p.images.medium)))) || null;
}

Deno.serve(async () => {
  if (!CLIENT_ID) return new Response(JSON.stringify({ error: "SEATGEEK_CLIENT_ID not set" }), { status: 500 });
  const auth = `client_id=${CLIENT_ID}` + (CLIENT_SECRET ? `&client_secret=${CLIENT_SECRET}` : "");
  let upserted = 0, cityHits = 0;
  for (const c of cities as Array<{ slug: string; lat: number; lng: number }>) {
    const u = `https://api.seatgeek.com/2/events?${auth}` +
      `&lat=${c.lat}&lon=${c.lng}&range=${RADIUS}km&per_page=50&sort=datetime_utc.asc`;
    let data: any;
    try { const r = await fetch(u); if (!r.ok) { await sleep(150); continue; } data = await r.json(); }
    catch { await sleep(150); continue; }

    const evs = data?.events || [];
    const rows = evs.map((e: any) => {
      const v = e.venue || {};
      const loc = v.location || {};
      const start = toIso(e.datetime_utc || (e.datetime_local ? e.datetime_local : null));
      return {
        ext_id: "sg:" + e.id,
        name: e.title || e.short_title,
        category: category(e.type, e.taxonomies?.[0]?.name),
        venue: v.name || null,
        lat: typeof loc.lat === "number" ? loc.lat : null,
        lng: typeof loc.lon === "number" ? loc.lon : null,
        city: c.slug,
        start_at: start,
        end_at: start,
        url: e.url || null,
        image: image(e),
        source: "seatgeek",
        status: STATUS,
      };
    }).filter((x: any) => x.name && isFinite(x.lat) && isFinite(x.lng) && x.start_at);

    if (rows.length) {
      const { error } = await sb.from("events").upsert(rows, { onConflict: "ext_id" });
      if (!error) { upserted += rows.length; cityHits++; }
    }
    await sleep(150); // be polite to the SeatGeek API
  }
  return new Response(JSON.stringify({ upserted, cities_with_events: cityHits }), {
    headers: { "Content-Type": "application/json" },
  });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
