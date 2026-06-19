#!/usr/bin/env node
"use strict";
/*
 * tools/import-candidates.js — merge triaged candidate files into data/spots.json.
 *
 * For every tools/candidates/<city>.json it strips _meta, forces w:"" (writeups
 * stay the owner's), keeps only the schema keys, validates each row against the
 * SAME rules build.js enforces, de-duplicates against the existing catalogue AND
 * against rows already accepted in this run (by name-in-city and ~120 m
 * proximity), and re-mints any colliding id. Writes the merged array back to
 * data/spots.json. Run `npm run build` afterwards.
 *
 * Usage: node tools/import-candidates.js [--dry] [city ...]
 */
const fs = require("fs");
const path = require("path");
const M = require("./model");

const ROOT = path.join(__dirname, "..");
const OUTDIR = path.join(__dirname, "candidates");
const SPOTS = path.join(ROOT, "data", "spots.json");

const args = process.argv.slice(2);
const dry = args.includes("--dry");
const only = args.filter((a) => !a.startsWith("--"));

const model = M.loadModel();
const cat = M.loadCatalogue();           // {spots, ids, nameCity, pointsByCity}
const dupReason = (r) => {               // name/proximity dup only (NOT id — those get re-minted)
  if (cat.nameCity.has(r.city + "|" + M.norm(r.n))) return "name";
  for (const p of cat.pointsByCity.get(r.city) || []) {
    if (M.haversineM(r.lat, r.lng, p.lat, p.lng) < 120) return "proximity";
  }
  return null;
};
const register = (r) => {                // so later candidates dedup against this one too
  cat.ids.add(r.id);
  cat.nameCity.add(r.city + "|" + M.norm(r.n));
  if (!cat.pointsByCity.has(r.city)) cat.pointsByCity.set(r.city, []);
  cat.pointsByCity.get(r.city).push({ id: r.id, n: r.n, lat: r.lat, lng: r.lng });
};

const files = fs.readdirSync(OUTDIR).filter((f) => f.endsWith(".json") &&
  (!only.length || only.includes(f.replace(/\.json$/, ""))));

const accepted = [];
const stats = { rows: 0, added: 0, dupName: 0, dupProx: 0, invalid: 0, remintId: 0, noCat: 0 };

for (const f of files) {
  const rows = JSON.parse(fs.readFileSync(path.join(OUTDIR, f), "utf8"));
  for (const c of rows) {
    stats.rows++;
    if (!c.c || !model.categories.has(c.c)) { stats.noCat++; continue; } // untriaged → skip
    const row = {
      id: c.id, n: c.n, a: c.a || "", pc: c.pc || "",
      lat: c.lat, lng: c.lng, c: c.c, s: c.s || "",
      q: c.q || `${c.n}`, w: "", city: c.city,
    };
    const v = M.validateRow(row, model);
    if (!v.ok) { stats.invalid++; continue; }
    const why = dupReason(row);
    if (why === "name") { stats.dupName++; continue; }
    if (why === "proximity") { stats.dupProx++; continue; }
    const base = (c.id && /^[a-z0-9]+$/.test(c.id)) ? c.id : M.slugify(c.n);
    const id = M.uniqueId(base, cat.ids);   // re-mints on collision, adds to taken set
    if (id !== base) stats.remintId++;
    row.id = id;
    register(row);
    accepted.push(row);
    stats.added++;
  }
}

console.log(`scanned ${files.length} city files, ${stats.rows} candidate rows`);
console.log(`  + added:        ${stats.added}`);
console.log(`  - dup (name):   ${stats.dupName}`);
console.log(`  - dup (≤120m):  ${stats.dupProx}`);
console.log(`  - untriaged c:  ${stats.noCat}`);
console.log(`  - invalid:      ${stats.invalid}`);
console.log(`  · id re-minted: ${stats.remintId}`);

if (dry) { console.log("\n--dry: data/spots.json NOT written."); process.exit(0); }

const merged = cat.spots.concat(accepted);
fs.writeFileSync(SPOTS, JSON.stringify(merged, null, 1) + "\n");
console.log(`\nwrote data/spots.json — ${cat.spots.length} existing + ${accepted.length} new = ${merged.length} spots.`);
console.log("next: npm run build");
