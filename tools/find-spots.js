#!/usr/bin/env node
"use strict";
/*
 * tools/find-spots.js — the candidate-finder CLI.
 *
 * Pipeline:  gather → enrich (geocode) → assign city → guess category →
 *            validate (build.js rules) → dedupe (against data/spots.json) →
 *            write tools/candidates/<city>.json
 *
 * Every emitted row is in the EXACT spots.json schema, with:
 *   - w  ALWAYS ""   (the writeup is yours to write — the tool never invents it)
 *   - c  a valid slug if confidently guessed, else "" with _meta.needs:["c"]
 *   - _meta {source,url,confidence,needs}  — provenance; strip it before pasting
 *     (or use `node tools/find-spots.js --emit <city>` to print paste-ready rows)
 *
 * Nothing here mutates data/spots.json. You review candidates/<city>.json, fill
 * the blanks, paste the good ones in, then `npm run build`.
 *
 * Examples:
 *   node tools/find-spots.js --city london   --source overpass --limit 150
 *   node tools/find-spots.js --city paris    --source wikidata
 *   node tools/find-spots.js --city london   --source reddit --sub london --query "hidden OR underrated OR secret"
 *   node tools/find-spots.js --city glasgow  --source pullpush --sub glasgow --query "weird OR oddity"
 *   node tools/find-spots.js --emit london          # print paste-ready rows (no _meta, c+w filled-in only)
 */

const fs = require("fs");
const path = require("path");
const M = require("./model");
const S = require("./sources");
const { guessCategory } = require("./category-map");

const OUTDIR = path.join(__dirname, "candidates");

function parseArgs(argv) {
  const a = { source: "overpass", limit: 150, sort: "relevance" };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--emit") { a.emit = argv[++i]; continue; }
    if (k.startsWith("--")) a[k.slice(2)] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
  }
  if (a.limit) a.limit = +a.limit;
  return a;
}

function shortHook(s) {
  // a placeholder s (short hook) from a source description; lower-cased, trimmed.
  // The owner will usually rewrite this — it just stops the field being empty.
  if (!s) return "";
  return String(s).replace(/\s+/g, " ").trim().replace(/^[A-Z]/, (m) => m.toLowerCase()).slice(0, 60);
}

function googleQuery(name, cityName) {
  return `${name} ${cityName}`.replace(/\s+/g, " ").trim();
}

// turn one raw source hit into a finished (or near-finished) candidate row
function toRow(hit, model, takenIds) {
  // need coordinates — geocode happens in the caller for text-only sources
  if (!Number.isFinite(hit.lat) || !Number.isFinite(hit.lng)) return null;
  const cityId = M.cityForPoint(hit.lat, hit.lng, model);
  if (!cityId) return null; // outside every city — drop
  const city = model.cityById.get(cityId);
  // honour a category already chosen by claudeExtract; else guess from OSM tags
  const cat =
    hit.c && model.categories.has(hit.c) ? hit.c : guessCategory(hit.tags, model.categories);
  const id = M.uniqueId(M.slugify(hit.n), takenIds);
  const needs = [];
  if (!cat) needs.push("c");
  needs.push("w"); // always — the writeup is authored by hand
  return {
    id,
    n: hit.n,
    a: hit.area || "",
    pc: hit.pc || "",
    lat: +(+hit.lat).toFixed(5),
    lng: +(+hit.lng).toFixed(5),
    c: cat || "",
    s: shortHook(hit.s || hit.hint || ""),
    q: googleQuery(hit.n, city.name),
    w: "", // NEVER auto-written
    city: cityId,
    _meta: { ...hit._meta, confidence: cat ? "category-guessed" : "needs-category", needs },
  };
}

async function gather(args, model) {
  const city = model.cityById.get(args.city);
  if (!city && !["reddit", "pullpush"].includes(args.source))
    throw new Error(`unknown --city "${args.city}". Known: ${model.cities.map((c) => c.id).join(", ")}`);

  if (args.source === "overpass") return S.overpass(city.bbox, { limit: args.limit });
  if (args.source === "wikidata") return S.wikidata(city.bbox, { limit: args.limit });

  if (args.source === "reddit" || args.source === "pullpush") {
    if (!args.sub || !args.query) throw new Error(`--source ${args.source} needs --sub and --query`);
    const fn = args.source === "reddit" ? S.reddit : S.pullpush;
    const posts = await fn(args.sub, args.query, { limit: args.limit, size: args.limit });

    // With ANTHROPIC_API_KEY set, turn the text into structured candidates that
    // flow through the normal geocode → validate → dedupe pipeline.
    if (process.env.ANTHROPIC_API_KEY) {
      if (!city) throw new Error(`--source ${args.source} with extraction needs a valid --city`);
      console.error(`  ${posts.length} ${args.source} post(s) → extracting places with Claude…`);
      const hits = await S.claudeExtract(posts, {
        cityName: city.name,
        categories: [...model.categories],
      });
      console.error(`  extracted ${hits.length} candidate place(s) (no coords yet — geocoding next)`);
      return hits;
    }

    // No key: hand back text leads for manual review (can't get coords from prose).
    console.error(
      `\n  ${posts.length} ${args.source} post(s) gathered. These are TEXT LEADS — ` +
        `no coordinates.\n  Set ANTHROPIC_API_KEY (+ \`npm install @anthropic-ai/sdk\`) to ` +
        `turn them into rows automatically, or skim them yourself:\n`
    );
    posts.slice(0, args.limit).forEach((p) =>
      console.error(`  • [${p._meta.score ?? "?"}] ${p._meta.title}\n    ${p._meta.url}`)
    );
    return [];
  }

  // keyed sources — will throw with setup instructions
  if (S[args.source]) return S[args.source]();
  throw new Error(`unknown --source "${args.source}"`);
}

