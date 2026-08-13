"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const modelApi = require("../model");

const ROOT = path.resolve(__dirname, "../..");
const REQUIRED = ["n", "a", "pc", "lat", "lng", "c", "s", "q", "w", "city"];
const SCORE_KEYS = ["story", "walkability", "distinctiveness", "source_quality", "geographic_value"];
const ACTION_QUERY = /^(climb|cross|walk|visit|find|follow|discover|stand|browse|look)\b/i;
const PRESUMED_DUPLICATE_M = 30;
const REVIEW_DISTANCE_M = 120;

const contracts = [
  { file: "paris-built-history-deep-2026-08-09.json", count: 32, screened: 108 },
  { file: "paris-outdoor-deep-2026-08-09.json", count: 29, screened: 88 },
  { file: "paris-culture-commerce-deep-2026-08-09.json", count: 30, screened: 128 },
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

function neighbourRationale(row) {
  const dedupe = row.dedupe || {};
  return String(
    dedupe.rationale || dedupe.review_note ||
    (typeof dedupe.manual_review === "string" ? dedupe.manual_review : "") ||
    (dedupe.nearest_existing && dedupe.nearest_existing.review) || ""
  ).trim();
}

function reviewedExistingNeighbour(row) {
  const dedupe = row.dedupe || {};
  const outcome = `${dedupe.outcome || ""} ${dedupe.result || ""} ${dedupe.status || ""}`;
  return /clear|distinct|no[_ -]?conflict|pass/i.test(outcome) && neighbourRationale(row).length >= 20;
}

function internalReviews(row) {
  const dedupe = row.dedupe || {};
  return [
    ...(Array.isArray(dedupe.internal_neighbours) ? dedupe.internal_neighbours : []),
    ...(Array.isArray(dedupe.candidate_neighbours) ? dedupe.candidate_neighbours : []),
    ...(Array.isArray(dedupe.reviewed_neighbours) ? dedupe.reviewed_neighbours : []),
  ].filter((review) => review && typeof review === "object");
}

function reviewedInternalPair(left, right) {
  const rightKeys = new Set([
    right.id,
    modelApi.slugify(right.n || ""),
    right.n,
    ...(Array.isArray(right.aliases) ? right.aliases : []),
    ...(Array.isArray(right.local_aliases) ? right.local_aliases : []),
  ].map(canonical).filter(Boolean));
  return internalReviews(left).some((review) => {
    const reference = canonical(
      review.id || review.candidate_id || review.name || review.n ||
      review.neighbour || review.neighbor || review.other
    );
    const outcome = `${review.outcome || ""} ${review.result || ""} ${review.status || ""}`;
    const rationale = String(
      review.rationale || review.review_note || review.manual_review || review.note || ""
    ).trim();
    return rightKeys.has(reference) &&
      /clear|distinct|no[_ -]?conflict|pass/i.test(outcome) && rationale.length >= 20;
  });
}

function main() {
  const model = modelApi.loadModel();
  const spots = JSON.parse(fs.readFileSync(path.join(ROOT, "data/spots.json"), "utf8"));
  const quality = JSON.parse(fs.readFileSync(path.join(ROOT, "data/quality.json"), "utf8"));
  const rows = [];

  assert.equal(model.categories.size, 68, "the live model exposes 68 categories");
  for (const contract of contracts) {
    const dossier = JSON.parse(fs.readFileSync(path.join(ROOT, "research", contract.file), "utf8"));
    assert.equal(dossier.included.length, contract.count, `${contract.file} retained count`);
    assert.equal(dossier.included_count, contract.count, `${contract.file} declared count`);
    const screened = dossier.screened_count || (dossier.meta && dossier.meta.screened_count) ||
      (dossier.screening && dossier.screening.screened_count);
    assert.equal(screened, contract.screened, `${contract.file} screened count`);
    assert.equal(dossier.import_metadata && dossier.import_metadata.status, "imported_as_draft", `${contract.file} records the guarded draft import`);
    assert.equal(dossier.import_metadata.imported_count, contract.count, `${contract.file} import count`);
    assert.equal(dossier.import_metadata.quality_flag, "d", `${contract.file} import quality flag`);
    assert.equal(dossier.import_metadata.do_not_reimport, true, `${contract.file} cannot be re-imported accidentally`);
    for (const row of dossier.included) rows.push({ row, contract });
  }
  assert.equal(contracts.reduce((sum, contract) => sum + contract.screened, 0), 324, "the run screened 324 leads");
  assert.equal(rows.length, 91, "the strict Paris bundle contains 91 rows");

  const importedIds = new Set();
  for (const { row, contract } of rows) {
    const label = `${contract.file}: ${row.n}`;
    for (const field of REQUIRED) assert.ok(field in row, `${label} has production field ${field}`);
    assert.equal(row.city, "paris", `${label} belongs to Paris`);
    assert.ok(row.n && row.a && row.s && row.q && row.w, `${label} has complete core copy`);
    assert.equal(ACTION_QUERY.test(String(row.q).trim()), false, `${label} q is a search query`);

    const validation = modelApi.validateRow({ ...row, id: row.id || modelApi.slugify(row.n) }, model);
    assert.equal(validation.ok, true, `${label}: ${validation.errors.join("; ")}`);
    const city = model.cityById.get(row.city);
    assert.ok(
      row.lng >= city.bbox[0] && row.lng <= city.bbox[2] &&
      row.lat >= city.bbox[1] && row.lat <= city.bbox[3],
      `${label} lies inside the raw Paris bbox`
    );
    const inferred = modelApi.cityForPoint(row.lat, row.lng, model);
    if (inferred !== row.city) {
      const inferredCity = model.cityById.get(inferred);
      assert.equal(!!(inferredCity && inferredCity.region), true, `${label} may only be shadowed by a broad region`);
    }

    const score = row.editorial_score;
    assert.ok(score && score.total >= 19, `${label} clears 19/25`);
    assert.ok(score.story >= 4 && score.walkability >= 4, `${label} clears story/walkability floors`);
    assert.equal(SCORE_KEYS.reduce((sum, key) => sum + score[key], 0), score.total, `${label} score adds up`);
    const confidence = confidenceValues(row.confidence);
    assert.ok(confidence.length && confidence.every((value) => value === "high"), `${label} is all-high`);
    assert.ok(Array.isArray(row.sources) && row.sources.length >= 2, `${label} has two sources`);
    assert.ok(row.sources.every((source) => /^https?:\/\//.test(source.url || "")), `${label} sources are URLs`);
    assert.ok(row.sources.some(officialSource), `${label} has an official/manager/first-party source`);
    const access = row.access || row.public_access_evidence;
    assert.ok(access && typeof access === "object", `${label} records current access`);
    assert.equal(
      access.checked_at === "2026-08-09" || row.sources.some((source) => source.checked_at === "2026-08-09"),
      true,
      `${label} has a 2026-08-09 currentness check`
    );
    const sourceUrls = new Set(row.sources.map((source) => source.url));
    const sourceIds = new Set(row.sources.map((source) => source.id).filter(Boolean));
    const coordinate = row.coordinate_basis;
    assert.ok(coordinate && typeof coordinate === "object" && !Array.isArray(coordinate), `${label} has a structured coordinate basis`);
    const coordinateUrl = coordinate.url || coordinate.source_url;
    const coordinateIds = Array.isArray(coordinate.source_ids) ? coordinate.source_ids : [];
    assert.equal(/^https?:\/\//.test(coordinateUrl || "") || coordinateIds.length > 0, true, `${label} coordinate basis links to evidence`);
    assert.ok(coordinateIds.every((id) => sourceIds.has(id)), `${label} coordinate source id belongs to the row`);
    assert.ok(Array.isArray(row.facts) && row.facts.length >= 2, `${label} has atomic facts`);
    for (const fact of row.facts) {
      assert.ok(fact && typeof fact === "object" && String(fact.claim || "").trim(), `${label} fact is an object with a claim`);
      const urls = Array.isArray(fact.source_urls) ? fact.source_urls : [];
      const ids = Array.isArray(fact.source_ids) ? fact.source_ids : [];
      assert.ok(urls.length || ids.length, `${label} fact links to evidence`);
      assert.ok(urls.every((url) => sourceUrls.has(url)), `${label} fact source URL belongs to the row`);
      assert.ok(ids.every((id) => sourceIds.has(id)), `${label} fact source id belongs to the row`);
    }

    const matches = spots.filter((spot) => spot.n === row.n && spot.c === row.c && spot.city === "paris");
    assert.equal(matches.length, 1, `${label} maps to exactly one production row`);
    const live = matches[0];
    for (const field of ["n", "a", "pc", "c", "s", "q", "w", "city"])
      assert.equal(live[field], row[field], `${label} production ${field} matches`);
    assert.equal(live.lat, +row.lat.toFixed(5), `${label} production latitude matches`);
    assert.equal(live.lng, +row.lng.toFixed(5), `${label} production longitude matches`);
    assert.equal(quality.flags[live.id], "d", `${label} remains draft quality`);
    assert.equal(importedIds.has(live.id), false, `${label} production id is unique in the run`);
    importedIds.add(live.id);
  }

  for (let i = 0; i < rows.length; i++) {
    const left = rows[i].row;
    const leftAliases = new Set(aliasesOf(left));
    for (let j = i + 1; j < rows.length; j++) {
      const right = rows[j].row;
      const distance = modelApi.haversineM(left.lat, left.lng, right.lat, right.lng);
      assert.ok(distance >= PRESUMED_DUPLICATE_M, `${left.n}/${right.n} are not an under-30 m presumed duplicate`);
      if (distance < REVIEW_DISTANCE_M)
        assert.equal(reviewedInternalPair(left, right) || reviewedInternalPair(right, left), true, `${left.n}/${right.n} have a named dense-city review`);
      if (distance < 3000)
        assert.equal(aliasesOf(right).some((alias) => leftAliases.has(alias)), false, `${left.n}/${right.n} have no alias collision`);
    }
  }

  const preexisting = spots.filter((spot) => !importedIds.has(spot.id));
  for (const { row } of rows) {
    let nearest = null;
    const aliases = new Set(aliasesOf(row));
    for (const spot of preexisting) {
      const distance = modelApi.haversineM(row.lat, row.lng, spot.lat, spot.lng);
      if (!nearest || distance < nearest.distance) nearest = { spot, distance };
      if (distance < 3000)
        assert.equal(aliases.has(canonical(spot.n)), false, `${row.n} has no nearby preexisting alias collision`);
    }
    assert.ok(nearest.distance >= PRESUMED_DUPLICATE_M, `${row.n} is not an under-30 m preexisting duplicate`);
    if (nearest.distance < REVIEW_DISTANCE_M)
      assert.equal(reviewedExistingNeighbour(row), true, `${row.n}'s ${Math.round(nearest.distance)} m existing neighbour has a written review`);
  }

  const preexistingParis = preexisting.filter((spot) => spot.city === "paris");
  assert.ok(preexisting.length >= 17237, "the catalogue retains all 17,237 pre-run rows");
  assert.ok(preexistingParis.length >= 140, "the catalogue retains all 140 pre-run Paris rows");
  assert.ok(spots.length >= 17328, "the catalogue retains the 91 Paris drafts");
  assert.ok(spots.filter((spot) => spot.city === "paris").length >= 231, "Paris retains at least 231 rows after import");
  assert.ok(new Set(preexistingParis.map((spot) => spot.c)).size >= 37, "pre-run Paris coverage remains at least 37 categories");
  assert.ok(new Set(spots.filter((spot) => spot.city === "paris").map((spot) => spot.c)).size >= 51, "Paris retains coverage of at least 51 categories");

  const productionIds = new Set(spots.map((spot) => spot.id));
  assert.equal(productionIds.size, spots.length, "all production ids are unique");
  assert.equal(quality.baseline, spots.length, "quality baseline matches the catalogue");
  assert.equal(Object.keys(quality.flags).length, spots.length, "every production row has a quality flag");
  assert.equal(Object.keys(quality.flags).every((id) => productionIds.has(id)), true, "quality has no orphan ids");
  console.log("Paris deep-run contracts passed (91 draft rows; 231 Paris total; 51 categories)");
}

main();
