#!/usr/bin/env node
"use strict";
/*
 * tools/write-up.js — Stage 4: the house-voice writer.
 *
 * Takes a SOURCED facts dossier (research/dossiers/<city>.json — see dossier.js)
 * and drafts one writeup per spot in the owner's voice, FEW-SHOT-PRIMED on real
 * authored London writeups (selected exactly via data/quality.json, not guessed
 * from length). Every draft is grounded ONLY in the dossier's facts, validated
 * against the RESEARCH-BRIEF spec, and lands as a reviewable "d" draft — never
 * silently promoted to your voice.
 *
 *   research → dossier (facts+sources) → write-up.js → review file → --apply → spots.json (flag d)
 *                                                                       → you review → quality.js --promote
 *
 * Setup (SDK is intentionally not a project dependency):
 *   npm install @anthropic-ai/sdk
 *   export ANTHROPIC_API_KEY=sk-ant-...
 *   # optional: export FLANEUR_WRITE_MODEL=claude-opus-4-8   (default; best voice)
 *
 * Usage:
 *   node tools/write-up.js rome --dry        # build + print the prompt, no API call
 *   node tools/write-up.js rome              # draft → research/drafts/rome.json (review file)
 *   node tools/write-up.js rome --apply      # write reviewed drafts into spots.json (flag d)
 */
const fs = require("fs");
const path = require("path");
const M = require("./model");
const Q = require("./quality");

const ROOT = path.join(__dirname, "..");
const SPOTS = path.join(ROOT, "data", "spots.json");
const DOSSIER_DIR = path.join(ROOT, "research", "dossiers");
const DRAFT_DIR = path.join(ROOT, "research", "drafts");
const MODEL = process.env.FLANEUR_WRITE_MODEL || "claude-opus-4-8";

const SPEC = { min: 180, max: 340 }; // RESEARCH-BRIEF: 220–320, with a little slack

