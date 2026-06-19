#!/usr/bin/env node
"use strict";
/*
 * tools/relabel-oddity.js — move imported `oddity` spots into a better category
 * where there's a clear signal (recovered OSM tags from tools/candidates/*, plus
 * the Wikidata description carried in `s`). Only ever RELABELS oddity → something
 * else; never the reverse, never an original (protected via /tmp/orig-ids.json),
 * and leaves genuinely-miscellaneous spots as oddity.
 *
 * Usage: node tools/relabel-oddity.js [--dry]
 */
const fs = require("fs");
const path = require("path");
const M = require("./model");
const SPOTS = path.join(__dirname, "..", "data", "spots.json");
const dry = process.argv.includes("--dry");

const slugs = new Set([...M.loadModel().categories]);
const ok = (s) => (slugs.has(s) ? s : null);
const orig = new Set(JSON.parse(fs.readFileSync("/tmp/orig-ids.json", "utf8")));
const norm = (n) => String(n).toLowerCase().replace(/^the\s+/, "").replace(/\s+/g, " ").trim();

// recover OSM tags by city|name from the candidate piles
const lookup = new Map();
const cdir = path.join(__dirname, "candidates");
for (const f of fs.existsSync(cdir) ? fs.readdirSync(cdir).filter((f) => f.endsWith(".json")) : []) {
  for (const r of JSON.parse(fs.readFileSync(path.join(cdir, f), "utf8"))) {
    const raw = r._meta && r._meta.raw;
    if (raw && typeof raw === "object") lookup.set(r.city + "|" + norm(r.n), raw);
  }
}

// improved guess: returns a non-oddity slug or null (=> keep oddity)
function reguess(spot) {
  const t = lookup.get(spot.city + "|" + norm(spot.n)) || {};
  const tag = (k, ...v) => v.includes(t[k]);
  // structured tags (overpass) first
  if (tag("leisure", "stadium") || tag("building", "stadium")) return ok("stadium");
  if (tag("leisure", "park", "garden", "nature_reserve") || tag("natural", "wood") || tag("landuse", "forest")) return ok("green");
  if (tag("man_made", "lighthouse")) return ok("maritime");
  if (tag("waterway", "canal")) return ok("canals");
  // keyword match on the TYPE at the head of the description (Wikidata blurbs are
  // "TYPE in/of PLACE") — NOT the name, so proper nouns like "Canal Sur" or
  // "Lock's Hill" don't trip it. Overpass rows (s="local curiosity") fall through.
  const head = String(spot.s || "").toLowerCase().split(/\s+in\s+|\s+of\s+|,/)[0];
  const m = (re) => re.test(head);
  if (m(/\b(cathedral|basilica|abbey|monastery|convent|friary|priory|church|chapel|mosque|synagogue|temple|shrine)\b/)) return ok("faith");
  if (m(/\b(museum|art gallery|gallery)\b/)) return ok("museum");
  if (m(/\b(cemetery|graveyard|necropolis|mausoleum|catacomb|crematorium|war grave)\b/)) return ok("death");
  if (m(/\b(lighthouse|harbour|harbor|shipyard|lifeboat|dock|dockyard|quay|wharf|pier|naval)\b/)) return ok("maritime");
  if (m(/\b(castle|fortress|citadel|city gate|city wall|town wall|bastion|medieval)\b/)) return ok("medieval");
  if (m(/\b(mural|sculpture|graffiti|street art|public art|art installation|frieze)\b/)) return ok("streetart");
  if (m(/\b(cinema|picture ?house|playhouse|theatre|theater|opera house|concert hall)\b/)) return ok("cinema");
  if (m(/\b(stadium|arena|football ground|sports ground|velodrome|racecourse)\b/)) return ok("stadium");
  if (m(/\b(public house|pub|tavern|inn|brewery|brewpub)\b/)) return ok("pub");
  if (m(/\b(woodland|forest|nature reserve|park|public garden|botanical|arboretum|common|meadow|wetland|marsh)\b/)) return ok("green");
  if (m(/\b(viewpoint|lookout|observation deck|observation tower|panorama)\b/)) return ok("view");
  if (m(/\b(canal|aqueduct|lock)\b/)) return ok("canals");
  if (m(/\b(country house|manor house|manor|villa|stately home|listed building|listed house|palace|mansion|townhouse|almshouse|tower house|historic house|crypt|obelisk|monument|memorial|fountain|fortification|barracks|windmill|watermill|mill|gatehouse|ruins?|archaeological|tumulus|barrow|hillfort|standing stone)\b/)) return ok("history");
  return null;
}

const all = JSON.parse(fs.readFileSync(SPOTS, "utf8"));
const moved = {};
let relabeled = 0, stay = 0;
for (const s of all) {
  if (s.c !== "oddity" || orig.has(s.id)) continue;
  const g = reguess(s);
  if (g && g !== "oddity") { s.c = g; relabeled++; moved[g] = (moved[g] || 0) + 1; }
  else stay++;
}
console.log(`imported oddity → relabeled ${relabeled}, kept as oddity ${stay}`);
console.log("moved to:", Object.entries(moved).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${v} ${k}`).join(", "));
if (dry) { console.log("\n--dry: not written."); process.exit(0); }
fs.writeFileSync(SPOTS, JSON.stringify(all, null, 1) + "\n");
console.log("wrote data/spots.json. next: npm run build");
