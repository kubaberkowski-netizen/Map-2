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

const LOCAL_ONLY = args.includes("--local-only");

const spots = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "spots.json"), "utf8"));
const q = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "quality.json"), "utf8"));
const notable = new Set(q.notable || []);
const flags = q.flags || {};

/* ---- per-city local Wikipedia languages, derived from the Ci registry's flag
 * emoji (e:"🇪🇸" → ES → ["es"]). English-speaking countries map to [] so the
 * default en pass keeps covering them. City-id overrides handle multilingual
 * countries (Barcelona → ca before es, Montréal → fr, …). ---- */
const CC_LANGS = {
  ES: ["es"], AD: ["ca", "es"], FR: ["fr"], MC: ["fr"], BE: ["fr", "nl"], NL: ["nl"],
  DE: ["de"], AT: ["de"], CH: ["de", "fr", "it"], LU: ["fr", "de"], LI: ["de"],
  IT: ["it"], VA: ["it"], SM: ["it"], MT: [],
  PT: ["pt"], BR: ["pt"], MX: ["es"], AR: ["es"], CL: ["es"], CO: ["es"], PE: ["es"],
  UY: ["es"], EC: ["es"], BO: ["es"], PY: ["es"], VE: ["es"], CR: ["es"], PA: ["es"],
  GT: ["es"], SV: ["es"], HN: ["es"], NI: ["es"], CU: ["es"], DO: ["es"], PR: ["es"],
  JP: ["ja"], KR: ["ko"], CN: ["zh"], TW: ["zh"], HK: ["zh"], MO: ["zh"],
  PL: ["pl"], CZ: ["cs"], SK: ["sk"], HU: ["hu"], GR: ["el"], CY: ["el"], TR: ["tr"],
  SE: ["sv"], NO: ["no"], DK: ["da"], FI: ["fi"], IS: ["is"],
  EE: ["et"], LV: ["lv"], LT: ["lt"], RO: ["ro"], MD: ["ro"], BG: ["bg"],
  HR: ["hr"], RS: ["sr"], BA: ["hr", "sr"], SI: ["sl"], MK: ["mk"], AL: ["sq"], ME: ["sr"],
  UA: ["uk"], GE: ["ka"], AM: ["hy"], AZ: ["az"], RU: ["ru"], BY: ["ru"], KZ: ["ru"], UZ: ["ru"],
  TH: ["th"], VN: ["vi"], ID: ["id"], MY: ["ms"], KH: ["km"], LA: ["lo"], MM: ["my"],
  NP: ["ne"], LK: ["si"], BD: ["bn"], PK: ["ur"], IR: ["fa"], IL: ["he"],
  SA: ["ar"], AE: ["ar"], QA: ["ar"], KW: ["ar"], BH: ["ar"], OM: ["ar"], JO: ["ar"],
  LB: ["ar"], IQ: ["ar"], EG: ["ar"], MA: ["fr", "ar"], TN: ["fr", "ar"], DZ: ["fr", "ar"],
  SN: ["fr"], CI: ["fr"], ET: ["am"], MN: ["mn"],
};
const CITY_LANGS_OVERRIDE = {
  barcelona: ["ca", "es"], valencia: ["ca", "es"], bilbao: ["eu", "es"], sansebastian: ["eu", "es"],
  montreal: ["fr"], quebeccity: ["fr"], geneva: ["fr"], lausanne: ["fr"],
  zurich: ["de"], basel: ["de"], bern: ["de"], lugano: ["it"],
  brussels: ["fr", "nl"], antwerp: ["nl"], ghent: ["nl"], bruges: ["nl"],
};
function flagCC(e) {
  const cps = [...String(e || "")].map((ch) => ch.codePointAt(0)).filter((cp) => cp >= 0x1f1e6 && cp <= 0x1f1ff);
  if (cps.length < 2) return null;
  return String.fromCharCode(65 + cps[0] - 0x1f1e6, 65 + cps[1] - 0x1f1e6);
}
function cityLangMap() {
  const acorn = require("acorn");
  const tpl = fs.readFileSync(path.join(ROOT, "src", "app.template.html"), "utf8");
  const o = tpl.indexOf("<script>");
  const body = tpl.slice(o + 8, tpl.indexOf("</script>", o + 8));
  const ast = acorn.parse(body, { ecmaVersion: "latest" });
  const map = {};
  (function walk(n) {
    if (!n || typeof n.type !== "string") return;
    if (n.type === "VariableDeclarator" && n.id && n.id.name === "Ci" && n.init && n.init.type === "ArrayExpression") {
      for (const el of n.init.elements) {
        if (!el || el.type !== "ObjectExpression") continue;
        const get = (k) => {
          const p = el.properties.find((pp) => pp.type === "Property" && (pp.key.name === k || pp.key.value === k));
          return p && p.value && p.value.value;
        };
        const id = get("id");
        if (!id) continue;
        map[id] = CITY_LANGS_OVERRIDE[id] || CC_LANGS[flagCC(get("e"))] || [];
      }
      return;
    }
    for (const k of Object.keys(n)) {
      const v = n[k];
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v.type === "string") walk(v);
    }
  })(ast);
  return map;
}
const LANGS = cityLangMap();

