#!/usr/bin/env node
"use strict";
/* One-off: harvest notable European STADIUMS from Wikidata, map each to an
   existing Ci city by point-in-bbox, fetch Wikipedia extracts, and write
   per-city dossier files (research/dossiers/stadium-<city>.json) for a
   stadium-focused composer. ZERO LLM. Reuses the harvest.js fetch/extract shape. */
const fs = require("fs"), path = require("path");
const M = require("./model.js");
const UA = "FlaneurHarvest/1.0 (map-2 catalogue research; contact via repo)";
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ROOT = path.join(__dirname, "..");
const EXTRACT_CACHE = path.join(ROOT, "research/.extract-cache.json");

async function sparql(query) {
  const url = "https://query.wikidata.org/sparql?format=json&query=" + encodeURIComponent(query);
  for (let a = 0; a < 4; a++) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/sparql-results+json" } });
      if (r.ok) return (await r.json()).results.bindings;
      if (r.status === 429 || r.status === 503 || r.status === 500) { await sleep(2000 * (a + 1)); continue; }
      throw new Error("SPARQL HTTP " + r.status);
    } catch (e) { if (a === 3) throw e; await sleep(2000 * (a + 1)); }
  }
  return [];
}

// Europe bbox stadium query, ranked by sitelinks.
function stadiumQuery(minSitelinks) {
  return `SELECT ?item ?itemLabel ?lat ?lng ?sitelinks ?cap ?article WHERE {
  VALUES ?type { wd:Q483110 wd:Q1154710 wd:Q641226 }
  ?item wdt:P31 ?type ; wikibase:sitelinks ?sitelinks . FILTER(?sitelinks >= ${minSitelinks})
  ?item p:P625/psv:P625 ?cn . ?cn wikibase:geoLatitude ?lat ; wikibase:geoLongitude ?lng .
  FILTER(?lat > 34 && ?lat < 62 && ?lng > -11 && ?lng < 33)
  ?article schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> .
  OPTIONAL { ?item wdt:P1083 ?cap . }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en" . ?item rdfs:label ?itemLabel . }
} ORDER BY DESC(?sitelinks) LIMIT 900`;
}

let _cache = null;
const cacheLoad = () => { if (_cache) return _cache; try { _cache = JSON.parse(fs.readFileSync(EXTRACT_CACHE, "utf8")); } catch { _cache = {}; } return _cache; };
const cacheSave = () => { try { fs.writeFileSync(EXTRACT_CACHE, JSON.stringify(_cache)); } catch {} };
async function extractFor(article) {
  const cache = cacheLoad();
  if (article && cache[article] && cache[article].extract) return cache[article];
  const title = encodeURIComponent(article.replace(/ /g, "_"));
  const url = `https://en.wikipedia.org/w/api.php?action=query&format=json&prop=extracts&exintro=1&explaintext=1&redirects=1&titles=${title}`;
  for (let a = 0; a < 4; a++) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": UA } });
      if (r.status === 429 || r.status === 503) { await sleep(1600 * (a + 1)); continue; }
      if (r.ok) {
        const pages = (await r.json())?.query?.pages || {};
        const p = Object.values(pages)[0] || {};
        const extract = (p.extract || "").replace(/\s+/g, " ").trim();
        if (extract) { const v = { extract, description: p.description || "" }; cache[article] = v; cacheSave(); return v; }
        return null;
      }
    } catch {}
    await sleep(500 * (a + 1));
  }
  return null;
}
async function mapLimit(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length || 1) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

(async () => {
  const minSit = +(process.argv[2] || 12);
  const model = M.loadModel();
  const cities = [...model.cityById.values()].filter(c => c.bbox);
  const inBbox = (lat, lng, b) => lng >= b[0] && lng <= b[2] && lat >= b[1] && lat <= b[3];

  console.error(`SPARQL: European stadiums with >= ${minSit} sitelinks...`);
  const rows = await sparql(stadiumQuery(minSit));
  console.error(`  ${rows.length} stadiums returned`);

  // dedupe by QID, map to first containing city
  const byId = new Map();
  for (const b of rows) {
    const qid = b.item.value.split("/").pop();
    if (byId.has(qid)) continue;
    const lat = +(+b.lat.value).toFixed(5), lng = +(+b.lng.value).toFixed(5);
    const city = cities.find(c => inBbox(lat, lng, c.bbox));
    if (!city) continue; // not in any catalogue city
    byId.set(qid, {
      qid, n: b.itemLabel.value, lat, lng,
      article: decodeURIComponent((b.article.value.split("/wiki/")[1] || "")).replace(/_/g, " "),
      sitelinks: +b.sitelinks.value, cap: b.cap ? +b.cap.value : null,
      city: city.id,
    });
  }
  const stadiums = [...byId.values()];
  // group by city
  const byCity = {};
  for (const s of stadiums) (byCity[s.city] ||= []).push(s);
  console.error(`  mapped to ${Object.keys(byCity).length} catalogue cities; ${stadiums.length} stadiums total`);

  // dossiers (extracts) for all, 4-wide
  console.error("Fetching Wikipedia extracts...");
  const dos = await mapLimit(stadiums, 4, s => extractFor(s.article));
  stadiums.forEach((s, i) => { s.extract = (dos[i]?.extract || "").slice(0, 1500); s.description = dos[i]?.description || ""; });

  // write per-city dossier files (only cities with >=1 stadium that has an extract)
  const outdir = path.join(ROOT, "research/dossiers");
  fs.mkdirSync(outdir, { recursive: true });
  const summary = {};
  for (const [cityId, arr] of Object.entries(byCity)) {
    const withExtract = arr.filter(s => s.extract && s.extract.length > 60)
      .sort((a, b) => b.sitelinks - a.sitelinks);
    if (!withExtract.length) continue;
    fs.writeFileSync(path.join(outdir, `stadium-${cityId}.json`), JSON.stringify(withExtract, null, 1));
    summary[cityId] = withExtract.length;
  }
  fs.writeFileSync(path.join(ROOT, "research/stadium-cities.json"), JSON.stringify(summary, null, 1));
  const total = Object.values(summary).reduce((a, b) => a + b, 0);
  console.error(`\nwrote ${Object.keys(summary).length} city dossier files, ${total} stadiums with extracts`);
  console.error(JSON.stringify(summary));
})();
