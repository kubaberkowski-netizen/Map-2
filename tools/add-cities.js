#!/usr/bin/env node
"use strict";

/*
 * Add audited city metadata to the minified in-template registries without
 * hand-editing their very long source line. The plan JSON is expected to expose
 * recommendation.preserving_dossier_city_semantics.proposed_entries, using the
 * {id,name,label,e,lat,lng,bbox,blurb,region?,country} shape documented by the
 * balanced Europe registry QA dossier. The same section may include guarded
 * bbox_updates entries shaped as {id,bbox} for an existing, honestly grouped
 * city or metro whose current raw bbox is too tight.
 *
 * Usage:
 *   node tools/add-cities.js research/europe-steps-city-registry-qa-2026-08-09.json --dry
 *   node tools/add-cities.js research/europe-steps-city-registry-qa-2026-08-09.json
 */

const fs = require("fs");
const path = require("path");
const acorn = require("acorn");

const ROOT = path.join(__dirname, "..");
const TEMPLATE = path.join(ROOT, "src", "app.template.html");

function die(message) {
  console.error(message);
  process.exit(1);
}

function findDeclarator(ast, name, initType) {
  let hit = null;
  (function walk(node) {
    if (!node || typeof node.type !== "string" || hit) return;
    if (
      node.type === "VariableDeclarator" && node.id && node.id.name === name &&
      node.init && (!initType || node.init.type === initType)
    ) {
      hit = node;
      return;
    }
    for (const key in node) {
      const value = node[key];
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value.type === "string") walk(value);
    }
  })(ast);
  return hit;
}

function propValue(objectNode, key) {
  const prop = objectNode.properties.find(
    (p) => p.type === "Property" && (p.key.name === key || p.key.value === key)
  );
  return prop && prop.value && prop.value.type === "Literal" ? prop.value.value : null;
}

function citySource(entry) {
  const required = ["id", "name", "label", "e", "lat", "lng", "bbox", "blurb", "country"];
  for (const key of required) {
    if (entry[key] == null || entry[key] === "") die(`city entry is missing ${key}: ${JSON.stringify(entry)}`);
  }
  if (!Array.isArray(entry.bbox) || entry.bbox.length !== 4 || entry.bbox.some((n) => !Number.isFinite(n)))
    die(`city ${entry.id} has an invalid bbox`);
  if (!/^[a-z0-9-]+$/.test(entry.id)) die(`city ${entry.id} has an invalid slug`);
  const parts = [
    `id:${JSON.stringify(entry.id)}`,
    `name:${JSON.stringify(entry.name)}`,
    `label:${JSON.stringify(entry.label)}`,
    `e:${JSON.stringify(entry.e)}`,
    `lat:${JSON.stringify(entry.lat)}`,
    `lng:${JSON.stringify(entry.lng)}`,
    `bbox:${JSON.stringify(entry.bbox)}`,
  ];
  if (entry.region) parts.push("region:1");
  parts.push(`blurb:${JSON.stringify(entry.blurb)}`);
  return `{${parts.join(",")}}`;
}

