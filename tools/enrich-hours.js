#!/usr/bin/env node
"use strict";
/*
 * tools/enrich-hours.js — research OPENING HOURS for the catalogue's
 * hours-relevant spots (museums, pubs, food/drink, shops, venues) from
 * OpenStreetMap's structured `opening_hours` tag, via Overpass.
 *
 * It does NOT touch data/spots.json or any writeup. It writes a SEPARATE
 * sidecar, data/hours.json, keyed by spot id:
 *
 *   {
 *     "_generated": "...ISO...",
 *     "_source": "OpenStreetMap opening_hours via Overpass (ODbL)",
 *     "hours": {
 *       "<spotId>": {
 *         "h":     "Tu-Su 10:00-18:00",   // raw OSM opening_hours value
 *         "osm":   "node/123456789",      // the element it came from
 *         "name":  "Sir John Soane's Museum",
 *         "match": "name",                // how we matched: name | contains | token | near
 *         "dist":  6                       // metres from the spot's coords
 *       }, ...
 *     }
 *   }
 *
 * Strategy (per spot): one Overpass `around` query for any element carrying
 * `opening_hours` near the spot's coordinates, then pick the best NAME match
 * (falling back to a very-close single result). Spots with no confident match
 * are left out — a missing entry means "unknown", never a guessed value.
 *
 * Free, grounded (only real OSM tags), resumable (skips ids already in
 * data/hours.json unless --force), mirror-rotating, and polite (rate-limited).
 *
 * Usage:
 *   node tools/enrich-hours.js --dry            # show what it would fetch, write nothing
 *   node tools/enrich-hours.js --dry --limit 8  # small sample
 *   node tools/enrich-hours.js                  # full London run, write data/hours.json
 *   node tools/enrich-hours.js --city london --cats pub,museum
 *   node tools/enrich-hours.js --force          # re-fetch even already-resolved ids
 */
const fs = require("fs");
const path = require("path");
const { loadCatalogue, haversineM, norm } = require("./model.js");

// ---- the categories where opening hours are meaningful ----------------------
// (retail / hospitality / ticketed / indoor venues — not statues, parks, wells)
const HOURS_CATS = new Set([
  "pub", "food", "museum", "brunch", "bakery", "coffee", "caff", "cinema",
  "boba", "pieandmash", "matcha", "wine", "bookshops", "vinyl", "dumpling",
  "music", "diaspora", "lido", "archive", "view", "stadium", "livery", "polish",
]);

const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "data", "hours.json");

// Overpass refuses requests without a descriptive User-Agent (→ HTTP 403).
const UA = "Flaneur-hours-enrich/1.0 (https://github.com/kubaberkowski-netizen/map-2; personal catalogue tool)";
const ENDPOINTS = [
  "https://overpass.openstreetmap.fr/api/interpreter",
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter", // often down/slow — last resort
];

// ---- args -------------------------------------------------------------------
const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
const DRY = has("--dry");
const FORCE = has("--force");
const LIMIT = parseInt(val("--limit", "0"), 10) || 0;
const CITY = val("--city", "london");
// Wide net is SAFE because we only accept a hit with a real name match at range;
// the unnamed "near" fallback stays tight (≤12 m). A spot's recorded point can
// sit 100-200 m from the building centroid OSM tags the hours on.
const RADIUS = parseInt(val("--radius", "200"), 10);
const CATS = (val("--cats", "") || "")
  .split(",").map((s) => s.trim()).filter(Boolean);
const catFilter = CATS.length ? new Set(CATS) : HOURS_CATS;

