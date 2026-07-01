// Ingest parkrun (free, weekly 5k) courses into the Flâneur events feed, so
// people can check in at a parkrun in person. Runs in GitHub Actions on a
// schedule — see .github/workflows/ingest-parkrun.yml. No API key needed.
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, [INGEST_STATUS]
//
// parkrun publishes every course worldwide as a GeoJSON (coords + name), but no
// per-week times — parkrun is recurring (Saturday 5k). So we keep only courses
// within range of a Flâneur city, then generate the next few Saturday-morning
// occurrences at 9am local (DST-correct via the city's IANA timezone). Each
// occurrence is an event tagged source:"matches", so it inherits the What's-on
// list, map pin, type filter and matchday-gated check-in for free.
import fs from "node:fs";
import { reportRun } from "./report-run.mjs";

const SB_URL = process.env.SUPABASE_URL || "https://fpngxchltuovtsyzigul.supabase.co";
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const STATUS = process.env.INGEST_STATUS || "approved";
const RADIUS_KM = 25;   // assign a course to the nearest covered city within this range (metro-wide)
const WEEKS = 3;        // generate this many upcoming Saturdays
const RUN_MINUTES = 90; // end_at = start + 90min
if (!SB_KEY) { console.error("Missing SUPABASE_SERVICE_ROLE_KEY."); process.exit(1); }

const cities = JSON.parse(fs.readFileSync(new URL("../supabase/functions/ingest-events/cities.json", import.meta.url)));
const tzMap = JSON.parse(fs.readFileSync(new URL("./data/city-tz.json", import.meta.url)));
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
// UTC instant for a given local wall-clock time in an IANA zone (DST-aware).
function zonedToUTC(y, m, d, hh, mm, tz) {
  const guess = Date.UTC(y, m, d, hh, mm);
  const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
    .formatToParts(new Date(guess)).reduce((a, x) => (a[x.type] = x.value, a), {});
  let hour = +p.hour; if (hour === 24) hour = 0;
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, hour, +p.minute);
  return new Date(guess - (asUTC - guess)); // subtract the zone offset at the guess
}
// Local start hour: most countries 9am; a few run earlier (window absorbs slack).
function startHour(tz) {
  return /^Australia\/|^Pacific\/|Johannesburg|Los_Angeles|New_York|Chicago|Singapore|Sao_Paulo|Argentina|Mexico_City/.test(tz) ? 8 : 9;
}
// Dates (Y,M,D in the city's local tz) of the next WEEKS occurrences of weekday
// `dow` (0=Sun … 6=Sat), today included.
function nextDates(tz, dow) {
  const now = new Date();
  const loc = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(now).reduce((a, x) => (a[x.type] = x.value, a), {});
  const wd = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[loc.weekday];
  const base = Date.UTC(+loc.year, +loc.month - 1, +loc.day); // local calendar date as a UTC midnight anchor
  const out = [];
  let add = (dow - wd + 7) % 7; // days until the target weekday (0 if today)
  for (let i = 0; i < WEEKS; i++) {
    const dt = new Date(base + (add + i * 7) * 864e5);
    out.push([dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate()]);
  }
  return out;
}

let data;
try {
  const res = await fetch("https://images.parkrun.com/events.json", { headers: { "User-Agent": "Flaneur/1.0 (events ingest)" } });
  if (!res.ok) { console.error(`events.json: ${res.status}`); process.exit(1); }
  data = await res.json();
} catch (e) { console.error("fetch events.json: " + e.message); process.exit(1); }

const feats = (data && data.events && data.events.features) || [];
const rows = [];
const seen = new Set();
let courses = 0;
for (const f of feats) {
  const p = f.properties || {}, g = f.geometry || {};
  const sid = +p.seriesid || 1;          // 1 = Saturday 5k, 2 = junior 2k (Sunday)
  if (sid !== 1 && sid !== 2) continue;
  const dow = sid === 2 ? 0 : 6;         // Sunday for junior, Saturday for 5k
  const co = g.coordinates || [];
  const lng = +co[0], lat = +co[1];
  if (!isFinite(lat) || !isFinite(lng)) continue;
  const city = nearestCity(lat, lng);
  if (!city) continue;
  const tz = tzMap[city.slug]; if (!tz) continue;
  courses++;
  const name = p.EventLongName || (p.EventShortName ? p.EventShortName + " parkrun" : "parkrun");
  const venue = p.EventShortName || p.EventLongName || "parkrun";
  const hh = startHour(tz);
  for (const [y, m, d] of nextDates(tz, dow)) {
    const start = zonedToUTC(y, m, d, hh, 0, tz);
    const iso = new Date(Date.UTC(y, m, d)).toISOString().slice(0, 10);
    const ext = "pr:" + (p.eventname || p.id) + ":" + iso;
    if (seen.has(ext)) continue; seen.add(ext);
    rows.push({
      ext_id: ext,
      name,
      category: "Parkrun",
      venue,
      lat, lng,
      city: city.slug,
      start_at: start.toISOString(),
      end_at: new Date(start.getTime() + RUN_MINUTES * 6e4).toISOString(),
      url: null,
      image: null,
      source: "matches",
      status: STATUS,
    });
  }
}
console.log(`Matched ${courses} parkrun courses near covered cities → ${rows.length} dated events.`);

let upserted = 0;
for (let i = 0; i < rows.length; i += 200) {
  const batch = rows.slice(i, i + 200);
  const res = await fetch(`${SB_URL}/rest/v1/events?on_conflict=ext_id`, {
    method: "POST",
    headers: {
      apikey: SB_KEY,
      Authorization: "Bearer " + SB_KEY,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify(batch),
  });
  if (res.ok) upserted += batch.length;
  else console.error(`upsert ${i}: ${res.status} ${await res.text()}`);
  await sleep(150);
}
await reportRun("parkrun", upserted);
console.log(`Done: upserted ${upserted} parkrun events across ${new Set(rows.map((r) => r.city)).size} cities.`);
