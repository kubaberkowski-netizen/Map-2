#!/usr/bin/env node
/*
 * Flâneur build step.
 *
 * Source of truth for the spot catalogue is data/spots.json. This script
 * injects it back into src/app.template.html (at the placeholder that replaced
 * the inline `Z=[...]` array literal) and writes the deployed artifact index.html.
 *
 * It refuses to write anything unless every check passes:
 *   - spots.json is valid JSON, every entry has all required keys, no duplicate ids;
 *   - every entry's `c` is one of the category slugs DEFINED IN THE TEMPLATE's `ne`
 *     object (parsed, never hand-typed);
 *   - after injection the generated HTML still passes the CLAUDE.md recipe:
 *     inline <script> parses (node --check), and counts are 788 / 45 / 44.
 *
 * ne={slug:{l,e,t}} and Xr=[{...,match:e=>…}] stay inline in the template,
 * untouched. Only `Z` is data-driven.
 */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const acorn = require("acorn");

const ROOT = __dirname;
const TEMPLATE = path.join(ROOT, "src", "app.template.html");
const SPOTS = path.join(ROOT, "data", "spots.json");
const OUTPUT = path.join(ROOT, "index.html");
const PLACEHOLDER = "[]/*__FLANEUR_SPOTS__*/";
const REQUIRED = ["id", "n", "a", "pc", "lat", "lng", "c", "s", "q", "w", "city"];
const BASELINE = { entries: 787, worlds: 45, categories: 44 };

function die(msg) {
  console.error("✗ build aborted (nothing written): " + msg);
  process.exit(1);
}

// --- read template + extract the inline <script> body ------------------------
const template = fs.readFileSync(TEMPLATE, "utf8");
const sOpen = template.indexOf("<script>");
const sClose = template.indexOf("</script>", sOpen + 8);
if (sOpen < 0 || sClose < 0) die("could not locate inline <script> in template");
const scriptBody = template.slice(sOpen + 8, sClose);

// --- derive valid category slugs by PARSING the template's `ne` object -------
function parseNeSlugs(src) {
  const ast = acorn.parse(src, { ecmaVersion: "latest" });
  let slugs = null;
  (function walk(n) {
    if (!n || typeof n.type !== "string" || slugs) return;
    if (
      n.type === "VariableDeclarator" &&
      n.id && n.id.name === "ne" &&
      n.init && n.init.type === "ObjectExpression"
    ) {
      slugs = new Set(
        n.init.properties
          .filter((p) => p.type === "Property")
          .map((p) => (p.key.name != null ? p.key.name : p.key.value))
      );
      return;
    }
    for (const k in n) {
      const v = n[k];
      if (Array.isArray(v)) v.forEach((c) => c && typeof c.type === "string" && walk(c));
      else if (v && typeof v.type === "string") walk(v);
    }
  })(ast);
  return slugs;
}
const validSlugs = parseNeSlugs(scriptBody);
if (!validSlugs || validSlugs.size === 0) die("could not parse `ne` category slugs from template");
if (validSlugs.size !== BASELINE.categories)
  console.warn(`⚠ template defines ${validSlugs.size} category slugs (baseline ${BASELINE.categories})`);

// --- derive valid city slugs by PARSING the template's `Ci` registry ---------
function parseCiSlugs(src) {
  const ast = acorn.parse(src, { ecmaVersion: "latest" });
  let slugs = null;
  (function walk(n) {
    if (!n || typeof n.type !== "string" || slugs) return;
    if (
      n.type === "VariableDeclarator" &&
      n.id && n.id.name === "Ci" &&
      n.init && n.init.type === "ArrayExpression"
    ) {
      slugs = new Set(
        n.init.elements
          .filter((el) => el && el.type === "ObjectExpression")
          .map((el) => {
            const idp = el.properties.find(
              (p) => p.type === "Property" && (p.key.name === "id" || p.key.value === "id")
            );
            return idp && idp.value && idp.value.value;
          })
          .filter(Boolean)
      );
      return;
    }
    for (const k in n) {
      const v = n[k];
      if (Array.isArray(v)) v.forEach((c) => c && typeof c.type === "string" && walk(c));
      else if (v && typeof v.type === "string") walk(v);
    }
  })(ast);
  return slugs;
}
const validCities = parseCiSlugs(scriptBody);
if (!validCities || validCities.size === 0) die("could not parse `Ci` city registry from template");

// --- read + validate spots.json ----------------------------------------------
let spots;
try {
  spots = JSON.parse(fs.readFileSync(SPOTS, "utf8"));
} catch (e) {
  die("data/spots.json is not valid JSON — " + e.message);
}
if (!Array.isArray(spots)) die("data/spots.json must be a JSON array");

