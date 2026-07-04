#!/usr/bin/env node
"use strict";
/* Task BB/BC engine: geocode (Nominatim) -> bbox -> dedup(catalogue) -> traps -> classify.
   Deterministic. LLM coordinates are never used. Outputs:
     research/new/london-seeds.json  (NEW importable rows, add-spots schema)
     seeds/triage-report.md          (human triage)
     seeds/triage.json               (full machine record)
*/
const fs = require("fs"), path = require("path"), https = require("https");
const ROOT = path.join(__dirname, "..");
const UA = "FlaneurHarvest/1.0 (map-2 catalogue research; contact via repo)";
const BBOX = [-0.55, 51.26, 0.32, 51.72]; // london [W,S,E,N]
const CACHE = path.join(__dirname, "geocode-cache.json");

const cache = fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE, "utf8")) : {};
const sleep = ms => new Promise(r => setTimeout(r, ms));

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": UA } }, res => {
      let d = ""; res.on("data", c => d += c); res.on("end", () => resolve(d));
    }).on("error", reject);
  });
}
const VB = "-0.55,51.72,0.32,51.26"; // london viewbox (W,N,E,S)
async function nomQuery(q) {
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&bounded=1&viewbox=${VB}&addressdetails=0&q=${encodeURIComponent(q)}`;
  for (let a = 0; a < 3; a++) {
    try { const j = JSON.parse(await get(url)); await sleep(1100); return Array.isArray(j) ? j : []; }
    catch (e) { await sleep(1500); }
  }
  await sleep(1100); return [];
}
function pickByArea(results, area) {
  if (!results.length) return null;
  if (area) {
    const at = toks(area);
    const hit = results.find(r => { const d = (r.display_name || "").toLowerCase(); return [...at].some(t => d.includes(t)); });
    if (hit) return hit;
  }
  return results[0];
}
async function geocode(name, area) {
  const key = name + "|" + area;
  if (cache[key] && !cache[key].none) return cache[key];       // keep good hits
  // fallback ladder, all viewbox-bounded to London; area used to rank branches
  const ladder = [ [name, area].filter(Boolean).join(", "), name + " London", name ];
  let results = [], usedQ = "";
  for (const q of ladder) {
    results = await nomQuery(q); usedQ = q;
    if (results.length) break;
  }
  let out;
  if (!results.length) out = { none: true };
  else {
    const r = pickByArea(results, area);
    const others = results.filter(x => x !== r);
    out = { lat: +r.lat, lng: +r.lon, type: r.type, cls: r.category || r.class,
            importance: r.importance, n_results: results.length, query: usedQ,
            ambig_m: others.length ? Math.round(haversine(+r.lat, +r.lon, +others[0].lat, +others[0].lon)) : 0,
            display: (r.display_name || "").slice(0, 80) };
  }
  cache[key] = out;
  fs.writeFileSync(CACHE, JSON.stringify(cache));
  return out;
}
function haversine(a, b, c, d) {
  const R = 6371000, r = Math.PI / 180;
  const dLat = (c - a) * r, dLng = (d - b) * r;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
const STOP = new Set("the a an of and & at on in to london cafe caf restaurant bar shop store the co ltd son sons house market st".split(" "));
function toks(s) {
  return new Set(String(s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(w => w && !STOP.has(w)));
}
function nameSim(a, b) {
  const A = toks(a), B = toks(b); if (!A.size || !B.size) return 0;
  let inter = 0; for (const t of A) if (B.has(t)) inter++;
  return inter / Math.min(A.size, B.size); // subset-friendly
}

// catalogue london index
const Z = JSON.parse(fs.readFileSync(path.join(ROOT, "data/spots.json"), "utf8"));
const LON = Z.filter(z => z.city === "london").map(z => ({ n: z.n, lat: z.lat, lng: z.lng, id: z.id, c: z.c }));
const takenIds = new Set(Z.map(z => z.id));

function slugId(name) {
  let base = String(name).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "spot";
  let id = base, i = 2; while (takenIds.has(id)) id = base + "-" + i++;
  takenIds.add(id); return id;
}
function dedupeHit(name, lat, lng) {
  let best = null;
  for (const s of LON) {
    const sim = nameSim(name, s.n);
    const dist = (lat != null) ? haversine(lat, lng, s.lat, s.lng) : 9e9;
    if (sim >= 0.6 || (dist <= 75 && sim >= 0.34)) {
      if (!best || sim > best.sim) best = { id: s.id, n: s.n, c: s.c, sim: +sim.toFixed(2), dist: Math.round(dist) };
    }
  }
  return best;
}
function inBbox(lat, lng) { return lng >= BBOX[0] && lng <= BBOX[2] && lat >= BBOX[1] && lat <= BBOX[3]; }
function normDrop(name) { return name.toLowerCase().replace(/[^a-z0-9]/g, ""); }

(async () => {
  const seeds = [];
  for (const f of ["london-food.json", "london-culture.json"]) {
    const p = path.join(__dirname, f);
    if (!fs.existsSync(p)) { console.error("MISSING " + f); continue; }
    const arr = JSON.parse(fs.readFileSync(p, "utf8"));
    arr.forEach(s => seeds.push({ ...s, src: f.includes("food") ? "food" : "culture" }));
  }
  const dna = [];
  for (const f of ["london-food.donotadd.json", "london-culture.donotadd.json"]) {
    const p = path.join(__dirname, f);
    if (fs.existsSync(p)) JSON.parse(fs.readFileSync(p, "utf8")).forEach(n => dna.push(normDrop(n)));
  }
  const dnaSet = new Set(dna);

  const buckets = { NEW: [], DEDUPE: [], MARKET_HOLD: [], UNRESOLVED: [], TRAP: [], AMBIGUOUS: [] };
  const importable = [];

  for (const s of seeds) {
    // trap / do-not-add
    if (s.kind === "trap" || dnaSet.has(normDrop(s.n))) { buckets.TRAP.push({ ...s }); continue; }
    // market has no category slug yet -> quarantine for owner decision
    if (s.cat === "MARKET_HOLD" || s.cat === "market") {
      const g = await geocode(s.n, s.area);
      buckets.MARKET_HOLD.push({ ...s, geo: g }); continue;
    }
    const g = await geocode(s.n, s.area);
    if (!g || g.none || !Number.isFinite(g.lat)) { buckets.UNRESOLVED.push({ ...s, geo: g || null }); continue; }
    if (!inBbox(g.lat, g.lng)) { buckets.UNRESOLVED.push({ ...s, geo: g, why: "outside-bbox" }); continue; }
    const dup = dedupeHit(s.n, g.lat, g.lng);
    if (dup) { buckets.DEDUPE.push({ ...s, geo: g, existing: dup }); continue; }
    if (g.ambig_m > 400) { buckets.AMBIGUOUS.push({ ...s, geo: g }); continue; } // two far-apart matches
    // NEW importable
    const cat = s.kind === "site-of" ? "history" : s.cat;
    const row = {
      n: s.n, a: s.area || "", c: cat,
      lat: +g.lat.toFixed(5), lng: +g.lng.toFixed(5),
      w: (s.hook || "").trim(),                 // owner's own hook -> provisional draft prose (their voice)
      s: (s.hook || "").split(/[;.]/)[0].trim().slice(0, 60),
      _facts: [], _sources: [],
      confidence: s.verify ? "thin" : "medium"
    };
    importable.push(row);
    buckets.NEW.push({ ...s, geo: g, cat, id_preview: slugId(s.n) });
  }

  fs.mkdirSync(path.join(ROOT, "research/new"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, "research/new/london-seeds.json"), JSON.stringify(importable, null, 1) + "\n");
  fs.writeFileSync(path.join(__dirname, "triage.json"), JSON.stringify(buckets, null, 1));

  const R = [];
  R.push("# Task BB/BC triage — London food + culture seeds\n");
  R.push(`Parsed ${seeds.length} leads. Geocoded via Nominatim; deduped vs ${LON.length} London spots (name>=0.6 or <=75m).\n`);
  R.push(`| bucket | count | meaning |`);
  R.push(`|---|---|---|`);
  R.push(`| NEW | ${buckets.NEW.length} | geocoded, in-bbox, not a duplicate -> importable as drafts |`);
  R.push(`| DEDUPE | ${buckets.DEDUPE.length} | already in catalogue -> enrichment (cross-link tags, NOT auto-applied) |`);
  R.push(`| MARKET_HOLD | ${buckets.MARKET_HOLD.length} | needs a new 'market' category slug (owner decision) |`);
  R.push(`| AMBIGUOUS | ${buckets.AMBIGUOUS.length} | geocoder returned far-apart matches -> owner triage |`);
  R.push(`| UNRESOLVED | ${buckets.UNRESOLVED.length} | no geocode / outside bbox -> quarantine |`);
  R.push(`| TRAP | ${buckets.TRAP.length} | do-not-add / closed -> dropped, never imported |\n`);
  const line = s => `- **${s.n}** (${s.area || "?"}) [${s.cat}${s.verify ? ", verify" : ""}] ${s.geo ? "" : ""}`;
  R.push(`## NEW — importable drafts (${buckets.NEW.length})`);
  buckets.NEW.forEach(s => R.push(`- **${s.n}** — ${s.area} — \`${s.cat}\` — ${s.geo.lat.toFixed(4)},${s.geo.lng.toFixed(4)}${s.verify ? " _[verify]_" : ""}`));
  R.push(`\n## DEDUPE — enrichment candidates (${buckets.DEDUPE.length})`);
  buckets.DEDUPE.forEach(s => R.push(`- **${s.n}** ~ existing \`${s.existing.id}\` ("${s.existing.n}", sim ${s.existing.sim}, ${s.existing.dist}m) -> suggest tags: ${s.tags.join(", ")}`));
  R.push(`\n## MARKET_HOLD — need 'market' category (${buckets.MARKET_HOLD.length})`);
  buckets.MARKET_HOLD.forEach(s => R.push(`- **${s.n}** — ${s.area}${s.geo && s.geo.lat ? ` (${s.geo.lat.toFixed(4)},${s.geo.lng.toFixed(4)})` : ""}`));
  R.push(`\n## AMBIGUOUS (${buckets.AMBIGUOUS.length})`);
  buckets.AMBIGUOUS.forEach(s => R.push(`- **${s.n}** — ${s.area} — geocoder split ${s.geo.ambig_m}m: ${s.geo.display}`));
  R.push(`\n## UNRESOLVED (${buckets.UNRESOLVED.length})`);
  buckets.UNRESOLVED.forEach(s => R.push(`- **${s.n}** — ${s.area} — ${s.why || "no geocode"}`));
  R.push(`\n## TRAP — dropped (${buckets.TRAP.length})`);
  buckets.TRAP.forEach(s => R.push(`- ${s.n}`));
  fs.writeFileSync(path.join(__dirname, "triage-report.md"), R.join("\n") + "\n");

  console.log(JSON.stringify(Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, v.length])), null, 0));
  console.log("importable rows:", importable.length, "-> research/new/london-seeds.json");
})();
