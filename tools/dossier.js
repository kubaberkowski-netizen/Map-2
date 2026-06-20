#!/usr/bin/env node
"use strict";
/*
 * tools/dossier.js — the facts-dossier contract between Stage 3 (research) and
 * Stage 4 (writeup). It deliberately SEPARATES fact-gathering from prose:
 * researchers (Claude Code subagents, or you) fill dossiers with SOURCED facts;
 * the writer (write-up.js) turns a dossier into one house-voice writeup. Keeping
 * the two apart is what makes "never invent / source everything" enforceable.
 *
 * A dossier file is research/dossiers/<city>.json — an array of:
 *   {
 *     id:        "<existing spot id>",      // REQUIRED — the spot to enrich
 *     n:         "<name>",                  // echoed for the reviewer's sake
 *     hook:      "the single most interesting angle",   // optional steer
 *     facts:     [ "atomic, checkable fact", ... ],     // REQUIRED — what to say
 *     legend:    [ "folklore to FRAME as legend", ... ],// optional, never asserted
 *     sources:   [ { url, note }, ... ],                // REQUIRED — corroboration
 *     confidence:"high" | "medium" | "low" | "thin",    // thin ⇒ writer writes short
 *     notes:     ""                                     // anything for the reviewer
 *   }
 *
 * Usage:
 *   node tools/dossier.js template <city> [--limit N]   # blank dossiers for the
 *        notable-but-weak pool, seeded with catalogue context → research/dossiers/<city>.todo.json
 *   node tools/dossier.js validate <city>               # check research/dossiers/<city>.json
 */
const fs = require("fs");
const path = require("path");
const M = require("./model");
const Q = require("./quality");

const ROOT = path.join(__dirname, "..");
const SPOTS = path.join(ROOT, "data", "spots.json");
const DOSSIER_DIR = path.join(ROOT, "research", "dossiers");

function loadCatLabels() {
  // light reuse of the same parse find-spots uses, for human-readable category
  const tpl = fs.readFileSync(path.join(ROOT, "src", "app.template.html"), "utf8");
  const body = tpl.slice(tpl.indexOf("<script>") + 8, tpl.indexOf("</script>", tpl.indexOf("<script>") + 8));
  const ast = require("acorn").parse(body, { ecmaVersion: "latest" });
  const out = {};
  (function walk(n) {
    if (!n || typeof n.type !== "string") return;
    if (n.type === "VariableDeclarator" && n.id && n.id.name === "ne" && n.init && n.init.type === "ObjectExpression") {
      for (const p of n.init.properties) {
        if (p.type !== "Property") continue;
        const slug = p.key.name != null ? p.key.name : p.key.value;
        const lp = p.value.properties && p.value.properties.find((q) => (q.key.name || q.key.value) === "l");
        out[slug] = lp ? lp.value.value : slug;
      }
      return;
    }
    for (const k in n) { const v = n[k]; if (Array.isArray(v)) v.forEach((c) => c && typeof c.type === "string" && walk(c)); else if (v && typeof v.type === "string") walk(v); }
  })(ast);
  return out;
}

function validate(dossier) {
  const errors = [];
  if (!Array.isArray(dossier)) return { ok: false, errors: ["dossier must be a JSON array"] };
  const cat = M.loadCatalogue();
  dossier.forEach((d, i) => {
    const at = `[${i}] ${d.id || d.n || "?"}`;
    if (!d.id) errors.push(`${at}: missing "id"`);
    else if (!cat.ids.has(d.id)) errors.push(`${at}: id not in catalogue (writeups only enrich EXISTING spots — add new ones via find-spots.js)`);
    if (!Array.isArray(d.facts) || !d.facts.length) errors.push(`${at}: needs a non-empty "facts" array`);
    if (!Array.isArray(d.sources) || !d.sources.length) errors.push(`${at}: needs at least one "sources" entry (source everything)`);
    if (d.confidence && !["high", "medium", "low", "thin"].includes(d.confidence)) errors.push(`${at}: confidence must be high|medium|low|thin`);
  });
  return { ok: errors.length === 0, errors };
}

function template(citySlug, { limit = 50 } = {}) {
  const model = M.loadModel();
  if (!model.cityById.has(citySlug)) throw new Error(`unknown city "${citySlug}"`);
  Q.load();
  const labels = loadCatLabels();
  const spots = JSON.parse(fs.readFileSync(SPOTS, "utf8"));
  // prime the writeup pool: notable backing, still a stub (RESEARCH-BRIEF target #1)
  const pool = spots
    .filter((s) => s.city === citySlug && !Q.isAuthored(s.id) && Q.isNotable(s.id))
    .slice(0, limit);
  const out = pool.map((s) => ({
    id: s.id, n: s.n, area: s.a, category: labels[s.c] || s.c,
    current_hook: s.s, current_w: s.w,
    hook: "", facts: [], legend: [], sources: [], confidence: "", notes: "",
  }));
  fs.mkdirSync(DOSSIER_DIR, { recursive: true });
  const file = path.join(DOSSIER_DIR, `${citySlug}.todo.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 1) + "\n");
  return { file, count: out.length };
}

// --- CLI ---------------------------------------------------------------------
if (require.main === module) {
  const [cmd, city, ...rest] = process.argv.slice(2);
  if (cmd === "template") {
    if (!city) { console.error("usage: node tools/dossier.js template <city> [--limit N]"); process.exit(1); }
    const limit = rest.includes("--limit") ? +rest[rest.indexOf("--limit") + 1] : 50;
    const { file, count } = template(city, { limit });
    console.log(`wrote ${count} blank dossier(s) → ${path.relative(ROOT, file)}`);
    console.log(`Fill facts+sources (research stage), rename to ${city}.json, then: node tools/write-up.js ${city}`);
  } else if (cmd === "validate") {
    const file = path.join(DOSSIER_DIR, `${city}.json`);
    if (!fs.existsSync(file)) { console.error(`no ${path.relative(ROOT, file)}`); process.exit(1); }
    const { ok, errors } = validate(JSON.parse(fs.readFileSync(file, "utf8")));
    if (ok) console.log(`✓ ${city}.json is a valid dossier.`);
    else { console.error(`✗ ${errors.length} problem(s):`); errors.forEach((e) => console.error("  - " + e)); process.exit(1); }
  } else {
    console.error("usage: node tools/dossier.js template <city> [--limit N]  |  validate <city>");
    process.exit(1);
  }
}

module.exports = { validate, template, DOSSIER_DIR };
