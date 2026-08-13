"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const modelApi = require("../model");

const ROOT = path.resolve(__dirname, "../..");
const REQUIRED = ["n", "a", "pc", "lat", "lng", "c", "s", "q", "w", "city"];
const SCORE_KEYS = ["story", "walkability", "distinctiveness", "source_quality", "geographic_value"];
const ACTION_QUERY = /^(climb|cross|walk|visit|find|follow|discover|stand|browse|look)\b/i;

const contracts = [
  { file: "world-hills-wave2-2026-08-09.json", category: "hills", count: 20 },
  { file: "world-steps-wave2-2026-08-09.json", category: "steps", count: 14 },
  { file: "world-landmark-trees-wave2-2026-08-09.json", category: "landmarktrees", count: 24 },
  { file: "world-specialist-shops-wave2-2026-08-09.json", category: "specialistshops", count: 15 },
  { file: "world-footbridges-wave2-2026-08-09.json", category: "footbridges", count: 33 },
];

function canonical(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function aliasesOf(row) {
  return [...new Set([
    row.n,
    ...(Array.isArray(row.aliases) ? row.aliases : []),
    ...(Array.isArray(row.local_aliases) ? row.local_aliases : []),
  ].map(canonical).filter(Boolean))];
}

function confidenceValues(value) {
  if (!value || typeof value !== "object") return [];
  return Object.values(value).flatMap((item) =>
    item && typeof item === "object" ? confidenceValues(item) : [item]
  );
}

function externalIdsOf(row) {
  const values = [];
  const ids = row.external_ids || row.externalIds || {};
  if (ids && typeof ids === "object" && !Array.isArray(ids)) {
    for (const [kind, value] of Object.entries(ids))
      if (value != null && value !== "") values.push(`${kind}:${value}`);
  }
  for (const key of ["wikidata", "osm_id", "osm_way", "osm_node", "mapillary"])
    if (row[key] != null && row[key] !== "") values.push(`${key}:${row[key]}`);
  return [...new Set(values)];
}

function officialSource(source) {
  return !!(
    source &&
    (source.official === true || source.official_or_land_manager === true ||
      source.land_manager === true || source.first_party === true ||
      /official|municipal|government|council|land manager|operator|heritage register|first.party/i.test(
        `${source.role || ""} ${source.type || ""}`
      ))
  );
}

function reviewedNeighbour(row) {
  const dedupe = row.dedupe || {};
  const outcome = `${dedupe.outcome || ""} ${dedupe.result || ""} ${dedupe.status || ""}`;
  const rationale = String(
    dedupe.rationale || dedupe.review_note ||
    (typeof dedupe.manual_review === "string" ? dedupe.manual_review : "") ||
    (dedupe.nearest_existing && dedupe.nearest_existing.review) || ""
  ).trim();
  return /clear|distinct|no[_ -]?conflict|pass/i.test(outcome) && rationale.length >= 20;
}

function main() {
  const model = modelApi.loadModel();
  const spots = JSON.parse(fs.readFileSync(path.join(ROOT, "data/spots.json"), "utf8"));
  const quality = JSON.parse(fs.readFileSync(path.join(ROOT, "data/quality.json"), "utf8"));
  const plan = JSON.parse(
    fs.readFileSync(path.join(ROOT, "research/discovery-wave-2-city-registry-qa-2026-08-09.json"), "utf8")
  );
  const proposed = plan.recommendation.preserving_dossier_city_semantics.proposed_entries;
  const bboxUpdates = plan.recommendation.preserving_dossier_city_semantics.bbox_updates || [];

  assert.equal(model.categories.size, 68, "the live model exposes 68 categories");
  assert.equal(model.categories.has("footbridges"), true, "footbridges is registered");
  assert.equal(proposed.length, 49, "the reviewed city plan contains 49 additions");
  assert.equal(bboxUpdates.length, 0, "wave 2 requires no existing-city bbox expansion");
  assert.equal(new Set(proposed.map((entry) => entry.id)).size, proposed.length, "city plan ids are unique");
  for (const entry of proposed) {
    const live = model.cityById.get(entry.id);
    assert.ok(live, `${entry.id} is live in the city registry`);
    assert.deepEqual(live.bbox, entry.bbox, `${entry.id} live bbox matches the reviewed plan`);
  }

  const rows = [];
  for (const contract of contracts) {
    const dossier = JSON.parse(
      fs.readFileSync(path.join(ROOT, "research", contract.file), "utf8")
    );
    assert.equal(dossier.included.length, contract.count, `${contract.file} retained count`);
    assert.equal(
      dossier.import_metadata && dossier.import_metadata.status,
      "imported_as_draft",
      `${contract.file} records the guarded draft import`
    );
    assert.equal(dossier.import_metadata.imported_count, contract.count, `${contract.file} import count`);
    assert.equal(dossier.import_metadata.quality_flag, "d", `${contract.file} import quality flag`);
    assert.equal(dossier.import_metadata.do_not_reimport, true, `${contract.file} is protected from re-import`);
    for (const row of dossier.included) rows.push({ row, contract });
  }
  assert.equal(rows.length, 106, "the final strict bundle contains 106 rows");

  const importedIds = new Set();
  const externalIds = new Map();
  for (const { row, contract } of rows) {
    const label = `${contract.file}: ${row.n}`;
    for (const field of REQUIRED) assert.ok(field in row, `${label} has production field ${field}`);
    assert.equal(row.c, contract.category, `${label} category`);
    assert.ok(row.n && row.a && row.s && row.q && row.w && row.city, `${label} has non-empty core copy`);
    assert.equal(ACTION_QUERY.test(String(row.q).trim()), false, `${label} q is a search query, not an action hook`);

    const validation = modelApi.validateRow({ ...row, id: row.id || modelApi.slugify(row.n) }, model);
    assert.equal(validation.ok, true, `${label}: ${validation.errors.join("; ")}`);
    const city = model.cityById.get(row.city);
    assert.ok(
      row.lng >= city.bbox[0] && row.lng <= city.bbox[2] &&
      row.lat >= city.bbox[1] && row.lat <= city.bbox[3],
      `${label} lies inside the raw reviewed city/region bbox`
    );
    assert.equal(modelApi.cityForPoint(row.lat, row.lng, model), row.city, `${label} infers to its declared city`);

    const score = row.editorial_score;
    assert.ok(score && score.total >= 19, `${label} clears the 19/25 gate`);
    assert.ok(score.story >= 4 && score.walkability >= 4, `${label} clears story and ordinary-walk gates`);
    assert.equal(
      SCORE_KEYS.reduce((sum, key) => sum + score[key], 0),
      score.total,
      `${label} score components add to total`
    );
    const confidence = confidenceValues(row.confidence);
    assert.ok(confidence.length > 0 && confidence.every((value) => value === "high"), `${label} is all-high`);
    assert.ok(Array.isArray(row.sources) && row.sources.length >= 2, `${label} has two or more sources`);
    assert.ok(row.sources.every((source) => /^https?:\/\//.test(source.url || "")), `${label} sources are URLs`);
    assert.ok(row.sources.some(officialSource), `${label} has an official/manager/first-party source`);

    for (const externalId of externalIdsOf(row)) {
      assert.equal(externalIds.has(externalId), false, `${label} external id ${externalId} is unique`);
      externalIds.set(externalId, label);
    }

    const matches = spots.filter(
      (spot) => spot.n === row.n && spot.c === row.c && spot.city === row.city
    );
    assert.equal(matches.length, 1, `${label} maps to exactly one production row`);
    const live = matches[0];
    for (const field of ["n", "a", "pc", "c", "s", "q", "w", "city"])
      assert.equal(live[field], row[field], `${label} production ${field} matches dossier`);
    assert.equal(live.lat, +row.lat.toFixed(5), `${label} production latitude matches`);
    assert.equal(live.lng, +row.lng.toFixed(5), `${label} production longitude matches`);
    assert.equal(quality.flags[live.id], "d", `${label} remains a draft`);
    assert.equal(importedIds.has(live.id), false, `${label} production id is unique within the wave`);
    importedIds.add(live.id);
  }
  assert.equal(importedIds.size, 106, "all 106 retained rows are present once");

  for (let i = 0; i < rows.length; i++) {
    const left = rows[i].row;
    const leftAliases = new Set(aliasesOf(left));
    for (let j = i + 1; j < rows.length; j++) {
      const right = rows[j].row;
      const distance = modelApi.haversineM(left.lat, left.lng, right.lat, right.lng);
      assert.ok(distance >= 120, `${left.n} is not within 120 m of ${right.n}`);
      if (distance < 3000)
        assert.equal(aliasesOf(right).some((alias) => leftAliases.has(alias)), false, `${left.n}/${right.n} alias collision`);
    }
  }

  const preexisting = spots.filter((spot) => !importedIds.has(spot.id));
  for (const { row } of rows) {
    const aliases = new Set(aliasesOf(row));
    let nearest = null;
    for (const spot of preexisting) {
      const distance = modelApi.haversineM(row.lat, row.lng, spot.lat, spot.lng);
      if (!nearest || distance < nearest.distance) nearest = { spot, distance };
      if (distance < 3000)
        assert.equal(aliases.has(canonical(spot.n)), false, `${row.n} has no nearby preexisting alias collision`);
    }
    if (nearest.distance < 120)
      assert.equal(reviewedNeighbour(row), true, `${row.n}'s ${Math.round(nearest.distance)} m neighbour has a written distinct-place review`);
  }

  assert.ok(spots.length >= 17237, "catalogue retains the wave-2 baseline of 17,237 rows");
  const productionIds = new Set(spots.map((spot) => spot.id));
  assert.equal(productionIds.size, spots.length, "all production ids are unique");
  assert.equal(quality.baseline, spots.length, "quality baseline matches catalogue");
  assert.equal(Object.keys(quality.flags).length, spots.length, "every production row has one quality flag");
  assert.equal(
    Object.keys(quality.flags).every((id) => productionIds.has(id)),
    true,
    "quality flags contain no orphan ids"
  );
  console.log("discovery wave 2 pipeline contracts passed (106 draft rows, 49 registry additions)");
}

main();
