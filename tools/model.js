"use strict";
/*
 * tools/model.js — the Flâneur data model, parsed live from the real sources.
 *
 * This is the trustworthy core every tool in tools/ shares. It NEVER hand-types
 * the category slugs or city bboxes: it parses them out of src/app.template.html
 * with acorn (exactly like build.js), and reads the existing catalogue from
 * data/spots.json. That way a candidate the pipeline emits is validated against
 * the same rules build.js will later enforce — if it passes here it will not
 * white-screen the app or be rejected at build time.
 *
 * Exposes: loadModel(), loadCatalogue(), slugify(), uniqueId(), haversineM(),
 * cityForPoint(), validateRow(), findDuplicate(), REQUIRED, BBOX_MARGIN.
 */
const fs = require("fs");
const path = require("path");
const acorn = require("acorn");

const ROOT = path.join(__dirname, "..");
const TEMPLATE = path.join(ROOT, "src", "app.template.html");
const SPOTS = path.join(ROOT, "data", "spots.json");

// Mirror build.js exactly so "valid here" == "valid at build time".
const REQUIRED = ["id", "n", "a", "pc", "lat", "lng", "c", "s", "q", "w", "city"];
const BBOX_MARGIN = 0.1; // same ±0.1° gross-typo guard build.js uses

// --- generic acorn helpers ---------------------------------------------------
function scriptBodyOf(html) {
  const o = html.indexOf("<script>");
  const c = html.indexOf("</script>", o + 8);
  if (o < 0 || c < 0) throw new Error("could not locate inline <script> in template");
  return html.slice(o + 8, c);
}
function numOf(node) {
  if (!node) return null;
  if (node.type === "Literal" && typeof node.value === "number") return node.value;
  if (node.type === "UnaryExpression" && node.operator === "-") {
    const v = numOf(node.argument);
    return v == null ? null : -v;
  }
  return null;
}
function findDeclarator(ast, name, initType) {
  let hit = null;
  (function walk(n) {
    if (!n || typeof n.type !== "string" || hit) return;
    if (
      n.type === "VariableDeclarator" && n.id && n.id.name === name &&
      n.init && (!initType || n.init.type === initType)
    ) {
      hit = n;
      return;
    }
    for (const k in n) {
      const v = n[k];
      if (Array.isArray(v)) v.forEach((c) => c && typeof c.type === "string" && walk(c));
      else if (v && typeof v.type === "string") walk(v);
    }
  })(ast);
  return hit;
}

/**
 * Parse the live model out of the template: category slugs + the city registry
 * (id, display name, bbox, centre). Cached after first call.
 */
let _model = null;
function loadModel() {
  if (_model) return _model;
  const body = scriptBodyOf(fs.readFileSync(TEMPLATE, "utf8"));
  const ast = acorn.parse(body, { ecmaVersion: "latest" });

  const neDecl = findDeclarator(ast, "ne", "ObjectExpression");
  if (!neDecl || !neDecl.init || neDecl.init.type !== "ObjectExpression")
    throw new Error("could not parse `ne` category slugs from template");
  const categories = new Set(
    neDecl.init.properties
      .filter((p) => p.type === "Property")
      .map((p) => (p.key.name != null ? p.key.name : p.key.value))
  );

  const ciDecl = findDeclarator(ast, "Ci", "ArrayExpression");
  if (!ciDecl || !ciDecl.init || ciDecl.init.type !== "ArrayExpression")
    throw new Error("could not parse `Ci` city registry from template");
  const cities = ciDecl.init.elements
    .filter((el) => el && el.type === "ObjectExpression")
    .map((el) => {
      const get = (name) =>
        el.properties.find(
          (p) => p.type === "Property" && (p.key.name === name || p.key.value === name)
        );
      const id = get("id"), nm = get("name"), bb = get("bbox");
      const bbox = bb && bb.value.type === "ArrayExpression" ? bb.value.elements.map(numOf) : null;
      return {
        id: id && id.value && id.value.value,
        name: nm && nm.value && nm.value.value,
        bbox, // [minLng, minLat, maxLng, maxLat]
        centre: bbox ? [(bbox[1] + bbox[3]) / 2, (bbox[0] + bbox[2]) / 2] : null, // [lat,lng]
      };
    })
    .filter((c) => c.id && c.bbox && c.bbox.length === 4 && c.bbox.every((x) => x != null));

  const cityById = new Map(cities.map((c) => [c.id, c]));
  _model = { categories, cities, cityById };
  return _model;
}

/**
 * Load the existing catalogue + dedup indexes (ids, name|city keys, points/city).
 */
