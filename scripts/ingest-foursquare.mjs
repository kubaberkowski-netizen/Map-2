// Ingest quality restaurants/cafés/bars near each city from Foursquare into the
// places table. Filtered to well-rated, non-chain spots (not chain soup).
// Runs in GitHub Actions — see .github/workflows/ingest-foursquare.yml.
// Env: FOURSQUARE_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, [INGEST_STATUS]
import fs from "node:fs";

const KEY = process.env.FOURSQUARE_KEY;
const SB_URL = process.env.SUPABASE_URL || "https://fpngxchltuovtsyzigul.supabase.co";
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const STATUS = process.env.INGEST_STATUS || "approved";
const MIN_RATING = 7.5; // Foursquare rating is out of 10
if (!KEY || !SB_KEY) { console.error("Missing FOURSQUARE_KEY or SUPABASE_SERVICE_ROLE_KEY."); process.exit(1); }

const cities = JSON.parse(fs.readFileSync(new URL("../supabase/functions/ingest-events/cities.json", import.meta.url)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let mode = null, diagShown = false;
async function search(c) {
  // try the new Places API first (fresh keys), fall back to legacy v3
  if (mode !== "legacy") {
    try {
      const r = await fetch(`https://places-api.foursquare.com/places/search?ll=${c.lat},${c.lng}&radius=2500&categories=13000&sort=RATING&limit=30`,
        { headers: { Authorization: "Bearer " + KEY, "X-Places-Api-Version": "2025-06-17", Accept: "application/json" } });
      if (r.ok) { mode = "new"; return (await r.json()).results || []; }
      if (!diagShown && mode !== "new") { diagShown = true; console.error("new API status", r.status, (await r.text()).slice(0, 160)); }
      if (r.status !== 401 && r.status !== 403 && r.status !== 400) return [];
    } catch (e) { /* fall through */ }
  }
  try {
    const r = await fetch(`https://api.foursquare.com/v3/places/search?ll=${c.lat},${c.lng}&radius=2500&categories=13000&sort=RATING&limit=30&fields=fsq_id,name,geocodes,location,categories,rating,price,website,description,photos,chains`,
      { headers: { Authorization: KEY, Accept: "application/json" } });
    if (r.ok) { mode = "legacy"; return (await r.json()).results || []; }
    if (!diagShown) { diagShown = true; console.error("legacy API status", r.status, (await r.text()).slice(0, 160)); }
  } catch (e) { /* give up this city */ }
  return [];
}
function row(e, slug) {
  const id = e.fsq_place_id || e.fsq_id;
  const lat = e.latitude != null ? e.latitude : e.geocodes?.main?.latitude;
  const lng = e.longitude != null ? e.longitude : e.geocodes?.main?.longitude;
  const ph = e.photos?.[0] ? e.photos[0].prefix + "original" + e.photos[0].suffix : null;
  return {
    ext_id: "fsq:" + id,
    name: e.name,
    category: e.categories?.[0]?.name || "Food & drink",
    description: e.description || e.location?.formatted_address || null,
    lat: +lat, lng: +lng,
    city: slug,
    url: e.website || (id ? "https://foursquare.com/v/" + id : null),
    image: ph,
    source: "foursquare",
    status: STATUS,
  };
}

let upserted = 0, hits = 0;
for (const c of cities) {
  const results = await search(c);
  const rows = results
    .filter((e) => e.rating != null && e.rating >= MIN_RATING && !(e.chains && e.chains.length))
    .map((e) => row(e, c.slug))
    .filter((x) => x.name && /:.+/.test(x.ext_id) && isFinite(x.lat) && isFinite(x.lng));
  if (rows.length) {
    const res = await fetch(`${SB_URL}/rest/v1/places?on_conflict=ext_id`, {
      method: "POST",
      headers: { apikey: SB_KEY, Authorization: "Bearer " + SB_KEY,
        "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(rows),
    });
    if (res.ok) { upserted += rows.length; hits++; }
    else console.error(`${c.slug}: ${res.status} ${await res.text()}`);
  }
  await sleep(250);
}
console.log(`Foursquare (${mode || "no-auth"}): upserted ${upserted} places across ${hits} cities.`);
