// Ingest US/Canada major-league fixtures (NBA / NFL / MLB / NHL) from
// TheSportsDB into the Flâneur events feed, so people can check in to a game in
// person. Runs in GitHub Actions on a schedule — see the matching workflow.
// Env: [THESPORTSDB_KEY] (defaults to the free test key "3"),
//      SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, [INGEST_STATUS]
//
// Like ingest-matches (football), TheSportsDB gives the fixture but no usable
// coords, so scripts/data/us-team-venues.json maps each home team to its arena
// and only games at an arena in a city we cover are ingested. Each game becomes
// a "Sport" event tagged source:"matches", so it inherits the What's-on list,
// map pin, type filter and matchday-gated in-person check-in for free.
import fs from "node:fs";

const KEY = process.env.THESPORTSDB_KEY || "3"; // free public test key
const SB_URL = process.env.SUPABASE_URL || "https://fpngxchltuovtsyzigul.supabase.co";
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const STATUS = process.env.INGEST_STATUS || "approved";
const DAYS_AHEAD = 60;        // only ingest games within this horizon
const GAME_MINUTES = 180;     // end_at = tip-off + 3h (feed drops it after)
if (!SB_KEY) { console.error("Missing SUPABASE_SERVICE_ROLE_KEY."); process.exit(1); }

// TheSportsDB league ids → label kept in the event name prefix.
const LEAGUES = [
  { id: "4387", name: "NBA" },
  { id: "4391", name: "NFL" },
  { id: "4424", name: "MLB" },
  { id: "4380", name: "NHL" },
];

const { venues } = JSON.parse(fs.readFileSync(new URL("./data/us-team-venues.json", import.meta.url)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function norm(s) {
  return String(s || "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}
function venueFor(teamName) {
  const n = norm(teamName);
  if (!n) return null;
  for (const v of venues) {
    for (const a of v.aliases) { if (n.includes(norm(a))) return v; }
  }
  return null;
}
const now = Date.now();
const horizon = now + DAYS_AHEAD * 864e5;
const rows = [];
const seen = new Set();
const unmatched = new Set();

for (const lg of LEAGUES) {
  let data;
  try {
    const res = await fetch(`https://www.thesportsdb.com/api/v1/json/${KEY}/eventsnextleague.php?id=${lg.id}`);
    if (!res.ok) { console.error(`${lg.name}: ${res.status} ${await res.text()}`); await sleep(1500); continue; }
    data = await res.json();
  } catch (e) { console.error(`${lg.name}: ${e.message}`); await sleep(1500); continue; }

  for (const ev of (data && data.events) || []) {
    const ts = ev.strTimestamp ? Date.parse(ev.strTimestamp.replace(" ", "T"))
      : (ev.dateEvent ? Date.parse(ev.dateEvent + "T" + (ev.strTime || "00:00:00") + "Z") : NaN);
    if (!isFinite(ts) || ts < now || ts > horizon) continue;
    const v = venueFor(ev.strHomeTeam);
    if (!v) { if (ev.strHomeTeam) unmatched.add(ev.strHomeTeam); continue; }
    const ext = "tsd:" + ev.idEvent;
    if (seen.has(ext)) continue; seen.add(ext);
    const home = ev.strHomeTeam, away = ev.strAwayTeam;
    rows.push({
      ext_id: ext,
      name: (home && away) ? `${home} v ${away}` : (ev.strEvent || home || "Game"),
      category: "Sport",
      venue: v.venue,
      lat: v.lat,
      lng: v.lng,
      city: v.city,
      start_at: new Date(ts).toISOString(),
      end_at: new Date(ts + GAME_MINUTES * 6e4).toISOString(),
      url: null,
      image: null,
      source: "matches",
      status: STATUS,
    });
  }
  await sleep(1500); // be polite to the free API
}

if (unmatched.size) console.log(`Skipped ${unmatched.size} teams with no venue mapping: ${[...unmatched].sort().join(", ")}`);

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
}
console.log(`Done: upserted ${upserted} US games across ${new Set(rows.map((r) => r.city)).size} cities.`);
