#!/usr/bin/env node
"use strict";
/*
 * tools/quality.js — the DURABLE provenance/quality flag for every spot.
 *
 * Why this exists: until now, every tool guessed "authored vs machine stub" from
 * the LENGTH of `w` (RESEARCH-BRIEF.md explicitly says to stop doing that), and
 * the "these 787 are sacred" set lived in /tmp files that do NOT survive a fresh
 * checkout (prune-junk.js / draft-local.js both read /tmp/orig*.json). This makes
 * the classification explicit, committed, and hand-correctable.
 *
 * It writes data/quality.json — the source of truth other tools read:
 *   {
 *     generated, baseline,
 *     counts: { a, v, d, m, notable },
 *     flags: { "<id>": "a" | "v" | "d" | "m", ... }
 *            // a=authored/approved, v=verified-sourced, d=machine draft (pending
 *            // review — NOT your voice yet), m=thin machine stub
 *     notable: [ "<id>", ... ]                  // has Wikipedia/Wikidata backing
 *   }
 *
 * a/v/d are STICKY: regeneration never changes them (a draft stays a draft until
 * a human promotes d→a). Only an `m`/absent spot gets re-seeded from the heuristic.
 *
 * Regeneration is MONOTONIC and safe: it never downgrades a spot a human (or a
 * prior run) marked "a"/"v" back to "m" — it only PROMOTES m→a when a writeup has
 * since been written in the house voice. Use --reset to recompute from scratch.
 *
 * Usage:
 *   node tools/quality.js                 # (re)generate data/quality.json (monotonic)
 *   node tools/quality.js --reset         # recompute every flag from the heuristic
 *   node tools/quality.js --check         # report-only: drift vs the committed file
 *   node tools/quality.js --stats         # per-city authored/stub/notable table
 *
 * Other tools:  const Q = require("./quality"); Q.load();  Q.isAuthored(id); Q.isNotable(id);
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SPOTS = path.join(ROOT, "data", "spots.json");
const QFILE = path.join(ROOT, "data", "quality.json");

// --- the authored-voice heuristic --------------------------------------------
// Authored writeups lead with a hook and run long; machine stubs are short and
// open "X is a Y…" / "<Name> is/was a …". This only ever SEEDS the flag — once a
// flag is in data/quality.json it is authoritative and is not silently undone.
const GAZETTEER_OPEN = [
  /^the\s+.+\bis\s+(a|an|the)\b/i,           // "The X is a Y…"
  /^[A-Z][\wÀ-ÿ'’.-]+\s+.+\b(is|was)\s+(a|an|the)\b/, // "<Name> is/was a …"
  /^[A-Z].+\bis\s+(a|an)\s+\d{0,4}\s*(century|listed|grade)/i,
];
function looksAuthored(w) {
  const t = String(w || "").trim();
  if (t.length < 160) return false;            // stubs are short
  if (GAZETTEER_OPEN.some((re) => re.test(t))) return false; // gazetteer opener
  return true;
}

// --- notable backing (Wikipedia / Wikidata) ----------------------------------
function loadIdArray(file) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(__dirname, file), "utf8"));
    return Array.isArray(j) ? j.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}
function notableSet() {
  const s = new Set();
  for (const id of loadIdArray("wiki-enriched.json")) s.add(id);
  for (const id of loadIdArray("wikidata-enriched.json")) s.add(id);
  return s;
}

// --- public API (for other tools) --------------------------------------------
let _q = null;
function load() {
  if (_q) return _q;
  _q = JSON.parse(fs.readFileSync(QFILE, "utf8"));
  _q._notable = new Set(_q.notable || []);
  return _q;
}
const flagOf = (id) => (load().flags[id] || "m");
const isAuthored = (id) => flagOf(id) === "a" || flagOf(id) === "v";
const isVerified = (id) => flagOf(id) === "v";
const isNotable = (id) => load()._notable.has(id);

// --- generation ---------------------------------------------------------------
function readExisting() {
  try {
    return JSON.parse(fs.readFileSync(QFILE, "utf8"));
  } catch {
    return null;
  }
}

function generate({ reset = false } = {}) {
  const spots = JSON.parse(fs.readFileSync(SPOTS, "utf8"));
  const notable = notableSet();
  const prev = reset ? null : readExisting();
  const prevFlags = (prev && prev.flags) || {};

  const flags = {};
  let promoted = 0;
  for (const s of spots) {
    const seeded = looksAuthored(s.w) ? "a" : "m";
    const old = prevFlags[s.id];
    // Monotonic: a/v/d are sticky (human-owned states). Only m/absent re-seeds.
    if (old === "v" || old === "a" || old === "d") flags[s.id] = old;
    else {
      flags[s.id] = seeded;
      if (old === "m" && seeded === "a") promoted++;
    }
  }

  const ids = new Set(spots.map((s) => s.id));
  const notableInCat = [...notable].filter((id) => ids.has(id)).sort();
  const tally = (f) => Object.values(flags).filter((x) => x === f).length;
  const counts = { a: tally("a"), v: tally("v"), d: tally("d"), m: tally("m"), notable: notableInCat.length };

  return { obj: { generated: new Date().toISOString(), baseline: spots.length, counts, flags, notable: notableInCat }, promoted };
}

/**
 * Set the quality flag for a list of ids (used by write-up.js --apply to mark
 * machine drafts "d", and by a human promoting d→a). Rewrites data/quality.json.
 */
