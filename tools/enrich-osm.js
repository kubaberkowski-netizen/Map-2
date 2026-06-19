#!/usr/bin/env node
"use strict";
/*
 * tools/enrich-osm.js — append REAL facts from OSM tags to plain placeholder
 * writeups: build/founding dates, architect, artist, denomination, heritage
 * listing, inscription. Free, grounded (sourced facts only, nothing invented).
 * Skips the 787 curated originals AND the Wikipedia-enriched spots; only
 * touches the plain machine placeholders. Resumable.
 *
 * Usage:  node tools/enrich-osm.js --dry [--city X]   |   node tools/enrich-osm.js
 */
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const SPOTS = path.join(ROOT, "data", "spots.json");
const MANIFEST = path.join(__dirname, "osm-enriched.json");
const args = process.argv.slice(2);
const dry = args.includes("--dry");
const onlyCity = args.includes("--city") ? args[args.indexOf("--city") + 1] : null;

const norm = (n) => String(n).toLowerCase().replace(/^the\s+/, "").replace(/\s+/g, " ").trim();
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const ORIG = new Set(JSON.parse(fs.readFileSync("/tmp/orig787.json", "utf8")));
const WIKI = fs.existsSync(path.join(__dirname, "wiki-enriched.json"))
  ? new Set(JSON.parse(fs.readFileSync(path.join(__dirname, "wiki-enriched.json"), "utf8"))) : new Set();

const tags = new Map();
for (const f of fs.readdirSync(path.join(__dirname, "candidates")).filter((f) => f.endsWith(".json")))
  for (const r of JSON.parse(fs.readFileSync(path.join(__dirname, "candidates", f), "utf8"))) {
    const raw = r._meta && r._meta.raw;
    if (raw && typeof raw === "object") tags.set(r.city + "|" + norm(r.n), raw);
  }

function yearOf(v) {
  v = String(v);
  let m = v.match(/\b(1[0-9]{3}|20[0-2][0-9])\b/); if (m) return m[1];
  m = v.match(/C(\d{1,2})\b/i) || v.match(/\b(\d{1,2})(?:st|nd|rd|th)\s+century/i);
  if (m) return `the ${m[1]}th century`;
  return null;
}
const tidyName = (s) => String(s).replace(/[;,]\s*/g, " and ").replace(/\s+/g, " ").trim();
const denom = (d) => cap(String(d).replace(/_/g, " "));

// returns extra factual sentences (array) grounded in the tags
function facts(spot, t) {
  const out = [];
  // OSM free-text description (richest) — guard length, sentence-case, one sentence
  if (t.description && spot.c !== "faith") {
    let d = String(t.description).replace(/\s+/g, " ").trim();
    const nonLatin = /[Ͱ-ϿЀ-ӿ　-鿿가-힯]/.test(d); // Greek/Cyrillic/CJK
    if (d.length >= 12 && d.length <= 200 && !/^https?:/i.test(d) && !nonLatin) {
      d = d.split(/(?<=[.!?])\s+/)[0];
      out.push(/[.!?]$/.test(d) ? cap(d) : cap(d) + ".");
    }
  }
  const yr = yearOf(t.start_date || t.year_of_construction || t.opening_date || t["building:start_date"] || "");
  if (yr) out.push(`Dates from ${yr}.`);
  if (t.architect) out.push(`Designed by ${tidyName(t.architect)}.`);
  if (t.artist_name && /streetart|history/.test(spot.c)) out.push(`Work by ${tidyName(t.artist_name)}.`);
  if ((t["building:architecture"] || t.architecture) && /history|medieval|faith|museum/.test(spot.c))
    out.push(`Built in the ${denom(t["building:architecture"] || t.architecture)} style.`);
  if (t.material && /streetart|history/.test(spot.c)) out.push(`Made of ${String(t.material).replace(/_/g, " ").toLowerCase()}.`);
  if (t.denomination && spot.c === "faith") out.push(`${denom(t.denomination)} denomination.`);
  if (t.cuisine && /pub|caff|coffee|food|bakery|wine/.test(spot.c))
    out.push(`Serves ${denom(t.cuisine).toLowerCase().replace(/;/g, ", ")}.`);
  if (t.ele && spot.c === "view" && /^\d{2,4}(\.\d+)?$/.test(String(t.ele)))
    out.push(`About ${Math.round(+t.ele)} m above sea level.`);
  if (t.capacity && spot.c === "stadium" && /^\d{3,6}$/.test(String(t.capacity)))
    out.push(`Capacity ${(+t.capacity).toLocaleString("en-GB")}.`);
  const listed = t.listed_status || (t.heritage ? "heritage" : null);
  if (listed) out.push(listed === "heritage" ? "A heritage-listed structure." : `${cap(listed)} listed.`);
  if (t.inscription) {
    const ins = String(t.inscription).replace(/\s+/g, " ").trim();
    if (ins.length >= 4 && ins.length <= 120) out.push(`Inscribed: “${ins}”.`);
  }
  // locational fallback: the street it stands on (added last, low priority)
  if (t["addr:street"] && !out.length) {
    const st = String(t["addr:street"]).replace(/\s+/g, " ").trim();
    if (st.length >= 3 && st.length <= 40 && !/[0-9]{3,}/.test(st)) out.push(`On ${st}.`);
  }
  return out.slice(0, 3); // at most three appended facts
}

const spots = JSON.parse(fs.readFileSync(SPOTS, "utf8"));
const enriched = fs.existsSync(MANIFEST) ? new Set(JSON.parse(fs.readFileSync(MANIFEST, "utf8"))) : new Set();
let done = 0; const samples = [];
for (const s of spots) {
  if (ORIG.has(s.id) || WIKI.has(s.id) || enriched.has(s.id)) continue;
  if (onlyCity && s.city !== onlyCity) continue;
  const t = tags.get(s.city + "|" + norm(s.n));
  if (!t) continue;
  const extra = facts(s, t);
  if (!extra.length) continue;
  const base = String(s.w || "").trim();
  // avoid double-appending if a fact (e.g. the year) is already present
  const add = extra.filter((e) => { const y = e.match(/\d{3,4}/); return !(y && base.includes(y[0])); });
  if (!add.length) continue;
  const w = (base ? base + " " : "") + add.join(" ");
  if (samples.length < 14) samples.push(`[${s.c}] ${s.n} — ${w}`);
  if (!dry) { s.w = w; enriched.add(s.id); }
  done++;
}
if (dry) {
  console.log(samples.join("\n\n"));
  console.log(`\n--dry: would enrich ${done} placeholders with OSM facts${onlyCity ? " in " + onlyCity : ""}. Nothing written.`);
} else {
  fs.writeFileSync(SPOTS, JSON.stringify(spots, null, 1) + "\n");
  fs.writeFileSync(MANIFEST, JSON.stringify([...enriched], null, 0) + "\n");
  console.log(`enriched ${done} placeholders with OSM facts. ${enriched.size} ids in ${path.relative(ROOT, MANIFEST)}. next: npm run build`);
}