let db = { generated: "", photos: {} };
if (fs.existsSync(OUT)) { try { db = JSON.parse(fs.readFileSync(OUT, "utf8")); } catch (e) { /* fresh */ } }
db.photos = db.photos || {};

const norm = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
  .replace(/[^a-z0-9 ]+/g, " ").replace(/\b(the|a|of|and|st|saint)\b/g, " ").replace(/\s+/g, " ").trim();
const toks = (s) => new Set(norm(s).split(" ").filter((t) => t.length > 2));
function titleMatch(a, b) {
  const ta = toks(a), tb = toks(b);
  if (ta.size && tb.size) {
    let hit = 0;
    for (const t of ta) if (tb.has(t)) hit++;
    if (hit >= Math.min(2, ta.size) || norm(b).includes(norm(a)) || norm(a).includes(norm(b))) return true;
  }
  // script-agnostic path: spot names outside London are often in local script
  // (ja/zh/ko/el/…), which norm() strips to nothing — compare NFKC-normalized,
  // punctuation-free strings by containment instead.
  const ua = normU(a), ub = normU(b);
  return ua.length >= 3 && ub.length >= 3 && (ua.includes(ub) || ub.includes(ua));
}
const normU = (s) => String(s || "").toLowerCase().normalize("NFKC")
  .replace(/[\s　]+/g, "")
  .replace(/[()\[\]（）「」『』【】・·.,'’"“”\-–—:;!?、。]/g, "");
const hav = (a, b) => {
  const R = 6371e3, p = Math.PI / 180, s1 = Math.sin((b.lat - a.lat) * p / 2), s2 = Math.sin((b.lng - a.lng) * p / 2);
  const x = s1 * s1 + Math.cos(a.lat * p) * Math.cos(b.lat * p) * s2 * s2;
  return 2 * R * Math.asin(Math.sqrt(x));
};
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const targets = spots.filter((z) =>
  typeof z.lat === "number" && typeof z.lng === "number" &&
  (notable.has(z.id) || flags[z.id] === "a" || flags[z.id] === "v") &&
  !(z.id in db.photos) && (!CITY || z.city === CITY) &&
  (!LOCAL_ONLY || (LANGS[z.city] || []).length > 0)
).slice(0, LIMIT);

console.log(`targets: ${targets.length} (have ${Object.keys(db.photos).length} already)`);

let done = 0, found = 0, saved = 0, errs = 0;
function persist() {
  db.generated = new Date().toISOString();
  fs.writeFileSync(OUT, JSON.stringify(db, null, 1));
  saved = done;
}
async function tryLang(z, lang) {
  // Non-en wikis: ask for langlinks so CJK/Cyrillic/Greek titles can be matched
  // against the spot's Latin name via their English interwiki title.
  const url = `https://${lang}.wikipedia.org/w/api.php?action=query&generator=geosearch` +
    `&ggscoord=${z.lat}%7C${z.lng}&ggsradius=160&ggslimit=20` +
    "&prop=pageimages%7Ccoordinates%7Clanglinks&lllang=en&lllimit=50" +
    "&piprop=thumbnail&pithumbsize=640&format=json&origin=*";
  let r = await fetch(url, UA);
  if (r.status === 429 || r.status === 403) { await delay(8000); r = await fetch(url, UA); }
  if (!r.ok) { errs++; return null; }
  const j = await r.json();
  const pages = j && j.query && j.query.pages ? Object.values(j.query.pages) : [];
  // title-match ONLY — a nearby geotagged photo of something else is worse
  // than no photo, so there is deliberately no proximity-only fallback.
  let best = null, bestD = Infinity;
  for (const p of pages) {
    if (!p.thumbnail || !p.thumbnail.source) continue;
    // no vector art: an SVG pageimage is a logo/coat of arms, not a photo.
    if (/\.svg(\/|$)/i.test(p.thumbnail.source) || /logo/i.test(p.thumbnail.source)) continue;
    // local-wiki thumbs must be Commons-hosted: guarantees a free license and
    // a valid commons.wikimedia.org/wiki/File: attribution link in the app.
    if (lang !== "en" && p.thumbnail.source.indexOf("/wikipedia/commons/") < 0) continue;
    const en = p.langlinks && p.langlinks[0] && (p.langlinks[0]["*"] || p.langlinks[0].title);
    if (!titleMatch(z.n, p.title) && !(en && titleMatch(z.n, en))) continue;
    const c = p.coordinates && p.coordinates[0];
    const d = c ? hav(z, { lat: c.lat, lng: c.lon }) : 500;
    if (d < bestD) { best = p; bestD = d; }
  }
  return best ? best.thumbnail.source : null;
}
async function one(z) {
  const langs = [...(LANGS[z.city] || [])];
  if (!LOCAL_ONLY) langs.push("en");
  try {
    for (const lang of langs) {
      const src = await tryLang(z, lang);
      if (src) { db.photos[z.id] = src; found++; break; }
      if (langs.length > 1) await delay(120);
    }
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
