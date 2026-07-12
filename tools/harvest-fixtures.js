#!/usr/bin/env node
"use strict";
/*
 * tools/harvest-fixtures.js — season fixture schedules for the catalogue's
 * stadium spots, from fixturedownload.com's free full-season JSON feeds
 * (season calendars are static data — no runtime API needed in the app).
 *
 * Each fixture's venue name ("Location") is matched against the catalogue's
 * `stadium` spots (token match, enrich-hours style) — a fixture is only kept
 * when it lands on a real catalogue ground. Writes data/fixtures.json:
 *
 *   { "_generated": "...", "_source": "fixturedownload.com season feeds",
 *     "byId": { "<spotId>": [ { "id":"fxd:epl-2026:1", "n":"Arsenal v Coventry",
 *       "t":"2026-08-21T19:00:00Z", "lg":"Premier League", "sp":"Football" } ] } }
 *
 * build.js ships this as a content-hashed fixtures.<hash>.js sidecar
 * (window.__FLFX). Re-run + `npm run build` weekly/monthly to refresh (also
 * picks up newly published seasons — e.g. NBA/NHL drop in late summer).
 * Usage: node tools/harvest-fixtures.js [--dry]
 */
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "data", "fixtures.json");
const DRY = process.argv.includes("--dry");

// Feed slug → league label + Matchday sport category. Year = season START year;
// bump (or add next year's slugs) when new seasons are announced. Missing feeds
// (404 / not yet published) are skipped gracefully.
const Y = 2026;
const FEEDS = [
  { slug: `epl-${Y}`, lg: "Premier League", sp: "Football" },
  { slug: `championship-${Y}`, lg: "EFL Championship", sp: "Football" },
  { slug: `la-liga-${Y}`, lg: "La Liga", sp: "Football" },
  { slug: `bundesliga-${Y}`, lg: "Bundesliga", sp: "Football" },
  { slug: `serie-a-${Y}`, lg: "Serie A", sp: "Football" },
  { slug: `ligue-1-${Y}`, lg: "Ligue 1", sp: "Football" },
  { slug: `mls-${Y}`, lg: "MLS", sp: "Football" },
  { slug: `nfl-${Y}`, lg: "NFL", sp: "Am. Football" },
  { slug: `mlb-${Y}`, lg: "MLB", sp: "Baseball" },
  { slug: `nba-${Y}`, lg: "NBA", sp: "Basketball" },
  { slug: `nba-${Y - 1}`, lg: "NBA", sp: "Basketball" },
  { slug: `nhl-${Y}`, lg: "NHL", sp: "Hockey" },
  { slug: `nhl-${Y - 1}`, lg: "NHL", sp: "Hockey" },
];

const spots = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "spots.json"), "utf8"));
const grounds = spots.filter((z) => z.c === "stadium" && typeof z.lat === "number");

// --- venue-name matching (precision first: no name match, no fixture) --------
const NOISE = new Set(["the", "stadium", "stadion", "estadio", "estadi", "arena", "park", "field", "ground"]);
function tokens(s) {
  return String(s || "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/).filter((t) => t && !NOISE.has(t));
}
const tight = (s) => tokens(s).join(" ");
function jac(a, b) {
  const A = new Set(a), B = new Set(b);
  if (!A.size || !B.size) return 0;
  let n = 0; for (const t of A) if (B.has(t)) n++;
  return n / (A.size + B.size - n);
}
const groundCache = new Map();
function matchGround(venue) {
  if (groundCache.has(venue)) return groundCache.get(venue);
  const vN = tight(venue), vT = tokens(venue);
  let best = null, bestS = 0;
  if (vN) for (const g of grounds) {
    const gN = tight(g.n);
    let s = 0;
    if (gN === vN) s = 1;
    else if (gN.includes(vN) || vN.includes(gN)) s = Math.min(gN.length, vN.length) >= 5 ? 0.9 : 0;
    else { const j = jac(vT, tokens(g.n)); s = j >= 0.6 ? j : 0; }
    if (s > bestS) { bestS = s; best = g; }
  }
  const out = bestS >= 0.6 ? best : null;
  groundCache.set(venue, out);
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const now = Date.now();
  const byId = {}; const res = {}; let total = 0, matched = 0; const unmatched = {};
  for (const f of FEEDS) {
    let rows;
    try {
      const r = await fetch(`https://fixturedownload.com/feed/json/${f.slug}`, { headers: { "User-Agent": "flaneur-fixtures/1.0" } });
      if (!r.ok) throw new Error("HTTP " + r.status);
      rows = await r.json();
      if (!Array.isArray(rows)) throw new Error("not a season feed");
    } catch (e) { console.error(`  · ${f.slug}: unavailable (${e.message}) — skipped`); continue; }
    let kept = 0;
    for (const m of rows) {
      const ts = Date.parse(String(m.DateUtc || "").replace(" ", "T"));
      if (!isFinite(ts)) continue;
      // recent finals -> results map (Matchday backfills checked-in scores)
      if (ts < now - 864e5) {
        if (ts > now - 120 * 864e5 && m.HomeTeamScore != null && m.AwayTeamScore != null)
          res[`fxd:${f.slug}:${m.MatchNumber}`] = `${m.HomeTeamScore}-${m.AwayTeamScore}`;
        continue;
      }
      total++;
      const g = m.Location ? matchGround(m.Location) : null;
      if (!g) { if (m.Location) unmatched[m.Location] = (unmatched[m.Location] || 0) + 1; continue; }
      matched++; kept++;
      (byId[g.id] = byId[g.id] || []).push({
        id: `fxd:${f.slug}:${m.MatchNumber}`,
        n: `${m.HomeTeam} v ${m.AwayTeam}`,
        t: new Date(ts).toISOString().replace(/\.\d{3}Z$/, "Z"),
        lg: f.lg, sp: f.sp,
      });
    }
    console.error(`  ${f.slug}: ${rows.length} fixtures, ${kept} upcoming matched to grounds`);
    await sleep(600);
  }
  for (const k of Object.keys(byId)) {
    byId[k].sort((a, b) => (a.t < b.t ? -1 : 1));
    byId[k] = byId[k].slice(0, 40);
  }
  const out = { _generated: new Date().toISOString(), _source: "fixturedownload.com season feeds", byId, res };
  console.error(`\n[fixtures] ${total} upcoming fixtures seen, ${matched} matched onto ${Object.keys(byId).length} catalogue grounds, ${Object.keys(res).length} recent results`);
  const miss = Object.entries(unmatched).sort((a, b) => b[1] - a[1]).slice(0, 15);
  console.error("[fixtures] top unmatched venues (add these stadiums to the catalogue to capture them):");
  miss.forEach(([v, n]) => console.error(`   ${String(n).padStart(4)}  ${v}`));
  if (!DRY) { fs.writeFileSync(OUT, JSON.stringify(out, null, 1) + "\n"); console.error(`→ ${path.relative(ROOT, OUT)}`); }
  else console.error("(DRY — nothing written)");
})().catch((e) => { console.error(e); process.exit(1); });
