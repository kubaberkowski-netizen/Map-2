#!/usr/bin/env node
"use strict";
/*
 * tools/blueprint.js — measure a city against the London blueprint (Track B).
 *
 * London is the gold standard: ~970 spots, ~73% authored, dense category and
 * "Worlds" coverage. Every other city is 1–19% authored and patchy. This tool
 * quantifies the gap so expansion is TARGETED — it tells each downstream stage
 * what to go find, instead of dredging everything.
 *
 * For a target city it reports:
 *   - writeup deficit: authored vs stub vs notable-but-weak (prime writeup pool)
 *   - density gap: spots per km² vs London's
 *   - category coverage gap: London's category MIX, scaled to the city's size,
 *     vs what the city actually has → which categories are missing/underweight
 *
 * Usage:
 *   node tools/blueprint.js                 # league table: all cities vs London
 *   node tools/blueprint.js rome            # full gap report for one city
 *   node tools/blueprint.js rome --ref paris
 */
const fs = require("fs");
const path = require("path");
const M = require("./model");
const Q = require("./quality");

const ROOT = path.join(__dirname, "..");
const SPOTS = path.join(ROOT, "data", "spots.json");
const REF_DEFAULT = "london";

function bboxAreaKm2(city) {
  const b = city.bbox; // [minLng,minLat,maxLng,maxLat]
  const w = M.haversineM(b[1], b[0], b[1], b[2]); // along bottom edge
  const h = M.haversineM(b[1], b[0], b[3], b[0]); // along left edge
  return (w / 1000) * (h / 1000);
}

function profile(citySlug, allSpots, model) {
  const city = model.cityById.get(citySlug);
  const spots = allSpots.filter((s) => s.city === citySlug);
  const cats = {};
  let authored = 0, notableWeak = 0;
  for (const s of spots) {
    cats[s.c] = (cats[s.c] || 0) + 1;
    if (Q.isAuthored(s.id)) authored++;
    else if (Q.isNotable(s.id)) notableWeak++;
  }
  const areaKm2 = city && city.bbox ? bboxAreaKm2(city) : null;
  return {
    slug: citySlug, name: city ? city.name : citySlug,
    total: spots.length, authored, notableWeak,
    pctAuthored: spots.length ? authored / spots.length : 0,
    areaKm2, density: areaKm2 ? spots.length / areaKm2 : null,
    cats,
  };
}

function gapReport(target, ref) {
  // London's category mix as fractions, scaled to the target's spot count.
  const refTotal = ref.total || 1;
  const rows = [];
  const allCats = new Set([...Object.keys(ref.cats), ...Object.keys(target.cats)]);
  for (const c of allCats) {
    const refShare = (ref.cats[c] || 0) / refTotal;
    const expected = Math.round(refShare * target.total);
    const actual = target.cats[c] || 0;
    rows.push({ c, refN: ref.cats[c] || 0, expected, actual, gap: expected - actual });
  }
  rows.sort((a, b) => b.gap - a.gap);
  return rows;
}

function pct(x) { return (100 * x).toFixed(0) + "%"; }

// --- CLI ---------------------------------------------------------------------
if (require.main === module) {
  const args = process.argv.slice(2);
  const model = M.loadModel();
  Q.load();
  const allSpots = JSON.parse(fs.readFileSync(SPOTS, "utf8"));
  const refSlug = args.includes("--ref") ? args[args.indexOf("--ref") + 1] : REF_DEFAULT;
  const ref = profile(refSlug, allSpots, model);
  const target = args.find((a) => !a.startsWith("--"));

  if (!target) {
    // league table vs the reference
    const cities = model.cities.filter((c) => allSpots.some((s) => s.city === c.id));
    const profiles = cities.map((c) => profile(c.id, allSpots, model))
      .sort((a, b) => a.pctAuthored - b.pctAuthored);
    console.log(`league table vs ${ref.name} (ref: ${ref.total} spots, ${pct(ref.pctAuthored)} authored, ${ref.density ? ref.density.toFixed(1) : "—"}/km²)\n`);
    console.log("city            total  %auth  notable-weak  /km²   gap-to-ref-density");
    for (const p of profiles) {
      const gapDens = ref.density && p.density != null ? (ref.density - p.density) : null;
      console.log(
        p.slug.padEnd(14),
        String(p.total).padStart(6),
        pct(p.pctAuthored).padStart(6),
        String(p.notableWeak).padStart(13),
        (p.density != null ? p.density.toFixed(1) : "—").padStart(6),
        (gapDens != null ? (gapDens > 0 ? "+" : "") + gapDens.toFixed(1) : "—").padStart(10)
      );
    }
    process.exit(0);
  }

  // full gap report for one city
  const t = profile(target, allSpots, model);
  console.log(`# Blueprint gap report — ${t.name} vs ${ref.name}\n`);
  console.log(`spots:            ${t.total}   (${ref.name}: ${ref.total})`);
  console.log(`authored:         ${t.authored} (${pct(t.pctAuthored)})   (${ref.name}: ${pct(ref.pctAuthored)})`);
  console.log(`notable-but-weak: ${t.notableWeak}   ← prime writeup pool (notable backing, still a stub)`);
  if (t.density != null && ref.density != null) {
    console.log(`density:          ${t.density.toFixed(1)}/km²   (${ref.name}: ${ref.density.toFixed(1)}/km²)`);
    const room = Math.round((ref.density - t.density) * (t.areaKm2 || 0));
    if (room > 0) console.log(`                  → ~${room} more spots would match ${ref.name}'s density`);
  }

  console.log(`\n## Category coverage gap (${ref.name}'s mix scaled to ${t.total} spots)\n`);
  console.log("category        ref    expected  actual   gap");
  for (const r of gapReport(t, ref)) {
    if (r.gap <= 0 && r.actual >= r.expected) continue; // only show under-served
    if (r.expected < 1 && r.actual === 0) continue;
    console.log(
      r.c.padEnd(14),
      String(r.refN).padStart(5),
      String(r.expected).padStart(9),
      String(r.actual).padStart(7),
      (r.gap > 0 ? "+" + r.gap : String(r.gap)).padStart(6)
    );
  }
  console.log(`\ndownstream: feed the top category gaps to find-spots.js (sourcing) and the`);
  console.log(`${t.notableWeak} notable-but-weak spots to the writeup stage first.`);
}

module.exports = { profile, gapReport, bboxAreaKm2 };
