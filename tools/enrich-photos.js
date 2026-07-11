#!/usr/bin/env node
"use strict";
/*
 * tools/enrich-photos.js — resolve a free Wikipedia/Commons thumbnail for every
 * quality spot (notable ∪ authored) via en.wikipedia geosearch + pageimages
 * (pilicense=free by default, so only freely-licensed images are returned).
 * A candidate page is accepted only when its title matches the spot name, or
 * it sits within 60 m of the spot — conservative on purpose: no photo beats a
 * wrong photo. Writes data/photos.json {generated, photos:{id: thumbUrl}}.
 * Resumable (skips ids already present). Usage:
 *   node tools/enrich-photos.js [--limit 500] [--city london]
 */
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "data", "photos.json");
const UA = { headers: { "User-Agent": "flaneur-research/1.0 (kuba.berkowski@gmail.com)" } };
const args = process.argv.slice(2);
const LIMIT = args.includes("--limit") ? +args[args.indexOf("--limit") + 1] : Infinity;
const CITY = args.includes("--city") ? args[args.indexOf("--city") + 1] : null;

const spots = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "spots.json"), "utf8"));
const q = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "quality.json"), "utf8"));
const notable = new Set(q.notable || []);
const flags = q.flags || {};

let db = { generated: "", photos: {} };
if (fs.existsSync(OUT)) { try { db = JSON.parse(fs.readFileSync(OUT, "utf8")); } catch (e) { /* fresh */ } }
db.photos = db.photos || {};

const norm = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
  .replace(/[^a-z0-9 ]+/g, " ").replace(/\b(the|a|of|and|st|saint)\b/g, " ").replace(/\s+/g, " ").trim();
const toks = (s) => new Set(norm(s).split(" ").filter((t) => t.length > 2));
function titleMatch(a, b) {
  const ta = toks(a), tb = toks(b);
  if (!ta.size || !tb.size) return false;
  let hit = 0;
  for (const t of ta) if (tb.has(t)) hit++;
  return hit >= Math.min(2, ta.size) || norm(b).includes(norm(a)) || norm(a).includes(norm(b));
}
const hav = (a, b) => {
  const R = 6371e3, p = Math.PI / 180, s1 = Math.sin((b.lat - a.lat) * p / 2), s2 = Math.sin((b.lng - a.lng) * p / 2);
  const x = s1 * s1 + Math.cos(a.lat * p) * Math.cos(b.lat * p) * s2 * s2;
  return 2 * R * Math.asin(Math.sqrt(x));
};
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const targets = spots.filter((z) =>
  typeof z.lat === "number" && typeof z.lng === "number" &&
  (notable.has(z.id) || flags[z.id] === "a" || flags[z.id] === "v") &&
  !(z.id in db.photos) && (!CITY || z.city === CITY)
).slice(0, LIMIT);

console.log(`targets: ${targets.length} (have ${Object.keys(db.photos).length} already)`);

let done = 0, found = 0, saved = 0, errs = 0;
function persist() {
  db.generated = new Date().toISOString();
  fs.writeFileSync(OUT, JSON.stringify(db, null, 1));
  saved = done;
}
async function one(z) {
  const url = "https://en.wikipedia.org/w/api.php?action=query&generator=geosearch" +
    `&ggscoord=${z.lat}%7C${z.lng}&ggsradius=160&ggslimit=12` +
    "&prop=pageimages%7Ccoordinates&piprop=thumbnail&pithumbsize=640&format=json&origin=*";
  try {
    let r = await fetch(url, UA);
    if (r.status === 429 || r.status === 403) { await delay(8000); r = await fetch(url, UA); }
    if (!r.ok) { errs++; done++; return; }
    const j = await r.json();
    const pages = j && j.query && j.query.pages ? Object.values(j.query.pages) : [];
    // title-match ONLY — a nearby geotagged photo of something else is worse
    // than no photo, so there is deliberately no proximity-only fallback.
    let best = null, bestD = Infinity;
    for (const p of pages) {
      if (!p.thumbnail || !p.thumbnail.source) continue;
      if (!titleMatch(z.n, p.title)) continue;
      const c = p.coordinates && p.coordinates[0];
      const d = c ? hav(z, { lat: c.lat, lng: c.lon }) : 500;
      if (d < bestD) { best = p; bestD = d; }
    }
    if (best) { db.photos[z.id] = best.thumbnail.source; found++; }
  } catch (e) { errs++; /* transient — spot stays unresolved, rerun is resumable */ }
  done++;
  if (done - saved >= 100) persist();
  if (done % 250 === 0) console.log(`${done}/${targets.length} · ${found} photos · ${errs} errors`);
}
(async () => {
  const POOL = 2;
  let i = 0;
  await Promise.all(Array.from({ length: POOL }, async () => {
    while (i < targets.length) { const z = targets[i++]; await one(z); await delay(220); }
  }));
  persist();
  console.log(`done: ${found} new photos (${errs} errors)`+`, ${Object.keys(db.photos).length} total → data/photos.json`);
})();