// strip _meta + keep only rows whose c and w are filled — paste-ready
function emit(cityId) {
  const file = path.join(OUTDIR, `${cityId}.json`);
  if (!fs.existsSync(file)) throw new Error(`no candidates file for "${cityId}" (run a gather first)`);
  const rows = JSON.parse(fs.readFileSync(file, "utf8"));
  const ready = rows
    .filter((r) => r.c && String(r.w).trim() === "" /* w intentionally blank, c filled */)
    .map(({ _meta, ...r }) => r);
  const blocked = rows.length - ready.length;
  process.stdout.write(JSON.stringify(ready, null, 1) + "\n");
  if (blocked) console.error(`\n  (${blocked} row(s) still need a category — left out of this emit)`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const model = M.loadModel();

  if (args.emit) return emit(args.emit);

  const cat = M.loadCatalogue();
  const rawHits = await gather(args, model);

  // geocode any hits lacking coordinates (none today from the ready sources, but
  // future text/extracted hits arrive with a name only)
  const hits = [];
  for (const h of rawHits) {
    if (Number.isFinite(h.lat) && Number.isFinite(h.lng)) { hits.push(h); continue; }
    const cityName = model.cityById.get(args.city)?.name;
    const g = await S.geocode(h.n, cityName);
    if (g) hits.push({ ...h, ...g });
  }

  const takenIds = new Set(cat.ids); // avoid colliding with existing AND each other
  const rows = [];
  const stats = { dropped_no_city: 0, dup: 0, invalid: 0, kept: 0, need_cat: 0 };

  for (const h of hits) {
    const row = toRow(h, model, takenIds);
    if (!row) { stats.dropped_no_city++; continue; }

    const dup = M.findDuplicate(row, cat, { proximityM: 120 });
    if (dup) { stats.dup++; continue; }

    // validate ignoring the (intentionally) blank category — only block on the
    // hard rules build.js enforces that are already determinable
    const probe = { ...row, c: row.c || [...model.categories][0] }; // temp slug to test coords/keys
    const v = M.validateRow(probe, model);
    if (!v.ok) { stats.invalid++; continue; }

    if (!row.c) stats.need_cat++;
    rows.push(row);
    stats.kept++;
    // register so later hits dedupe against this one too
    cat.ids.add(row.id);
    cat.nameCity.add(row.city + "|" + M.norm(row.n));
    if (!cat.pointsByCity.has(row.city)) cat.pointsByCity.set(row.city, []);
    cat.pointsByCity.get(row.city).push(row);
  }

  if (rows.length) {
    fs.mkdirSync(OUTDIR, { recursive: true });
    const byCity = {};
    for (const r of rows) (byCity[r.city] = byCity[r.city] || []).push(r);
    for (const [cityId, list] of Object.entries(byCity)) {
      const file = path.join(OUTDIR, `${cityId}.json`);
      const existing = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : [];
      const haveIds = new Set(existing.map((r) => r.id));
      const merged = existing.concat(list.filter((r) => !haveIds.has(r.id)));
      fs.writeFileSync(file, JSON.stringify(merged, null, 1) + "\n");
      console.error(`  → wrote ${list.length} new candidate(s) to ${path.relative(path.join(__dirname, ".."), file)} (${merged.length} total)`);
    }
  }

  console.error(
    `\n  done: ${stats.kept} kept (${stats.need_cat} need a category), ` +
      `${stats.dup} dup, ${stats.dropped_no_city} outside any city, ${stats.invalid} invalid.`
  );
  if (stats.kept) {
    console.error(`\n  Next:`);
    console.error(`   1. open tools/candidates/<city>.json — fill each "c" (and a better "s"); leave "w" blank`);
    console.error(`   2. write the "w" writeups yourself, in your voice`);
    console.error(`   3. node tools/find-spots.js --emit <city>   # paste-ready rows → data/spots.json`);
    console.error(`   4. npm run build`);
  }
}

main().catch((e) => { console.error("✗ " + e.message); process.exit(1); });
