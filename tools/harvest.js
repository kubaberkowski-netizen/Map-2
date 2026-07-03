#!/usr/bin/env node
"use strict";
/*
 * tools/harvest.js — LAYER 1 of the cheap pipeline: candidate discovery + ranking.
 *
 * ZERO LLM tokens. For a city, runs ONE Wikidata SPARQL query over the bbox for
 * notable geolocated items (things with an English Wikipedia article), attaches
 * the free ranking signals nobody uses — Wikipedia monthly PAGEVIEWS and Wikidata
 * SITELINK counts — dedupes against the live catalogue, scores each candidate
 * deterministically, and writes a ranked "candidate lake" to research/lake/<city>.json.
 *
 * This replaces the expensive pattern (an LLM agent web-searching per place to
 * decide what's worth including) with a free, deterministic ranking. The model
 * later only ever reads a dossier for the TOP candidates (Layers 2-3).
 *
 * Usage:
 *   node tools/harvest.js vienna            # harvest + rank Vienna
 *   node tools/harvest.js vienna --min 6    # raise the notability floor (fewer, stronger)
 */
const fs = require("fs");
const path = require("path");
const M = require("./model");

const UA = "FlaneurHarvest/1.0 (map-2 catalogue research; contact via repo)";
const LAKE = path.join(__dirname, "..", "research", "lake");

function argVal(flag, def) { const i = process.argv.indexOf(flag); return i >= 0 ? process.argv[i + 1] : def; }

function norm(s) { return String(s).toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]/g, ""); }
function haversine(a, b, c, d) {
  const R = 6371000, r = Math.PI / 180;
  const dLat = (c - a) * r, dLng = (d - b) * r;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

async function sparql(query) {
  const url = "https://query.wikidata.org/sparql?format=json&query=" + encodeURIComponent(query);
  const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/sparql-results+json" } });
  if (!r.ok) throw new Error("SPARQL HTTP " + r.status);
  return (await r.json()).results.bindings;
}

// A visitable PLACE reads as a place from its P31 type label. Keep anything whose
// type matches this; it catches buildings/parks/landmarks and drops events,
// empires, battles, treaties, airlines, organisations, people, languages, etc.
const PLACE_RE = /build|structure|museum|church|cathedral|basilica|chapel|synagogue|mosque|temple|shrine|palace|castle|tower|bridge|square|house|villa|theat|cinema|opera|station|cemeter|graveyard|garden|park|\bhall\b|gate|fountain|statue|monument|memorial|market|librar|galler|archive|universit|college|\bschool\b|hospital|prison|barrack|factory|brewer|mill|arena|stadium|pool|bath|lido|\bzoo\b|observator|lighthouse|pier|dock|canal|reservoir|lake|pond|\bhill\b|mountain|\bcave\b|ruin|\bsite\b|district|neighbo|quarter|street|avenue|boulevard|arcade|passage|courtyard|estate|mansion|manor|abbey|priory|convent|monaster|\btomb\b|mausoleum|column|\barch\b|\bwall\b|\bfort|citadel|bunker|works|exchange|\bbank\b|hotel|restaurant|cafe|\bbar\b|\bpub\b|\bshop|store|bakery|\bclub\b|venue|centre|center|institut|academ|conservator|greenhouse|aquarium|planetarium|winery|distiller|cellar|reserve|monument|plaza|promenade|embankment|island/i;

function boxQuery(bbox, minSitelinks) {
  const [wLng, sLat, eLng, nLat] = bbox;
  return `SELECT ?item ?itemLabel ?lat ?lng ?sitelinks ?article ?typeLabel WHERE {
  SERVICE wikibase:box {
    ?item wdt:P625 ?coord .
    bd:serviceParam wikibase:cornerWest "Point(${wLng} ${sLat})"^^geo:wktLiteral .
    bd:serviceParam wikibase:cornerEast "Point(${eLng} ${nLat})"^^geo:wktLiteral .
  }
  ?item wikibase:sitelinks ?sitelinks . FILTER(?sitelinks >= ${minSitelinks})
  ?article schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> .
  ?item p:P625/psv:P625 ?cn . ?cn wikibase:geoLatitude ?lat ; wikibase:geoLongitude ?lng .
  OPTIONAL { ?item wdt:P31 ?type . }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en" . ?item rdfs:label ?itemLabel . ?type rdfs:label ?typeLabel . }
} ORDER BY DESC(?sitelinks) LIMIT 1500`;
}

// A fixed, definitely-complete recent window (H2 2025). Relative popularity is
// stable year-on-year, so this is a robust ranking signal regardless of the
// container clock; we take the busiest single month as the readership proxy.
const PV_WINDOW = ["2025070100", "2026010100"];

async function pageviews(article) {
  const title = encodeURIComponent(article.replace(/ /g, "_"));
  const url = `https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia/all-access/all-agents/${title}/monthly/${PV_WINDOW[0]}/${PV_WINDOW[1]}`;
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA } });
    if (!r.ok) return 0;
    const j = await r.json();
    return Math.max(0, ...(j.items || []).map((i) => i.views || 0));
  } catch { return 0; }
}

async function mapLimit(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length || 1) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

