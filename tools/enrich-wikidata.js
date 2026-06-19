#!/usr/bin/env node
"use strict";
/*
 * tools/enrich-wikidata.js — for spots with a Wikidata QID but no English
 * Wikipedia article (typically places in non-English countries), pull facts
 * from Wikidata in ENGLISH: the English description + structured claims
 * (inception P571, architect P84, architectural style P149, heritage P1435,
 * named-after P138). Free, grounded, English even for foreign places.
 *
 * Skips the 787 curated originals and the Wikipedia-enriched spots; augments the
 * plain placeholders. Resumable. Usage:
 *   node tools/enrich-wikidata.js --dry [--city munich]
 *   node tools/enrich-wikidata.js
 */
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const SPOTS = path.join(ROOT, "data", "spots.json");
const MANIFEST = path.join(__dirname, "wikidata-enriched.json");
const UA = { headers: { "User-Agent": "flaneur-research/1.0 (kuba.berkowski@gmail.com)" } };
const args = process.argv.slice(2);
const dry = args.includes("--dry");
const onlyCity = args.includes("--city") ? args[args.indexOf("--city") + 1] : null;

const norm = (n) => String(n).toLowerCase().replace(/^the\s+/, "").replace(/\s+/g, " ").trim();
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const ORIG = new Set(JSON.parse(fs.readFileSync("/tmp/orig787.json", "utf8")));
const WIKI = new Set(JSON.parse(fs.readFileSync(path.join(__dirname, "wiki-enriched.json"), "utf8")));

// city|name -> QID from the candidate piles
const qmap = new Map();
for (const f of fs.readdirSync(path.join(__dirname, "candidates")).filter((f) => f.endsWith(".json")))
  for (const r of JSON.parse(fs.readFileSync(path.join(__dirname, "candidates", f), "utf8"))) {
    const raw = r._meta && r._meta.raw, url = (r._meta && r._meta.url) || "";
    let qid = raw && typeof raw === "object" && /^Q\d+$/.test(raw.wikidata || "") ? raw.wikidata : null;
    const m = url.match(/entity\/(Q\d+)/); if (m) qid = qid || m[1];
    if (qid) qmap.set(r.city + "|" + norm(r.n), qid);
  }

async function api(url) {
  for (let a = 0; a < 4; a++) {
    try { const r = await fetch(url, UA); if (r.ok) return await r.json(); if (r.status < 500 && r.status !== 429) return null; }
    catch (_) {}
    await delay(1200 * (a + 1));
  }
  return null;
}
const claimId = (e, p) => { const c = e.claims && e.claims[p] && e.claims[p][0] && e.claims[p][0].mainsnak; return c && c.datavalue && c.datavalue.value && c.datavalue.value.id; };
const claimTime = (e, p) => { const c = e.claims && e.claims[p] && e.claims[p][0] && e.claims[p][0].mainsnak; return c && c.datavalue && c.datavalue.value && c.datavalue.value.time; };
const yearOf = (t) => { const m = String(t || "").match(/([+-]\d{4})/); return m ? String(+m[1]) : null; };

(async () => {
  const spots = JSON.parse(fs.readFileSync(SPOTS, "utf8"));
  const enriched = fs.existsSync(MANIFEST) ? new Set(JSON.parse(fs.readFileSync(MANIFEST, "utf8"))) : new Set();
  let targets = spots.filter((s) => !ORIG.has(s.id) && !WIKI.has(s.id) && !enriched.has(s.id) && (!onlyCity || s.city === onlyCity))
    .map((s) => ({ s, qid: qmap.get(s.city + "|" + norm(s.n)) })).filter((x) => x.qid);
  console.error(`${targets.length} ${onlyCity || "all-cities"} spots with a QID to look up.`);
  if (!targets.length) return;

  // pass 1: descriptions + claims for each spot QID
  const ent = new Map();
  const qids = [...new Set(targets.map((x) => x.qid))];
  for (let i = 0; i < qids.length; i += 50) {
    const j = await api(`https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&props=descriptions|claims&languages=en&ids=${qids.slice(i, i + 50).join("|")}`);
    if (j && j.entities) for (const q in j.entities) ent.set(q, j.entities[q]);
    process.stderr.write(`\r  fetched ${Math.min(i + 50, qids.length)}/${qids.length} entities`); await delay(250);
  }
  process.stderr.write("\n");

  // pass 2: resolve value-QID labels (architect / style / heritage / named-after)
  const valQids = new Set();
  for (const q of ent.keys()) for (const p of ["P84", "P149", "P1435", "P138"]) { const v = claimId(ent.get(q), p); if (v) valQids.add(v); }
  const label = new Map();
  const vlist = [...valQids];
  for (let i = 0; i < vlist.length; i += 50) {
    const j = await api(`https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&props=labels&languages=en&ids=${vlist.slice(i, i + 50).join("|")}`);
    if (j && j.entities) for (const q in j.entities) { const l = j.entities[q].labels && j.entities[q].labels.en; if (l) label.set(q, l.value); }
    process.stderr.write(`\r  resolved ${Math.min(i + 50, vlist.length)}/${vlist.length} value labels`); await delay(250);
  }
  process.stderr.write("\n");

  let done = 0; const samples = [];
  for (const x of targets) {
    const e = ent.get(x.qid); if (!e) continue;
    const desc = e.descriptions && e.descriptions.en && e.descriptions.en.value;
    const base = String(x.s.w || "").trim();
    const facts = [];
    const yr = yearOf(claimTime(e, "P571"));
    if (yr && !base.includes(yr)) facts.push(`Built in ${yr}.`);
    const arch = label.get(claimId(e, "P84")); if (arch) facts.push(`Designed by ${arch}.`);
    const style = label.get(claimId(e, "P149")); if (style) facts.push(`${cap(style)} style.`);
    const herit = label.get(claimId(e, "P1435")); if (herit) facts.push(`${cap(herit)}.`);
    // prefer the (more specific) English Wikidata description as the base line
    let lead = base;
    if (desc && desc.length >= 12 && desc.length <= 160 && desc.length > base.replace(/\.$/, "").length)
      lead = cap(desc) + ".";
    const extra = facts.filter((f) => !lead.includes(f.replace(/\.$/, ""))).slice(0, 3);
    if (lead === base && !extra.length) continue;  // nothing new
    const w = (lead + (extra.length ? " " + extra.join(" ") : "")).trim();
    if (w === base) continue;
    if (samples.length < 16) samples.push(`[${x.s.city}/${x.s.c}] ${x.s.n} — ${w}`);
    if (!dry) { x.s.w = w; enriched.add(x.s.id); }
    done++;
  }
  if (dry) { console.log("\n" + samples.join("\n")); console.error(`\n--dry: would enrich ${done}. Nothing written.`); return; }
  fs.writeFileSync(SPOTS, JSON.stringify(spots, null, 1) + "\n");
  fs.writeFileSync(MANIFEST, JSON.stringify([...enriched], null, 0) + "\n");
  console.error(`\nenriched ${done} from Wikidata. ${enriched.size} ids in ${path.relative(ROOT, MANIFEST)}. next: npm run build`);
})().catch((e) => { console.error("✗ " + e.message); process.exit(1); });
