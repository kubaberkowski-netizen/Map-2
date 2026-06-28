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
const BASELINE = { entries: 9367, worlds: 80, categories: 43 };

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

// --- derive each city's bbox [minLng,minLat,maxLng,maxLat] from `Ci` ----------
// (used to catch coordinate typos — a spot whose lat/lng lands far outside its
//  own city is almost certainly mistyped, and would mis-place it + break the
//  nearest-city detection that keys off these bboxes.)
function parseCiBboxes(src) {
  const ast = acorn.parse(src, { ecmaVersion: "latest" });
  const numOf = (node) => {
    if (!node) return null;
    if (node.type === "Literal" && typeof node.value === "number") return node.value;
    if (node.type === "UnaryExpression" && node.operator === "-") {
      const v = numOf(node.argument);
      return v == null ? null : -v;
    }
    return null;
  };
  const out = new Map();
  (function walk(n) {
    if (!n || typeof n.type !== "string") return;
    if (
      n.type === "VariableDeclarator" && n.id && n.id.name === "Ci" &&
      n.init && n.init.type === "ArrayExpression"
    ) {
      for (const el of n.init.elements) {
        if (!el || el.type !== "ObjectExpression") continue;
        const get = (name) =>
          el.properties.find((p) => p.type === "Property" && (p.key.name === name || p.key.value === name));
        const idp = get("id"), bbp = get("bbox");
        if (idp && idp.value && bbp && bbp.value && bbp.value.type === "ArrayExpression") {
          const bb = bbp.value.elements.map(numOf);
          if (bb.length === 4 && bb.every((x) => x != null)) out.set(idp.value.value, bb);
        }
      }
      return;
    }
    for (const k in n) {
      const v = n[k];
      if (Array.isArray(v)) v.forEach((c) => c && typeof c.type === "string" && walk(c));
      else if (v && typeof v.type === "string") walk(v);
    }
  })(ast);
  return out;
}
const cityBboxes = parseCiBboxes(scriptBody);
// gross-typo guard only: a generous margin (~11 km) tolerates legitimate
// metro-edge spots while still catching wrong-city / sign-flip / transposed coords.
const BBOX_MARGIN = 0.1;

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
  if (!Number.isFinite(e.lat) || !Number.isFinite(e.lng) || e.lat === 0 || e.lng === 0)
    die(`entry ${JSON.stringify(e.id)} has a non-finite or zero coordinate (lat ${JSON.stringify(e.lat)}, lng ${JSON.stringify(e.lng)})`);
  const bb = cityBboxes.get(e.city);
  if (bb && !(
    e.lng >= bb[0] - BBOX_MARGIN && e.lng <= bb[2] + BBOX_MARGIN &&
    e.lat >= bb[1] - BBOX_MARGIN && e.lat <= bb[3] + BBOX_MARGIN
  ))
    die(`entry ${JSON.stringify(e.id)} coord (lat ${e.lat}, lng ${e.lng}) is outside its city ` +
        `"${e.city}" bbox [${bb.join(",")}] (±${BBOX_MARGIN}°) — almost certainly a coordinate typo`);
});
if (spots.length !== BASELINE.entries)
  console.warn(`⚠ entry count is ${spots.length} (baseline ${BASELINE.entries}) — confirm this is intended`);

// --- non-fatal data-quality audit (warn, never block) ------------------------
// duplicate names within the same city (likely the same place entered twice)
const byName = new Map();
spots.forEach((e) => {
  const key = e.city + "|" + String(e.n).toLowerCase().trim();
  if (!byName.has(key)) byName.set(key, []);
  byName.get(key).push(e.id);
});
const dupNames = [...byName.entries()].filter(([, ids]) => ids.length > 1);
if (dupNames.length) {
  console.warn(`⚠ ${dupNames.length} duplicate name(s) within a city (possible duplicate spots):`);
  for (const [key, ids] of dupNames)
    console.warn(`    ${key.split("|")[1]} [${key.split("|")[0]}] → ${ids.join(", ")}`);
}

// empty writeups — the writeup is the product; surface how many are unwritten
const empties = spots.filter((e) => !String(e.w).trim());
if (empties.length) {
  const byCity = {};
  for (const e of empties) byCity[e.city] = (byCity[e.city] || 0) + 1;
  const breakdown = Object.entries(byCity).map(([c, n]) => `${c} ${n}`).join(", ");
  console.warn(`⚠ ${empties.length}/${spots.length} spots have an empty writeup (${breakdown})`);
}

