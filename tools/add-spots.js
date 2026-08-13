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
 *   - c   : a valid category slug from the live `ne` registry
 *   - lat/lng inside the city's Ci bbox (±0.1°, or ±1.0° for regions)
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
 *   node tools/add-spots.js london --file research/run.json --key included --offset 0 --limit 25
 *                                                       # import a bounded wave from a dossier
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
  if (!city) { console.error("usage: node tools/add-spots.js <city> [--dry] [--proximity <m>] [--file <path> --key <array> --offset <n> --limit <n>]"); process.exit(1); }

  // default input research/new/<city>.json; --file <path> for a per-run provenance file
  const fileArg = args.includes("--file") ? args[args.indexOf("--file") + 1] : null;
  const file = fileArg ? path.resolve(ROOT, fileArg) : path.join(NEW_DIR, `${city}.json`);
  if (!fs.existsSync(file)) { console.error(`no ${path.relative(ROOT, file)} — discovery stage writes this.`); process.exit(1); }

  const keyArg = args.includes("--key") ? args[args.indexOf("--key") + 1] : null;
  const offset = args.includes("--offset") ? Number(args[args.indexOf("--offset") + 1]) : 0;
  const limit = args.includes("--limit") ? Number(args[args.indexOf("--limit") + 1]) : Infinity;
  if (!Number.isInteger(offset) || offset < 0) { console.error("--offset must be a non-negative integer"); process.exit(1); }
  if (!(limit === Infinity || (Number.isInteger(limit) && limit > 0))) { console.error("--limit must be a positive integer"); process.exit(1); }

  const model = M.loadModel();
  if (!model.cityById.has(city)) { console.error(`unknown city "${city}"`); process.exit(1); }
  Q.load();
  const cat = M.loadCatalogue();          // ids / nameCity / pointsByCity dedupe indexes
  const taken = new Set(cat.ids);
  const cityName = model.cityById.get(city).name;

  const payload = JSON.parse(fs.readFileSync(file, "utf8"));
  let sourceRows = payload;
  if (keyArg) sourceRows = payload && payload[keyArg];
  if (!Array.isArray(sourceRows)) {
    console.error(keyArg ? `key "${keyArg}" is not an array in ${path.relative(ROOT, file)}` : `${path.relative(ROOT, file)} must contain a JSON array (or use --key)`);
    process.exit(1);
  }
  const rows = sourceRows.slice(offset, limit === Infinity ? undefined : offset + limit);
  if (!rows.length) { console.error(`selected wave is empty (source ${sourceRows.length}, offset ${offset}, limit ${limit})`); process.exit(1); }
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

  const wave = offset || limit !== Infinity ? ` [source ${sourceRows.length}, offset ${offset}, limit ${limit}]` : "";
  console.log(`\n${city}${wave}: ${stats.kept} valid & new, ${stats.dup} duplicate, ${stats.invalid} invalid (of ${rows.length}).`);
  if (dry) { console.log("--dry: nothing written."); return; }
  if (!kept.length) { console.log("nothing to add."); return; }

  const all = cat.spots.concat(kept);
  fs.writeFileSync(SPOTS, JSON.stringify(all, null, 1) + "\n");
  const newBaseline = bumpBaseline(kept.length);
  Q.setFlags(kept.map((r) => r.id), "d");
  console.log(`added ${kept.length} spot(s) → data/spots.json (now ${all.length}); bumped build.js BASELINE.entries to ${newBaseline}; flagged "d".`);
  console.log(`next: npm run build  (then review the new spots; quality.js --promote to approve).`);
  console.log(`also update the catalogue entry count in CLAUDE.md.`);
}

main();
