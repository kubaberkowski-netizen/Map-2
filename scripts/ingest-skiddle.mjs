// Ingest UK events from the Skiddle API into Supabase. Runs in GitHub Actions
// on a schedule — see .github/workflows/ingest-skiddle.yml. No terminal needed.
// Env: SKIDDLE_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, [INGEST_STATUS]
import fs from "node:fs";

const KEY = process.env.SKIDDLE_KEY;
const SB_URL = process.env.SUPABASE_URL || "https://fpngxchltuovtsyzigul.supabase.co";
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const STATUS = process.env.INGEST_STATUS || "approved";
const RADIUS = 10; // miles around each city centre (Skiddle uses miles)

if (!KEY || !SB_KEY) {
  console.error("Missing SKIDDLE_KEY or SUPABASE_SERVICE_ROLE_KEY.");
  process.exit(1);
}
const cities = JSON.parse(
  fs.readFileSync(new URL("../supabase/functions/ingest-events/cities.json", import.meta.url))
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function category(code) {
  const m = { LIVE: "Music", FEST: "Festival", CLUB: "Clubbing", ARTS: "Arts", COMEDY: "Comedy",
    THEATRE: "Theatre", FAMILY: "Family", SPORT: "Sport", EXHIB: "Exhibition", KIDS: "Family",
    BARPUB: "Nightlife", DATE: "Social", LGB: "LGBTQ+", LEARN: "Talk" };
  return m[code] || "Event";
}
const norm = (v) => (v ? String(v).replace(" ", "T") : null);

let upserted = 0, hits = 0;
for (const c of cities) {
  const u = `https://www.skiddle.com/api/v1/events/search/?api_key=${KEY}` +
    `&latitude=${c.lat}&longitude=${c.lng}&radius=${RADIUS}&order=date&limit=100&description=1`;
  let data;
  try { const r = await fetch(u); if (!r.ok) { await sleep(300); continue; } data = await r.json(); }
  catch { await sleep(300); continue; }

  const evs = (data && data.results) || [];
  const rows = evs.map((e) => {
    const v = e.venue || {};
    const start = norm(e.startdate) || (e.date ? `${e.date}T19:00:00` : null);
    return {
      ext_id: "sk:" + e.id,
      name: e.eventname,
      category: category(e.EventCode),
      venue: v.name || null,
      lat: v.latitude ? +v.latitude : null,
      lng: v.longitude ? +v.longitude : null,
      city: c.slug,
      start_at: start,
      end_at: norm(e.enddate) || start,
      url: e.link || null,
      image: e.largeimageurl || e.imageurl || null,
      description: (e.description || "").slice(0, 500) || null,
      source: "skiddle",
      status: STATUS,
    };
  }).filter((x) => x.name && isFinite(x.lat) && isFinite(x.lng) && x.start_at);

  if (rows.length) {
    const res = await fetch(`${SB_URL}/rest/v1/events?on_conflict=ext_id`, {
      method: "POST",
      headers: { apikey: SB_KEY, Authorization: "Bearer " + SB_KEY,
        "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(rows),
    });
    if (res.ok) { upserted += rows.length; hits++; }
    else console.error(`${c.slug}: ${res.status} ${await res.text()}`);
  }
  await sleep(300);
}
console.log(`Skiddle: upserted ${upserted} events across ${hits} cities.`);