// --- spec validation (mirrors tools/RESEARCH-BRIEF.md) -----------------------
function checkSpec(w) {
  const issues = [];
  const t = String(w || "").trim();
  if (t.length < SPEC.min) issues.push(`too short (${t.length} < ${SPEC.min})`);
  if (t.length > SPEC.max) issues.push(`too long (${t.length} > ${SPEC.max})`);
  if (/[‘’“”]/.test(t)) issues.push("smart quotes (use straight ASCII)");
  if (/https?:\/\//i.test(t)) issues.push("contains a URL");
  if (/€|EUR\b/.test(t)) issues.push("contains €/EUR (catalogue uses neither)");
  if (/^the\s+.+\bis\s+(a|an|the)\b/i.test(t) || /^[A-Z][\wÀ-ÿ'.-]+\s+.+\b(is|was)\s+(a|an|the)\b/.test(t))
    issues.push("gazetteer opener ('X is a Y…') — lead with the hook");
  return issues;
}

// --- few-shot exemplars: real authored London writeups -----------------------
function exemplars(n = 6) {
  Q.load();
  const spots = JSON.parse(fs.readFileSync(SPOTS, "utf8"));
  const pool = spots.filter(
    (s) => s.city === "london" && Q.flagOf(s.id) === "a" && s.w && s.w.length >= 220 && s.w.length <= 330
  );
  // diversify across categories, deterministic order
  const byCat = new Map();
  for (const s of pool.sort((a, b) => a.id.localeCompare(b.id))) {
    if (!byCat.has(s.c)) byCat.set(s.c, s);
  }
  return [...byCat.values()].slice(0, n).map((s) => s.w);
}

const SYSTEM =
  "You write entries for Flâneur, a personal catalogue of offbeat, storied places, " +
  "in the owner's established voice. HARD RULES: (1) Use ONLY the supplied facts — " +
  "never invent dates, names, anecdotes, or claims. If the facts are thin, write " +
  "SHORT rather than pad. (2) Frame any folklore explicitly as legend ('the story " +
  "goes…', 'said to…') — never assert it. (3) Lead with the hook, never 'The X is " +
  "a Y…'. End on a short, punchy fragment — the house signature. (4) 220–320 " +
  "characters, one tight paragraph. Straight ASCII quotes; keep diacritics; no URLs, " +
  "citations, markdown, or € / EUR. Match the register of the examples exactly.";

function buildPrompt(dossier, byId, shots) {
  const examples = shots.map((w, i) => `EXAMPLE ${i + 1}:\n${w}`).join("\n\n");
  const items = dossier.map((d) => {
    const s = byId.get(d.id);
    const lines = [
      `#${d.id}`,
      `name: ${d.n || (s && s.n)}`,
      s ? `category: ${s.c} | area: ${s.a || "—"} | city: ${s.city}` : "",
      d.hook ? `angle: ${d.hook}` : "",
      `facts:\n` + (d.facts || []).map((f) => `  - ${f}`).join("\n"),
      (d.legend && d.legend.length) ? `legend (frame as legend, never assert):\n` + d.legend.map((f) => `  - ${f}`).join("\n") : "",
      d.confidence ? `confidence: ${d.confidence}` : "",
    ].filter(Boolean);
    return lines.join("\n");
  }).join("\n\n");
  const user =
    `Here is the owner's voice — match it precisely:\n\n${examples}\n\n` +
    `Now write ONE writeup for each item below, grounded ONLY in its facts. Return a ` +
    `strict JSON object mapping each id (the string after #) to its writeup string. ` +
    `No other text.\n\n${items}`;
  return { system: SYSTEM, user };
}

// --- CLI ---------------------------------------------------------------------
async function main() {
  const args = process.argv.slice(2);
  const city = args.find((a) => !a.startsWith("--"));
  if (!city) { console.error("usage: node tools/write-up.js <city> [--dry|--apply]"); process.exit(1); }

  const spots = JSON.parse(fs.readFileSync(SPOTS, "utf8"));
  const byId = new Map(spots.map((s) => [s.id, s]));

  // --apply: promote a reviewed draft file into spots.json + mark ids "d"
  if (args.includes("--apply")) {
    const file = path.join(DRAFT_DIR, `${city}.json`);
    if (!fs.existsSync(file)) { console.error(`no review file ${path.relative(ROOT, file)} — run the writer first.`); process.exit(1); }
    const drafts = JSON.parse(fs.readFileSync(file, "utf8"));
    const force = args.includes("--force");
    let applied = 0; const ids = [];
    for (const d of drafts) {
      const s = byId.get(d.id);
      if (!s) continue;
      if (Q.isAuthored(s.id)) { console.error(`  skip ${d.id}: already authored (never overwrite your voice)`); continue; }
      if (d._issues && d._issues.length && !force) { console.error(`  skip ${d.id}: ${d._issues.join("; ")} (use --force to apply anyway)`); continue; }
      s.w = d.w; applied++; ids.push(d.id);
    }
    fs.writeFileSync(SPOTS, JSON.stringify(spots, null, 1) + "\n");
    if (ids.length) Q.setFlags(ids, "d");
    console.log(`applied ${applied} draft(s) → data/spots.json (flagged "d" — pending your review).`);
    console.log(`next: read the diff; for approved ones: node tools/quality.js --promote ; then npm run build.`);
    return;
  }

  // gather the dossier
  const dfile = path.join(DOSSIER_DIR, `${city}.json`);
  if (!fs.existsSync(dfile)) {
    console.error(`no dossier at ${path.relative(ROOT, dfile)}.`);
    console.error(`make one: node tools/dossier.js template ${city}  → fill facts+sources → rename to ${city}.json`);
    process.exit(1);
  }
  const D = require("./dossier");
  const dossier = JSON.parse(fs.readFileSync(dfile, "utf8"));
  const v = D.validate(dossier);
  if (!v.ok) { console.error("✗ dossier invalid:"); v.errors.forEach((e) => console.error("  - " + e)); process.exit(1); }

  const shots = exemplars(6);
  const { system, user } = buildPrompt(dossier, byId, shots);

  if (args.includes("--dry")) {
    console.log("=== SYSTEM ===\n" + system + "\n\n=== USER ===\n" + user);
    console.error(`\n--dry: no API call. ${dossier.length} spot(s), ${shots.length} exemplars, model ${MODEL}.`);
    return;
  }

  let Anthropic;
  try { Anthropic = require("@anthropic-ai/sdk"); }
  catch { console.error("✗ install the SDK:  npm install @anthropic-ai/sdk"); process.exit(1); }
  if (!process.env.ANTHROPIC_API_KEY) { console.error("✗ set ANTHROPIC_API_KEY"); process.exit(1); }
  const client = new Anthropic();

  const msg = await client.messages.create({
    model: MODEL, max_tokens: 4000, system,
    messages: [{ role: "user", content: user }],
  });
  const text = (msg.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
  let json;
  try { json = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)); }
  catch { console.error("✗ could not parse model output:\n" + text.slice(0, 400)); process.exit(1); }

  const out = [];
  for (const d of dossier) {
    const w = json[d.id] && String(json[d.id]).trim();
    if (!w) continue;
    out.push({ id: d.id, n: d.n || (byId.get(d.id) || {}).n, w, _issues: checkSpec(w), confidence: d.confidence || "" });
  }
  fs.mkdirSync(DRAFT_DIR, { recursive: true });
  const file = path.join(DRAFT_DIR, `${city}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 1) + "\n");
  const clean = out.filter((o) => !o._issues.length).length;
  console.log(`drafted ${out.length} (${clean} clean, ${out.length - clean} flagged) → ${path.relative(ROOT, file)}`);
  console.log(`review/edit, then: node tools/write-up.js ${city} --apply`);
}

main().catch((e) => { console.error("✗ " + e.message); process.exit(1); });
