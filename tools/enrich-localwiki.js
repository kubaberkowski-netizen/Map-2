#!/usr/bin/env node
"use strict";
/*
 * tools/enrich-localwiki.js — for bare spots in non-English European cities,
 * geosearch the LOCAL-language Wikipedia near the coordinates, match by name,
 * resolve the matched page to its Wikidata item, and write the facts back in
 * ENGLISH (Wikidata English description + inception/architect/style/heritage).
 * So a Naples spot that only has an Italian article still gets an English line.
 * Grounded, free; strict name+proximity match. Skips originals + already-enriched.
 *
 * Usage:  node tools/enrich-localwiki.js --dry [--city naples] [--limit N]
 */
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const SPOTS = path.join(ROOT, "data", "spots.json");
const MANIFEST = path.join(__dirname, "localwiki-enriched.json");
const UA = { headers: { "User-Agent": "flaneur-research/1.0 (kuba.berkowski@gmail.com)" } };
const args = process.argv.slice(2);
const dry = args.includes("--dry");
const onlyCity = args.includes("--city") ? args[args.indexOf("--city") + 1] : null;
const limit = args.includes("--limit") ? +args[args.indexOf("--limit") + 1] : Infinity;

const LANG = { berlin:"de",hamburg:"de",munich:"de",vienna:"de",zurich:"de",paris:"fr",lyon:"fr",marseille:"fr",brussels:"fr",amsterdam:"nl",rotterdam:"nl",rome:"it",milan:"it",naples:"it",florence:"it",venice:"it",madrid:"es",barcelona:"es",seville:"es",valencia:"es",lisbon:"pt",porto:"pt",prague:"cs",budapest:"hu",warsaw:"pl",krakow:"pl",gdansk:"pl",copenhagen:"da",stockholm:"sv",oslo:"no",helsinki:"fi",athens:"el",thessaloniki:"el",istanbul:"tr",bucharest:"ro",sofia:"bg",zagreb:"hr",ljubljana:"sl",tallinn:"et",riga:"lv",vilnius:"lt",belgrade:"sr" };

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const deburr = (s) => String(s).normalize("NFKD").replace(/[̀-ͯ]/g, "");
const norm = (s) => deburr(s).toLowerCase().replace(/^the\s+|^l['’]|^la\s+|^le\s+|^il\s+|^el\s+|^de\s+/i, "").replace(/[’']/g, "'").replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

const SKIP = new Set();
JSON.parse(fs.readFileSync("/tmp/orig787.json", "utf8")).forEach((id) => SKIP.add(id));
for (const m of ["wiki", "osm", "wikidata", "geosearch"]) JSON.parse(fs.readFileSync(path.join(__dirname, m + "-enriched.json"), "utf8")).forEach((id) => SKIP.add(id));

async function api(url) {
  for (let a = 0; a < 4; a++) {
    try { const r = await fetch(url, UA); if (r.ok) return await r.json(); if (r.status < 500 && r.status !== 429) return null; } catch (_) {}
    await delay(1000 * (a + 1));
  }
  return null;
}
function nameMatch(spotName, title) {
  const n = norm(spotName), t = norm(title);
  if (n.length < 4) return false;
  return t === n || t.startsWith(n + " ") || n.startsWith(t + " ");
}
const cid = (e, p) => { const c = e.claims && e.claims[p] && e.claims[p][0] && e.claims[p][0].mainsnak; return c && c.datavalue && c.datavalue.value && c.datavalue.value.id; };
const ctime = (e, p) => { const c = e.claims && e.claims[p] && e.claims[p][0] && e.claims[p][0].mainsnak; return c && c.datavalue && c.datavalue.value && c.datavalue.value.time; };
const yearOf = (t) => { const m = String(t || "").match(/([+-]\d{4})/); return m ? String(+m[1]) : null; };

