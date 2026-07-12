#!/usr/bin/env node
"use strict";
/*
 * tools/add-92.js — complete the English league grounds ("the 92") in the
 * catalogue. Club list comes from the live season feeds (fixturedownload
 * PL + Championship 2026-27) plus openfootball League One/Two rosters
 * (latest published season). Each club's home ground + coordinates come
 * from Wikidata (P115 home venue, P625 coords). Grounds already in the
 * catalogue are kept; missing ones are appended to data/spots.json as
 * machine-stub stadium spots (city = enclosing Ci city, else the
 * `england` region). Also writes data/grounds92.json (normalized club ->
 * {ground, spotId, lat, lng}) used by harvest-fixtures' openfootball
 * adapter to attach L1/L2 fixtures by home club.
 * Usage: node tools/add-92.js [--dry]
 */
const fs = require("fs");
const path = require("path");
const acorn = require("acorn");
const ROOT = path.join(__dirname, "..");
const DRY = process.argv.includes("--dry");
const UA = { headers: { "User-Agent": "flaneur-grounds/1.0 (kuba.berkowski@gmail.com)" } };

const spots = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "spots.json"), "utf8"));
const grounds = spots.filter((z) => z.c === "stadium" && typeof z.lat === "number");

// --- normalizers ---------------------------------------------------------
const clubNorm = (s) => String(s || "").toLowerCase()
  .replace(/\b(a\.?f\.?c\.?|f\.?c\.?)\b/g, "").replace(/&/g, "and")
  .replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
const NOISE = new Set(["the", "stadium", "stadion", "arena", "park", "field", "ground"]);
const gTokens = (s) => String(s || "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
  .replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/).filter((t) => t && !NOISE.has(t));
const gTight = (s) => gTokens(s).join(" ");
function jac(a, b) { const A = new Set(a), B = new Set(b); if (!A.size || !B.size) return 0; let n = 0; for (const t of A) if (B.has(t)) n++; return n / (A.size + B.size - n); }
function matchGround(name, lat, lng) {
  const vN = gTight(name), vT = gTokens(name);
  let best = null, bestS = 0;
  for (const g of grounds) {
    const gN = gTight(g.n);
    let s = 0;
    if (gN === vN) s = 1;
    else if (gN.includes(vN) || vN.includes(gN)) s = Math.min(gN.length, vN.length) >= 5 ? 0.9 : 0;
    else { const j = jac(vT, gTokens(g.n)); s = j >= 0.6 ? j : 0; }
    // distance sanity: a name match to a ground >5 km away is a collision
    // (Exeter's St James Park vs Newcastle's; London Road vs London Stadium),
    // and a nearby unnamed match is a rename (sponsor names) — within 300 m.
    if (typeof lat === "number") {
      const d = Math.hypot((g.lat - lat) * 111, (g.lng - lng) * 70);
      if (d > 5) s = 0;
      else if (s < 0.6 && d < 0.3) s = 0.75;
    }
    if (s > bestS) { bestS = s; best = g; }
  }
  return bestS >= 0.6 ? best : null;
}
const slug = (s) => clubNorm(s).replace(/ /g, "-").replace(/-+/g, "-").slice(0, 40) || "ground";

