// Dead-man's switch for the scheduled ingests (audit P1.4). Each ingest upserts
// a row into public.ingest_runs on a successful run (via report-run.mjs); this
// script reads that table and fails loudly if any source has gone stale or
// last reported ok=false. It runs on its own daily GitHub Actions schedule —
// see .github/workflows/ingest-health.yml — so a process.exit(1) here surfaces
// as a workflow-failure email to the repo owner. That's the whole point: if an
// ingest silently stops running (bad key, upstream API change, disabled cron),
// nobody notices until the feed rots — unless something is watching the watchers.
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//
// Thresholds are per-source: daily crons get 48h (one missed run of grace);
// the three weekly Monday crons (foursquare/plaques/wikidata) get 8 days.
const SB_URL = process.env.SUPABASE_URL || "https://fpngxchltuovtsyzigul.supabase.co";
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SB_KEY) { console.error("Missing SUPABASE_SERVICE_ROLE_KEY."); process.exit(1); }

const H = 3600e3;
// Expected sources → max age (hours) before we consider the source stale.
const EXPECTED = {
  astronomy: 48, aurora: 48, events: 48, matches: 48, parkrun: 48,
  seatgeek: 48, skiddle: 48, "us-sports": 48,
  foursquare: 192, plaques: 192, wikidata: 192, // weekly Monday crons (168h + a day)
};

let rows;
try {
  const res = await fetch(`${SB_URL}/rest/v1/ingest_runs?select=source,ran_at,upserted,ok`, {
    headers: { apikey: SB_KEY, Authorization: "Bearer " + SB_KEY },
  });
  if (!res.ok) { console.error(`ingest_runs read: ${res.status} ${await res.text()}`); process.exit(1); }
  rows = await res.json();
} catch (e) { console.error("fetch ingest_runs: " + e.message); process.exit(1); }

const byId = new Map(rows.map((r) => [r.source, r]));
const now = Date.now();
const problems = [];

for (const [source, maxH] of Object.entries(EXPECTED)) {
  const r = byId.get(source);
  if (!r) { problems.push(`${source}: NEVER reported (no ingest_runs row)`); continue; }
  const ageH = (now - Date.parse(r.ran_at)) / H;
  if (!isFinite(ageH)) { problems.push(`${source}: unparseable ran_at "${r.ran_at}"`); continue; }
  if (r.ok === false) { problems.push(`${source}: last run reported ok=false (${ageH.toFixed(0)}h ago)`); continue; }
  if (ageH > maxH) { problems.push(`${source}: STALE — last ran ${ageH.toFixed(0)}h ago (limit ${maxH}h)`); continue; }
  console.log(`ok  ${source.padEnd(11)} ${ageH.toFixed(0)}h ago, upserted ${r.upserted}`);
}

// Any rows we don't recognise are informational, not failures (new ingest added).
for (const r of rows) {
  if (!(r.source in EXPECTED)) console.log(`--  ${r.source}: unknown source (not health-checked)`);
}

if (problems.length) {
  console.error(`\n${problems.length} ingest health problem(s):`);
  for (const p of problems) console.error("  ✗ " + p);
  process.exit(1);
}
console.log(`\nAll ${Object.keys(EXPECTED).length} ingests healthy.`);
