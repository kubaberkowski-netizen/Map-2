// Ingest events from SeatGeek into the Flâneur events feed — one geo-query per
// city. Runs in GitHub Actions on a schedule — see the matching workflow. This
// is the scheduled counterpart to supabase/functions/ingest-seatgeek (which
// needed a manual Supabase deploy); this version runs with no terminal.
// Env: SEATGEEK_CLIENT_ID, [SEATGEEK_CLIENT_SECRET], SUPABASE_URL,
//      SUPABASE_SERVICE_ROLE_KEY, [INGEST_STATUS]
import fs from "node:fs";
import { reportRun } from "./report-run.mjs";

const CLIENT_ID = process.env.SEATGEEK_CLIENT_ID;
const CLIENT_SECRET = process.env.SEATGEEK_CLIENT_SECRET || "";
const SB_URL = process.env.SUPABASE_URL || "https://fpngxchltuovtsyzigul.supabase.co";
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const STATUS = process.env.INGEST_STATUS || "approved";
const RADIUS = 15; // km around each city centre
if (!CLIENT_ID || !SB_KEY) { console.error("Missing SEATGEEK_CLIENT_ID or SUPABASE_SERVICE_ROLE_KEY."); process.exit(1); }

const cities = JSON.parse(fs.readFileSync(new URL("../supabase/functions/ingest-events/cities.json", import.meta.url)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Map SeatGeek's event `type`/taxonomy onto the app's category set (all of which
// have an emoji in the client's flEVI pin map).
function category(type, taxo) {
  const any = ((type || "") + " " + (taxo || "")).toLowerCase();
  if (/concert|music_festival|classical|cmt|dance_performance/.test(any) && /festival/.test(any)) return "Festival";
  if (/concert|classical|cmt|opera/.test(any)) return "Music";
  if (/comedy/.test(any)) return "Comedy";
  if (/theater|theatre|broadway|musical/.test(any)) return "Theatre";
  if (/dance_performance|ballet|art|exhibit/.test(any)) return "Arts";
  if (/family|circus|disney/.test(any)) return "Family";
  if (/festival/.test(any)) return "Festival";
  if (/sport|nba|nfl|mlb|nhl|mls|ncaa|soccer|football|baseball|basketball|hockey|tennis|golf|boxing|mma|ufc|rugby|cricket|wrestling|racing|motor/.test(any)) return "Sport";
  return "Event";
}
function toIso(dt) {
  if (!dt) return null;
  if (/[zZ]|[+-]\d\d:?\d\d$/.test(dt)) return dt;
  return dt + "Z";
}
function image(e) {
  const p = (e.performers || []).find((x) => x.image) || (e.performers || [])[0];
  return (p && (p.image || (p.images && (p.images.huge || p.images.large || p.images.medium)))) || null;
}
function describe(e) {
  const extra = (e.performers || []).map((p) => p && p.name).filter(Boolean).slice(1, 4);
  return extra.length ? "With " + extra.join(", ") : null;
}

const auth = `client_id=${CLIENT_ID}` + (CLIENT_SECRET ? `&client_secret=${CLIENT_SECRET}` : "");
let upserted = 0, hits = 0;
for (const c of cities) {
  const u = `https://api.seatgeek.com/2/events?${auth}&lat=${c.lat}&lon=${c.lng}&range=${RADIUS}km&per_page=50&sort=datetime_utc.asc`;
  let data;
  try { const r = await fetch(u); if (!r.ok) { await sleep(150); continue; } data = await r.json(); }
  catch { await sleep(150); continue; }

  const rows = (data && data.events || []).map((e) => {
    const v = e.venue || {}, loc = v.location || {};
    const start = toIso(e.datetime_utc || e.datetime_local || null);
    return {
      ext_id: "sg:" + e.id,
      name: e.title || e.short_title,
      description: describe(e),
      category: category(e.type, e.taxonomies && e.taxonomies[0] && e.taxonomies[0].name),
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
  }).filter((x) => x.name && Number.isFinite(x.lat) && Number.isFinite(x.lng) && x.start_at);

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
  await sleep(150); // be polite to the SeatGeek API
}
await reportRun("seatgeek", upserted);
console.log(`Done: upserted ${upserted} SeatGeek events across ${hits} cities.`);