// --- Ci registry (id + bbox) from the template, acorn-parsed --------------
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
  return "england";
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  // --- 1) club rosters ----------------------------------------------------
  const clubs = new Map(); // norm -> {name, tier}
  const feedVenue = new Map(); // norm -> current season home venue (authoritative)
  for (const [slugF, tier] of [["epl-2026", "Premier League"], ["championship-2026", "EFL Championship"]]) {
    const rows = await (await fetch(`https://fixturedownload.com/feed/json/${slugF}`, UA)).json();
    for (const m of rows) {
      for (const t of [m.HomeTeam, m.AwayTeam]) { const k = clubNorm(t); if (k && !clubs.has(k)) clubs.set(k, { name: t, tier }); }
      const hk = clubNorm(m.HomeTeam);
      if (hk && m.Location && !feedVenue.has(hk)) feedVenue.set(hk, m.Location);
    }
    await sleep(400);
  }
  for (const [file, tier] of [["3-league1.txt", "League One"], ["4-league2.txt", "League Two"]]) {
    let txt = null;
    for (const season of ["2026-27", "2025-26"]) {
      const r = await fetch(`https://raw.githubusercontent.com/openfootball/england/master/${season}/${file}`, UA);
      if (r.ok) { txt = await r.text(); console.error(`  roster: ${season}/${file}`); break; }
    }
    if (!txt) { console.error(`  ! no roster source for ${tier}`); continue; }
    for (const raw of txt.split(/\r?\n/)) {
      const line = raw.replace(/\s{2,}(\d+-\d+|\[).*$/, ""); // strip trailing result / [postponed] notes
      const m = line.match(/^\s+(?:\d{1,2}[.:]\d{2}\s+)?(.+?)\s+v\s+(.+?)\s*$/);
      if (!m) continue;
      for (const t of [m[1], m[2]]) { const k = clubNorm(t.trim()); if (k && !clubs.has(k)) clubs.set(k, { name: t.trim(), tier }); }
    }
    await sleep(400);
  }
  console.error(`[92] clubs collected: ${clubs.size}`);

  // --- 2) Wikidata: club -> home ground + coords ---------------------------
  const q = `SELECT ?clubLabel ?groundLabel ?coord WHERE {
    ?club wdt:P31 wd:Q476028 . ?club wdt:P115 ?ground . ?ground wdt:P625 ?coord . ?club wdt:P17 wd:Q145 .
    SERVICE wikibase:label { bd:serviceParam wikibase:language "en". } } LIMIT 4000`;
  const wd = await (await fetch("https://query.wikidata.org/sparql?query=" + encodeURIComponent(q),
    { headers: { ...UA.headers, Accept: "application/sparql-results+json" } })).json();
  const wdMap = new Map(); // clubNorm -> {ground, lat, lng}
  for (const r of wd.results.bindings) {
    const k = clubNorm(r.clubLabel.value);
    const pm = r.coord.value.match(/Point\(([-\d.]+) ([-\d.]+)\)/);
    if (!k || !pm || wdMap.has(k)) continue;
    wdMap.set(k, { ground: r.groundLabel.value, lng: +pm[1], lat: +pm[2] });
  }
  console.error(`[92] wikidata club->ground rows: ${wdMap.size}`);

  // --- 3) resolve each club ------------------------------------------------
  const boxes = ciBoxes();
  const mapOut = {}; const newSpots = []; const misses = [];
  const seenIds = new Set(spots.map((z) => z.id));
  // fixturedownload uses short names — alias them onto Wikidata labels
  const ALIAS = { "man utd": "manchester united", "man city": "manchester city", spurs: "tottenham hotspur",
    "nott m forest": "nottingham forest", wolves: "wolverhampton wanderers", "west brom": "west bromwich albion",
    "sheff utd": "sheffield united", "sheff wed": "sheffield wednesday", qpr: "queens park rangers",
    coventry: "coventry city", hull: "hull city", ipswich: "ipswich town", leeds: "leeds united",
    brighton: "brighton and hove albion", newcastle: "newcastle united", "west ham": "west ham united",
    luton: "luton town", stoke: "stoke city", derby: "derby county", preston: "preston north end",
    blackburn: "blackburn rovers", norwich: "norwich city", cardiff: "cardiff city", swansea: "swansea city",
    middlesbrough: "middlesbrough", charlton: "charlton athletic", oxford: "oxford united" };
  const wdFind = (k) => {
    if (wdMap.has(k)) return wdMap.get(k);
    if (ALIAS[k] && wdMap.has(ALIAS[k])) return wdMap.get(ALIAS[k]);
    const cands = [...wdMap.keys()].filter((x) => x === k || x.startsWith(k + " ") || k.startsWith(x + " "));
    return cands.length === 1 ? wdMap.get(cands[0]) : null;
  };
  // strict name-only match (exact or long containment; no fuzz, no distance)
  const strictByName = (name) => {
    const vN = gTight(name);
    if (!vN || vN.length < 8) return null;
    let hit = null;
    for (const g of grounds) {
      const gN = gTight(g.n);
      if (gN === vN || gN.includes(vN) || vN.includes(gN)) { if (hit) return null; hit = g; }
    }
    return hit;
  };
  for (const [k, c] of clubs) {
    const w = wdFind(k);
    if (!w) { misses.push(c.name); continue; }
    // this season's feed venue beats Wikidata's (which can lag a stadium move —
    // e.g. Brentford listed at the demolished Griffin Park)
    const fv = feedVenue.get(k);
    const fvHit = fv ? strictByName(fv) : null;
    if (fvHit) { mapOut[k] = { club: c.name, ground: fvHit.n, spotId: fvHit.id, lat: fvHit.lat, lng: fvHit.lng }; continue; }
    const ex = matchGround(w.ground, w.lat, w.lng);
    if (ex) { mapOut[k] = { club: c.name, ground: w.ground, spotId: ex.id, lat: ex.lat, lng: ex.lng }; continue; }
    let id = slug(w.ground) || slug(c.name) + "-ground";
    while (seenIds.has(id)) id += "-x";
    seenIds.add(id);
    const spot = {
      id, n: w.ground, a: "", pc: "",
      lat: Math.round(w.lat * 1e5) / 1e5, lng: Math.round(w.lng * 1e5) / 1e5,
      c: "stadium", s: "Home of " + c.name,
      q: w.ground + " stadium",
      w: "Home ground of " + c.name + " (" + c.tier + "). Check in on foot on a matchday and the fixture lands in your Matchday record.",
      city: cityFor(w.lat, w.lng, boxes),
    };
    newSpots.push(spot);
    mapOut[k] = { club: c.name, ground: w.ground, spotId: id, lat: spot.lat, lng: spot.lng };
  }
  console.error(`[92] existing grounds matched: ${Object.keys(mapOut).length - newSpots.length}, new spots: ${newSpots.length}, unresolved clubs: ${misses.length}`);
  if (misses.length) console.error("  unresolved: " + misses.join(" | "));
  const cityDist = {};
  newSpots.forEach((z) => { cityDist[z.city] = (cityDist[z.city] || 0) + 1; });
  console.error("  new spots by city: " + JSON.stringify(cityDist));
  if (DRY) { console.error("(DRY — nothing written)"); return; }
  fs.writeFileSync(path.join(ROOT, "data", "grounds92.json"),
    JSON.stringify({ _generated: new Date().toISOString(), clubs: mapOut }, null, 1) + "\n");
  // grand-quest registry: The 92 (build.js ships it via the fixtures sidecar)
  const qIds = [...new Set(Object.values(mapOut).map((x) => x.spotId))].sort();
  fs.writeFileSync(path.join(ROOT, "data", "quests.json"), JSON.stringify({
    _generated: new Date().toISOString(),
    quests: [{ id: "the92", name: "The 92", e: "\u26bd",
      blurb: "Every current English league ground, GPS-verified on matchdays. The groundhopper\u2019s life list.",
      ids: qIds, tiers: [10, 25, 46], goal: qIds.length }],
  }, null, 1) + "\n");
  fs.writeFileSync(path.join(ROOT, "data", "spots.json"), JSON.stringify(spots.concat(newSpots), null, 1));
  console.error(`→ data/spots.json (+${newSpots.length}) and data/grounds92.json (${Object.keys(mapOut).length} clubs)`);
})().catch((e) => { console.error(e); process.exit(1); });