const seen = new Set();
spots.forEach((e, i) => {
  if (e === null || typeof e !== "object" || Array.isArray(e))
    die(`entry #${i} is not an object`);
  for (const k of REQUIRED)
    if (!(k in e)) die(`entry #${i} (id=${JSON.stringify(e.id)}) is missing required key "${k}"`);
  if (seen.has(e.id)) die(`duplicate id ${JSON.stringify(e.id)}`);
  seen.add(e.id);
  if (!validSlugs.has(e.c))
    die(`entry ${JSON.stringify(e.id)} has unknown category slug ${JSON.stringify(e.c)} ` +
        `(reads ne[c] unguarded → white-screen). Valid: ${[...validSlugs].join(", ")}`);
  if (!validCities.has(e.city))
    die(`entry ${JSON.stringify(e.id)} has unknown city ${JSON.stringify(e.city)} ` +
        `(not in the Ci registry). Valid: ${[...validCities].join(", ")}`);
});
if (spots.length !== BASELINE.entries)
  console.warn(`⚠ entry count is ${spots.length} (baseline ${BASELINE.entries}) — confirm this is intended`);

// --- serialise back to the ORIGINAL compact JS object-literal style ----------
// (unquoted keys in the original field order; string values via JSON.stringify;
//  numbers raw) so the deployed file matches the minified bundle's shape and the
//  CLAUDE.md `id:"…",n:"` count check keeps working.
const num = (v) => (typeof v === "number" ? String(v) : JSON.stringify(v));
const literal =
  "[" +
  spots
    .map(
      (e) =>
        "{" +
        REQUIRED.map((k) =>
          k === "lat" || k === "lng" ? `${k}:${num(e[k])}` : `${k}:${JSON.stringify(e[k])}`
        ).join(",") +
        "}"
    )
    .join(",") +
  "]";

// --- inject at the placeholder (must appear exactly once) --------------------
const occ = template.split(PLACEHOLDER).length - 1;
if (occ !== 1) die(`expected exactly 1 placeholder in template, found ${occ}`);
const output = template.replace(PLACEHOLDER, literal);

// --- validate the GENERATED html IN MEMORY before writing --------------------
function check(out) {
  const o = out.indexOf("<script>");
  const c = out.indexOf("</script>", o + 8);
  const body = out.slice(o + 8, c);

  // node --check (CLAUDE.md recipe) on a temp file
  const tmp = path.join(require("os").tmpdir(), "flaneur-build-check.js");
  fs.writeFileSync(tmp, body);
  try {
    execFileSync(process.execPath, ["--check", tmp], { stdio: "pipe" });
  } catch (e) {
    fs.unlinkSync(tmp);
    die("generated <script> failed `node --check`:\n" + (e.stderr || e).toString());
  }
  fs.unlinkSync(tmp);

  const entries = (out.match(/id:"[^"]*",n:"/g) || []).length;
  const worlds = (out.match(/match:\s*e\s*=>/g) || []).length;
  const categories = (out.match(/[A-Za-z0-9_]+:\{l:"/g) || []).length;
  if (entries !== BASELINE.entries) die(`generated entry count ${entries} ≠ ${BASELINE.entries}`);
  if (worlds !== BASELINE.worlds) die(`generated Worlds count ${worlds} ≠ ${BASELINE.worlds}`);
  if (categories !== BASELINE.categories) die(`generated category count ${categories} ≠ ${BASELINE.categories}`);

  // confirm Z really has the right number of elements via a real parse
  const ast = acorn.parse(body, { ecmaVersion: "latest" });
  let zlen = -1;
  (function walk(n) {
    if (!n || typeof n.type !== "string") return;
    if (n.type === "VariableDeclarator" && n.id && n.id.name === "Z" &&
        n.init && n.init.type === "ArrayExpression") zlen = n.init.elements.length;
    for (const k in n) {
      const v = n[k];
      if (Array.isArray(v)) v.forEach((x) => x && typeof x.type === "string" && walk(x));
      else if (v && typeof v.type === "string") walk(v);
    }
  })(ast);
  if (zlen !== spots.length) die(`parsed Z has ${zlen} elements, expected ${spots.length}`);
  return { entries, worlds, categories };
}
const counts = check(output);

// --- all green: write -------------------------------------------------------
fs.writeFileSync(OUTPUT, output);
console.log(
  `✓ wrote ${path.relative(ROOT, OUTPUT)} — ` +
    `${spots.length} spots / ${counts.worlds} Worlds / ${counts.categories} categories, node --check OK`
);