// ---- name matching ----------------------------------------------------------
// Normalise hard: lowercase, drop accents, punctuation, and noise words so
// "The Mayflower" ~ "Mayflower" and "Café Diana" ~ "Cafe Diana".
const NOISE = new Set(["the", "a", "an", "pub", "bar", "cafe", "ltd", "and", "of", "london"]);
function tokens(s) {
  return String(s)
    .toLowerCase()
    .normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim().split(/\s+/)
    .filter((t) => t && !NOISE.has(t));
}
function tightNorm(s) { return tokens(s).join(" "); }
function jaccard(a, b) {
  const A = new Set(a), B = new Set(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

// Spot names often carry a place suffix ("Hitchcock Mosaics, Leytonstone
// Station"); compare on the lead clause too.
function leadClause(s) { return String(s).split(/[,–—-]/)[0].trim(); }

/** Decide how (if at all) an OSM element matches the spot. Returns {match,score} or null. */
function classify(spot, el) {
  const sNames = [spot.n, leadClause(spot.n)];
  const eName = el.tags.name;
  if (!eName) return null;
  const eTok = tokens(eName), eNorm = tightNorm(eName);
  for (const sn of sNames) {
    const sTok = tokens(sn), sNorm = tightNorm(sn);
    if (!sNorm || !eNorm) continue;
    if (sNorm === eNorm) return { match: "name", score: 1 };
    if (sNorm.includes(eNorm) || eNorm.includes(sNorm)) {
      if (Math.min(sNorm.length, eNorm.length) >= 4) return { match: "contains", score: 0.9 };
    }
    const j = jaccard(sTok, eTok);
    if (j >= 0.6) return { match: "token", score: j };
    if (j >= 0.34 && el._dist <= 40) return { match: "token", score: j };
  }
  // no name signal: only trust an essentially-coincident hit (guards against the
  // wide radius grabbing an unrelated neighbour — e.g. a Sainsbury's near a museum)
  if (el._dist <= 12) return { match: "near", score: 0.2 };
  return null;
}

// ---- overpass ---------------------------------------------------------------
async function fetchHoursNear(lat, lng, radius) {
  const ql = `[out:json][timeout:25];nwr(around:${radius},${lat},${lng})["opening_hours"];out tags center;`;
  let lastErr;
  for (const url of ENDPOINTS) {
    try {
      // client-side timeout so a hung endpoint fails OVER to the next mirror
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 30000);
      let res;
      try {
        res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA },
          body: "data=" + encodeURIComponent(ql),
          signal: ctrl.signal,
        });
      } finally { clearTimeout(t); }
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();
      return (data.elements || []).map((el) => {
        const elat = el.lat ?? el.center?.lat, elng = el.lon ?? el.center?.lon;
        return {
          type: el.type, id: el.id, tags: el.tags || {},
          lat: elat, lng: elng,
          _dist: elat != null ? Math.round(haversineM(lat, lng, elat, elng)) : 9999,
        };
      });
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

function bestMatch(spot, els) {
  let best = null;
  for (const el of els) {
    if (!el.tags.opening_hours) continue;
    const c = classify(spot, el);
    if (!c) continue;
    // prefer higher score, then closer
    const cand = { el, ...c };
    if (!best || cand.score > best.score ||
        (cand.score === best.score && el._dist < best.el._dist)) best = cand;
  }
  return best;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- main -------------------------------------------------------------------
(async () => {
  const { spots } = loadCatalogue();
  const targets = spots.filter((s) => s.city === CITY && catFilter.has(s.c));

  // resume from any existing sidecar
  let store = { _generated: null, _source: "OpenStreetMap opening_hours via Overpass (ODbL)", hours: {} };
  if (fs.existsSync(OUT)) {
    try { store = JSON.parse(fs.readFileSync(OUT, "utf8")); store.hours = store.hours || {}; }
    catch { /* start fresh */ }
  }

  const todo = targets.filter((s) => FORCE || !store.hours[s.id]);
  const queue = LIMIT ? todo.slice(0, LIMIT) : todo;

  console.error(
    `[hours] ${CITY}: ${targets.length} hours-relevant spots, ` +
    `${Object.keys(store.hours).length} already resolved, ${queue.length} to fetch` +
    (DRY ? "  (DRY RUN — nothing written)" : ""));

  let found = 0, miss = 0, errs = 0, done = 0;
  for (const s of queue) {
    done++;
    try {
      const els = await fetchHoursNear(s.lat, s.lng, RADIUS);
      const m = bestMatch(s, els);
      if (m) {
        found++;
        const rec = {
          h: m.el.tags.opening_hours,
          osm: `${m.el.type}/${m.el.id}`,
          name: m.el.tags.name,
          match: m.match,
          dist: m.el._dist,
        };
        store.hours[s.id] = rec;
        console.error(`  ✓ ${s.id.padEnd(24)} [${s.c}] ${rec.match}/${rec.dist}m  ${rec.h}`);
      } else {
        miss++;
        console.error(`  · ${s.id.padEnd(24)} [${s.c}] no OSM hours within ${RADIUS}m  (${s.n})`);
      }
    } catch (e) {
      errs++;
      console.error(`  ! ${s.id.padEnd(24)} fetch failed: ${e.message}`);
    }
    // checkpoint every 20 so a long run is crash-safe
    if (!DRY && done % 20 === 0) writeOut(store);
    await sleep(1100); // be polite to Overpass
  }

  if (!DRY) writeOut(store);
  console.error(
    `\n[hours] done: ${found} matched, ${miss} no-data, ${errs} errors. ` +
    `Total resolved now: ${Object.keys(store.hours).length}.` +
    (DRY ? "  (DRY — data/hours.json untouched)" : `  → ${path.relative(ROOT, OUT)}`));
})().catch((e) => { console.error(e); process.exit(1); });

function writeOut(store) {
  store._generated = new Date().toISOString();
  // stable key order for clean diffs
  const ordered = {};
  for (const k of Object.keys(store.hours).sort()) ordered[k] = store.hours[k];
  store.hours = ordered;
  fs.writeFileSync(OUT, JSON.stringify(store, null, 1) + "\n");
}