function main() {
  const args = process.argv.slice(2);
  const planArg = args.find((arg) => !arg.startsWith("--"));
  if (!planArg) die("usage: node tools/add-cities.js <registry-plan.json> [--dry]");
  const dry = args.includes("--dry");
  const planPath = path.resolve(ROOT, planArg);
  if (!fs.existsSync(planPath)) die(`no ${path.relative(ROOT, planPath)}`);

  const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
  const section = plan && plan.recommendation && plan.recommendation.preserving_dossier_city_semantics;
  const entries = section && section.proposed_entries || [];
  const bboxUpdates = section && section.bbox_updates || [];
  if (!Array.isArray(entries)) die("plan proposed_entries must be an array");
  if (!Array.isArray(bboxUpdates)) die("plan bbox_updates must be an array");
  if (!entries.length && !bboxUpdates.length) die("plan has no proposed city entries or bbox updates");
  if (new Set(entries.map((entry) => entry.id)).size !== entries.length) die("plan contains duplicate city ids");
  if (new Set(bboxUpdates.map((entry) => entry.id)).size !== bboxUpdates.length)
    die("plan contains duplicate bbox-update ids");

  const html = fs.readFileSync(TEMPLATE, "utf8");
  const scriptOpen = html.indexOf("<script>");
  const scriptClose = html.indexOf("</script>", scriptOpen + 8);
  if (scriptOpen < 0 || scriptClose < 0) die("could not locate the main inline script");
  const bodyOffset = scriptOpen + 8;
  const body = html.slice(bodyOffset, scriptClose);
  const ast = acorn.parse(body, { ecmaVersion: "latest" });
  const ciDecl = findDeclarator(ast, "Ci", "ArrayExpression");
  const coDecl = findDeclarator(ast, "flCO", "ObjectExpression");
  if (!ciDecl || !coDecl) die("could not parse Ci/flCO from the main script");

  const existingCityNodes = new Map();
  for (const node of ciDecl.init.elements.filter((item) => item && item.type === "ObjectExpression")) {
    const id = propValue(node, "id");
    if (id && !existingCityNodes.has(id)) existingCityNodes.set(id, node);
  }
  const existingCities = new Set(existingCityNodes.keys());
  const existingCountries = new Set(
    coDecl.init.properties
      .filter((prop) => prop.type === "Property")
      .map((prop) => prop.key.name != null ? prop.key.name : prop.key.value)
  );
  const collisions = entries.map((entry) => entry.id).filter((id) => existingCities.has(id) || existingCountries.has(id));
  if (collisions.length) die(`refusing existing city id(s): ${collisions.join(", ")}`);
  const addedIds = new Set(entries.map((entry) => entry.id));
  for (const update of bboxUpdates) {
    if (!update || !/^[a-z0-9-]+$/.test(update.id || "")) die(`invalid bbox-update city id: ${JSON.stringify(update)}`);
    if (addedIds.has(update.id)) die(`bbox update duplicates a proposed city entry: ${update.id}`);
    if (!existingCities.has(update.id)) die(`bbox update names unknown city id: ${update.id}`);
    if (!Array.isArray(update.bbox) || update.bbox.length !== 4 || update.bbox.some((n) => !Number.isFinite(n)))
      die(`city ${update.id} has an invalid bbox update`);
    if (!(update.bbox[0] < update.bbox[2] && update.bbox[1] < update.bbox[3]))
      die(`city ${update.id} has a non-increasing bbox update`);
  }

  const cityInsert = entries.length
    ? (ciDecl.init.elements.length ? "," : "") + entries.map(citySource).join(",")
    : "";
  const countryInsert = entries.length
    ? (coDecl.init.properties.length ? "," : "") + entries
      .map((entry) => `${JSON.stringify(entry.id)}:${JSON.stringify(entry.country)}`)
      .join(",")
    : "";

  const flagAdditions = plan.grouping_conventions && plan.grouping_conventions.flag_map_addition || {};
  const flagMarker = "};window.flCountryFlag=function(n){return F[n]||\"\";};})();</script>";
  const flagEnd = html.indexOf(flagMarker);
  if (Object.keys(flagAdditions).length && flagEnd < 0) die("could not locate flCountryFlag registry");
  const flagInsert = Object.entries(flagAdditions)
    .map(([country, flag]) => `,${JSON.stringify(country)}:${JSON.stringify(flag)}`)
    .join("");

  const edits = [];
  if (cityInsert) edits.push({ at: bodyOffset + ciDecl.init.end - 1, text: cityInsert });
  if (countryInsert) edits.push({ at: bodyOffset + coDecl.init.end - 1, text: countryInsert });
  for (const update of bboxUpdates) {
    const node = existingCityNodes.get(update.id);
    const prop = node.properties.find(
      (item) => item.type === "Property" && (item.key.name === "bbox" || item.key.value === "bbox")
    );
    if (!prop || !prop.value || prop.value.type !== "ArrayExpression") die(`city ${update.id} has no literal bbox`);
    edits.push({
      at: bodyOffset + prop.value.start,
      end: bodyOffset + prop.value.end,
      text: JSON.stringify(update.bbox),
    });
  }
  if (flagInsert) edits.push({ at: flagEnd, text: flagInsert });
  edits.sort((a, b) => b.at - a.at);
  let next = html;
  for (const edit of edits) next = next.slice(0, edit.at) + edit.text + next.slice(edit.end == null ? edit.at : edit.end);

  const nextBody = next.slice(bodyOffset, next.indexOf("</script>", bodyOffset));
  acorn.parse(nextBody, { ecmaVersion: "latest" });
  console.log(`${entries.length} city entries; ${entries.length} flCO mappings; ${bboxUpdates.length} bbox update(s); ${Object.keys(flagAdditions).length} country flag(s)`);
  if (dry) {
    console.log("--dry: syntax checked; nothing written.");
    return;
  }
  fs.writeFileSync(TEMPLATE, next);
  console.log(`updated ${path.relative(ROOT, TEMPLATE)}`);
}

main();
