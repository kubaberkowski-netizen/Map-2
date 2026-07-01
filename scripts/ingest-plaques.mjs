// Ingest commemorative "blue plaque" style markers from Open Plaques into the
// places table, so storied micro-histories ("X lived here") surface as you walk.
// Data is Public Domain. Runs in GitHub Actions on a schedule (weekly is plenty
// — plaques are historical/static). No API key.
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, [INGEST_STATUS]
//
// Open Plaques publishes dated worldwide snapshots (no "latest" URL); a pinned
// snapshot is fine since the data barely changes. We keep plaques within range
// of a Flâneur city (assigned to the nearest), cap per city, and upsert into the
// same `places` table Foursquare/Wikidata write to — so they inherit the
// "Storied" finds list and map pins for free.
import fs from "node:fs";
import { reportRun } from "./report-run.mjs";

const SNAPSHOT = "https://openplaques.s3.eu-west-2.amazonaws.com/open-plaques-all-2025-12-15.json";
const SB_URL = process.env.SUPABASE_URL || "https://fpngxchltuovtsyzigul.supabase.co";
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const STATUS = process.env.INGEST_STATUS || "approved";
const RADIUS_KM = 25;   // assign a plaque to the nearest covered city within range
const PER_CITY = 150;   // cap so plaques don't crowd out other finds
if (!SB_KEY) { console.error("Missing SUPABASE_SERVICE_ROLE_KEY."); process.exit(1); }

const cities = JSON.parse(fs.readFileSync(new URL("../supabase/functions/ingest-events/cities.json", import.meta.url)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function distKm(la1, lo1, la2, lo2) {
  const R = 6371, d1 = (la2 - la1) * Math.PI / 180, d2 = (lo2 - lo1) * Math.PI / 180;
  const a = Math.sin(d1 / 2) ** 2 + Math.cos(la1 * Math.PI / 180) * Math.cos(la2 * Math.PI / 180) * Math.sin(d2 / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}
function nearestCity(lat, lng) {
  let best = null, bd = Infinity;
  for (const c of cities) { const d = distKm(lat, lng, c.lat, c.lng); if (d < bd) { bd = d; best = c; } }
  return bd <= RADIUS_KM ? best : null;
}

let data;
try {
  const res = await fetch(SNAPSHOT);
  if (!res.ok) { console.error(`snapshot: ${res.status}`); process.exit(1); }
  data = await res.json();
} catch (e) { console.error("fetch snapshot: " + e.message); process.exit(1); }

const list = Array.isArray(data) ? data : (data.features ? data.features.map((f) => Object.assign({}, f.properties, f.geometry ? { latitude: f.geometry.coordinates[1], longitude: f.geometry.coordinates[0] } : {})) : []);
const byCity = {};
for (const p of list) {
  if (p.is_current === false) continue;
  const lat = +p.latitude, lng = +p.longitude;
  if (!isFinite(lat) || !isFinite(lng) || (lat === 0 && lng === 0)) continue;
  const c = nearestCity(lat, lng);
  if (!c) continue;
  const person = p.people && p.people[0] && (p.people[0].name || p.people[0].full_name);
  const name = person || (p.title ? String(p.title).replace(/\s+(blue|green|grey|gray|brown|black|white|red|bronze)?\s*plaque$/i, "") : null) || "Plaque";
  byCity[c.slug] = byCity[c.slug] || [];
  byCity[c.slug].push({
    ext_id: "op:" + p.id,
    name: name.slice(0, 120),
    category: "Plaque",
    description: (p.inscription || p.title || "").slice(0, 500) || null,
    lat, lng, city: c.slug,
    url: p.uri || (p.id ? "https://openplaques.org/plaques/" + p.id : null),
    image: p.thumbnail_url || null,
    source: "openplaques",
    status: STATUS,
    _photo: !!p.thumbnail_url,
  });
}

const rows = [];
for (const slug in byCity) {
  const arr = byCity[slug].sort((a, b) => (b._photo - a._photo)).slice(0, PER_CITY);
  arr.forEach((r) => { delete r._photo; rows.push(r); });
}
console.log(`Matched ${rows.length} plaques across ${Object.keys(byCity).length} cities (of ${list.length} worldwide).`);

let upserted = 0;
for (let i = 0; i < rows.length; i += 200) {
  const batch = rows.slice(i, i + 200);
  const res = await fetch(`${SB_URL}/rest/v1/places?on_conflict=ext_id`, {
    method: "POST",
    headers: { apikey: SB_KEY, Authorization: "Bearer " + SB_KEY, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(batch),
  });
  if (res.ok) upserted += batch.length;
  else console.error(`upsert ${i}: ${res.status} ${await res.text()}`);
  await sleep(120);
}
await reportRun("plaques", upserted);
console.log(`Done: upserted ${upserted} plaques.`);
