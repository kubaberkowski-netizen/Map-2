#!/usr/bin/env node
"use strict";
/*
 * tools/gen-descriptions.js — draft SHORT placeholder writeups for spots whose
 * `w` is still blank, using Claude. These are MACHINE DRAFTS to review/rewrite,
 * not finished copy — see CLAUDE.md ("the writeups are the entire point of the
 * product"). The owner explicitly opted in to drafting.
 *
 * Safety rails:
 *   - only ever fills an EMPTY `w` (never overwrites a written one — your
 *     curated writeups and any edits are untouched); the run is resumable.
 *   - grounds every draft in the spot's real facts (name, area, city, category,
 *     the `s` hook, and recovered OSM tags / Wikidata blurb) and instructs the
 *     model not to invent specifics it wasn't given.
 *   - records every drafted id in tools/ai-drafts.json so you can find them.
 *
 * Setup (intentionally NOT a project dependency — CLAUDE.md keeps acorn only):
 *   npm install @anthropic-ai/sdk
 *   export ANTHROPIC_API_KEY=sk-ant-...
 *   # optional: export FLANEUR_DESC_MODEL=claude-haiku-4-5-20251001  (default)
 *
 * Usage:
 *   node tools/gen-descriptions.js --dry                 # build a prompt, print it, no API call
 *   node tools/gen-descriptions.js --city edinburgh --limit 50
 *   node tools/gen-descriptions.js --limit 500 --batch 20
 *   # then: npm run build
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SPOTS = path.join(ROOT, "data", "spots.json");
const MANIFEST = path.join(__dirname, "ai-drafts.json");
const MODEL = process.env.FLANEUR_DESC_MODEL || "claude-haiku-4-5-20251001";

function parseArgs(argv) {
  const a = { batch: 20, limit: Infinity };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--dry") a.dry = true;
    else if (k === "--city") a.city = argv[++i];
    else if (k === "--limit") a.limit = +argv[++i];
    else if (k === "--batch") a.batch = +argv[++i];
  }
  return a;
}

// recover OSM tags / Wikidata blurb by city|name from the candidate piles
const norm = (n) => String(n).toLowerCase().replace(/^the\s+/, "").replace(/\s+/g, " ").trim();
function loadFacts() {
  const m = new Map();
  const dir = path.join(__dirname, "candidates");
  if (!fs.existsSync(dir)) return m;
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    for (const r of JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"))) {
      const raw = r._meta && r._meta.raw;
      if (raw) m.set(r.city + "|" + norm(r.n), raw);
    }
  }
  return m;
}

// category slug -> human label, parsed from the template so we send the model
// the real editorial label rather than the slug
function loadCatLabels() {
  const M = require("./model");
  const out = {};
  // reuse model's parse by reading labels off the template ne block
  const tpl = fs.readFileSync(path.join(ROOT, "src", "app.template.html"), "utf8");
  const body = tpl.slice(tpl.indexOf("<script>") + 8, tpl.indexOf("</script>", tpl.indexOf("<script>") + 8));
  const acorn = require("acorn");
  const ast = acorn.parse(body, { ecmaVersion: "latest" });
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

const cityName = (slug) => {
  try {
    const M = require("./model");
    const c = M.loadModel().cityById.get(slug);
    return c ? c.name : slug;
  } catch { return slug; }
};

function factLine(spot, facts, labels) {
  const raw = facts.get(spot.city + "|" + norm(spot.n));
  const bits = [];
  bits.push(`name: ${spot.n}`);
  bits.push(`category: ${labels[spot.c] || spot.c}`);
  if (spot.a) bits.push(`area: ${spot.a}`);
  bits.push(`city: ${cityName(spot.city)}`);
  if (spot.s) bits.push(`hook: ${spot.s}`);
  if (raw && typeof raw === "string") bits.push(`wikidata: ${raw}`);
  else if (raw && typeof raw === "object") {
    const keep = ["historic", "tourism", "amenity", "building", "religion", "artwork_type", "memorial", "inscription", "start_date", "description", "wikipedia"];
    const t = keep.filter((k) => raw[k]).map((k) => `${k}=${raw[k]}`).join(", ");
    if (t) bits.push(`osm: ${t}`);
  }
  return bits.join(" | ");
}

const SYSTEM =
  "You draft SHORT factual placeholder blurbs for entries in a personal city-walk " +
  "catalogue of offbeat, storied places. For each item you get only a few facts. " +
  "Write 1–2 plain sentences (about 25–45 words), third person, no markdown, no " +
  "lists. Use ONLY the facts provided — never invent dates, names, anecdotes or " +
  "claims you weren't given; if the facts are thin, write a minimal factual line. " +
  "Do not start with the place name in bold. Return strict JSON only.";

function buildPrompt(batch, facts, labels) {
  const items = batch.map((s) => `#${s.id}\n${factLine(s, facts, labels)}`).join("\n\n");
  return (
    `Draft a blurb for each item below. Return a JSON object mapping each id ` +
    `(the string after #) to its blurb, e.g. {"someid":"..."}. Items:\n\n${items}`
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const facts = loadFacts();
  const labels = loadCatLabels();
  const spots = JSON.parse(fs.readFileSync(SPOTS, "utf8"));

  let todo = spots.filter((s) => (!s.w || !String(s.w).trim()) && (!args.city || s.city === args.city));
  const totalBlank = todo.length;
  if (Number.isFinite(args.limit)) todo = todo.slice(0, args.limit);
  console.error(`${totalBlank} spots have a blank writeup${args.city ? ` in ${args.city}` : ""}; drafting ${todo.length} (model ${MODEL}).`);

  if (!todo.length) { console.error("nothing to do."); return; }

  if (args.dry) {
    const batch = todo.slice(0, Math.min(args.batch, 5));
    console.log("=== SYSTEM ===\n" + SYSTEM + "\n\n=== USER (first batch) ===\n" + buildPrompt(batch, facts, labels));
    console.error(`\n--dry: no API call. Would process ${todo.length} spots in batches of ${args.batch}.`);
    return;
  }

  let Anthropic;
  try { Anthropic = require("@anthropic-ai/sdk"); }
  catch { console.error("✗ install the SDK first:  npm install @anthropic-ai/sdk"); process.exit(1); }
  if (!process.env.ANTHROPIC_API_KEY) { console.error("✗ set ANTHROPIC_API_KEY"); process.exit(1); }
  const client = new Anthropic();

  const drafted = fs.existsSync(MANIFEST) ? new Set(JSON.parse(fs.readFileSync(MANIFEST, "utf8"))) : new Set();
  const byId = new Map(spots.map((s) => [s.id, s]));
  let done = 0, failed = 0;

  for (let i = 0; i < todo.length; i += args.batch) {
    const batch = todo.slice(i, i + args.batch);
    try {
      const msg = await client.messages.create({
        model: MODEL, max_tokens: 1500, system: SYSTEM,
        messages: [{ role: "user", content: buildPrompt(batch, facts, labels) }],
      });
      const text = (msg.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
      const json = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
      for (const s of batch) {
        const w = json[s.id];
        if (w && String(w).trim() && (!s.w || !String(s.w).trim())) {
          byId.get(s.id).w = String(w).trim();
          drafted.add(s.id); done++;
        }
      }
      // persist incrementally so an interrupted run isn't lost
      fs.writeFileSync(SPOTS, JSON.stringify(spots, null, 1) + "\n");
      fs.writeFileSync(MANIFEST, JSON.stringify([...drafted], null, 0) + "\n");
      console.error(`  ${Math.min(i + args.batch, todo.length)}/${todo.length} (drafted ${done})`);
    } catch (e) {
      failed += batch.length;
      console.error(`  batch @${i} failed: ${e.message}`);
    }
  }
  console.error(`\ndone: drafted ${done}, failed ${failed}. ${drafted.size} ids in ${path.relative(ROOT, MANIFEST)}.`);
  console.error("review the drafts, then: npm run build");
}
main().catch((e) => { console.error("✗ " + e.message); process.exit(1); });
