// Ingest quality restaurants/cafés/bars near each city from Foursquare into the
// places table (rating-filtered, non-chain). Runs in GitHub Actions.
// Env: FOURSQUARE_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, [INGEST_STATUS]
// Foursquare's API is mid-migration, so we probe auth combos and use what works.
import fs from "node:fs";
import { reportRun } from "./report-run.mjs";

const KEY = process.env.FOURSQUARE_KEY;
const SB_URL = process.env.SUPABASE_URL || "https://fpngxchltuovtsyzigul.supabase.co";
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const STATUS = process.env.INGEST_STATUS || "approved";
const MIN_RATING = 7.5;
const VER = "2025-06-17";
if (!KEY || !SB_KEY) { console.error("Missing FOURSQUARE_KEY or SUPABASE_SERVICE_ROLE_KEY."); process.exit(1); }

const cities = JSON.parse(fs.readFileSync(new URL("../supabase/functions/ingest-events/cities.json", import.meta.url)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const NEW = "https://places-api.foursquare.com/places/search";
const LEG = "https://api.foursquare.com/v3/places/search";
// Premium fields (rating/popularity/hours/photos) CONSUME Foursquare API credits.
// We request them on the main (full) query so the discovery cards light up with
// ★ratings, 🕒hours and thumbnails. If the account has NO credits the API answers
// 429, and we fall back to the free fields below (names + map pins, no premium
// data) so the ingest still produces useful rows instead of nothing.
const FIELDS_LEG = "fsq_id,name,geocodes,location,categories,rating,popularity,hours,photos,website,description,tel,chains";
const FIELDS_NEW = "fsq_place_id,name,latitude,longitude,location,categories,rating,popularity,hours,photos,website,description,tel,chains";
const FREE_LEG = "fsq_id,name,geocodes,location,categories";
const FREE_NEW = "fsq_place_id,name,latitude,longitude,location,categories";
function q(base, c, full, free) {
  let u = `${base}?ll=${c.lat},${c.lng}&radius=2500&limit=${full ? 50 : 5}&sort=RATING`;
  if (!full) return u; // cheap auth probe — no fields, no credits spent
  // Category filtering: legacy v3 accepts the numeric "13000" (Dining & Drinking);
  // the new Places API uses a different taxonomy and rejects it (400), so we omit
  // the category param there and rely on the FOOD/NOTFOOD name regex below.
  if (base === LEG) u += "&categories=13000&fields=" + (free ? FREE_LEG : FIELDS_LEG);
  else u += "&fields=" + (free ? FREE_NEW : FIELDS_NEW);
  return u;
}
const FOOD = /restaurant|caf[eé]|coffee|\bbar\b|\bpub\b|bistro|brasserie|diner|bakery|gastropub|wine bar|cocktail|tavern|trattoria|izakaya|ramen|noodle|sushi|pizz|steak|\bgrill\b|bbq|barbecue|eatery|tea ?room|teahouse|dessert|ice cream|gelato|creper|juice bar|breakfast|brunch/i;
const NOTFOOD = /grocer|supermarket|convenience|food store|drugstore|pharmacy|liquor store/i;
const PROBES = [
  { label: "new+bearer", base: NEW, headers: { Authorization: "Bearer " + KEY, "X-Places-Api-Version": VER, Accept: "application/json" } },
  { label: "new+raw", base: NEW, headers: { Authorization: KEY, "X-Places-Api-Version": VER, Accept: "application/json" } },
  { label: "legacy+raw", base: LEG, headers: { Authorization: KEY, Accept: "application/json" } },
  { label: "legacy+bearer", base: LEG, headers: { Authorization: "Bearer " + KEY, Accept: "application/json" } },
];

const T = { lat: 51.5074, lng: -0.1278 };
let chosen = null;
for (const p of PROBES) {
  try {
    const r = await fetch(q(p.base, T, false), { headers: p.headers });
    const body = await r.text();
    console.error(`probe [${p.label}] ${r.status} ${body.slice(0, 110)}`);
    if (r.ok) { chosen = p; break; }
  } catch (e) { console.error(`probe [${p.label}] ERR ${String(e).slice(0, 90)}`); }
  await sleep(300);
}
if (!chosen) { console.error("No working Foursquare auth combo — likely the wrong key type."); process.exit(1); }
console.log("Foursquare auth: " + chosen.label);
// refresh: clear our prior foursquare rows so each run reflects the current filter
try { await fetch(`${SB_URL}/rest/v1/places?source=eq.foursquare`, { method: "DELETE", headers: { apikey: SB_KEY, Authorization: "Bearer " + SB_KEY } }); } catch (e) { /* non-fatal */ }

function row(e, slug) {
  const id = e.fsq_place_id || e.fsq_id;
  const lat = e.latitude != null ? e.latitude : e.geocodes?.main?.latitude;
  const lng = e.longitude != null ? e.longitude : e.geocodes?.main?.longitude;
  const ph = e.photos?.[0] ? e.photos[0].prefix + "400x400" + e.photos[0].suffix : null;
  const rating = e.rating != null && isFinite(+e.rating) ? +e.rating : null;     // FSQ 0–10
  const pop = e.popularity != null && isFinite(+e.popularity) ? +e.popularity : null; // 0–1
  const hours = e.hours?.display ? String(e.hours.display).trim() : null;        // human-readable
  return {
    ext_id: "fsq:" + id, name: e.name,
    category: e.categories?.[0]?.name || "Food & drink",
    description: e.description || e.location?.formatted_address || null,
    lat: +lat, lng: +lng, city: slug,
    url: e.website || (id ? "https://foursquare.com/v/" + id : null),
    image: ph, rating, popularity: pop, hours,
    source: "foursquare", status: STATUS,
  };
}

let upserted = 0, hits = 0, dbg = false, freeMode = false;
for (const c of cities) {
  let results = [];
  try {
    let r = await fetch(q(chosen.base, c, true, freeMode), { headers: chosen.headers });
    let t = await r.text();
    if (!freeMode && r.status === 429) {
      // No Foursquare credits → premium fields rejected. Drop to free fields
      // (names + pins) for this and every remaining city.
      console.error("Foursquare 429 (no credits for premium fields) — falling back to FREE fields: names + map pins only, no ratings/photos/hours.");
      freeMode = true;
      r = await fetch(q(chosen.base, c, true, true), { headers: chosen.headers });
      t = await r.text();
    }
    if (!dbg) { dbg = true; console.error(`MAIN ${r.status} ${t.slice(0, 500)}`); }
    if (r.ok) results = JSON.parse(t).results || [];
  } catch (e) { if (!dbg) { dbg = true; console.error("MAIN err " + String(e).slice(0, 200)); } }
  const rows = results
    .filter((e) => {
      const n = (e.categories || []).map((x) => x.name || "").join(" ");
      if (!(FOOD.test(n) && !NOTFOOD.test(n))) return false;
      if (Array.isArray(e.chains) && e.chains.length) return false;        // independents only
      if (e.rating != null && +e.rating < MIN_RATING) return false;        // high-rated (skipped if rating absent)
      return true;
    })
    .map((e) => row(e, c.slug))
    .filter((x) => x.name && /:.+/.test(x.ext_id) && isFinite(x.lat) && isFinite(x.lng));
  if (rows.length) {
    const res = await fetch(`${SB_URL}/rest/v1/places?on_conflict=ext_id`, {
      method: "POST",
      headers: { apikey: SB_KEY, Authorization: "Bearer " + SB_KEY, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(rows),
    });
    if (res.ok) { upserted += rows.length; hits++; } else console.error(`${c.slug}: ${res.status} ${await res.text()}`);
  }
  await sleep(250);
}
await reportRun("foursquare", upserted);
console.log(`Foursquare (${chosen.label}): upserted ${upserted} places across ${hits} cities.`);
