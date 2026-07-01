// Ingest events from Ticketmaster into Supabase. Runs in GitHub Actions on a
// schedule (no terminal needed) — see .github/workflows/ingest-events.yml.
// Env: TICKETMASTER_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, [INGEST_STATUS]
import fs from "node:fs";
import { reportRun } from "./report-run.mjs";

const TM = process.env.TICKETMASTER_KEY;
const SB_URL = process.env.SUPABASE_URL || "https://fpngxchltuovtsyzigul.supabase.co";
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const STATUS = process.env.INGEST_STATUS || "approved"; // 'approved' | 'pending'
const RADIUS = 15; // km around each city centre

if (!TM || !SB_KEY) {
  console.error("Missing TICKETMASTER_KEY or SUPABASE_SERVICE_ROLE_KEY secret.");
  process.exit(1);
}

const cities = JSON.parse(
  fs.readFileSync(new URL("../supabase/functions/ingest-events/cities.json", import.meta.url))
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Map a Ticketmaster classification to a Flaneur event category. Reads the
// finer `genre` (not just the broad `segment`) so comedy, theatre, family and
// talks get their own pin/filter chip instead of all collapsing into "Arts".
function category(cl) {
  const seg = (cl && cl.segment && cl.segment.name || "").toLowerCase();
  const gen = (cl && cl.genre && cl.genre.name || "").toLowerCase();
  if (seg.includes("music")) return "Music";
  if (seg.includes("sport")) return "Sport";
  if (seg.includes("film")) return "Film";
  if (gen.includes("comedy")) return "Comedy";
  if (/theat|musical|opera|ballet|dance/.test(gen)) return "Theatre";
  if (gen.includes("classical")) return "Music";
  if (/festival|fair/.test(gen)) return "Festival";
  if (/family|children/.test(gen)) return "Family";
  if (/lecture|seminar|talk/.test(gen)) return "Talk";
  if (seg.includes("arts") || seg.includes("theatre") || seg.includes("theater")) return "Arts";
  return "Event";
}

let upserted = 0, hits = 0;
for (const c of cities) {
  const u = `https://app.ticketmaster.com/discovery/v2/events.json?apikey=${TM}` +
    `&latlong=${c.lat},${c.lng}&radius=${RADIUS}&unit=km&size=100&sort=date,asc`;
  let data;
  try { const r = await fetch(u); if (!r.ok) { await sleep(220); continue; } data = await r.json(); }
  catch { await sleep(220); continue; }

  const evs = data?._embedded?.events || [];
  const rows = evs.map((e) => {
    const v = e._embedded?.venues?.[0];
    const start = e.dates?.start?.dateTime ||
      (e.dates?.start?.localDate ? `${e.dates.start.localDate}T19:00:00Z` : null);
    return {
      ext_id: "tm:" + e.id,
      name: e.name,
      category: category(e.classifications?.[0]),
      venue: v?.name || null,
      lat: v?.location ? +v.location.latitude : null,
      lng: v?.location ? +v.location.longitude : null,
      city: c.slug,
      start_at: start,
      end_at: e.dates?.end?.dateTime || start,
      url: e.url || null,
      image: e.images?.find((i) => i.width >= 640)?.url || e.images?.[0]?.url || null,
      source: "ticketmaster",
      status: STATUS,
    };
  }).filter((x) => x.name && isFinite(x.lat) && isFinite(x.lng) && x.start_at);

  if (rows.length) {
    const res = await fetch(`${SB_URL}/rest/v1/events?on_conflict=ext_id`, {
      method: "POST",
      headers: {
        apikey: SB_KEY,
        Authorization: "Bearer " + SB_KEY,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify(rows),
    });
    if (res.ok) { upserted += rows.length; hits++; }
    else console.error(`${c.slug}: ${res.status} ${await res.text()}`);
  }
  await sleep(220); // stay under Ticketmaster's rate limit
}
await reportRun("events", upserted);
console.log(`Done: upserted ${upserted} events across ${hits} cities.`);
