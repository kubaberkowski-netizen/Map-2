#!/usr/bin/env node
"use strict";
/*
 * tools/enrich-wiki.js — upgrade machine placeholder writeups with REAL facts
 * from Wikipedia (free, no key). For each imported spot that carries a
 * wikipedia/wikidata reference, fetch the English Wikipedia intro and use its
 * first sentence or two as the `w`. Sourced facts only (CLAUDE.md allows these
 * when asked); nothing invented. Protects the 787 curated originals.
 *
 * Usage:
 *   node tools/enrich-wiki.js --dry --city edinburgh
 *   node tools/enrich-wiki.js --city edinburgh
 *   node tools/enrich-wiki.js                 # all cities
 */
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const SPOTS = path.join(ROOT, "data", "spots.json");
const MANIFEST = path.join(__dirname, "wiki-enriched.json");
const UA = { headers: { "User-Agent": "flaneur-research/1.0 (kuba.berkowski@gmail.com)" } };

const args = process.argv.slice(2);
const dry = args.includes("--dry");
const onlyCity = args.includes("--city") ? args[args.indexOf("--city") + 1] : null;
const limit = args.includes("--limit") ? +args[args.indexOf("--limit") + 1] : Infinity;

const norm = (n) => String(n).toLowerCase().replace(/^the\s+/, "").replace(/\s+/g, " ").trim();
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const ORIG = new Set(JSON.parse(fs.readFileSync("/tmp/orig787.json", "utf8")));

// city|name -> { enTitle, qid } from the candidate piles
function loadRefs() {
  const m = new Map();
  const dir = path.join(__dirname, "candidates");
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    for (const r of JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"))) {
      const raw = r._meta && r._meta.raw, url = (r._meta && r._meta.url) || "";
      let enTitle = null, qid = null;
      if (raw && typeof raw === "object") {
        if (typeof raw.wikipedia === "string") {
          const mm = raw.wikipedia.match(/^([a-z-]+):(.+)$/);
          if (mm && mm[1] === "en") enTitle = mm[2];
        }
        if (raw.wikidata && /^Q\d+$/.test(raw.wikidata)) qid = raw.wikidata;
      }
      const qm = url.match(/entity\/(Q\d+)/);
      if (qm) qid = qid || qm[1];
      if (enTitle || qid) m.set(r.city + "|" + norm(r.n), { enTitle, qid });
    }
  }
  return m;
}

async function batchJSON(url) {
  for (let a = 0; a < 4; a++) {
    try { const r = await fetch(url, UA); if (r.ok) return await r.json(); if (r.status < 500 && r.status !== 429) return null; }
    catch (_) {}
    await delay(1500 * (a + 1));
  }
  return null;
}

// resolve QIDs -> enwiki titles (50 ids/request)
async function resolveQids(qids) {
  const out = new Map();
  for (let i = 0; i < qids.length; i += 50) {
    const ids = qids.slice(i, i + 50);
    const j = await batchJSON(`https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&props=sitelinks&ids=${ids.join("|")}`);
    if (j && j.entities) for (const q of ids) { const sl = j.entities[q] && j.entities[q].sitelinks; if (sl && sl.enwiki) out.set(q, sl.enwiki.title); }
    await delay(300);
    process.stderr.write(`\r  resolved QIDs ${Math.min(i + 50, qids.length)}/${qids.length}`);
  }
  process.stderr.write("\n");
  return out;
}

// fetch enwiki intro extracts (20 titles/request)
async function fetchExtracts(titles) {
  const out = new Map();
  for (let i = 0; i < titles.length; i += 20) {
    const batch = titles.slice(i, i + 20);
    const j = await batchJSON(`https://en.wikipedia.org/w/api.php?action=query&format=json&prop=extracts&exintro&explaintext&redirects=1&titles=${batch.map(encodeURIComponent).join("|")}`);
    if (j && j.query) {
      const norm2 = {}; (j.query.normalized || []).forEach((n) => (norm2[n.to] = n.from));
      const redir = {}; (j.query.redirects || []).forEach((n) => (redir[n.to] = n.from));
      for (const k in j.query.pages) {
        const p = j.query.pages[k];
        if (!p.extract) continue;
        // map the resolved page title back to the requested title
        let req = p.title; if (redir[req]) req = redir[req]; if (norm2[req]) req = norm2[req];
        out.set(req, p.extract);
        out.set(p.title, p.extract);
      }
    }
    await delay(300);
    process.stderr.write(`\r  fetched extracts ${Math.min(i + 20, titles.length)}/${titles.length}`);
  }
  process.stderr.write("\n");
  return out;
}