// LAYER 2 — for a candidate, fetch+cache the Wikipedia intro extract (the clean,
// attributed fact bundle the writer reads instead of crawling the web). ~zero LLM.
async function dossierFor(cand) {
  const title = encodeURIComponent(cand.article.replace(/ /g, "_"));
  const url = `https://en.wikipedia.org/w/api.php?action=query&format=json&prop=extracts&exintro=1&explaintext=1&redirects=1&titles=${title}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": UA } });
      if (r.ok) {
        const pages = (await r.json())?.query?.pages || {};
        const p = Object.values(pages)[0] || {};
        const extract = (p.extract || "").replace(/\s+/g, " ").trim();
        if (extract) return { extract, description: p.description || "" };
      }
    } catch {}
    await new Promise((res) => setTimeout(res, 400 * (attempt + 1)));
  }
  return null;
}

async function main() {
  if (typeof fetch !== "function") throw new Error("global fetch unavailable — needs Node 18+");
  const city = process.argv[2];
  const minSitelinks = +argVal("--min", 4);
  if (!city || city.startsWith("--")) { console.error("usage: node tools/harvest.js <city> [--min 4]"); process.exit(1); }
  const model = M.loadModel();
  const c = model.cityById.get(city);
  if (!c) { console.error(`unknown city "${city}"`); process.exit(1); }

  const Z = require("../data/spots.json");
  const inCity = Z.filter((z) => z.city === city);
  const names = new Set(inCity.map((z) => norm(z.n)));

  console.error(`Layer 1 · harvesting ${c.name}  (bbox ${JSON.stringify(c.bbox)})  — ZERO LLM tokens`);
  const rows = await sparql(boxQuery(c.bbox, minSitelinks));
  console.error(`  SPARQL: ${rows.length} notable geolocated items (>= ${minSitelinks} sitelinks)`);

  // group rows by item (one item can have several P31 types → several rows)
  const byId = new Map();
  for (const b of rows) {
    const qid = b.item.value.split("/").pop();
    let x = byId.get(qid);
    if (!x) {
      x = {
        qid, n: b.itemLabel.value,
        lat: +(+b.lat.value).toFixed(5), lng: +(+b.lng.value).toFixed(5),
        sitelinks: +b.sitelinks.value,
        article: decodeURIComponent((b.article.value.split("/wiki/")[1] || "")).replace(/_/g, " "),
        types: [],
      };
      byId.set(qid, x);
    }
    if (b.typeLabel && b.typeLabel.value) x.types.push(b.typeLabel.value);
  }
  let cands = [...byId.values()].filter((x) => x.n && !/^Q\d+$/.test(x.n));
  const preType = cands.length;
  cands = cands.filter((x) => x.types.some((t) => PLACE_RE.test(t)));
  console.error(`  place-type filter: ${preType} → ${cands.length} (dropped events/orgs/people)`);

  const before = cands.length;
  cands = cands.filter((x) => !names.has(norm(x.n)) && !inCity.some((z) => haversine(x.lat, x.lng, z.lat, z.lng) < 120));
  console.error(`  dedupe vs the ${inCity.length} live ${city} spots: ${before} → ${cands.length} genuinely new`);

  console.error(`  pageviews for ${cands.length} candidates (busiest month, ${PV_WINDOW[0].slice(0, 6)}–${PV_WINDOW[1].slice(0, 6)})…`);
  const pv = await mapLimit(cands, 8, (x) => pageviews(x.article));
  cands.forEach((x, i) => (x.pageviews = pv[i]));

  cands.forEach((x) => {
    x.score = Math.round(Math.log10(1 + x.pageviews) * 40 + Math.log2(1 + x.sitelinks) * 10);
  });
  cands.sort((a, b) => b.score - a.score);

  fs.mkdirSync(LAKE, { recursive: true });
  const out = path.join(LAKE, city + ".json");
  fs.writeFileSync(out, JSON.stringify(cands, null, 1));
  console.error(`\n  → wrote ${cands.length} ranked candidates to ${path.relative(path.join(__dirname, ".."), out)}`);

  // Layer 2 — build dossiers for the top N (the only rows the composer will read)
  const topN = +argVal("--dossiers", 0);
  if (topN > 0) {
    const top = cands.slice(0, topN);
    console.error(`\n  Layer 2 · building dossiers (Wikipedia extracts) for top ${top.length}…`);
    const dos = await mapLimit(top, 4, (x) => dossierFor(x));
    const bundle = top.map((x, i) => ({
      qid: x.qid, n: x.n, lat: x.lat, lng: x.lng, article: x.article,
      pageviews: x.pageviews, sitelinks: x.sitelinks, types: x.types.slice(0, 4),
      description: dos[i]?.description || "", extract: (dos[i]?.extract || "").slice(0, 1500),
    })).filter((x) => x.extract.length > 80);
    const dpath = path.join(__dirname, "..", "research", "dossiers", city + ".json");
    fs.mkdirSync(path.dirname(dpath), { recursive: true });
    fs.writeFileSync(dpath, JSON.stringify(bundle, null, 1));
    const toks = Math.round(bundle.reduce((s, x) => s + x.extract.length, 0) / 4 / 1000);
    console.error(`  → wrote ${bundle.length} dossiers to ${path.relative(path.join(__dirname, ".."), dpath)} (~${toks}k tokens of clean fact — the writer reads THIS, never the web)`);
  }
  console.error(`\n  TOP 15 (score · monthly pageviews · sitelinks) — what a cheap composer would draft first:`);
  cands.slice(0, 15).forEach((x) =>
    console.error(`   ${String(x.score).padStart(4)}  ${x.n.slice(0, 40).padEnd(40)} ${String(x.pageviews).padStart(7)}pv ${String(x.sitelinks).padStart(3)}sl`)
  );
}
main().catch((e) => { console.error("✗ " + e.message); process.exit(1); });
