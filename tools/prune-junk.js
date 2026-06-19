#!/usr/bin/env node
"use strict";
/*
 * tools/prune-junk.js — remove obvious low-value imported spots.
 *
 * Only ever touches IMPORTED spots (ids NOT in /tmp/orig-ids.json — the 787
 * curated originals are always protected, even the ones with blank writeups).
 * Drops, by rule:
 *   generic   — the name is just a type-word ("War Memorial", "Cinema", "Statue")
 *   chainCine — chain multiplex (Odeon, Vue, Cineworld, Cinema City, …)
 *   chainWor  — generic chain place of worship (Kingdom Hall, Salvation Army, …)
 *   warMem    — war memorials / Kriegerdenkmal / cenotaph (obscure, repetitive)
 *   dupInCity — a normalised name already kept in the same city (keep first)
 *
 * Usage: node tools/prune-junk.js [--dry]
 */
const fs = require("fs");
const path = require("path");
const SPOTS = path.join(__dirname, "..", "data", "spots.json");
const dry = process.argv.includes("--dry");

const orig = new Set(JSON.parse(fs.readFileSync("/tmp/orig-ids.json", "utf8")));
const all = JSON.parse(fs.readFileSync(SPOTS, "utf8"));
const norm = (n) => String(n).toLowerCase().replace(/^the\s+/, "").replace(/[’']/g, "'").replace(/\s+/g, " ").trim();

const GENERIC = new Set([
  "war memorial", "memorial", "cinema", "sculpture", "statue", "fountain",
  "drinking fountain", "monument", "obelisk", "column", "pillar", "cross",
  "celtic cross", "cannon", "anchor", "lighthouse", "well", "milestone",
  "boundary stone", "coal tax post", "standing stone", "stone", "mural",
  "artwork", "public art", "gallery", "museum", "library", "church", "chapel",
  "mosque", "synagogue", "temple", "gurdwara", "cemetery", "graveyard",
  "sundial", "bandstand", "clock", "clock tower", "pump", "water pump",
  "horse trough", "trough", "bench", "plaque", "here", "untitled", "kit",
  "maypole", "war memorial.", "memorial cross", "memorial stone", "memorial fountain",
]);
const CHAIN_CINE = /^(odeon|vue|cineworld|cinema city|showcase|cineplex|omniplex|cinemark|amc|regal|path[ée]|ugc|kinepolis|cgv|megabox|lotte cinema|empire cinemas?|cin[ée]polis|caribbean cinemas|event cinemas|hoyts|reading cinemas|toho cinemas?|movie theater)\b/;
const CHAIN_WOR = /(kingdom hall|jehovah|salvation army|latter-day saints|church of god|church of christ|apostolisch|new apostolic|seventh[- ]day adventist|assemblies of god)/;
const WARMEM = /(war memorial|kriegerdenkmal|cenotaph|boer war|wwi memorial|wwii memorial|ww1 memorial|ww2 memorial|fallen soldiers)/;
// mundane non-attraction types — matched on the Wikidata blurb in `s` (the
// Overpass hooks never contain these words), so this only hits Wikidata noise.
const MUNDANE = /(railway station|train station|metro station|underground station|tram stop|bus station|bus stop|\bairport\b|aerodrome|heliport|\bairline\b|\bschool\b|elementary|high school|primary school|secondary school|kindergarten|\bcollege\b|\buniversity\b|\bhospital\b|\bclinic\b|healthcare|polyclinic|medical cent(re|er)|neighbo[u]?rhood|\bsuburb\b|municipality|local government|electoral|\bcensus\b|populated place|human settlement|\bvillage\b|\bhamlet\b|\blake\b|reservoir|\bshoal\b|fire station|police station|power station|substation|sewage|water treatment|energy company|telecommunications|\bcompany\b|corporation|\bstreet\b|\broad in\b)/;

const tally = { generic: 0, chainCine: 0, chainWor: 0, warMem: 0, mundane: 0, dupInCity: 0 };
const samples = {};
const seen = new Set(); // city|name kept so far (imports)
const kept = [];
const sample = (rule, n) => { (samples[rule] = samples[rule] || []); if (samples[rule].length < 8) samples[rule].push(n); };

for (const s of all) {
  if (orig.has(s.id)) { kept.push(s); continue; }   // protected original
  const nm = norm(s.n);
  let rule = null;
  if (!nm || GENERIC.has(nm)) rule = "generic";
  else if (CHAIN_CINE.test(nm)) rule = "chainCine";
  else if (CHAIN_WOR.test(nm)) rule = "chainWor";
  else if (WARMEM.test(nm)) rule = "warMem";
  // Wikidata junk (stations/schools/lakes/companies/streets…) landed in the
  // `oddity` fallback; match only the TYPE at the head of the blurb (before
  // " in "/" of "/comma) so legit names ("University Museum", "Street Mural")
  // and the location tail ("…in X Municipality") don't trip it.
  else if (s.c === "oddity" && MUNDANE.test((s.s || "").toLowerCase().split(/\s+in\s+|\s+of\s+|,/)[0])) rule = "mundane";
  else {
    const key = s.city + "|" + nm;
    if (seen.has(key)) rule = "dupInCity"; else seen.add(key);
  }
  if (rule) { tally[rule]++; sample(rule, s.n + " ["+s.city+"]"); continue; }
  kept.push(s);
}

const removed = all.length - kept.length;
console.log(`spots: ${all.length} → ${kept.length}  (removed ${removed}; originals protected: ${orig.size})`);
for (const [k, v] of Object.entries(tally)) {
  console.log(`  - ${k.padEnd(9)} ${v}`);
  (samples[k] || []).forEach((n) => console.log(`        e.g. ${n}`));
}
if (dry) { console.log("\n--dry: data/spots.json NOT written."); process.exit(0); }
fs.writeFileSync(SPOTS, JSON.stringify(kept, null, 1) + "\n");
console.log(`\nwrote data/spots.json — ${kept.length} spots. next: bump build.js BASELINE.entries + npm run build`);
