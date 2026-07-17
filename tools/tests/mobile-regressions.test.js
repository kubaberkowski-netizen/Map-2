"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const {
  distanceMeters,
  elapsedSecondsForArchive,
  filterDiscoverySpots,
  selectRadarCandidates,
  setRouteDestination,
  simulateLocationAcceptance,
  spotsForWorld,
} = require("./mobile-regression-contracts");

const appTemplateSource = fs.readFileSync(
  path.resolve(__dirname, "../../src/app.template.html"),
  "utf8"
);

function loadProductionOpenNow() {
  const start = appTemplateSource.indexOf("function flOpenNow(");
  const end = appTemplateSource.indexOf("\nfunction flOhOpen(", start);
  assert.ok(start >= 0 && end > start, "canonical production opening-hours function is extractable");
  const context = { Date };
  vm.runInNewContext(
    `${appTemplateSource.slice(start, end)};this.openNow=flOpenNow;`,
    context
  );
  return context.openNow;
}

const productionOpenNow = loadProductionOpenNow();
function localDate(dayFromMonday, hour, minute = 0) {
  return new Date(2026, 6, 13 + dayFromMonday, hour, minute, 0, 0);
}

const tests = [];
function test(name, run) {
  tests.push({ name, run });
}

function localCoordinate(origin, eastMeters, northMeters = 0) {
  const latitudeScale = 111_194.9266;
  return {
    lat: origin.lat + northMeters / latitudeScale,
    lng: origin.lng + eastMeters / (latitudeScale * Math.cos(origin.lat * Math.PI / 180)),
  };
}

