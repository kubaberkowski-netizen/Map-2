#!/usr/bin/env node
"use strict";
/*
 * tools/audit-city.js — scored, per-city junk audit (Track A: "clean up the junk").
 *
 * Where prune-junk.js is binary rule-matching (and depends on /tmp files), this
 * SCORES every spot in a city from the signals already in the catalogue, then
 * surfaces the worst — with a proposed action — for review. Nothing is deleted
 * by the audit itself: it writes a proposal you eyeball/edit, then `--apply`.
 *
 * keep-score signals (higher = keep):
 *   + authored writeup (data/quality.json flag a/v)      [PROTECTED — never pruned]
 *   + notable backing  (Wikipedia / Wikidata)            [strong keep]
 *   + storied category (oddity/history/death/follies/streetart/literary/film…)
 *   − generic type-word name ("War Memorial", "Cinema", "Statue", "Fountain")
 *   − chain (Odeon/Vue/Starbucks/Kingdom Hall…)
 *   − duplicate name within the city (keep the best-scored, flag the rest)
 *   − geofence outlier: far from the city centre relative to the city's own bbox
 *   − mundane Wikidata type bled into the `oddity` fallback (station/school/lake…)
 *
 * Usage:
 *   node tools/audit-city.js london                 # report + write proposal JSON
 *   node tools/audit-city.js london --limit 60      # show the worst 60
 *   node tools/audit-city.js --all                  # one-line summary for every city
 *   node tools/audit-city.js london --apply         # apply approved actions from the proposal
 *
 * Proposal file: tools/candidates/audit-<city>.json. Each row has {id,n,score,
 * rules,action}. `action` is "" (keep), "prune", or "retag:<city>". Edit it by
 * hand, then re-run with --apply to enact only the non-empty, non-protected ones.
 */
const fs = require("fs");
const path = require("path");
const M = require("./model");
const Q = require("./quality");

const ROOT = path.join(__dirname, "..");
const SPOTS = path.join(ROOT, "data", "spots.json");
const OUTDIR = path.join(__dirname, "candidates");

const STORIED = new Set([
  "oddity", "history", "death", "roman", "medieval", "follies", "streetart",
  "literary", "film", "espionage", "music", "maritime", "ghost", "ruin",
]);
const GENERIC = new Set([
  "war memorial", "memorial", "cinema", "sculpture", "statue", "fountain",
  "drinking fountain", "monument", "obelisk", "column", "pillar", "cross",
  "celtic cross", "cannon", "anchor", "lighthouse", "well", "milestone",
  "boundary stone", "coal tax post", "standing stone", "stone", "mural",
  "artwork", "public art", "gallery", "museum", "library", "church", "chapel",
  "mosque", "synagogue", "temple", "gurdwara", "cemetery", "graveyard",
  "sundial", "bandstand", "clock", "clock tower", "pump", "water pump",
  "horse trough", "trough", "bench", "plaque", "maypole",
]);
const CHAIN = /^(odeon|vue|cineworld|cinema city|showcase|cineplex|omniplex|cinemark|amc|regal|path[ée]|ugc|kinepolis|cgv|megabox|lotte cinema|empire cinemas?|cin[ée]polis|hoyts|reading cinemas|toho cinemas?|starbucks|costa coffee|cost[ae]|pret a manger|mcdonald|kfc|subway|greggs|nando|kingdom hall|jehovah|salvation army|latter-day saints|new apostolic|seventh[- ]day adventist)\b/;
const WARMEM = /(war memorial|kriegerdenkmal|cenotaph|boer war|ww[12i]+ memorial|fallen soldiers)/;
const MUNDANE = /(railway station|train station|metro station|underground station|tram stop|bus station|\bairport\b|\bschool\b|high school|primary school|kindergarten|\bcollege\b|\buniversity\b|\bhospital\b|\bclinic\b|medical cent(re|er)|\bsuburb\b|municipality|populated place|human settlement|\bvillage\b|\bhamlet\b|\blake\b|reservoir|fire station|police station|power station|substation|sewage|water treatment|\bcompany\b|corporation)/;

const norm = M.norm;
const km = (m) => m / 1000;

function bboxHalfDiagonalKm(city) {
  const b = city.bbox; // [minLng,minLat,maxLng,maxLat]
  return km(M.haversineM(b[1], b[0], b[3], b[2])) / 2;
}

