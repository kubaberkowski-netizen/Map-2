#!/usr/bin/env node
"use strict";

/*
 * Audit one or more research dossiers before they are imported. This is the
 * bundle-level counterpart to add-spots.js: it applies the editorial contract
 * across categories, checks the live model, and reviews aliases / coordinates
 * globally rather than only within a declared city.
 *
 * Usage:
 *   node tools/audit-research-bundle.js research/world-hills-wave2-2026-08-09.json \
 *     research/world-steps-wave2-2026-08-09.json
 *
 * Each dossier must expose an `included` array. Missing city slugs are reported
 * separately so they can be resolved through tools/add-cities.js; all other
 * failures make the command exit non-zero.
 *
 * Dense-city candidate pairs from 30–119 m apart require a named review on
 * either row, for example:
 *   dedupe.internal_neighbours = [
 *     { id: "other-candidate-id", status: "distinct", rationale: "..." }
 *   ]
 * Candidate pairs under 30 m remain presumed duplicates.
 */

const fs = require("node:fs");
const path = require("node:path");
const modelApi = require("./model");

const ROOT = path.join(__dirname, "..");
const PROXIMITY_M = 120;
const PRESUMED_DUPLICATE_M = 30;

function die(message) {
  console.error(message);
  process.exit(1);
}

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
  ]
    .map(canonical)
    .filter(Boolean))];
}

function externalIdsOf(row) {
  const values = [];
  const add = (kind, value) => {
    if (value != null && value !== "") values.push(`${kind}:${String(value)}`);
  };
  const ids = row.external_ids || row.externalIds || {};
  if (ids && typeof ids === "object" && !Array.isArray(ids))
    for (const [kind, value] of Object.entries(ids)) add(kind, value);
  for (const key of ["wikidata", "osm_id", "osm_way", "osm_node", "mapillary"])
    add(key, row[key]);
  if (row.coordinate_basis && typeof row.coordinate_basis === "object") {
    for (const key of ["wikidata", "osm_id", "osm_way", "osm_node"])
      add(key, row.coordinate_basis[key]);
  }
  return [...new Set(values)];
}

function isOfficialSource(source) {
  return !!(
    source &&
    (source.official_or_land_manager === true ||
      source.official === true ||
      source.land_manager === true ||
      source.first_party === true ||
      /official|municipal|government|council|land manager|operator|heritage register|first.party/i.test(
        `${source.role || ""} ${source.type || ""}`
      ))
  );
}

function scoreOf(row) {
  return row.editorial_score || row.score || null;
}

function sourcesOf(row) {
  return row.sources || row._sources || null;
}

function confidenceValues(value) {
  if (!value || typeof value !== "object") return [];
  const values = [];
  for (const item of Object.values(value)) {
    if (item && typeof item === "object") values.push(...confidenceValues(item));
    else values.push(item);
  }
  return values;
}

function reviewedNeighbour(row) {
  const dedupe = row.dedupe || {};
  return /clear|distinct|no[_ -]?conflict|pass/i.test(
    `${dedupe.outcome || ""} ${dedupe.result || ""} ${dedupe.status || ""}`
  );
}

function neighbourRationale(row) {
  const dedupe = row.dedupe || {};
  return String(
    dedupe.rationale || dedupe.review_note || dedupe.manual_review ||
    (dedupe.nearest_existing && dedupe.nearest_existing.review) || ""
  ).trim();
}

function internalNeighbourReviews(row) {
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
  return internalNeighbourReviews(left).some((review) => {
    const referenced = canonical(
      review.id || review.candidate_id || review.name || review.n ||
      review.neighbour || review.neighbor || review.other
    );
    const outcome = `${review.outcome || ""} ${review.result || ""} ${review.status || ""}`;
    const rationale = String(
      review.rationale || review.review_note || review.manual_review || review.note || ""
    ).trim();
    return rightKeys.has(referenced) &&
      /clear|distinct|no[_ -]?conflict|pass/i.test(outcome) && rationale.length >= 20;
  });
}

