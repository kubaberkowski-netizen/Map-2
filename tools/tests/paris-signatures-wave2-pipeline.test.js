"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const modelApi = require("../model");

const ROOT = path.resolve(__dirname, "../..");
const REQUIRED = ["n", "a", "pc", "lat", "lng", "c", "s", "q", "w", "city"];
const SCORE_KEYS = ["story", "walkability", "distinctiveness", "source_quality", "geographic_value"];
const CONTRACTS = [
  { file: "paris-arcades-trades-faith-wave2-2026-08-09.json", count: 18, screened: 58 },
  { file: "paris-street-furniture-deep-2026-08-09.json", count: 12, screened: 84 },
  { file: "paris-art-nouveau-wave2-2026-08-09.json", count: 11, screened: 33 },
];

function canonical(value) {
  return String(value || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ")
    .trim().replace(/\s+/g, " ");
}

function aliases(row) {
  return new Set([row.n, ...(row.aliases || []), ...(row.local_aliases || [])]
    .map(canonical).filter(Boolean));
}

function confidenceValues(value) {
  if (!value || typeof value !== "object") return [];
  return Object.values(value).flatMap((item) =>
    item && typeof item === "object" ? confidenceValues(item) : [item]
  );
}

function official(source) {
  return !!(source && (source.official || source.official_or_land_manager ||
    source.land_manager || source.first_party ||
    /official|municipal|operator|manager|heritage|first.party/i.test(
      `${source.role || ""} ${source.publisher || ""}`
    )));
}

function neighbourReview(row) {
  const d = row.dedupe || {};
  const result = `${d.status || ""} ${d.outcome || ""} ${d.result || ""}`;
  const rationale = String(d.rationale || d.review_note || d.manual_review || "").trim();
  return /clear|distinct|pass|reviewed/i.test(result) && rationale.length >= 20;
}

function main() {
  const model = modelApi.loadModel();
  const spots = JSON.parse(fs.readFileSync(path.join(ROOT, "data/spots.json"), "utf8"));
  const quality = JSON.parse(fs.readFileSync(path.join(ROOT, "data/quality.json"), "utf8"));
  const rows = [];

  assert.equal(model.categories.size, 68, "the live model exposes 68 categories");
  for (const slug of ["arcades", "streetfurniture", "historicshopfronts", "artnouveau"])
    assert.equal(model.categories.has(slug), true, `the live model defines ${slug}`);

  for (const contract of CONTRACTS) {
    const dossier = JSON.parse(fs.readFileSync(path.join(ROOT, "research", contract.file), "utf8"));
    const screened = dossier.screened_count || (dossier.meta && dossier.meta.screened_count);
    assert.equal(dossier.included.length, contract.count, `${contract.file} retained count`);
    assert.equal(dossier.included_count, contract.count, `${contract.file} declared count`);
    assert.equal(screened, contract.screened, `${contract.file} screened count`);
    assert.equal(dossier.import_metadata.status, "imported_as_draft", `${contract.file} import status`);
    assert.equal(dossier.import_metadata.imported_count, contract.count, `${contract.file} import count`);
    assert.equal(dossier.import_metadata.quality_flag, "d", `${contract.file} import quality`);
    assert.equal(dossier.import_metadata.do_not_reimport, true, `${contract.file} reimport guard`);
    for (const row of dossier.included) rows.push({ row, contract });
  }
  assert.equal(rows.length, 41, "the strict second Paris bundle contains 41 rows");
  assert.equal(CONTRACTS.reduce((n, item) => n + item.screened, 0), 175, "the wave screened 175 leads");

  const importedIds = new Set();
  const categoryCounts = new Map();
  for (const { row, contract } of rows) {
    const label = `${contract.file}: ${row.n}`;
    for (const field of REQUIRED) assert.ok(field in row, `${label} has ${field}`);
    assert.equal(row.city, "paris", `${label} belongs to Paris`);
    assert.ok(row.n && row.a && row.pc && row.s && row.q && row.w, `${label} copy is complete`);
    assert.equal(/^(climb|cross|walk|visit|find|follow|discover|stand|browse|look)\b/i.test(row.q), false, `${label} q is a search query`);

    const validation = modelApi.validateRow({ ...row, id: row.id || modelApi.slugify(row.n) }, model);
    assert.equal(validation.ok, true, `${label}: ${validation.errors.join("; ")}`);
    const paris = model.cityById.get("paris");
    assert.ok(row.lng >= paris.bbox[0] && row.lng <= paris.bbox[2] &&
      row.lat >= paris.bbox[1] && row.lat <= paris.bbox[3], `${label} is raw-inside Paris`);

    const score = row.editorial_score;
    assert.ok(score && score.total >= 19 && score.story >= 4 && score.walkability >= 4, `${label} clears score gates`);
    assert.equal(SCORE_KEYS.reduce((n, key) => n + score[key], 0), score.total, `${label} score adds up`);
    const confidence = confidenceValues(row.confidence);
    assert.ok(confidence.length && confidence.every((value) => value === "high"), `${label} is all-high`);
    assert.ok(Array.isArray(row.sources) && row.sources.length >= 2, `${label} has two sources`);
    assert.ok(row.sources.some(official), `${label} has an authoritative source`);
    const sourceUrls = new Set(row.sources.map((source) => source.url));
    assert.ok(row.sources.every((source) => /^https?:\/\//.test(source.url || "")), `${label} sources are URLs`);
    assert.ok(Array.isArray(row.facts) && row.facts.length >= 2, `${label} has atomic facts`);
    for (const fact of row.facts) {
      assert.ok(fact && String(fact.claim || "").trim(), `${label} fact has a claim`);
      assert.ok(Array.isArray(fact.source_urls) && fact.source_urls.length, `${label} fact has sources`);
      assert.ok(fact.source_urls.every((url) => sourceUrls.has(url)), `${label} fact URLs belong to the row`);
    }
    const coordinate = row.coordinate_basis;
    assert.ok(coordinate && /^https?:\/\//.test(coordinate.source_url || coordinate.url || ""), `${label} coordinate basis is inspectable`);
    const access = row.access || row.public_access_evidence;
    assert.ok(access && access.checked_at === "2026-08-09", `${label} has current access evidence`);

    const matches = spots.filter((spot) => spot.n === row.n && spot.c === row.c && spot.city === "paris");
    assert.equal(matches.length, 1, `${label} maps to one production row`);
    const live = matches[0];
    for (const field of ["n", "a", "pc", "c", "s", "q", "w", "city"])
      assert.equal(live[field], row[field], `${label} production ${field} matches`);
    assert.equal(live.lat, +row.lat.toFixed(5), `${label} production latitude matches`);
    assert.equal(live.lng, +row.lng.toFixed(5), `${label} production longitude matches`);
    assert.equal(quality.flags[live.id], "d", `${label} remains draft quality`);
    assert.equal(importedIds.has(live.id), false, `${label} import id is unique`);
    importedIds.add(live.id);
    categoryCounts.set(row.c, (categoryCounts.get(row.c) || 0) + 1);
  }

  assert.deepEqual(Object.fromEntries([...categoryCounts].sort()), {
    arcades: 7,
    artnouveau: 11,
    historicshopfronts: 8,
    market: 1,
    monastery: 1,
    streetfurniture: 12,
    synagogue: 1,
  });

  for (let i = 0; i < rows.length; i++) {
    const left = rows[i].row;
    for (let j = i + 1; j < rows.length; j++) {
      const right = rows[j].row;
      const distance = modelApi.haversineM(left.lat, left.lng, right.lat, right.lng);
      assert.ok(distance >= 30, `${left.n}/${right.n} clear the hard 30 m rule`);
      if (distance < 120) assert.ok(neighbourReview(left) || neighbourReview(right), `${left.n}/${right.n} have a dense-city review`);
      if (distance < 3000) {
        const rightAliases = aliases(right);
        assert.equal([...aliases(left)].some((alias) => rightAliases.has(alias)), false, `${left.n}/${right.n} do not collide by alias`);
      }
    }
  }

  const preexisting = spots.filter((spot) => !importedIds.has(spot.id));
  for (const { row } of rows) {
    let nearest = Infinity;
    for (const spot of preexisting) nearest = Math.min(nearest, modelApi.haversineM(row.lat, row.lng, spot.lat, spot.lng));
    assert.ok(nearest >= 30, `${row.n} clears the hard global 30 m rule`);
    if (nearest < 120) assert.ok(neighbourReview(row), `${row.n} has a written global-neighbour review`);
  }

  const retags = {
    galerievivienne: "arcades",
    passagedespanoramas: "arcades",
    passagedugrandcerf: "arcades",
    passagebrady: "arcades",
    canonmeridiendupalaisroy: "streetfurniture",
    metreetalondelaruedevaug: "streetfurniture",
    miredusud: "streetfurniture",
    pointzerodesroutesdefran: "streetfurniture",
  };
  for (const [id, category] of Object.entries(retags))
    assert.equal(spots.find((spot) => spot.id === id).c, category, `${id} is precisely retagged`);
  assert.equal(spots.find((spot) => spot.id === "fontainewallace2").c, "history", "the mispinned generic Wallace row was not retagged");

  assert.equal(spots.length, 17369, "the catalogue contains 41 new Paris drafts");
  assert.equal(spots.filter((spot) => spot.city === "paris").length, 272, "Paris contains 272 rows");
  assert.equal(new Set(spots.filter((spot) => spot.city === "paris").map((spot) => spot.c)).size, 56, "Paris spans 56 categories");
  assert.equal(new Set(spots.map((spot) => spot.id)).size, spots.length, "production ids are unique");
  assert.equal(quality.baseline, spots.length, "quality baseline matches production");
  assert.equal(Object.keys(quality.flags).length, spots.length, "every row has a quality flag");
  console.log("Paris signature wave 2 contracts passed (41 drafts; 272 Paris rows; 56 categories)");
}

main();