function loadCatalogue() {
  const spots = JSON.parse(fs.readFileSync(SPOTS, "utf8"));
  const ids = new Set(spots.map((s) => s.id));
  const nameCity = new Set(spots.map((s) => s.city + "|" + norm(s.n)));
  const pointsByCity = new Map();
  for (const s of spots) {
    if (!pointsByCity.has(s.city)) pointsByCity.set(s.city, []);
    pointsByCity.get(s.city).push({ id: s.id, n: s.n, lat: s.lat, lng: s.lng });
  }
  return { spots, ids, nameCity, pointsByCity };
}

// --- string / geo helpers ----------------------------------------------------
const norm = (s) => String(s).toLowerCase().replace(/\s+/g, " ").trim();

/** Build an id slug in the catalogue's house style ("heathrobinson"). */
function slugify(name) {
  return String(name)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip accents (Café -> Cafe)
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "")
    .slice(0, 24) || "spot";
}
/** Ensure a slug is unique against a taken-set, suffixing 2,3,… as needed. */
function uniqueId(base, taken) {
  let id = base, i = 2;
  while (taken.has(id)) id = base + i++;
  taken.add(id);
  return id;
}

const R = 6371000;
const rad = (d) => (d * Math.PI) / 180;
function haversineM(aLat, aLng, bLat, bLng) {
  const dLat = rad(bLat - aLat), dLng = rad(bLng - aLng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/**
 * Which city does a coordinate belong to? Returns the city id whose bbox (with
 * margin) contains the point; if several do, the one whose centre is nearest.
 * null if the point is outside every city — those candidates are dropped.
 */
function cityForPoint(lat, lng, model = loadModel()) {
  const inside = model.cities.filter(
    (c) =>
      lng >= c.bbox[0] - BBOX_MARGIN &&
      lng <= c.bbox[2] + BBOX_MARGIN &&
      lat >= c.bbox[1] - BBOX_MARGIN &&
      lat <= c.bbox[3] + BBOX_MARGIN
  );
  if (!inside.length) return null;
  if (inside.length === 1) return inside[0].id;
  return inside
    .map((c) => ({ id: c.id, d: haversineM(lat, lng, c.centre[0], c.centre[1]) }))
    .sort((a, b) => a.d - b.d)[0].id;
}

/**
 * Validate a finished row against the SAME rules build.js applies. Returns
 * { ok, errors[] }. An empty `w` is allowed (the owner writes it later) — but a
 * blank category or out-of-bbox coordinate is fatal, just as at build time.
 */
function validateRow(row, model = loadModel()) {
  const errors = [];
  for (const k of REQUIRED) if (!(k in row)) errors.push(`missing key "${k}"`);
  if (row.c != null && !model.categories.has(row.c))
    errors.push(`unknown category "${row.c}" (not one of the ${model.categories.size} ne slugs)`);
  if (row.city != null && !model.cityById.has(row.city))
    errors.push(`unknown city "${row.city}" (not in Ci registry)`);
  if (!Number.isFinite(row.lat) || !Number.isFinite(row.lng) || row.lat === 0 || row.lng === 0)
    errors.push(`non-finite or zero coordinate (lat ${row.lat}, lng ${row.lng})`);
  const city = model.cityById.get(row.city);
  if (city && Number.isFinite(row.lat) && Number.isFinite(row.lng)) {
    const b = city.bbox;
    const ok =
      row.lng >= b[0] - BBOX_MARGIN && row.lng <= b[2] + BBOX_MARGIN &&
      row.lat >= b[1] - BBOX_MARGIN && row.lat <= b[3] + BBOX_MARGIN;
    if (!ok) errors.push(`coord outside city "${row.city}" bbox — likely a geocoding error`);
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Is this candidate already in (or too close to) the catalogue? Checks id
 * collision, same name within the city, and proximity (default 120 m within the
 * same city — same place, slightly different geocode). Returns a reason or null.
 */
function findDuplicate(cand, cat, { proximityM = 120 } = {}) {
  if (cand.id && cat.ids.has(cand.id)) return `id "${cand.id}" already exists`;
  if (cand.city && cand.n && cat.nameCity.has(cand.city + "|" + norm(cand.n)))
    return `name "${cand.n}" already in ${cand.city}`;
  if (cand.city && Number.isFinite(cand.lat) && Number.isFinite(cand.lng)) {
    for (const p of cat.pointsByCity.get(cand.city) || []) {
      const d = haversineM(cand.lat, cand.lng, p.lat, p.lng);
      if (d < proximityM) return `${Math.round(d)} m from existing "${p.n}" (${p.id})`;
    }
  }
  return null;
}

module.exports = {
  REQUIRED, BBOX_MARGIN,
  loadModel, loadCatalogue,
  slugify, uniqueId, norm,
  haversineM, cityForPoint,
  validateRow, findDuplicate,
};