// --- optional opening-hours sidecar (data/hours.json) ------------------------
// Researched OSM opening_hours, kept OUT of spots.json (see data/hours-research.md).
// Merged here by id as an extra `oh` field on each spot literal; spots without a
// match simply have no `oh`. The field is additive — it never changes the
// id:"…",n:" entry-count signature the recipe below checks.
const HOURS = path.join(ROOT, "data", "hours.json");
let hoursById = {};
if (fs.existsSync(HOURS)) {
  let hj;
  try {
    hj = JSON.parse(fs.readFileSync(HOURS, "utf8"));
  } catch (e) {
    die("data/hours.json is not valid JSON — " + e.message);
  }
  hoursById = (hj && hj.hours) || {};
  // a stray hours entry for a non-existent spot is a sign the sidecar drifted
  for (const id of Object.keys(hoursById))
    if (!seen.has(id)) console.warn(`⚠ data/hours.json has hours for unknown spot id ${JSON.stringify(id)}`);
}

// --- serialise back to the ORIGINAL compact JS object-literal style ----------
// (unquoted keys in the original field order; string values via JSON.stringify;
//  numbers raw) so the deployed file matches the minified bundle's shape and the
//  CLAUDE.md `id:"…",n:"` count check keeps working.
const num = (v) => (typeof v === "number" ? String(v) : JSON.stringify(v));
let withHours = 0;
const literal =
  "[" +
  spots
    .map((e) => {
      const base = REQUIRED.map((k) =>
        k === "lat" || k === "lng" ? `${k}:${num(e[k])}` : `${k}:${JSON.stringify(e[k])}`
      ).join(",");
      const oh = hoursById[e.id] && hoursById[e.id].h;
      if (oh) withHours++;
      return "{" + base + (oh ? `,oh:${JSON.stringify(oh)}` : "") + "}";
    })
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
    `${spots.length} spots / ${counts.worlds} Worlds / ${counts.categories} categories, ` +
    `${withHours} with opening hours, node --check OK`
);

// --- SEO: static, crawlable landing pages (portable — pure data → HTML) ------
// One page per city + an explore hub + sitemap/robots. These are plain static
// files generated from data/spots.json, so they survive a move off GitHub Pages
// unchanged (only SITE below needs updating, or set $SITE_URL at build time).
try {
  genSeo();
} catch (e) {
  console.warn("⚠ SEO page generation skipped (non-fatal): " + (e && e.message));
}

function parseObjArrayMeta(src, varName, fields) {
  const ast = acorn.parse(src, { ecmaVersion: "latest" });
  const strOf = (n) => (n && n.type === "Literal" ? n.value : undefined);
  const out = new Map();
  (function walk(n) {
    if (!n || typeof n.type !== "string") return;
    if (n.type === "VariableDeclarator" && n.id && n.id.name === varName &&
        n.init && n.init.type === "ArrayExpression") {
      for (const el of n.init.elements) {
        if (!el || el.type !== "ObjectExpression") continue;
        const get = (name) => {
          const p = el.properties.find((p) => p.type === "Property" && (p.key.name === name || p.key.value === name));
          return p ? strOf(p.value) : undefined;
        };
        const id = get("id");
        if (id == null) continue;
        const rec = {};
        for (const f of fields) rec[f] = get(f);
        out.set(id, rec);
      }
      return;
    }
    for (const k in n) {
      const v = n[k];
      if (Array.isArray(v)) v.forEach((c) => c && typeof c.type === "string" && walk(c));
      else if (v && typeof v.type === "string") walk(v);
    }
  })(ast);
  return out;
}
function parseNeMeta(src) {
  const ast = acorn.parse(src, { ecmaVersion: "latest" });
  const strOf = (n) => (n && n.type === "Literal" ? n.value : undefined);
  let out = new Map();
  (function walk(n) {
    if (!n || typeof n.type !== "string" || out.size) return;
    if (n.type === "VariableDeclarator" && n.id && n.id.name === "ne" &&
        n.init && n.init.type === "ObjectExpression") {
      for (const p of n.init.properties) {
        if (p.type !== "Property" || !p.value || p.value.type !== "ObjectExpression") continue;
        const slug = p.key.name != null ? p.key.name : p.key.value;
        const g = (name) => {
          const q = p.value.properties.find((q) => q.type === "Property" && (q.key.name === name || q.key.value === name));
          return q ? strOf(q.value) : undefined;
        };
        out.set(slug, { l: g("l"), e: g("e") });
      }
      return;
    }
    for (const k in n) {
      const v = n[k];
      if (Array.isArray(v)) v.forEach((c) => c && typeof c.type === "string" && walk(c));
      else if (v && typeof v.type === "string") walk(v);
    }
  })(ast);
  return out;
}

