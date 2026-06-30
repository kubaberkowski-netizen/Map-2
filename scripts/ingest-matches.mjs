// Ingest football fixtures from Football-Data.org into the Flâneur events feed,
// so people can check in to a match in person. Runs in GitHub Actions on a
// schedule — see .github/workflows/ingest-matches.yml. No terminal needed.
// Env: FOOTBALL_DATA_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, [INGEST_STATUS]
//
// Football-Data.org returns kickoff + teams but NO stadium coordinates, and the
// events table needs lat/lng + a Flâneur city slug. So we map each home team to
// its ground via scripts/data/team-venues.json and only ingest fixtures played
// at a venue in a city we cover. Each fixture becomes a "Sport" event tagged
// source:"matches" — it then inherits the What's-on list, map pin, type filter
// and (matchday-gated) in-person check-in for free.
import fs from "node:fs";

const KEY = process.env.FOOTBALL_DATA_KEY;
const SB_URL = process.env.SUPABASE_URL || "https://fpngxchltuovtsyzigul.supabase.co";
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const STATUS = process.env.INGEST_STATUS || "approved";
const DAYS_AHEAD = 60;            // only ingest fixtures within this horizon
const MATCH_MINUTES = 120;        // end_at = kickoff + 2h (feed drops it ~FT)
if (!KEY || !SB_KEY) { console.error("Missing FOOTBALL_DATA_KEY or SUPABASE_SERVICE_ROLE_KEY."); process.exit(1); }

// Free-tier competitions whose home grounds line up with our cities.
const COMPS = ["PL", "ELC", "PD", "SA", "BL1", "FL1", "DED", "PPL", "CL"];

const { venues } = JSON.parse(fs.readFileSync(new URL("./data/team-venues.json", import.meta.url)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// accent/punctuation/suffix-insensitive normaliser for tolerant name matching
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

for (const code of COMPS) {
  let data;
  try {
    const res = await fetch(`https://api.football-data.org/v4/competitions/${code}/matches?status=SCHEDULED`, {
      headers: { "X-Auth-Token": KEY },
    });
    if (!res.ok) { console.error(`${code}: ${res.status} ${await res.text()}`); await sleep(6500); continue; }
    data = await res.json();
  } catch (e) { console.error(`${code}: ${e.message}`); await sleep(6500); continue; }

  for (const m of data.matches || []) {
    const ko = Date.parse(m.utcDate);
    if (!isFinite(ko) || ko < now || ko > horizon) continue;
    const v = venueFor(m.homeTeam && (m.homeTeam.name || m.homeTeam.shortName));
    if (!v) { if (m.homeTeam && m.homeTeam.name) unmatched.add(m.homeTeam.name); continue; }
    const ext = "fd:" + m.id;
    if (seen.has(ext)) continue; seen.add(ext);
    const home = (m.homeTeam.shortName || m.homeTeam.name || "").replace(/ (FC|CF|AFC|SC|CD)$/i, "");
    const away = (m.awayTeam && (m.awayTeam.shortName || m.awayTeam.name) || "").replace(/ (FC|CF|AFC|SC|CD)$/i, "");
    rows.push({
      ext_id: ext,
      name: away ? `${home} v ${away}` : home,
      category: "Football",
      venue: v.venue,
      lat: v.lat,
      lng: v.lng,
      city: v.city,
      start_at: new Date(ko).toISOString(),
      end_at: new Date(ko + MATCH_MINUTES * 6e4).toISOString(),
      url: null,
      image: null,
      source: "matches",
      status: STATUS,
    });
  }
  await sleep(6500); // Football-Data free tier: 10 requests/min
}

if (unmatched.size) console.log(`Skipped ${unmatched.size} clubs with no venue mapping: ${[...unmatched].sort().join(", ")}`);

let upserted = 0;
// chunk the upsert so a single oversized POST can't be rejected
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
console.log(`Done: upserted ${upserted} fixtures across ${new Set(rows.map((r) => r.city)).size} cities.`);