test("vendored map styles have every relative image required by native bundles", () => {
  const root = path.resolve(__dirname, "../..");
  const cssFiles = [
    "vendor/leaflet/leaflet.css",
    "vendor/leaflet-markercluster/MarkerCluster.css",
    "vendor/leaflet-markercluster/MarkerCluster.Default.css",
  ];

  for (const relativeCss of cssFiles) {
    const cssFile = path.join(root, relativeCss);
    const css = fs.readFileSync(cssFile, "utf8");
    const references = [...css.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)]
      .map((match) => match[1].trim().split(/[?#]/, 1)[0])
      .filter((reference) => reference && !/^(?:https?:|data:|blob:|\/\/|#)/i.test(reference));
    for (const reference of references) {
      assert.equal(
        fs.existsSync(path.resolve(path.dirname(cssFile), reference)),
        true,
        `${relativeCss} references missing asset ${reference}`
      );
    }
  }
});

test("archive duration trusts native elapsed time, including a legitimate zero", () => {
  const route = [
    { timestamp: 60_000 },
    { timestamp: 180_000 },
  ];
  assert.equal(elapsedSecondsForArchive({ elapsedSeconds: 120 }, route, 60_000), 120);
  assert.equal(elapsedSecondsForArchive({ elapsedSeconds: 0 }, route, 0), 0);
  assert.equal(elapsedSecondsForArchive({ elapsedMs: 120_000 }, route, 60_000), 120);
  assert.equal(elapsedSecondsForArchive({ elapsedMs: 0 }, route, 0), 0);
  assert.equal(elapsedSecondsForArchive({ elapsedMilliseconds: 90_000 }, route, 0), 90);
  assert.equal(elapsedSecondsForArchive({}, route, 60_000), 60, "browser fallback remains available");
});

test("production native bridge consumes Android elapsedMs before fallbacks", () => {
  const patchSource = fs.readFileSync(
    path.resolve(__dirname, "../patch-active-walk.js"),
    "utf8"
  );
  assert.match(
    patchSource,
    /_s\.elapsedMs!=null\?\+_s\.elapsedMs:_s\.elapsedMilliseconds/
  );
});

test("ending while paused cannot turn an authoritative native duration into zero", () => {
  const route = [
    { timestamp: 0 },
    { timestamp: 120_000 },
  ];
  assert.equal(elapsedSecondsForArchive({ elapsedSeconds: 120 }, route, 300_000), 120);
});

test("route-corridor radar candidates remain useful after the WebView is suspended", () => {
  const origin = { lat: 51.5074, lng: -0.1278 };
  const route = [origin, localCoordinate(origin, 1_200)];
  const startDecoys = Array.from({ length: 30 }, (_, index) => ({
    id: `start-${index}`,
    ...localCoordinate(origin, 20 + index * 12, 450 + index * 4),
  }));
  const futurePlace = {
    id: "future-nearby",
    ...localCoordinate(origin, 910, 55),
  };
  const spots = [...startDecoys, futurePlace];

  const frozenNearest24 = spots
    .slice()
    .sort((left, right) => distanceMeters(origin, left) - distanceMeters(origin, right))
    .slice(0, 24);
  assert.equal(frozenNearest24.some((spot) => spot.id === futurePlace.id), false,
    "the reviewed nearest-24 hand-off loses the future place");

  const candidates = selectRadarCandidates(spots, {
    currentLocation: origin,
    route,
  });
  assert.equal(candidates.some((spot) => spot.id === futurePlace.id), true);

  const movedLocation = localCoordinate(origin, 900);
  const frozenDistance = Math.min(...frozenNearest24.map((spot) => distanceMeters(movedLocation, spot)));
  const selectedDistance = Math.min(...candidates.map((spot) => distanceMeters(movedLocation, spot)));
  assert.ok(frozenDistance > 300, `expected stale pool outside radar, got ${frozenDistance.toFixed(1)}m`);
  assert.ok(selectedDistance < 100, `expected corridor pool to retain nearby place, got ${selectedDistance.toFixed(1)}m`);
});

test("radar hand-off accepts 2,000 candidates and de-duplicates them", () => {
  const origin = { lat: 51.5, lng: -0.1 };
  const repeated = Array.from({ length: 2_500 }, (_, index) => ({
    id: `place-${index % 2_100}`,
    ...localCoordinate(origin, index * 5, index % 3),
  }));
  const candidates = selectRadarCandidates(repeated, {
    currentLocation: origin,
    route: [origin, localCoordinate(origin, 2_000)],
  });
  assert.equal(candidates.length, 2_000);
  assert.equal(new Set(candidates.map((spot) => spot.id)).size, candidates.length);
});

test("Explore this World uses exact predicate plus curated IDs, never category chips", () => {
  const world = {
    id: "literary-museums",
    cats: ["museum"],
    ids: ["curated-library"],
    match: (spot) => spot.c === "museum" && spot.tags.includes("literary"),
  };
  const spots = [
    { id: "writers-house", c: "museum", tags: ["literary"] },
    { id: "generic-museum", c: "museum", tags: ["science"] },
    { id: "curated-library", c: "library", tags: [] },
  ];
  assert.deepEqual(spotsForWorld(spots, world).map((spot) => spot.id), [
    "writers-house",
    "curated-library",
  ]);
});

test("choosing a destination preserves World, Saved-only and refinement filters", () => {
  const state = {
    cityId: "london",
    worldId: "literary",
    savedOnly: true,
    refinements: { categories: ["museum"], zone: "central" },
    destinationId: null,
  };
  const world = { match: (spot) => spot.tags.includes("literary") };
  const spots = [
    { id: "kept", city: "london", c: "museum", zone: "central", saved: true, tags: ["literary"] },
    { id: "not-saved", city: "london", c: "museum", zone: "central", saved: false, tags: ["literary"] },
    { id: "wrong-world", city: "london", c: "museum", zone: "central", saved: true, tags: [] },
  ];
  const before = filterDiscoverySpots(spots, state, world).map((spot) => spot.id);
  const afterState = setRouteDestination(state, "kept");
  const after = filterDiscoverySpots(spots, afterState, world).map((spot) => spot.id);

  assert.deepEqual(after, before);
  assert.equal(afterState.worldId, state.worldId);
  assert.equal(afterState.savedOnly, state.savedOnly);
  assert.deepEqual(afterState.refinements, state.refinements);
  assert.equal(afterState.destinationId, "kept");
});

test("production destination patch retains the active category filter", () => {
  const patchSource = fs.readFileSync(
    path.resolve(__dirname, "../patch-mobile-review.js"),
    "utf8"
  );
  assert.match(
    patchSource,
    /u\.size&&\(cw=cw\.filter\(Re=>u\.has\(Re\.c\)\)\);if\(w===/
  );
});

test("production proximity patch reads and assigns from the city-scoped catalogue", () => {
  const patchSource = fs.readFileSync(
    path.resolve(__dirname, "../patch-mobile-review.js"),
    "utf8"
  );
  assert.match(
    patchSource,
    /if\(Zc\[ci\]\.id===_R\.cur\)\{cz=Zc\[ci\]/
  );
});

test("city trophies are emitted only when their catalogue targets are attainable", () => {
  const patchSource = fs.readFileSync(
    path.resolve(__dirname, "../patch-mobile-review.js"),
    "utf8"
  );
  assert.match(patchSource, /_cityQuadrants\.size===4&&V\(\"quad\"/);
  assert.match(patchSource, /_ct>=th\[0\]&&V\(\"cat-/);
});

test("selecting a Plan suggestion keeps the scrollable list in stable order", () => {
  const patchSource = fs.readFileSync(
    path.resolve(__dirname, "../patch-mobile-review.js"),
    "utf8"
  );
  assert.match(patchSource, /var sug=_base\.slice\(0,60\);_selsp\.forEach/);
});

test("opening-hours UI paths share one canonical date-injectable production parser", () => {
  assert.equal((appTemplateSource.match(/function flOpenNow\(/g) || []).length, 1);
  assert.match(appTemplateSource, /function flOhOpen\(oh,date\)\{return flOpenNow\(oh,date\);\}/);
  assert.match(appTemplateSource, /g\.filter\(function\(z\)\{return flOpenNow\(z\.oh\)===!0\}\)/);
  assert.match(appTemplateSource, /window\.flOhOpen\(sp\.oh,dt\)/,
    "trip planning reaches the canonical parser through its compatibility delegate");
});

test("production opening hours parse comma-separated weekly rules and exact boundaries", () => {
  const compact = "Tu-Su 10:00-18:00, Mo off";
  assert.equal(productionOpenNow(compact, localDate(0, 12)), false, "Monday is explicitly off");
  assert.equal(productionOpenNow(compact, localDate(1, 10)), true, "Tuesday opens inclusively");
  assert.equal(productionOpenNow(compact, localDate(6, 18)), false, "Sunday closes exclusively");

  const longWeek = "Mo-Th 07:00-24:00, Fr 07:00-01:00, Sa 08:00-01:00, Su 08:00-22:00";
  assert.equal(productionOpenNow(longWeek, localDate(3, 23, 59)), true);
  assert.equal(productionOpenNow(longWeek, localDate(4, 0, 30)), false);
  assert.equal(productionOpenNow(longWeek, localDate(5, 0, 30)), true, "Friday rolls into Saturday");
  assert.equal(productionOpenNow(longWeek, localDate(5, 1)), false, "overnight close is exclusive");
  assert.equal(productionOpenNow(longWeek, localDate(6, 22)), false);
});

test("production opening hours handle split days, dayless spans, overnight rules and overrides", () => {
  const split = "Mo-Fr 09:00-12:00, 13:00-17:30";
  assert.equal(productionOpenNow(split, localDate(0, 11, 59)), true);
  assert.equal(productionOpenNow(split, localDate(0, 12)), false);
  assert.equal(productionOpenNow(split, localDate(0, 13)), true);
  assert.equal(productionOpenNow("09:00-12:00,13:00-17:00", localDate(6, 14)), true);

  const overnight = "Fr 18:00-02:00; Fr 18:00-02:00; Fr 20:00-23:00";
  assert.equal(productionOpenNow(overnight, localDate(4, 23, 30)), true);
  assert.equal(productionOpenNow(overnight, localDate(5, 1, 59)), true);
  assert.equal(productionOpenNow(overnight, localDate(5, 2)), false);
  assert.equal(productionOpenNow(`${overnight}; Sa closed`, localDate(5, 1)), false,
    "an explicit closed day overrides an overnight carry");
});

test("production opening hours return unknown for unsupported OSM syntax", () => {
  assert.equal(productionOpenNow("24/7", localDate(0, 3)), true);
  for (const expression of [
    "Apr-Oct 10:00-18:00",
    "PH 10:00-18:00",
    "SH off",
    'Mo 10:00-18:00 "by appointment"',
    "week 20-30 Mo 10:00-18:00",
    "sunrise-sunset",
    "Mo 10:00+",
    "Mo 10:00-18:00 open",
    "24/7; PH off",
  ]) {
    assert.equal(productionOpenNow(expression, localDate(0, 12)), null, expression);
  }
});

test("a one-kilometre, 2m/s walk records the travelled distance", () => {
  const points = Array.from({ length: 51 }, (_, index) => ({
    x: index * 20,
    y: 0,
    timestamp: index * 10_000,
    accuracy: 5,
    speed: 2,
  }));
  const result = simulateLocationAcceptance(points);
  assert.ok(Math.abs(result.totalDistance - 1_000) <= 10, `recorded ${result.totalDistance}m`);
  assert.equal(result.accepted.length, points.length);
});

test("ten minutes of stationary GPS jitter records no distance", () => {
  const points = [{ x: 0, y: 0, timestamp: 0, accuracy: 8 }];
  for (let index = 1; index <= 60; index += 1) {
    points.push({
      x: (index % 3 - 1) * 4,
      y: (index % 5 - 2) * 3,
      timestamp: index * 10_000,
      accuracy: 8,
    });
  }
  const result = simulateLocationAcceptance(points);
  assert.equal(result.totalDistance, 0);
  assert.equal(result.accepted.length, 1);
});

test("an impossible signal jump is excluded and recovery starts a new segment", () => {
  const points = [0, 20, 40, 60, 80, 100].map((x, index) => ({
    x,
    y: 0,
    timestamp: index * 10_000,
    accuracy: 5,
  }));
  points.push(
    { x: 900, y: 0, timestamp: 60_000, accuracy: 5 },
    { x: 120, y: 0, timestamp: 70_000, accuracy: 5 },
    { x: 140, y: 0, timestamp: 80_000, accuracy: 5 }
  );
  const result = simulateLocationAcceptance(points);
  const recovery = result.accepted.find((point) => point.x === 120);
  assert.ok(recovery && recovery.startsNewSegment);
  assert.equal(result.accepted.some((point) => point.x === 900), false);
  assert.equal(result.totalDistance, 120, "no 800m teleport or recovery bridge is counted");
});

test("slow vehicle movement at 6.25m/s is not archived as walking", () => {
  const withoutReportedSpeed = Array.from({ length: 17 }, (_, index) => ({
    x: index * 62.5,
    y: 0,
    timestamp: index * 10_000,
    accuracy: 5,
  }));
  const inferred = simulateLocationAcceptance(withoutReportedSpeed);
  assert.equal(inferred.totalDistance, 0);

  const withReportedSpeed = withoutReportedSpeed.map((point) => ({ ...point, speed: 6.25 }));
  const reported = simulateLocationAcceptance(withReportedSpeed);
  assert.equal(reported.totalDistance, 0);
  assert.equal(reported.accepted.length, 0);
});

let failed = 0;
for (const { name, run } of tests) {
  try {
    run();
    process.stdout.write(`ok - ${name}\n`);
  } catch (error) {
    failed += 1;
    process.stderr.write(`not ok - ${name}\n${error.stack}\n`);
  }
}

process.stdout.write(`\n${tests.length - failed}/${tests.length} mobile regression contracts passed\n`);
if (failed) process.exitCode = 1;
