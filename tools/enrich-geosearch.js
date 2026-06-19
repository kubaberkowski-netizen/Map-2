#!/usr/bin/env node
"use strict";
/*
 * tools/enrich-geosearch.js — find a Wikipedia article for spots that were
 * never tagged with one, via Wikipedia GeoSearch (articles near the spot's
 * coordinates) + a STRICT name match, then use the intro as `w`. English only.
 * Catches notable spots OSM didn't link to Wikipedia. Grounded; the strict
 * match (name + proximity) avoids attributing a neighbour's article.
 *
 * Skips the 787 curated originals and anything already enriched; resumable.
 * Usage:  node tools/enrich-geosearch.js --dry [--city london] [--limit N]
 */
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const SPOTS = path.join(ROOT, "data", "spots.json");
const MANIFEST = path.join(__dirname, "geosearch-enriched.json");
const UA = { headers: { "User-Agent": "flaneur-research/1.0 (kuba.berkowski@gmail.com)" } };
const args = process.argv.slice(2);
const dry = args.includes("--dry");
const onlyCity = args.includes("--city") ? args[args.indexOf("--city") + 1] : null;
const limit = args.includes("--limit") ? +args[args.indexOf("--limit") + 1] : Infinity;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s) => String(s).toLowerCase().replace(/^the\s+/, "").replace(/[’']/g, "'").replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

const SKIP = new Set();
JSON.parse(fs.readFileSync("/tmp/orig787.json", "utf8")).forEach((id) => SKIP.add(id));
for (const m of ["wiki-enriched", "osm-enriched", "wikidata-enriched"])
  JSON.parse(fs.readFileSync(path.join(__dirname, m + ".json"), "utf8")).forEach((id) => SKIP.add(id));

async function api(url) {
  for (let a = 0; a < 4; a++) {
    try { const r = await fetch(url, UA); if (r.ok) return await r.json(); if (r.status < 500 && r.status !== 429) return null; }
    catch (_) {}
    await delay(1000 * (a + 1));
  }
  return null;
}

// is the article title a confident match for the spot name?
function titleMatches(spotName, title) {
  const n = norm(spotName), t = norm(title);
  if (n.length < 4) return false;                 // too generic to trust
  if (t === n) return true;
  if (t.startsWith(n + " ")) return true;          // "Dove" ⊂ "Dove, Hammersmith"
  if (n.startsWith(t + " ")) return true;
  // token overlap: every significant title token is in the name or vice-versa
  return false;
}

function summarise(extract) {
  let t = String(extract).replace(/\s+/g, " ").trim();
  t = t.replace(/\s*\([^)]*(?:[:：]|[Ͱ-ϿЀ-ӿ　-鿿가-힯ɐ-ʯʰ-˿])[^)]*\)/g, "").replace(/\s*\([^)]*(?:listen|IPA|ⓘ)[^)]*\)/gi, "");
  t = t.replace(/\s{2,}/g, " ").replace(/\s+([.,;])/g, "$1").trim();
  const sents = t.split(/(?<=[.!?])\s+(?=[A-Z0-9“"'])/);
  let out = ""; for (const s of sents) { if (!out) out = s; else if ((out + " " + s).length <= 300) out += " " + s; else break; }
  if (out.length > 360) out = out.slice(0, 357).replace(/\s+\S*$/, "") + "…";
  return out.trim();
}

(async () => {
  const spots = JSON.parse(fs.readFileSync(SPOTS, "utf8"));
  const enriched = fs.existsSync(MANIFEST) ? new Set(JSON.parse(fs.readFileSync(MANIFEST, "utf8"))) : new Set();
  let targets = spots.filter((s) => !SKIP.has(s.id) && !enriched.has(s.id) && Number.isFinite(s.lat) && Number.isFinite(s.lng) && (!onlyCity || s.city === onlyCity));
  if (Number.isFinite(limit)) targets = targets.slice(0, limit);
  console.error(`${targets.length} candidate spots to geosearch${onlyCity ? " in " + onlyCity : ""}.`);

  const matches = [];   // {spot, title}
  let n = 0;
  for (const s of targets) {
    n++;
    const j = await api(`https://en.wikipedia.org/w/api.php?action=query&format=json&list=geosearch&gscoord=${s.lat}|${s.lng}&gsradius=150&gslimit=10`);
    await delay(120);
    const hits = (j && j.query && j.query.geosearch) || [];
    const m = hits.find((h) => h.dist <= 150 && titleMatches(s.n, h.title));
    if (m) matches.push({ s, title: m.title });
    if (n % 200 === 0) process.stderr.write(`\r  geosearched ${n}/${targets.length}, matched ${matches.length}`);
  }
  process.stderr.write(`\r  geosearched ${n}/${targets.length}, matched ${matches.length}\n`);

  // fetch intros for matched titles (20/req)
  const titles = [...new Set(matches.map((m) => m.title))];
  const ex = new Map();
  for (let i = 0; i < titles.length; i += 20) {
    const j = await api(`https://en.wikipedia.org/w/api.php?action=query&format=json&prop=extracts&exintro&explaintext&redirects=1&titles=${titles.slice(i, i + 20).map(encodeURIComponent).join("|")}`);
    if (j && j.query) for (const k in j.query.pages) { const p = j.query.pages[k]; if (p.extract) ex.set(p.title, p.extract); }
    await delay(250);
  }
  // map requested title -> extract (handle redirects/normalisation roughly by exact title)
  let done = 0; const samples = [];
  for (const m of matches) {
    let e = ex.get(m.title);
    if (!e) { for (const [k, v] of ex) if (norm(k).startsWith(norm(m.title)) || norm(m.title).startsWith(norm(k))) { e = v; break; } }
    if (!e) continue;
    const w = summarise(e);
    if (w.length < 25) continue;
    if (samples.length < 20) samples.push(`[${m.s.city}] ${m.s.n} ← "${m.title}" — ${w}`);
    if (!dry) { m.s.w = w; enriched.add(m.s.id); }
    done++;
  }
  if (dry) { console.log("\n" + samples.join("\n\n")); console.error(`\n--dry: would enrich ${done} from Wikipedia geosearch. Nothing written.`); return; }
  fs.writeFileSync(SPOTS, JSON.stringify(spots, null, 1) + "\n");
  fs.writeFileSync(MANIFEST, JSON.stringify([...enriched], null, 0) + "\n");
  console.error(`\nenriched ${done} from geosearch. ${enriched.size} ids in ${path.relative(ROOT, MANIFEST)}. next: npm run build`);
})().catch((e) => { console.error("✗ " + e.message); process.exit(1); });
