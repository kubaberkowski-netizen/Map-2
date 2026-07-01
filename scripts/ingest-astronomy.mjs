// Ingest astronomy events (major meteor-shower peaks + full moons) into the
// Flâneur events feed, so people get a "look up tonight" nudge and can check in.
// No API key — meteor peaks are a fixed annual calendar and full moons are
// computed. Runs in GitHub Actions on a schedule.
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, [INGEST_STATUS]
import fs from "node:fs";

const SB_URL = process.env.SUPABASE_URL || "https://fpngxchltuovtsyzigul.supabase.co";
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const STATUS = process.env.INGEST_STATUS || "approved";
const HORIZON_DAYS = 45;
if (!SB_KEY) { console.error("Missing SUPABASE_SERVICE_ROLE_KEY."); process.exit(1); }

const cities = JSON.parse(fs.readFileSync(new URL("../supabase/functions/ingest-events/cities.json", import.meta.url)));
const tzMap = JSON.parse(fs.readFileSync(new URL("./data/city-tz.json", import.meta.url)));

// Major annual meteor showers (approx peak day, month is 1-based) + best hour.
const SHOWERS = [
  { n: "Quadrantids", m: 1, d: 3 }, { n: "Lyrids", m: 4, d: 22 },
  { n: "Eta Aquariids", m: 5, d: 6 }, { n: "Perseids", m: 8, d: 12 },
  { n: "Draconids", m: 10, d: 8 }, { n: "Orionids", m: 10, d: 21 },
  { n: "Leonids", m: 11, d: 17 }, { n: "Geminids", m: 12, d: 14 },
  { n: "Ursids", m: 12, d: 22 },
];

// UTC instant for a local wall-clock time in an IANA zone (DST-aware).
function zonedToUTC(y, m, d, hh, mm, tz) {
  const guess = Date.UTC(y, m, d, hh, mm);
  const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
    .formatToParts(new Date(guess)).reduce((a, x) => (a[x.type] = x.value, a), {});
  let hour = +p.hour; if (hour === 24) hour = 0;
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, hour, +p.minute);
  return new Date(guess - (asUTC - guess));
}
const NEW_MOON_2000 = Date.UTC(2000, 0, 6, 18, 14); // reference new moon
const SYN = 29.530588853 * 864e5;                   // synodic month

const now = Date.now();
const horizon = now + HORIZON_DAYS * 864e5;

// Collect global astronomy dates in [now, horizon]: {kind, name, y, m0, d} (m0 0-based).
const dates = [];
// Full moons: compute the instants directly (new moon + half a synodic month).
{
  let k = Math.floor((now - NEW_MOON_2000) / SYN) - 1;
  for (let i = 0; i < 4; i++, k++) {
    const fm = NEW_MOON_2000 + k * SYN + 14.7653 * 864e5;
    if (fm >= now && fm <= horizon) {
      const dt = new Date(fm);
      dates.push({ kind: "moon", name: "Full moon", y: dt.getUTCFullYear(), m0: dt.getUTCMonth(), d: dt.getUTCDate(), hh: 21 });
    }
  }
}
// Meteor showers this year and next, if the peak falls in the horizon.
const yr = new Date(now).getUTCFullYear();
for (const y of [yr, yr + 1]) for (const s of SHOWERS) {
  const peak = Date.UTC(y, s.m - 1, s.d);
  if (peak >= now - 864e5 && peak <= horizon)
    dates.push({ kind: "shower", name: s.n + " meteor shower", y, m0: s.m - 1, d: s.d, hh: 22 });
}
console.log("Astronomy dates in horizon:", dates.map((x) => x.name + " " + x.y + "-" + (x.m0 + 1) + "-" + x.d).join("; ") || "(none)");

const rows = [];
for (const ev of dates) {
  for (const c of cities) {
    const tz = tzMap[c.slug]; if (!tz) continue;
    const start = zonedToUTC(ev.y, ev.m0, ev.d, ev.hh, 0, tz);
    const end = new Date(start.getTime() + (ev.kind === "shower" ? 5 : 3) * 3600e3);
    const iso = new Date(Date.UTC(ev.y, ev.m0, ev.d)).toISOString().slice(0, 10);
    rows.push({
      ext_id: "astro:" + c.slug + ":" + ev.kind + ":" + iso,
      name: ev.kind === "moon" ? "Full moon tonight" : (ev.name + " peaks tonight"),
      category: "Astronomy",
      venue: ev.kind === "shower" ? "Find a dark sky away from city lights" : "Look up after dark",
      lat: c.lat, lng: c.lng,
      city: c.slug,
      start_at: start.toISOString(),
      end_at: end.toISOString(),
      url: null,
      image: null,
      source: "matches",
      status: STATUS,
    });
  }
}

let upserted = 0;
for (let i = 0; i < rows.length; i += 200) {
  const batch = rows.slice(i, i + 200);
  const res = await fetch(`${SB_URL}/rest/v1/events?on_conflict=ext_id`, {
    method: "POST",
    headers: { apikey: SB_KEY, Authorization: "Bearer " + SB_KEY, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(batch),
  });
  if (res.ok) upserted += batch.length;
  else console.error(`upsert ${i}: ${res.status} ${await res.text()}`);
}
console.log(`Done: upserted ${upserted} astronomy events (${dates.length} dates × ${cities.length} cities).`);