(async () => {
  const spots = JSON.parse(fs.readFileSync(SPOTS, "utf8"));
  const enriched = fs.existsSync(MANIFEST) ? new Set(JSON.parse(fs.readFileSync(MANIFEST, "utf8"))) : new Set();
  let targets = spots.filter((s) => !SKIP.has(s.id) && !enriched.has(s.id) && LANG[s.city] && Number.isFinite(s.lat) && (!onlyCity || s.city === onlyCity));
  if (Number.isFinite(limit)) targets = targets.slice(0, limit);
  console.error(`${targets.length} bare spots to local-wiki geosearch.`);
  if (!targets.length) return;

  // 1) geosearch each spot's local wiki, name-match → {spot, lang, title}
  const matched = []; let n = 0;
  for (const s of targets) {
    n++; const lang = LANG[s.city];
    const j = await api(`https://${lang}.wikipedia.org/w/api.php?action=query&format=json&list=geosearch&gscoord=${s.lat}|${s.lng}&gsradius=150&gslimit=10`);
    await delay(110);
    const hit = ((j && j.query && j.query.geosearch) || []).find((h) => h.dist <= 150 && nameMatch(s.n, h.title));
    if (hit) matched.push({ s, lang, title: hit.title });
    if (n % 250 === 0) process.stderr.write(`\r  geosearched ${n}/${targets.length}, matched ${matched.length}`);
  }
  process.stderr.write(`\r  geosearched ${n}/${targets.length}, matched ${matched.length}\n`);

  // 2) matched page title -> wikidata QID (pageprops), batched per language
  const byLang = {}; matched.forEach((m) => (byLang[m.lang] = byLang[m.lang] || []).push(m));
  for (const lang in byLang) {
    const list = byLang[lang];
    for (let i = 0; i < list.length; i += 40) {
      const chunk = list.slice(i, i + 40);
      const j = await api(`https://${lang}.wikipedia.org/w/api.php?action=query&format=json&prop=pageprops&ppprop=wikibase_item&redirects=1&titles=${chunk.map((m) => encodeURIComponent(m.title)).join("|")}`);
      await delay(200);
      if (!j || !j.query) continue;
      const titleToQid = {};
      for (const k in j.query.pages) { const p = j.query.pages[k]; if (p.pageprops && p.pageprops.wikibase_item) titleToQid[p.title] = p.pageprops.wikibase_item; }
      const nm = {}; (j.query.normalized || []).forEach((x) => (nm[x.from] = x.to)); (j.query.redirects || []).forEach((x) => (nm[x.from] = x.to));
      for (const m of chunk) { let t = m.title; if (nm[t]) t = nm[t]; if (nm[t]) t = nm[t]; m.qid = titleToQid[t] || titleToQid[m.title]; }
    }
  }

  // 3) QIDs -> English description + claims; resolve value labels
  const qids = [...new Set(matched.map((m) => m.qid).filter(Boolean))];
  const ent = new Map();
  for (let i = 0; i < qids.length; i += 50) {
    const j = await api(`https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&props=descriptions|claims&languages=en&ids=${qids.slice(i, i + 50).join("|")}`);
    if (j && j.entities) for (const q in j.entities) ent.set(q, j.entities[q]); await delay(200);
  }
  const valq = new Set(); for (const e of ent.values()) for (const p of ["P84", "P149", "P1435"]) { const v = cid(e, p); if (v) valq.add(v); }
  const label = new Map(); const vl = [...valq];
  for (let i = 0; i < vl.length; i += 50) { const j = await api(`https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&props=labels&languages=en&ids=${vl.slice(i, i + 50).join("|")}`); if (j && j.entities) for (const q in j.entities) { const l = j.entities[q].labels && j.entities[q].labels.en; if (l) label.set(q, l.value); } await delay(200); }

  let done = 0; const samples = [];
  for (const m of matched) {
    const e = m.qid && ent.get(m.qid); if (!e) continue;
    const desc = e.descriptions && e.descriptions.en && e.descriptions.en.value;
    const base = String(m.s.w || "").trim();
    let lead = base;
    if (desc && desc.length >= 12 && desc.length <= 160 && desc.length > base.replace(/\.$/, "").length) lead = cap(desc) + ".";
    const facts = [];
    const yr = yearOf(ctime(e, "P571")); if (yr && !lead.includes(yr)) facts.push(`Built in ${yr}.`);
    const a = label.get(cid(e, "P84")); if (a) facts.push(`Designed by ${a}.`);
    const st = label.get(cid(e, "P149")); if (st) facts.push(`${cap(st)} style.`);
    const h = label.get(cid(e, "P1435")); if (h) facts.push(`${cap(h)}.`);
    const extra = facts.filter((f) => !lead.includes(f.replace(/\.$/, ""))).slice(0, 3);
    if (lead === base && !extra.length) continue;
    const w = (lead + (extra.length ? " " + extra.join(" ") : "")).trim();
    if (w === base) continue;
    if (samples.length < 18) samples.push(`[${m.s.city}] ${m.s.n} ← ${m.lang}:"${m.title}" — ${w}`);
    if (!dry) { m.s.w = w; enriched.add(m.s.id); }
    done++;
  }
  if (dry) { console.log("\n" + samples.join("\n")); console.error(`\n--dry: would enrich ${done}. Nothing written.`); return; }
  fs.writeFileSync(SPOTS, JSON.stringify(spots, null, 1) + "\n");
  fs.writeFileSync(MANIFEST, JSON.stringify([...enriched], null, 0) + "\n");
  console.error(`\nenriched ${done} via local-wiki→Wikidata. ${enriched.size} ids in ${path.relative(ROOT, MANIFEST)}. next: npm run build`);
})().catch((e) => { console.error("✗ " + e.message); process.exit(1); });
