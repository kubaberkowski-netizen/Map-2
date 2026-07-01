// Ingest an "aurora watch" event when the northern lights are likely tonight
// over a Flâneur city, so people can check in when they go out to look. No API
// key — NOAA SWPC publishes the planetary K-index forecast publicly.
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, [INGEST_STATUS]
//
// On quiet nights this upserts nothing (the feed stays clean). It only creates
// events for cities whose latitude makes the forecast Kp plausibly visible.
import fs from "node:fs";
import { reportRun } from "./report-run.mjs";

const SB_URL = process.env.SUPABASE_URL || "https://fpngxchltuovtsyzigul.supabase.co";
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const STATUS = process.env.INGEST_STATUS || "approved";
if (!SB_KEY) { console.error("Missing SUPABASE_SERVICE_ROLE_KEY."); process.exit(1); }

const cities = JSON.parse(fs.readFileSync(new URL("../supabase/functions/ingest-events/cities.json", import.meta.url)));
const tzMap = JSON.parse(fs.readFileSync(new URL("./data/city-tz.json", import.meta.url)));

// Minimum Kp for a plausible sighting at a given |latitude| (rough, conservative).
function kpNeeded(absLat) {
  if (absLat >= 62) return 3;
  if (absLat >= 58) return 4;
  if (absLat >= 54) return 5;
  if (absLat >= 50) return 6;
  if (absLat >= 46) return 7;
  return 99; // too far south/equatorial — never
}
// UTC instant for a local wall-clock time in an IANA zone (DST-aware).
function zonedToUTC(y, m, d, hh, mm, tz) {
  const guess = Date.UTC(y, m, d, hh, mm);
  const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
    .formatToParts(new Date(guess)).reduce((a, x) => (a[x.type] = x.value, a), {});
  let hour = +p.hour; if (hour === 24) hour = 0;
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, hour, +p.minute);
  return new Date(guess - (asUTC - guess));
}

let rows;
try {
  const res = await fetch("https://services.swpc.noaa.gov/products/noaa-planetary-k-index-forecast.json");
  if (!res.ok) { console.error(`kp forecast: ${res.status}`); process.exit(1); }
  rows = await res.json();
} catch (e) { console.error("fetch kp: " + e.message); process.exit(1); }

// rows[0] is a header; each row: [time_tag, kp, observed|predicted, noaa_scale]
const now = Date.now();
const horizon = now + 30 * 3600e3; // look ~30h ahead
let peakKp = 0, peakAt = null;
for (let i = 1; i < rows.length; i++) {
  const r = rows[i];
  const t = Date.parse((r[0] || "").replace(" ", "T") + "Z");
  const kp = parseFloat(r[1]);
  if (!isFinite(t) || !isFinite(kp) || t < now || t > horizon) continue;
  if (kp > peakKp) { peakKp = kp; peakAt = t; }
}
console.log(`Forecast peak Kp ${peakKp.toFixed(1)} in the next 30h.`);

const out = [];
if (peakKp >= 3) {
  for (const c of cities) {
    if (peakKp < kpNeeded(Math.abs(c.lat))) continue;
    const tz = tzMap[c.slug]; if (!tz) continue;
    // tonight in the city's local calendar
    const loc = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" })
      .formatToParts(new Date()).reduce((a, x) => (a[x.type] = x.value, a), {});
    const y = +loc.year, m = +loc.month - 1, d = +loc.day;
    const start = zonedToUTC(y, m, d, 22, 0, tz);        // 22:00 tonight local
    const end = new Date(start.getTime() + 4 * 3600e3);  // → ~02:00
    out.push({
      ext_id: "aurora:" + c.slug + ":" + new Date(Date.UTC(y, m, d)).toISOString().slice(0, 10),
      name: "Aurora watch — northern lights possible (Kp " + Math.round(peakKp) + ")",
      category: "Aurora",
      venue: "Head somewhere dark, away from city lights",
      lat: c.lat, lng: c.lng,
      city: c.slug,
      start_at: start.toISOString(),
      end_at: end.toISOString(),
      url: "https://www.swpc.noaa.gov/products/aurora-30-minute-forecast",
      image: null,
      source: "matches",
      status: STATUS,
    });
  }
}

await reportRun("aurora", out.length);
if (!out.length) { console.log("No aurora-likely cities tonight — nothing to upsert."); process.exit(0); }

const res = await fetch(`${SB_URL}/rest/v1/events?on_conflict=ext_id`, {
  method: "POST",
  headers: {
    apikey: SB_KEY,
    Authorization: "Bearer " + SB_KEY,
    "Content-Type": "application/json",
    Prefer: "resolution=merge-duplicates,return=minimal",
  },
  body: JSON.stringify(out),
});
if (res.ok) console.log(`Done: upserted ${out.length} aurora watches (${out.map((r) => r.city).join(", ")}).`);
else console.error(`upsert: ${res.status} ${await res.text()}`);
