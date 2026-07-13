#!/usr/bin/env node
"use strict";
/*
 * tools/recat.js — refine the giant catch-all categories into specific ones.
 *
 * Phase 1 (this tool): high-confidence, keyword-rule splits WITHIN a source
 * category only — a spot never leaves the bucket the curator chose, it just
 * gets a more specific shelf inside it:
 *   faith  → church | temple | mosque | synagogue | monastery   (residual: faith)
 *   green  → park | wild                                        (residual: green)
 *   museum → artgallery                                         (residual: museum)
 *
 * Rules match on name + hook + first 200 chars of writeup, in a fixed
 * PRIORITY order (mosque before temple so "Temple Church" style collisions
 * resolve sensibly; church before temple so European "templom/templo"
 * naming stays put). Non-Latin-script names that match nothing stay in the
 * residual category — that is by design, not a failure.
 *
 * The new slugs must exist in the template's `ne` before `npm run build`
 * (build.js validates every `c` against ne). Prints per-rule counts and
 * writes a full audit CSV next to the repo (scratch use; not committed).
 * Usage: node tools/recat.js [--dry]
 */
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const SPOTS = path.join(ROOT, "data", "spots.json");
const DRY = process.argv.includes("--dry");
const CSV = process.env.RECAT_CSV || "";

const spots = JSON.parse(fs.readFileSync(SPOTS, "utf8"));
const txt = (z) => (z.n + " " + (z.s || "") + " " + (z.w || "").slice(0, 200)).toLowerCase();

// [sourceCat, newCat, regex] — first match wins within each source category.
const RULES = {
  faith: [
    ["mosque", /mosque|masjid|\bcamii?\b|mezquita|moschee|mosquée/],
    ["synagogue", /synagog|sinagog|\bshul\b/],
    ["monastery", /\babbey\b|monaster|convent|priory|friary|charterhouse|kloster|monastère|monasterio|mosteiro|lavra\b/],
    ["church", /church|cathedral|chapel|basilica|\bkirk\b|minster|kirche|église|eglise|iglesia|igreja|\bkerk\b|kostel|katedr|templom|\bduomo\b|\bsé\b/],
    ["temple", /temple|shrine|pagoda|\bwat\b|gurdwara|stupa|\bmandir\b|torii|jinja|\bdaibutsu\b|tera\b|-ji\b|taishō|viharn?a?\b/],
  ],
  green: [
    ["park", /\bpark\b|garden|botanic|arboretum|jard[ií]n|jardim|parque|\bparc\b/],
    ["wild", /river|lake|waterfall|beach|coast|cliff|\bbay\b|\bhill\b|mountain|\bpeak\b|summit|\bfell\b|crag|forest|\bwoods?\b|nature reserve|wetland|heath\b|moor\b|gorge|\bglen\b|loch\b|\btarn\b|dunes?\b|estuary|marsh/],
  ],
  museum: [
    ["artgallery", /gallery|galerie|kunsthall|kunstmuseum|pinacotec|museum of art|art museum|museo de arte|musée d.art|contemporary art|modern art|art cent(re|er)|sculpture (park|garden)|galleria d.arte/],
  ],
};

// The spot's NAME outranks its writeup: "Gloucester Cathedral" whose blurb
// mentions its abbey origins is a church, not a monastery. Pass 1 matches
// names only; pass 2 falls back to the full text.
const counts = {}; const rows = [];
for (const z of spots) {
  const rules = RULES[z.c];
  if (!rules) continue;
  const nameOnly = z.n.toLowerCase(), full = txt(z);
  let hit = null;
  for (const t of [nameOnly, full]) {
    for (const [nc, rx] of rules) if (rx.test(t)) { hit = [nc, (t.match(rx) || [""])[0]]; break; }
    if (hit) break;
  }
  if (hit) {
    rows.push([z.id, z.city, z.n.replace(/[,"\n]/g, " "), z.c, hit[0], hit[1]]);
    counts[z.c + "→" + hit[0]] = (counts[z.c + "→" + hit[0]] || 0) + 1;
    if (!DRY) z.c = hit[0];
  }
}
console.error("[recat] moves:");
Object.entries(counts).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.error(`  ${k}: ${v}`));
const left = {};
for (const z of spots) if (z.c === "faith" || z.c === "green" || z.c === "museum") left[z.c] = (left[z.c] || 0) + 1;
console.error("[recat] residuals:", JSON.stringify(left));
if (CSV) fs.writeFileSync(CSV, "id,city,name,from,to,matched\n" + rows.map((r) => r.join(",")).join("\n") + "\n");
if (!DRY) { fs.writeFileSync(SPOTS, JSON.stringify(spots, null, 1) + "\n"); console.error(`→ data/spots.json (${rows.length} spots recategorised)`); }
else console.error(`(DRY — ${rows.length} spots would move)`);