function scoreSpot(s, ctx) {
  const rules = [];
  let score = 0;
  const nm = norm(s.n);
  const authored = Q.isAuthored(s.id);
  const notable = Q.isNotable(s.id);

  if (authored) { score += 100; rules.push("authored"); }
  if (notable) { score += 40; rules.push("notable"); }
  if (STORIED.has(s.c)) score += 8;

  if (!nm || GENERIC.has(nm)) { score -= 30; rules.push("generic-name"); }
  if (CHAIN.test(nm)) { score -= 40; rules.push("chain"); }
  if (WARMEM.test(nm)) { score -= 25; rules.push("war-memorial"); }
  if (s.c === "oddity") {
    const head = String(s.s || "").toLowerCase().split(/\s+in\s+|\s+of\s+|,/)[0];
    if (MUNDANE.test(head)) { score -= 30; rules.push("mundane-type"); }
  }

  // geofence: how far from the city centre, relative to the city's own size
  let proposedRetag = "";
  if (Number.isFinite(s.lat) && Number.isFinite(s.lng) && ctx.city.centre) {
    const dKm = km(M.haversineM(s.lat, s.lng, ctx.city.centre[0], ctx.city.centre[1]));
    const ratio = dKm / (ctx.halfDiag || 1);
    if (ratio > 1.4) { score -= 25; rules.push(`far(${dKm.toFixed(0)}km)`); }
    else if (ratio > 1.0) { score -= 10; rules.push(`edge(${dKm.toFixed(0)}km)`); }
    // does another city's bbox claim it better? (mis-tag candidate)
    const best = M.cityForPoint(s.lat, s.lng, ctx.model);
    if (best && best !== s.city) {
      const bc = ctx.model.cityById.get(best);
      const dBest = bc && bc.centre ? km(M.haversineM(s.lat, s.lng, bc.centre[0], bc.centre[1])) : Infinity;
      if (dBest < dKm) { rules.push(`nearer:${best}`); proposedRetag = best; }
    }
  }

  // duplicate name within the city (first/best keeps; later ones flagged)
  if (ctx.dupNames.has(nm) && ctx.dupNames.get(nm) > 1) { score -= 15; rules.push("dup-name"); }

  // proposed action — never for protected (authored/notable) spots
  let action = "";
  if (!authored && !notable) {
    if (proposedRetag && (rules.includes("far(") || rules.some((r) => r.startsWith("far(")))) action = "retag:" + proposedRetag;
    else if (rules.some((r) => ["generic-name", "chain", "war-memorial", "mundane-type", "dup-name"].includes(r)) && score < 0) action = "prune";
    else if (proposedRetag && rules.some((r) => r.startsWith("far("))) action = "retag:" + proposedRetag;
  }
  return { id: s.id, n: s.n, city: s.city, c: s.c, score, rules, action };
}

function auditCity(citySlug, allSpots, model) {
  const city = model.cityById.get(citySlug);
  if (!city) throw new Error(`unknown city "${citySlug}"`);
  const spots = allSpots.filter((s) => s.city === citySlug);
  const dupNames = new Map();
  for (const s of spots) dupNames.set(norm(s.n), (dupNames.get(norm(s.n)) || 0) + 1);
  const ctx = { city, model, halfDiag: bboxHalfDiagonalKm(city), dupNames };
  const scored = spots.map((s) => scoreSpot(s, ctx)).sort((a, b) => a.score - b.score);
  return scored;
}

function summaryLine(citySlug, scored) {
  const prune = scored.filter((r) => r.action === "prune").length;
  const retag = scored.filter((r) => r.action.startsWith("retag:")).length;
  const flagged = scored.filter((r) => r.action).length;
  return `${citySlug.padEnd(14)} ${String(scored.length).padStart(5)} spots — ${String(prune).padStart(4)} prune, ${String(retag).padStart(4)} retag  (${flagged} flagged)`;
}

// --- CLI ---------------------------------------------------------------------
if (require.main === module) {
  const args = process.argv.slice(2);
  const model = M.loadModel();
  Q.load();
  const allSpots = JSON.parse(fs.readFileSync(SPOTS, "utf8"));

  if (args.includes("--all")) {
    for (const c of model.cities) {
      if (!allSpots.some((s) => s.city === c.id)) continue;
      console.log(summaryLine(c.id, auditCity(c.id, allSpots, model)));
    }
    process.exit(0);
  }

  const citySlug = args.find((a) => !a.startsWith("--"));
  if (!citySlug) {
    console.error("usage: node tools/audit-city.js <city> [--limit N] [--apply]   |   --all");
    process.exit(1);
  }

  if (args.includes("--apply")) {
    const file = path.join(OUTDIR, `audit-${citySlug}.json`);
    if (!fs.existsSync(file)) { console.error(`no proposal at ${file} — run the audit first.`); process.exit(1); }
    const proposal = JSON.parse(fs.readFileSync(file, "utf8"));
    const byId = new Map(proposal.map((r) => [r.id, r]));
    let pruned = 0, retagged = 0;
    const kept = [];
    for (const s of allSpots) {
      const r = byId.get(s.id);
      if (r && r.action === "prune" && !Q.isAuthored(s.id) && !Q.isNotable(s.id)) { pruned++; continue; }
      if (r && r.action && r.action.startsWith("retag:")) {
        const dest = r.action.slice(6);
        if (model.cityById.has(dest) && !Q.isAuthored(s.id)) { s.city = dest; retagged++; }
      }
      kept.push(s);
    }
    fs.writeFileSync(SPOTS, JSON.stringify(kept, null, 1) + "\n");
    console.log(`applied: ${pruned} pruned, ${retagged} retagged → data/spots.json now ${kept.length} spots.`);
    console.log(`next: bump build.js BASELINE.entries to ${kept.length} (if pruned), then npm run build.`);
    process.exit(0);
  }

  const scored = auditCity(citySlug, allSpots, model);
  const limit = args.includes("--limit") ? +args[args.indexOf("--limit") + 1] : 40;
  console.log(summaryLine(citySlug, scored), "\n");
  console.log("worst-scored (action shown only for unprotected spots):");
  for (const r of scored.slice(0, limit)) {
    const tag = r.action ? `  ⟶ ${r.action}` : "";
    console.log(`  ${String(r.score).padStart(4)}  ${r.n.slice(0, 38).padEnd(38)} [${r.c}]  ${r.rules.join(",")}${tag}`);
  }
  if (!fs.existsSync(OUTDIR)) fs.mkdirSync(OUTDIR, { recursive: true });
  const file = path.join(OUTDIR, `audit-${citySlug}.json`);
  fs.writeFileSync(file, JSON.stringify(scored.filter((r) => r.action || r.score < 20), null, 1) + "\n");
  console.log(`\nwrote proposal → ${path.relative(ROOT, file)} (flagged/low-scored rows). Edit 'action', then --apply.`);
}

module.exports = { auditCity, scoreSpot };
