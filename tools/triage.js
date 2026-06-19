#!/usr/bin/env node
"use strict";
/*
 * tools/triage.js — best-effort bulk triage of candidate files.
 *
 * Unlike category-map.js (the conservative live-pipeline guesser that leaves
 * editorial categories blank on purpose), this fills EVERY candidate's `c`
 * with a valid slug — falling back to broad editorial buckets and finally
 * "oddity" — and writes a short FACTUAL placeholder hook into `s`. It NEVER
 * touches `w`: writeups stay blank and are the owner's to write.
 *
 * Usage:
 *   node tools/triage.js                 # triage every tools/candidates/*.json in place
 *   node tools/triage.js london paris    # only the named cities
 */
const fs = require("fs");
const path = require("path");
const M = require("./model");

const OUTDIR = path.join(__dirname, "candidates");
const slugs = new Set([...M.loadModel().categories]);
const ok = (s) => slugs.has(s) ? s : null;

// pick the first valid slug from a preference list, else null
const pick = (...c) => c.map(ok).find(Boolean) || null;

function tagsOf(row) {
  const raw = row._meta && row._meta.raw;
  return raw && typeof raw === "object" ? raw : {};
}
function descOf(row) {
  const raw = row._meta && row._meta.raw;
  const t = tagsOf(row);
  const parts = [row.n, typeof raw === "string" ? raw : "", t.description, t.inscription].filter(Boolean);
  return parts.join(" ").toLowerCase();
}

// ---- category, best-effort, always returns a valid slug ----
function categorize(row) {
  const t = tagsOf(row);
  const d = descOf(row);
  const has = (re) => re.test(d);

  // physical / unambiguous OSM tags first
  if (t.amenity === "place_of_worship" || t.building === "church" || t.building === "mosque" || t.building === "synagogue" || t.building === "temple") return ok("faith");
  if (t.amenity === "cinema" || t.tourism === "cinema") return ok("cinema");
  if (t.tourism === "museum" || t.amenity === "museum" || t.tourism === "gallery") return ok("museum");
  if (t.tourism === "viewpoint" || t.natural === "peak") return pick("view", "history");
  if (t.amenity === "archive" || t.office === "archive") return pick("archive", "history");
  if (t.shop === "books" || t.shop === "bookshop") return pick("bookshops", "literary");
  if (t.shop === "music" || /\bvinyl\b/i.test(t.name || "")) return ok("vinyl");
  if (t.shop === "bakery" || t.craft === "bakery") return ok("bakery");
  if (t.amenity === "pub") return ok("pub");
  if (t.amenity === "bar" && (t.wine === "yes")) return ok("wine");
  if (t.amenity === "cafe") return pick("caff", "coffee");
  if (t.building === "stadium" || t.leisure === "stadium") return ok("stadium");
  if (t.leisure === "park" || t.leisure === "garden" || t.leisure === "nature_reserve") return ok("green");
  if (t.leisure === "swimming_pool" && /lido|outdoor/i.test(t.name || "")) return pick("lido", "green");
  if (t.waterway === "canal") return pick("canals", "green");
  if (t.man_made === "lighthouse") return pick("maritime", "history");

  // historic features → editorial buckets (best-effort)
  if (t.historic === "folly" || t.building === "folly") return pick("follies", "history");
  if (/\b(castle|city_gate|citywalls|city_walls|fort|fortress|castle_wall|bastion)\b/.test(t.historic || "")) return pick("medieval", "history");
  if (t.historic === "tomb" || t.historic === "grave" || t.amenity === "grave_yard" || t.landuse === "cemetery" || /\b(tomb|grave|mausoleum|crypt|cemetery|necropolis)\b/.test(d)) return pick("death", "history");
  if (t.historic === "archaeological_site" && /roman/.test(d)) return pick("roman", "history");
  if (t.historic === "ship" || t.historic === "wreck" || /\b(anchor|harpoon|whaling|lighthouse|maritime|naval|lifeboat)\b/.test(d)) return pick("maritime", "history");
  if (t.historic === "memorial" && /plaque/i.test((t.memorial || t["memorial:type"] || "") + " " + row.n)) return pick("plaque", "history");
  if (t.historic === "blue_plaque" || t["plaque:type"]) return pick("plaque", "history");
  // murals / public art
  if (t.tourism === "artwork" || t.artwork_type) {
    if (/mural|graffiti|street|mosaic/i.test((t.artwork_type || "") + " " + d)) return pick("streetart", "oddity");
    return pick("streetart", "oddity"); // statues/sculptures/installations as public art
  }
  // writers / literary
  if (/\b(poet|poetry|novelist|writer|author|playwright|literary|book)\b/.test(d)) return pick("literary", "history");
  // any remaining historic tag → deep history
  if (t.historic) return pick("history", "oddity");
  // money / livery
  if (/livery (hall|company)|worshipful company|guild ?hall/i.test(d)) return pick("livery", "history");

  // keyword sweep over name/description (covers wikidata rows w/o tags)
  if (has(/\b(church|cathedral|chapel|mosque|synagogue|temple|basilica|abbey|shrine|monastery|convent)\b/)) return pick("faith", "history");
  if (has(/\b(museum|gallery)\b/)) return pick("museum", "history");
  if (has(/\b(cinema|theatre|theater|picturehouse|playhouse)\b/)) return pick("cinema", "history");
  if (has(/\b(park|gardens?|arboretum)\b/)) return pick("green", "history");
  if (has(/\b(statue|monument|memorial|obelisk|column|fountain|war memorial|cenotaph)\b/)) return pick("history", "oddity");
  if (has(/\b(standing stone|megalith|menhir|dolmen|cairn|tumulus|barrow|stone circle)\b/)) return pick("history", "oddity");
  if (has(/\b(castle|fortress|citadel|palace|tower|ruins?)\b/)) return pick("history", "medieval");

  // final fallback
  return ok("oddity") || ok("history");
}