function setFlags(ids, flag) {
  const o = readExisting();
  if (!o) throw new Error("no data/quality.json — run `node tools/quality.js` first.");
  let changed = 0;
  for (const id of ids) if (o.flags[id] !== flag) { o.flags[id] = flag; changed++; }
  const tally = (f) => Object.values(o.flags).filter((x) => x === f).length;
  o.counts = { a: tally("a"), v: tally("v"), d: tally("d"), m: tally("m"), notable: (o.notable || []).length };
  o.generated = new Date().toISOString();
  fs.writeFileSync(QFILE, serialize(o));
  _q = null; // invalidate cache
  return changed;
}

// pretty-print flags one-per-line so diffs/hand-edits stay clean
function serialize(o) {
  const flagLines = Object.entries(o.flags).map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)}`);
  const notableLines = o.notable.map((id) => `  ${JSON.stringify(id)}`);
  return (
    "{\n" +
    ` "generated": ${JSON.stringify(o.generated)},\n` +
    ` "baseline": ${o.baseline},\n` +
    ` "counts": ${JSON.stringify(o.counts)},\n` +
    ` "flags": {\n${flagLines.join(",\n")}\n },\n` +
    ` "notable": [\n${notableLines.join(",\n")}\n ]\n` +
    "}\n"
  );
}

function statsTable() {
  const spots = JSON.parse(fs.readFileSync(SPOTS, "utf8"));
  const q = readExisting();
  const flags = (q && q.flags) || {};
  const notable = new Set((q && q.notable) || []);
  const by = {};
  for (const s of spots) {
    const c = (by[s.city] = by[s.city] || { t: 0, a: 0, m: 0, nb: 0, nbWeak: 0 });
    c.t++;
    const f = flags[s.id] || "m";
    if (f === "a" || f === "v") c.a++;
    else if (f === "d") (c.d = (c.d || 0) + 1);
    else c.m++;
    if (notable.has(s.id)) {
      c.nb++;
      if (f === "m") c.nbWeak++; // notable but still a stub → prime writeup target
    }
  }
  const rows = Object.entries(by).sort((a, b) => b[1].t - a[1].t);
  console.log("city            total  authored  draft   stub  notable  notable-but-weak  %auth");
  for (const [city, c] of rows) {
    console.log(
      city.padEnd(14),
      String(c.t).padStart(6),
      String(c.a).padStart(9),
      String(c.d || 0).padStart(6),
      String(c.m).padStart(6),
      String(c.nb).padStart(8),
      String(c.nbWeak).padStart(17),
      String(Math.round((100 * c.a) / c.t)).padStart(6) + "%"
    );
  }
}

// --- CLI ---------------------------------------------------------------------
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.includes("--stats")) {
    statsTable();
  } else if (args.includes("--set")) {
    // node tools/quality.js --set <flag> <id> [<id>...]
    const i = args.indexOf("--set");
    const flag = args[i + 1];
    const ids = args.slice(i + 2).filter((a) => !a.startsWith("--"));
    if (!["a", "v", "d", "m"].includes(flag) || !ids.length) {
      console.error("usage: node tools/quality.js --set <a|v|d|m> <id> [<id>...]");
      process.exit(1);
    }
    console.log(`set ${setFlags(ids, flag)} id(s) → "${flag}".`);
  } else if (args.includes("--promote")) {
    // node tools/quality.js --promote  — promote all reviewed drafts d→a
    const o = readExisting();
    const ids = Object.entries(o.flags).filter(([, f]) => f === "d").map(([id]) => id);
    console.log(`promoting ${setFlags(ids, "a")} draft(s) d→a (mark these as reviewed/approved).`);
  } else if (args.includes("--check")) {
    const prev = readExisting();
    if (!prev) {
      console.log("no data/quality.json yet — run `node tools/quality.js` to create it.");
      process.exit(0);
    }
    const fresh = generate({ reset: false }).obj;
    let drift = 0;
    for (const [id, f] of Object.entries(fresh.flags)) {
      if ((prev.flags[id] || null) !== f) {
        if (drift < 30) console.log(`  ${id}: ${prev.flags[id] || "—"} → ${f}`);
        drift++;
      }
    }
    const removed = Object.keys(prev.flags).filter((id) => !(id in fresh.flags));
    console.log(`drift: ${drift} flag change(s) (m→a promotions), ${removed.length} id(s) no longer in catalogue.`);
    if (drift > 30) console.log(`  …and ${drift - 30} more.`);
  } else {
    const reset = args.includes("--reset");
    const { obj, promoted } = generate({ reset });
    fs.writeFileSync(QFILE, serialize(obj));
    console.log(
      `wrote data/quality.json — ${obj.baseline} spots: ` +
        `${obj.counts.a} authored, ${obj.counts.v} verified, ${obj.counts.m} stub; ` +
        `${obj.counts.notable} notable.` +
        (reset ? "  (--reset: recomputed from scratch)" : `  (promoted ${promoted} m→a)`)
    );
  }
}

module.exports = { load, flagOf, isAuthored, isVerified, isNotable, looksAuthored, setFlags };
