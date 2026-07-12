#!/usr/bin/env node
"use strict";
/*
 * tools/add-parkrun.js — parkrun courses as catalogue spots + the grand-quest
 * registry (data/quests.json).
 *
 * Pulls the official parkrun event list (images.parkrun.com/events.json,
 * seriesid 1 = the Saturday 5k), keeps events that land inside an existing Ci
 * city bbox (or a region bbox: england/highlands), and appends them as
 * c:"parkrun" machine-stub spots. Also (re)writes data/quests.json:
 *   - the92        — every current English league ground (data/grounds92.json)
 *   - parkrun-gb   — GB courses added here; goal 100 (the Cowell Club)
 * build.js ships quests inside the fixtures sidecar (window.__FLFX.quests).
 * Re-runnable: skips events already in the catalogue by id.
 * Usage: node tools/add-parkrun.js [--dry]
 */
const fs = require("fs");
const path = require("path");
const acorn = require("acorn");
const ROOT = path.join(__dirname, "..");
const DRY = process.argv.includes("--dry");

const spots = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "spots.json"), "utf8"));
const seenIds = new Set(spots.map((z) => z.id));

function ciBoxes() {
  const tpl = fs.readFileSync(path.join(ROOT, "src", "app.template.html"), "utf8");
  const o = tpl.indexOf("<script>");
  const body = tpl.slice(o + 8, tpl.indexOf("</script>", o + 8));
  const ast = acorn.parse(body, { ecmaVersion: "latest" });
  const out = [];
  (function walk(n) {
    if (!n || typeof n.type !== "string") return;
    if (n.type === "VariableDeclarator" && n.id && n.id.name === "Ci" && n.init && n.init.type === "ArrayExpression") {
      for (const el of n.init.elements) {
        if (!el || el.type !== "ObjectExpression") continue;
        const get = (k) => { const p = el.properties.find((pp) => pp.type === "Property" && (pp.key.name === k || pp.key.value === k)); return p && p.value; };
        const idn = get("id"), bb = get("bbox"), reg = get("region");
        if (!idn || !bb || bb.type !== "ArrayExpression") continue;
        const num = (x) => (x.type === "UnaryExpression" ? -num(x.argument) : x.value);
        out.push({ id: idn.value, bbox: bb.elements.map(num), region: !!reg });
      }
      return;
    }
    for (const k of Object.keys(n)) { const v = n[k]; if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v.type === "string") walk(v); }
  })(ast);
  return out;
}
function cityFor(lat, lng, boxes) {
  for (const c of boxes) if (!c.region && lng >= c.bbox[0] && lat >= c.bbox[1] && lng <= c.bbox[2] && lat <= c.bbox[3]) return c.id;
  for (const c of boxes) if (c.region && lng >= c.bbox[0] && lat >= c.bbox[1] && lng <= c.bbox[2] && lat <= c.bbox[3]) return c.id;
  return null;
}
const slug = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);

(async () => {
  const d = await (await fetch("https://images.parkrun.com/events.json", { headers: { "User-Agent": "flaneur-parkrun/1.0 (kuba.berkowski@gmail.com)" } })).json();
  const evs = (d.events && d.events.features || []).filter((e) => e.properties && e.properties.seriesid === 1);
  console.error(`[parkrun] 5k events in feed: ${evs.length}`);
  const boxes = ciBoxes();
  const added = []; const gbIds = []; let outside = 0, dupes = 0;
  for (const e of evs) {
    const p = e.properties, [lng, lat] = e.geometry.coordinates;
    const city = cityFor(lat, lng, boxes);
    if (!city) { outside++; continue; }
    const id = "prk-" + slug(p.eventname);
    const gb = p.countrycode === 97;
    if (seenIds.has(id)) { dupes++; if (gb) gbIds.push(id); continue; }
    seenIds.add(id);
    added.push({
      id, n: p.EventLongName || (p.EventShortName + " parkrun"), a: p.EventLocation || "", pc: "",
      lat: Math.round(lat * 1e5) / 1e5, lng: Math.round(lng * 1e5) / 1e5,
      c: "parkrun", s: "Free timed 5k — every Saturday morning",
      q: (p.EventLongName || p.EventShortName) + " " + (p.EventLocation || ""),
      w: "A free, volunteer-run, timed 5k every Saturday morning at " + (p.EventLocation || p.EventShortName) + ". Walk, jog or run — and check in on foot to add it to your parkrun record.",
      city,
    });
    if (gb) gbIds.push(id);
  }
  console.error(`[parkrun] added: ${added.length}, already present: ${dupes}, outside catalogue areas: ${outside}, GB courses tracked: ${gbIds.length}`);

  // --- grand quests registry ------------------------------------------------
  let the92 = [];
  try {
    const g = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "grounds92.json"), "utf8")).clubs;
    the92 = [...new Set(Object.values(g).map((x) => x.spotId))];
  } catch (e) { console.error("  ! grounds92.json missing — the92 quest skipped"); }
  const quests = [];
  if (the92.length) quests.push({
    id: "the92", name: "The 92", e: "⚽",
    blurb: "Every current English league ground, GPS-verified on matchdays. The groundhopper’s life list.",
    ids: the92, tiers: [10, 25, 46], goal: the92.length,
  });
  if (gbIds.length) quests.push({
    id: "parkrun-gb", name: "parkrun tourist", e: "🏃",
    blurb: "Tick off Great Britain’s Saturday-morning 5ks — 100 different courses is the fabled Cowell Club.",
    ids: gbIds, tiers: [5, 25, 50], goal: 100,
  });
  if (DRY) { console.error("(DRY — nothing written)"); return; }
  fs.writeFileSync(path.join(ROOT, "data", "quests.json"),
    JSON.stringify({ _generated: new Date().toISOString(), quests }, null, 1) + "\n");
  fs.writeFileSync(path.join(ROOT, "data", "spots.json"), JSON.stringify(spots.concat(added), null, 1));
  console.error(`→ data/spots.json (+${added.length}) and data/quests.json (${quests.map((q) => q.id).join(", ")})`);
})().catch((e) => { console.error(e); process.exit(1); });
