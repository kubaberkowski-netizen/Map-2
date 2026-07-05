// Ingest football fixtures from Football-Data.org into the Flâneur events feed,
// so people can check in to a match in person. Runs in GitHub Actions on a
// schedule — see .github/workflows/ingest-matches.yml. No terminal needed.
// Env: FOOTBALL_DATA_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, [INGEST_STATUS]
//
// Football-Data.org returns kickoff + teams but NO stadium coordinates, and the
// events table needs lat/lng + a Flâneur city slug. So we map each home team to
// its ground via scripts/data/team-venues.json and only ingest fixtures played
// at a venue in a city we cover. Each fixture becomes a "Football" event tagged
// source:"matches" — it then inherits the What's-on list, map pin, type filter
// and (matchday-gated) in-person check-in for free.
//
// Two passes:
//  1. SCHEDULED fixtures within DAYS_AHEAD → the upcoming-fixtures feed.
//  2. FINISHED fixtures within the last DAYS_BACK → the SAME ext_id rows are
//     re-upserted with a final `result` ("2-1") and best-effort `scorers`
//     (jsonb, from the per-match detail endpoint). This backfills the score for
//     a game you checked in to, so the Matchday log can show what you saw.
//     Requires the two nullable columns from sql/match_results.sql; if they are
//     absent the upsert degrades gracefully (retries without them).
import fs from "node:fs";
import { reportRun } from "./report-run.mjs";

const KEY = process.env.FOOTBALL_DATA_KEY;
const SB_URL = process.env.SUPABASE_URL || "https://fpngxchltuovtsyzigul.supabase.co";
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const STATUS = process.env.INGEST_STATUS || "approved";
const DAYS_AHEAD = 60;            // only ingest upcoming fixtures within this horizon
const DAYS_BACK = 12;             // backfill results for finished matches this recent
const MATCH_MINUTES = 120;        // end_at = kickoff + 2h (feed drops it ~FT)
const MAX_DETAILS = 40;           // cap per-match scorer lookups (rate-limit safety)
if (!KEY || !SB_KEY) { console.error("Missing FOOTBALL_DATA_KEY or SUPABASE_SERVICE_ROLE_KEY."); process.exit(1); }

// Free-tier competitions whose home grounds line up with our cities.
const COMPS = ["PL", "ELC", "PD", "SA", "BL1", "FL1", "DED", "PPL", "CL"];

const { venues } = JSON.parse(fs.readFileSync(new URL("./data/team-venues.json", import.meta.url)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// accent/punctuation/suffix-insensitive normaliser for tolerant name matching
function norm(s) {
  return String(s || "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
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
function shortName(t) {
  return (t && (t.shortName || t.name) || "").replace(/ (FC|CF|AFC|SC|CD)$/i, "");
}
const iso = (d) => new Date(d).toISOString().slice(0, 10);

async function fdGet(path) {
  const res = await fetch(`https://api.football-data.org/v4/${path}`, { headers: { "X-Auth-Token": KEY } });
  if (!res.ok) { const body = await res.text().catch(() => ""); throw new Error(`${res.status} ${body.slice(0, 160)}`); }
  return res.json();
}

const now = Date.now();
const horizon = now + DAYS_AHEAD * 864e5;
const backFrom = iso(now - DAYS_BACK * 864e5);
const backTo = iso(now);
const rows = new Map();            // ext_id -> row (finished pass overwrites/enriches scheduled)
const unmatched = new Set();
const finishedIds = [];            // fd match ids needing a scorer lookup

function baseRow(m, v, ko) {
  const home = shortName(m.homeTeam), away = shortName(m.awayTeam);
  return {
    ext_id: "fd:" + m.id,
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
  };
}

// ── Pass 1: upcoming SCHEDULED fixtures ──────────────────────────────────────
for (const code of COMPS) {
  let data;
  try { data = await fdGet(`competitions/${code}/matches?status=SCHEDULED`); }
  catch (e) { console.error(`${code} scheduled: ${e.message}`); await sleep(6500); continue; }
  for (const m of data.matches || []) {
    const ko = Date.parse(m.utcDate);
    if (!isFinite(ko) || ko < now || ko > horizon) continue;
    const v = venueFor(m.homeTeam && (m.homeTeam.name || m.homeTeam.shortName));
    if (!v) { if (m.homeTeam && m.homeTeam.name) unmatched.add(m.homeTeam.name); continue; }
    rows.set("fd:" + m.id, baseRow(m, v, ko));
  }
  await sleep(6500); // Football-Data free tier: 10 requests/min
}

// ── Pass 2: recently FINISHED fixtures → backfill final score ────────────────
for (const code of COMPS) {
  let data;
  try { data = await fdGet(`competitions/${code}/matches?status=FINISHED&dateFrom=${backFrom}&dateTo=${backTo}`); }
  catch (e) { console.error(`${code} finished: ${e.message}`); await sleep(6500); continue; }
  for (const m of data.matches || []) {
    const ko = Date.parse(m.utcDate);
    if (!isFinite(ko)) continue;
    const v = venueFor(m.homeTeam && (m.homeTeam.name || m.homeTeam.shortName));
    if (!v) continue;
    const ft = m.score && m.score.fullTime;
    if (!ft || ft.home == null || ft.away == null) continue;
    const row = baseRow(m, v, ko);
    row.result = `${ft.home}-${ft.away}`;
    rows.set(row.ext_id, row);
    if (finishedIds.length < MAX_DETAILS) finishedIds.push(m.id);
  }
  await sleep(6500);
}

// ── Best-effort scorers for finished matches (per-match detail) ──────────────
let scorerHits = 0;
for (const id of finishedIds) {
  let d;
  try { d = await fdGet(`matches/${id}`); }
  catch (e) { console.error(`detail ${id}: ${e.message}`); await sleep(6500); continue; }
  const goals = (d && d.goals) || [];
  const scorers = goals
    .filter((g) => g && g.scorer && g.scorer.name)
    .map((g) => ({ p: g.scorer.name, team: (g.team && g.team.name) || "", min: (g.minute != null ? g.minute : null) }));
  if (scorers.length) {
    const row = rows.get("fd:" + id);
    if (row) { row.scorers = scorers; scorerHits++; }
  }
  await sleep(6500);
}

if (unmatched.size) console.log(`Skipped ${unmatched.size} clubs with no venue mapping: ${[...unmatched].sort().join(", ")}`);
console.log(`${finishedIds.length} finished fixtures at covered grounds; ${scorerHits} with scorer detail.`);

const all = [...rows.values()];
let upserted = 0;

async function upsert(batch) {
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
  return res;
}

// chunk the upsert so a single oversized POST can't be rejected
for (let i = 0; i < all.length; i += 200) {
  const batch = all.slice(i, i + 200);
  let res = await upsert(batch);
  // Degrade gracefully if the result/scorers columns aren't in the schema yet.
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    if (/\b(result|scorers)\b/.test(body) && batch.some((r) => "result" in r || "scorers" in r)) {
      console.error(`upsert ${i}: result columns missing — retrying without them. Run sql/match_results.sql to enable.`);
      const stripped = batch.map((r) => { const { result, scorers, ...rest } = r; return rest; });
      res = await upsert(stripped);
    }
    if (!res.ok) { console.error(`upsert ${i}: ${res.status} ${await res.text().catch(() => "")}`); continue; }
  }
  upserted += batch.length;
}
await reportRun("matches", upserted);
console.log(`Done: upserted ${upserted} fixtures across ${new Set(all.map((r) => r.city)).size} cities.`);
