#!/usr/bin/env node
"use strict";
/*
 * tools/add-spots.js — the "capture stuff not yet in the app" path (Track B).
 *
 * The writeup pipeline (dossier.js → write-up.js) only ever ENRICHES spots that
 * already exist. This tool brings in BRAND-NEW, write-up-worthy places a research
 * pass discovered — running them through the exact same gates build.js enforces
 * (valid category/city slug, finite in-bbox coords) and the same dedupe as the
 * candidate finder (id / name-in-city / ~120 m proximity), so nothing white-
 * screens the app and nothing duplicates an existing spot.
 *
 * Input: research/new/<city>.json — an array of discovered rows. Each needs:
 *   { n, a, c, lat, lng, w, [city], [pc], [q], [s], [_facts], [_sources], [confidence] }
 *   - c   : a valid category slug (one of the 44 in `ne`)
 *   - lat/lng inside the city's Ci bbox (±0.1°)
 *   - w   : the house-voice writeup (written by the Stage-4 writer; may be "")
 *   - city: defaults to the <city> arg
 *   _facts/_sources/confidence are provenance only — ignored in the emitted row.
 *
 * On apply it: assigns a unique id, fills `s`/`q` if missing, appends to
 * data/spots.json, BUMPS build.js BASELINE.entries by the number added, and marks
 * each new id "d" (draft pending review) in data/quality.json.
 *
 * Usage:
 *   node tools/add-spots.js edinburgh --dry             # validate + dedupe report, write nothing
 *   node tools/add-spots.js edinburgh                   # append the valid, non-duplicate rows
 *   node tools/add-spots.js edinburgh --proximity 40    # tighten the proximity dedupe (see below)
 *   # then: npm run build   (and review the new 'd' spots; quality.js --promote to approve)
 *
 * --proximity <m> (default 120): how close to an EXISTING spot counts as a likely
 * re-geocode duplicate. In dense historic centres (Old Town, etc.) 120 m wrongly
 * flags distinct neighbours, so after eyeballing the --dry report you can lower it.
 * The id-collision and same-name-in-city checks ALWAYS run and are not affected.
 */
const fs = require("fs");
const path = require("path");
const M = require("./model");
const Q = require("./quality");

const ROOT = path.join(__dirname, "..");
const SPOTS = path.join(ROOT, "data", "spots.json");
const BUILD = path.join(ROOT, "build.js");
const NEW_DIR = path.join(ROOT, "research", "new");

function bumpBaseline(delta) {
  const src = fs.readFileSync(BUILD, "utf8");
  const m = src.match(/BASELINE\s*=\s*\{\s*entries:\s*(\d+)/);
  if (!m) throw new Error("could not find BASELINE.entries in build.js");
  const next = parseInt(m[1], 10) + delta;
  fs.writeFileSync(BUILD, src.replace(/(BASELINE\s*=\s*\{\s*entries:\s*)\d+/, `$1${next}`));
  return next;
}

function main() {
  const args = process.argv.slice(2);
  const city = args.find((a) => !a.startsWith("--"));
  const dry = args.includes("--dry");
  const proximityM = args.includes("--proximity") ? +args[args.indexOf("--proximity") + 1] : 120;
  if (!city) { console.error("usage: node tools/add-spots.js <city> [--dry] [--proximity <m>]"); process.exit(1); }

  const file = path.join(NEW_DIR, `${city}.json`);
  if (!fs.existsSync(file)) { console.error(`no ${path.relative(ROOT, file)} — discovery stage writes this.`); process.exit(1); }

  const model = M.loadModel();
  if (!model.cityById.has(city)) { console.error(`unknown city "${city}"`); process.exit(1); }
  Q.load();
  const cat = M.loadCatalogue();          // ids / nameCity / pointsByCity dedupe indexes
  const taken = new Set(cat.ids);
  const cityName = model.cityById.get(city).name;

  const rows = JSON.parse(fs.readFileSync(file, "utf8"));
  const kept = [];
  const stats = { kept: 0, dup: 0, invalid: 0 };
  for (const r of rows) {
    const citySlug = r.city || city;
    const row = {
      id: M.uniqueId(M.slugify(r.n), taken),
      n: r.n, a: r.a || "", pc: r.pc || "",
      lat: Number.isFinite(r.lat) ? +(+r.lat).toFixed(5) : r.lat,
      lng: Number.isFinite(r.lng) ? +(+r.lng).toFixed(5) : r.lng,
      c: r.c, s: r.s || r.hook || "", q: r.q || `${r.n} ${cityName}`,
      w: r.w || "", city: citySlug,
    };
    const v = M.validateRow(row, model);
    if (!v.ok) { stats.invalid++; console.error(`  ✗ ${r.n}: ${v.errors.join("; ")}`); taken.delete(row.id); continue; }
    const dup = M.findDuplicate(row, cat, { proximityM });
    if (dup) { stats.dup++; console.error(`  ~ ${r.n}: duplicate — ${dup}`); taken.delete(row.id); continue; }
    // register so later rows in THIS batch dedupe against it too
    cat.ids.add(row.id);
    cat.nameCity.add(row.city + "|" + M.norm(row.n));
    if (!cat.pointsByCity.has(row.city)) cat.pointsByCity.set(row.city, []);
    cat.pointsByCity.get(row.city).push(row);
    kept.push(row);
    stats.kept++;
  }

  console.log(`\n${city}: ${stats.kept} valid & new, ${stats.dup} duplicate, ${stats.invalid} invalid (of ${rows.length}).`);
  if (dry) { console.log("--dry: nothing written."); return; }
  if (!kept.length) { console.log("nothing to add."); return; }

  const all = cat.spots.concat(kept);
  fs.writeFileSync(SPOTS, JSON.stringify(all, null, 1) + "\n");
  const newBaseline = bumpBaseline(kept.length);
  Q.setFlags(kept.map((r) => r.id), "d");
  console.log(`added ${kept.length} spot(s) → data/spots.json (now ${all.length}); bumped build.js BASELINE.entries to ${newBaseline}; flagged "d".`);
  console.log(`next: npm run build  (then review the new spots; quality.js --promote to approve).`);
  console.log(`also update the entry count in CLAUDE.md (currently states 15,302).`);
}

main();