function main() {
  const args = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
  if (!args.length) die("usage: node tools/audit-research-bundle.js <dossier.json> [...]");

  const model = modelApi.loadModel();
  const catalogue = modelApi.loadCatalogue();
  const errors = [];
  const warnings = [];
  const cityGaps = new Map();
  const candidates = [];

  for (const arg of args) {
    const file = path.resolve(ROOT, arg);
    if (!fs.existsSync(file)) die(`no ${path.relative(ROOT, file)}`);
    const dossier = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!Array.isArray(dossier.included)) {
      errors.push(`${path.basename(file)}: top-level included is not an array`);
      continue;
    }
    const declaredCount = Number.isInteger(dossier.included_count)
      ? dossier.included_count
      : dossier.meta && Number.isInteger(dossier.meta.included_count)
        ? dossier.meta.included_count
        : null;
    if (declaredCount != null && declaredCount !== dossier.included.length)
      errors.push(`${path.basename(file)}: included_count ${declaredCount} != ${dossier.included.length}`);
    for (const row of dossier.included) candidates.push({ row, file: path.basename(file) });
  }

  const seenCandidateIds = new Map();
  const seenExternalIds = new Map();
  const required = ["n", "a", "pc", "lat", "lng", "c", "s", "q", "w", "city"];
  for (const candidate of candidates) {
    const { row, file } = candidate;
    const label = `${file}: ${row.n || "<unnamed>"}`;
    for (const field of required)
      if (!(field in row)) errors.push(`${label}: missing production field ${field}`);
    if (!row.n || !row.c || !row.city) errors.push(`${label}: blank identity/category/city`);
    if (!Number.isFinite(row.lat) || !Number.isFinite(row.lng)) errors.push(`${label}: invalid coordinate`);
    if (!model.categories.has(row.c)) errors.push(`${label}: unknown category ${row.c}`);

    const candidateId = row.id || modelApi.slugify(row.n);
    if (seenCandidateIds.has(candidateId))
      errors.push(`${label}: candidate id ${candidateId} also used by ${seenCandidateIds.get(candidateId)}`);
    else seenCandidateIds.set(candidateId, label);

    const score = scoreOf(row);
    if (!score || !Number.isFinite(score.total)) errors.push(`${label}: missing numeric editorial score`);
    else {
      if (score.total < 19) errors.push(`${label}: score ${score.total} is below 19`);
      if (score.story < 4) errors.push(`${label}: story score is below 4`);
      if (score.walkability < 4) errors.push(`${label}: walkability score is below 4`);
    }

    const confidence = confidenceValues(row.confidence);
    if (!confidence.length || confidence.some((value) => value !== "high"))
      errors.push(`${label}: confidence is missing or not all high`);

    const sources = sourcesOf(row);
    if (!Array.isArray(sources) || sources.length < 2) errors.push(`${label}: fewer than two sources`);
    else {
      if (sources.some((source) => !source || !/^https?:\/\//.test(source.url || "")))
        errors.push(`${label}: source without an HTTP(S) URL`);
      if (!sources.some(isOfficialSource)) errors.push(`${label}: no marked official/manager/first-party source`);
      if (!sources.some((source) => /current|access|open|hours|visitor|route|walk|pedestrian|connection|closure|reopen|destination|trading|retail|status|\buse\b/i.test(source.role || "")))
        errors.push(`${label}: no source is explicitly assigned a current access/trading/status role`);
    }

    if (!row.q || canonical(row.q).length < canonical(row.n).length)
      errors.push(`${label}: q is not a useful search query`);
    if (/^(climb|cross|walk|visit|find|follow|discover|stand|browse|look)\b/i.test(String(row.q).trim()))
      errors.push(`${label}: q reads like an action hook rather than a search query`);

    const city = model.cityById.get(row.city);
    if (!city) cityGaps.set(row.city, (cityGaps.get(row.city) || 0) + 1);
    else {
      const validation = modelApi.validateRow({ ...row, id: candidateId }, model);
      if (!validation.ok) errors.push(`${label}: ${validation.errors.join("; ")}`);
      const rawInside =
        row.lng >= city.bbox[0] && row.lng <= city.bbox[2] &&
        row.lat >= city.bbox[1] && row.lat <= city.bbox[3];
      if (!rawInside) errors.push(`${label}: coordinate is outside the raw ${row.city} bbox`);
      const inferred = modelApi.cityForPoint(row.lat, row.lng, model);
      if (inferred !== row.city) {
        const inferredCity = inferred && model.cityById.get(inferred);
        if (rawInside && inferredCity && inferredCity.region) {
          warnings.push(
            `${label}: explicit raw-in-bounds city ${row.city} retained over ` +
            `overlapping region ${inferred}`
          );
        } else {
          errors.push(`${label}: cityForPoint inferred ${inferred || "none"}, not ${row.city}`);
        }
      }
    }

    for (const externalId of externalIdsOf(row)) {
      if (seenExternalIds.has(externalId))
        errors.push(`${label}: external id ${externalId} also used by ${seenExternalIds.get(externalId)}`);
      else seenExternalIds.set(externalId, label);
    }
  }

  const existingAliases = catalogue.spots.map((spot) => ({
    spot,
    name: canonical(spot.n),
  }));
  for (const candidate of candidates) {
    const { row, file } = candidate;
    if (!Number.isFinite(row.lat) || !Number.isFinite(row.lng)) continue;
    const label = `${file}: ${row.n}`;
    const aliases = new Set(aliasesOf(row));
    let nearest = null;
    for (const existing of existingAliases) {
      const distance = modelApi.haversineM(row.lat, row.lng, existing.spot.lat, existing.spot.lng);
      if (!nearest || distance < nearest.distance) nearest = { ...existing, distance };
      if (aliases.has(existing.name) && distance < 3000)
        errors.push(`${label}: alias/name collision within 3 km with ${existing.spot.n} (${Math.round(distance)} m)`);
    }
    if (!nearest) continue;
    if (
      nearest.distance < PRESUMED_DUPLICATE_M &&
      !(reviewedNeighbour(row) && neighbourRationale(row).length >= 20)
    )
      errors.push(`${label}: presumed duplicate ${Math.round(nearest.distance)} m from ${nearest.spot.n}; a distinct-place override needs an explicit rationale`);
    else if (
      nearest.distance < PROXIMITY_M &&
      !(reviewedNeighbour(row) && neighbourRationale(row).length >= 20)
    )
      errors.push(`${label}: ${Math.round(nearest.distance)} m neighbour ${nearest.spot.n} lacks an explicit clear/distinct review rationale`);
  }

  for (let i = 0; i < candidates.length; i++) {
    const left = candidates[i].row;
    if (!Number.isFinite(left.lat) || !Number.isFinite(left.lng)) continue;
    const leftAliases = new Set(aliasesOf(left));
    for (let j = i + 1; j < candidates.length; j++) {
      const right = candidates[j].row;
      if (!Number.isFinite(right.lat) || !Number.isFinite(right.lng)) continue;
      const distance = modelApi.haversineM(left.lat, left.lng, right.lat, right.lng);
      if (distance < PRESUMED_DUPLICATE_M)
        errors.push(
          `candidate collision: ${left.n} is ${Math.round(distance)} m from ${right.n}; ` +
          `candidate pairs under ${PRESUMED_DUPLICATE_M} m are presumed duplicates`
        );
      else if (
        distance < PROXIMITY_M &&
        !reviewedInternalPair(left, right) &&
        !reviewedInternalPair(right, left)
      )
        errors.push(
          `candidate collision: ${left.n} is ${Math.round(distance)} m from ${right.n}; ` +
          "an explicit named internal-neighbour review is required"
        );
      if (distance < 3000 && aliasesOf(right).some((alias) => leftAliases.has(alias)))
        errors.push(`candidate alias collision: ${left.n} / ${right.n} (${Math.round(distance)} m)`);
    }
  }

  const byCategory = Object.create(null);
  for (const { row } of candidates) byCategory[row.c] = (byCategory[row.c] || 0) + 1;
  console.log(`${candidates.length} included row(s) across ${args.length} dossier(s)`);
  console.log(`categories: ${Object.entries(byCategory).map(([key, value]) => `${key}=${value}`).join(", ")}`);
  console.log(`catalogue snapshot: ${catalogue.spots.length} row(s); global threshold ${PROXIMITY_M} m`);
  if (cityGaps.size)
    console.log(`city gaps (${[...cityGaps.values()].reduce((sum, value) => sum + value, 0)} rows): ${[...cityGaps.entries()].map(([id, count]) => `${id}=${count}`).join(", ")}`);
  if (warnings.length) warnings.forEach((warning) => console.warn(`WARN ${warning}`));
  if (errors.length) {
    errors.forEach((error) => console.error(`FAIL ${error}`));
    console.error(`${errors.length} bundle audit failure(s)`);
    process.exitCode = 1;
    return;
  }
  console.log("bundle audit passed (city gaps, if listed, still require a reviewed registry plan)");
}

main();
