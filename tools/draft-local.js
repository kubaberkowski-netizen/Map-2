#!/usr/bin/env node
"use strict";
/*
 * tools/draft-local.js — fill blank `w` with a deterministic FACTUAL blurb
 * composed from data already in the catalogue (the `s` hook + area + city, and
 * the Wikidata one-liner where the hook already reads like one). No API, no key,
 * no cost. These are plain placeholders to review/rewrite — not the owner's
 * voice. Only ever fills an EMPTY `w` (never overwrites); resumable.
 *
 * Usage:
 *   node tools/draft-local.js --dry --city edinburgh   # print samples, write nothing
 *   node tools/draft-local.js                           # fill every blank w
 *   node tools/draft-local.js --city paris
 *   # then: npm run build
 */
const fs = require("fs");
const path = require("path");
const M = require("./model");

const ROOT = path.join(__dirname, "..");
const SPOTS = path.join(ROOT, "data", "spots.json");
const args = process.argv.slice(2);
const dry = args.includes("--dry");
const onlyCity = args.includes("--city") ? args[args.indexOf("--city") + 1] : null;

const cityName = (slug) => { const c = M.loadModel().cityById.get(slug); return c ? c.name : slug; };
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const end = (s) => (/[.!?]$/.test(s) ? s : s + ".");

// the true curated originals — never auto-draft these (the owner writes them)
const ORIG = new Set(JSON.parse(fs.readFileSync("/tmp/orig787.json", "utf8")));

// the `s` hook is either a Wikidata blurb ("church in Prague", "school in X")
// or a short type from our own hook()/triage ("historic pub", "mural", "viewpoint").
// No "A/An" prefixing (avoids "an university" / "a the …") — just capitalise the
// descriptor and pin it to a place.
function blurb(spot) {
  let s = String(spot.s || "").trim();
  const city = cityName(spot.city);
  const loc = spot.a ? `${spot.a}, ${city}` : city;
  if (!s || s.toLowerCase() === "local curiosity") return `Point of interest in ${loc}.`;
  // if the hook already says "… in …", it's situated — don't append another "in"
  if (/\sin\s/i.test(s)) return end(cap(s));
  return end(`${cap(s)} in ${loc}`);
}

const spots = JSON.parse(fs.readFileSync(SPOTS, "utf8"));
const MANIFEST = path.join(__dirname, "local-drafts.json");
const draftedIds = [];
let filled = 0, skipped = 0, protectedN = 0;
const samples = [];
for (const sp of spots) {
  if (onlyCity && sp.city !== onlyCity) continue;
  if (ORIG.has(sp.id)) { protectedN++; continue; }          // curated original — leave for the owner
  if (sp.w && String(sp.w).trim()) { skipped++; continue; }
  const w = blurb(sp);
  draftedIds.push(sp.id);
  if (samples.length < 25) samples.push(`[${sp.c}] ${sp.n} — ${w}`);
  if (!dry) sp.w = w;
  filled++;
}

if (dry) {
  console.log(samples.join("\n"));
  console.log(`\n--dry: would fill ${filled} blank writeups${onlyCity ? " in " + onlyCity : ""} (skipped ${skipped} already-written, ${protectedN} curated originals protected). Nothing written.`);
} else {
  fs.writeFileSync(SPOTS, JSON.stringify(spots, null, 1) + "\n");
  const prev = fs.existsSync(MANIFEST) ? JSON.parse(fs.readFileSync(MANIFEST, "utf8")) : [];
  fs.writeFileSync(MANIFEST, JSON.stringify([...new Set(prev.concat(draftedIds))], null, 0) + "\n");
  console.log(`filled ${filled} blank writeups${onlyCity ? " in " + onlyCity : ""} (left ${skipped} existing + ${protectedN} curated originals untouched). logged ids to ${path.relative(ROOT, MANIFEST)}. next: npm run build`);
}