// first 1–2 sentences, cleaned, ~max 320 chars
function summarise(extract) {
  let t = String(extract).replace(/\s+/g, " ").trim();
  // drop foreign-name / IPA / language-label parentheticals (but keep date ones):
  // parens containing a colon, or CJK / Greek / Cyrillic / IPA characters.
  t = t.replace(/\s*\([^)]*(?:[:：]|[　-鿿가-힯Ͱ-ϿЀ-ӿɐ-ʯʰ-˿])[^)]*\)/g, "");
  t = t.replace(/\s*\([^)]*(?:listen|IPA|ⓘ)[^)]*\)/gi, "");
  t = t.replace(/\s{2,}/g, " ").replace(/\s+([.,;])/g, "$1").trim();
  const sents = t.split(/(?<=[.!?])\s+(?=[A-Z0-9“"'])/);
  let out = "";
  for (const s of sents) { if (!out) out = s; else if ((out + " " + s).length <= 320) out += " " + s; else break; }
  if (out.length > 360) out = out.slice(0, 357).replace(/\s+\S*$/, "") + "…";
  return out.trim();
}

(async () => {
  const refs = loadRefs();
  const spots = JSON.parse(fs.readFileSync(SPOTS, "utf8"));
  let targets = spots.filter((s) => !ORIG.has(s.id) && (!onlyCity || s.city === onlyCity));
  // attach a ref to each target
  targets = targets.map((s) => ({ s, ref: refs.get(s.city + "|" + norm(s.n)) })).filter((x) => x.ref);
  if (Number.isFinite(limit)) targets = targets.slice(0, limit);
  console.error(`${targets.length} ${onlyCity || "all-cities"} machine spots have a wiki reference.`);
  if (!targets.length) return;

  // resolve QIDs that lack a direct enTitle
  const needQid = [...new Set(targets.filter((x) => !x.ref.enTitle && x.ref.qid).map((x) => x.ref.qid))];
  const qidTitle = needQid.length ? await resolveQids(needQid) : new Map();
  for (const x of targets) if (!x.ref.enTitle && x.ref.qid) x.title = qidTitle.get(x.ref.qid); else x.title = x.ref.enTitle;
  const withTitle = targets.filter((x) => x.title);
  const titles = [...new Set(withTitle.map((x) => x.title))];
  console.error(`${titles.length} unique English Wikipedia titles to fetch.`);

  const extracts = await fetchExtracts(titles);

  const enriched = fs.existsSync(MANIFEST) ? new Set(JSON.parse(fs.readFileSync(MANIFEST, "utf8"))) : new Set();
  let done = 0; const samples = [];
  for (const x of withTitle) {
    const ex = extracts.get(x.title);
    if (!ex) continue;
    const w = summarise(ex);
    if (w.length < 25) continue; // too thin to be worth it
    if (samples.length < 12) samples.push(`[${x.s.c}] ${x.s.n} — ${w}`);
    if (!dry) { x.s.w = w; enriched.add(x.s.id); }
    done++;
  }
  if (dry) {
    console.log("\n" + samples.join("\n\n"));
    console.error(`\n--dry: would enrich ${done} writeups from Wikipedia. Nothing written.`);
    return;
  }
  fs.writeFileSync(SPOTS, JSON.stringify(spots, null, 1) + "\n");
  fs.writeFileSync(MANIFEST, JSON.stringify([...enriched], null, 0) + "\n");
  console.error(`\nenriched ${done} writeups from Wikipedia. ${enriched.size} ids in ${path.relative(ROOT, MANIFEST)}. next: npm run build`);
})().catch((e) => { console.error("✗ " + e.message); process.exit(1); });