// ---- short factual placeholder hook (owner rewrites in their voice) ----
function hook(row, slug) {
  const t = tagsOf(row);
  const d = descOf(row);
  const at = (t.artwork_type || "").toLowerCase();
  switch (slug) {
    case "faith": {
      const r = (t.religion || "").toLowerCase();
      if (r === "muslim") return "mosque";
      if (r === "jewish") return "synagogue";
      if (r === "christian") return /cathedral/.test(d) ? "cathedral" : "church";
      if (r === "buddhist" || r === "hindu" || r === "shinto") return "temple";
      return "place of worship";
    }
    case "cinema": return "cinema";
    case "museum": return t.tourism === "gallery" ? "art gallery" : "museum";
    case "view": return t.natural === "peak" ? "hilltop viewpoint" : "viewpoint";
    case "streetart":
      if (/mural/.test(at + d)) return "mural";
      if (/mosaic/.test(at + d)) return "mosaic";
      if (/statue/.test(at)) return "public statue";
      if (/sculpture|installation/.test(at)) return "public sculpture";
      if (/fountain/.test(at)) return "decorative fountain";
      return "public artwork";
    case "plaque": return "commemorative plaque";
    case "death": return /cemetery|necropolis/.test(d) ? "historic cemetery" : "historic tomb";
    case "follies": return "folly";
    case "medieval": return /gate/.test(d) ? "old city gate" : /wall/.test(d) ? "old town wall" : /fort/.test(d) ? "fortification" : "medieval site";
    case "maritime": return /lighthouse/.test(d) ? "lighthouse" : /anchor/.test(d) ? "anchor" : "maritime relic";
    case "roman": return "Roman remains";
    case "green": return /garden/.test(d) ? "garden" : "park";
    case "canals": return "canal";
    case "stadium": return "stadium";
    case "pub": return "historic pub";
    case "bakery": return "bakery";
    case "vinyl": return "record shop";
    case "bookshops": return "bookshop";
    case "literary": return "literary landmark";
    case "archive": return "archive";
    case "history":
      if (/war memorial/.test(d)) return "war memorial";
      if (/standing stone|megalith|menhir|dolmen/.test(d)) return "prehistoric standing stone";
      if (/cairn/.test(d)) return "memorial cairn";
      if (/statue/.test(d)) return "commemorative statue";
      if (/obelisk|column/.test(d)) return "monument";
      if (/fountain/.test(d)) return "memorial fountain";
      if (/well\b/.test(d)) return "old well";
      if (/cannon/.test(d)) return "old cannon";
      if (/ruins?/.test(d)) return "historic ruins";
      if (/archaeolog/.test(d) || t.historic === "archaeological_site") return "archaeological site";
      return "historic landmark";
    default: return "local curiosity";
  }
}

function main() {
  const only = process.argv.slice(2);
  const files = fs.readdirSync(OUTDIR).filter((f) => f.endsWith(".json") &&
    (!only.length || only.includes(f.replace(/\.json$/, ""))));
  let totalRows = 0, filledC = 0, filledS = 0;
  const tally = {};
  for (const f of files) {
    const fp = path.join(OUTDIR, f);
    const rows = JSON.parse(fs.readFileSync(fp, "utf8"));
    for (const r of rows) {
      totalRows++;
      if (!r.c || !slugs.has(r.c)) { r.c = categorize(r); filledC++; }
      if (!r.s || !String(r.s).trim()) { r.s = hook(r, r.c); filledS++; }
      tally[r.c] = (tally[r.c] || 0) + 1;
    }
    fs.writeFileSync(fp, JSON.stringify(rows, null, 1) + "\n");
  }
  console.log(`triaged ${files.length} cities, ${totalRows} rows; set ${filledC} categories, ${filledS} hooks.`);
  console.log("category totals:", Object.entries(tally).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${v} ${k}`).join(", "));
}
main();