function genSeo() {
  const SITE = (process.env.SITE_URL || "https://kubaberkowski-netizen.github.io/map-2").replace(/\/+$/, "");
  const ciMeta = parseObjArrayMeta(scriptBody, "Ci", ["name", "label", "blurb", "e"]);
  const neMeta = parseNeMeta(scriptBody);
  const esc = (t) => String(t == null ? "" : t).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const catLabel = (c) => (neMeta.get(c) && neMeta.get(c).l) || c;
  const catEmoji = (c) => (neMeta.get(c) && neMeta.get(c).e) || "•";

  const byCity = new Map();
  for (const e of spots) {
    if (!byCity.has(e.city)) byCity.set(e.city, []);
    byCity.get(e.city).push(e);
  }
  const cityList = [...byCity.keys()]
    .map((id) => ({ id, n: byCity.get(id).length, name: (ciMeta.get(id) && ciMeta.get(id).name) || id }))
    .sort((a, b) => b.n - a.n);

  const CSS = `:root{--bg:#FAF8F3;--surface:#fff;--ink:#2C2522;--ink2:#5C524A;--ink3:#736A5E;--line:#E7E0D4;--accent:#C8372D}
*{box-sizing:border-box}html,body{margin:0;background:var(--bg);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;line-height:1.55;-webkit-text-size-adjust:100%}
.wrap{max-width:780px;margin:0 auto;padding:24px 18px 64px}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
.brand{display:inline-flex;align-items:center;gap:8px;font-weight:800;font-size:15px;color:var(--ink);margin-bottom:22px}.brand .dot{width:9px;height:9px;border-radius:50%;background:var(--accent)}
h1{font-family:Georgia,serif;font-size:32px;line-height:1.12;margin:0 0 10px}
.lede{font-size:16px;color:var(--ink2);margin:0 0 18px}
.cta{display:inline-block;background:var(--accent);color:#fff;border-radius:11px;padding:11px 18px;font-weight:700;font-size:15px;margin:4px 0 26px}.cta:hover{text-decoration:none;opacity:.94}
h2{font-size:15px;letter-spacing:.04em;text-transform:uppercase;color:var(--ink3);border-bottom:1px solid var(--line);padding-bottom:7px;margin:30px 0 12px}
ul.spots{list-style:none;margin:0;padding:0}
ul.spots li{padding:11px 0;border-bottom:1px solid var(--line)}
.sname{font-weight:700;font-size:16px}.sarea{color:var(--ink3);font-size:13px;font-weight:400;margin-left:6px}
.shook{color:var(--ink2);font-size:14px;margin-top:2px}
.more{color:var(--ink3);font-size:14px;font-style:italic;padding:12px 0}
.cities{display:flex;flex-wrap:wrap;gap:8px;margin:8px 0 0}
.cities a{background:var(--surface);border:1px solid var(--line);border-radius:999px;padding:6px 12px;font-size:13px;color:var(--ink2)}
.foot{margin-top:40px;padding-top:18px;border-top:1px solid var(--line);font-size:13px;color:var(--ink3)}`;

  const page = (opts) => `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="robots" content="index,follow" />
<title>${esc(opts.title)}</title>
<meta name="description" content="${esc(opts.desc)}" />
<link rel="canonical" href="${esc(opts.canonical)}" />
<meta property="og:type" content="website" /><meta property="og:site_name" content="Flâneur" />
<meta property="og:title" content="${esc(opts.title)}" /><meta property="og:description" content="${esc(opts.desc)}" />
<meta property="og:url" content="${esc(opts.canonical)}" />
<style>${CSS}</style>
</head><body><div class="wrap">${opts.body}<div class="foot">${opts.foot}</div></div></body></html>
`;

  const cityDir = path.join(ROOT, "city");
  if (!fs.existsSync(cityDir)) fs.mkdirSync(cityDir, { recursive: true });
  const CAP = 400; // spots listed per city page; the rest live in the app

  let written = 0;
  for (const c of cityList) {
    const meta = ciMeta.get(c.id) || {};
    const cname = meta.name || c.id;
    const list = byCity.get(c.id).slice().sort((a, b) => String(a.n).localeCompare(String(b.n)));
    // group by category, biggest groups first
    const groups = new Map();
    for (const e of list) {
      if (!groups.has(e.c)) groups.set(e.c, []);
      groups.get(e.c).push(e);
    }
    const orderedCats = [...groups.keys()].sort((a, b) => groups.get(b).length - groups.get(a).length);
    const topCats = orderedCats.slice(0, 4).map(catLabel).join(", ");
    let shown = 0, bodyCats = "";
    for (const cat of orderedCats) {
      if (shown >= CAP) break;
      const items = groups.get(cat).slice(0, CAP - shown);
      shown += items.length;
      bodyCats += `<h2>${esc(catEmoji(cat))} ${esc(catLabel(cat))} · ${groups.get(cat).length}</h2><ul class="spots">` +
        items.map((e) =>
          `<li><a href="../index.html#spot=${encodeURIComponent(e.id)}"><span class="sname">${esc(e.n)}</span>` +
          `${e.a ? `<span class="sarea">${esc(e.a)}</span>` : ""}</a>` +
          `${e.s ? `<div class="shook">${esc(e.s)}</div>` : ""}</li>`
        ).join("") + `</ul>`;
    }
    const remaining = list.length - shown;
    if (remaining > 0) bodyCats += `<p class="more">…and ${remaining} more in ${esc(cname)} — <a href="../index.html">open the app</a>.</p>`;
    const otherCities = cityList.filter((x) => x.id !== c.id).slice(0, 30)
      .map((x) => `<a href="${esc(x.id)}.html">${esc(x.name)}</a>`).join("");
    const desc = `${list.length} hand-picked offbeat and storied places in ${cname}${topCats ? ` — ${topCats}` : ""}. A personal, ad-free guide you can sort by distance from where you are.`;
    const body =
      `<a class="brand" href="../index.html"><span class="dot"></span>Flâneur</a>` +
      `<h1>Offbeat &amp; storied places in ${esc(cname)}</h1>` +
      `<p class="lede">${esc(desc)}${meta.blurb ? " " + esc(meta.blurb) : ""}</p>` +
      `<a class="cta" href="../index.html">Open ${esc(cname)} in the app →</a>` +
      bodyCats +
      `<h2>More cities</h2><div class="cities">${otherCities}</div>`;
    const foot = `<a href="../index.html">Flâneur</a> — a personal guide to the offbeat, sorted by distance. · <a href="../explore.html">All cities</a> · <a href="../privacy.html">Privacy</a>`;
    fs.writeFileSync(path.join(cityDir, c.id + ".html"),
      page({ title: `${cname} — offbeat & storied places | Flâneur`, desc, canonical: `${SITE}/city/${c.id}.html`, body, foot }));
    written++;
  }

  // explore hub
  const totalCities = cityList.length;
  const exploreBody =
    `<a class="brand" href="index.html"><span class="dot"></span>Flâneur</a>` +
    `<h1>Explore ${spots.length.toLocaleString("en")} offbeat places across ${totalCities} cities</h1>` +
    `<p class="lede">Flâneur is a personal, ad-free guide to storied, strange and overlooked places — sorted by distance from wherever you are. Pick a city:</p>` +
    `<a class="cta" href="index.html">Open the app →</a>` +
    `<h2>Cities</h2><ul class="spots">` +
    cityList.map((c) => `<li><a href="city/${esc(c.id)}.html"><span class="sname">${esc(c.name)}</span><span class="sarea">${c.n} places</span></a></li>`).join("") +
    `</ul>`;
  fs.writeFileSync(path.join(ROOT, "explore.html"),
    page({ title: `Explore ${spots.length.toLocaleString("en")} offbeat places across ${totalCities} cities | Flâneur`,
      desc: `A personal, ad-free guide to offbeat and storied places across ${totalCities} cities worldwide, sorted by distance from where you are.`,
      canonical: `${SITE}/explore.html`, body: exploreBody,
      foot: `<a href="index.html">Flâneur</a> · <a href="privacy.html">Privacy</a>` }));

  // sitemap + robots
  const urls = [`${SITE}/`, `${SITE}/explore.html`, `${SITE}/discover.html`].concat(cityList.map((c) => `${SITE}/city/${c.id}.html`));
  const sitemap = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    urls.map((u) => `  <url><loc>${esc(u)}</loc></url>`).join("\n") + `\n</urlset>\n`;
  fs.writeFileSync(path.join(ROOT, "sitemap.xml"), sitemap);
  const robots = `User-agent: *\nAllow: /\n\nSitemap: ${SITE}/sitemap.xml\n`;
  fs.writeFileSync(path.join(ROOT, "robots.txt"), robots);

  console.log(`✓ SEO — ${written} city pages + explore + sitemap (${urls.length} urls) · base ${SITE}`);
}
