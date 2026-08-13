"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { guessCategory } = require("../category-map");
const modelApi = require("../model");
const sources = require("../sources");

async function main() {

const model = modelApi.loadModel();
assert.equal(model.categories.has("hills"), true, "the live template defines hills");
assert.equal(
  guessCategory({ name: "Example Hill", natural: "hill" }, model.categories),
  "hills"
);
assert.equal(
  guessCategory({ name: "Example Peak", natural: "peak", tourism: "viewpoint" }, model.categories),
  "hills",
  "a physical landform outranks its secondary viewpoint tag"
);
assert.equal(
  guessCategory({ name: "Park Hill", natural: "hill", leisure: "park" }, model.categories),
  "hills",
  "a named landform outranks a generic park tag"
);
assert.equal(
  guessCategory({ name: "Example Lookout", tourism: "viewpoint" }, model.categories),
  "view",
  "a viewpoint without a hill tag stays in Views & lookouts"
);

const regionProbe = {
  id: "region-margin-contract",
  n: "Region margin contract",
  a: "",
  pc: "",
  lat: 49.2,
  lng: -1.5,
  c: "hills",
  s: "",
  q: "",
  w: "",
  city: "england",
};
assert.equal(
  modelApi.validateRow(regionProbe, model).ok,
  true,
  "research validation mirrors build.js's one-degree region margin"
);
assert.equal(modelApi.REGION_MARGIN, 1.0);

const assignmentModel = {
  cities: [
    { id: "country", bbox: [0, 0, 10, 10], region: true, centre: [5, 5] },
    { id: "nearby-region", bbox: [5.5, 4.9, 5.6, 5.1], region: true, centre: [5, 5.55] },
  ],
};
assert.equal(
  modelApi.cityForPoint(5, 5, assignmentModel),
  "country",
  "the generous validation margin for regions must not steal automatic city assignment"
);

const template = fs.readFileSync(
  path.resolve(__dirname, "../../src/app.template.html"),
  "utf8"
);
assert.match(template, /hills:\{l:"Hills & mounds"/);
assert.match(
  template,
  /\["park","wild","hills","landmarktrees","green","canals","lido","bathhouse","maritime"\]/
);

const originalFetch = global.fetch;
let request;
try {
  global.fetch = async (url, options) => {
    request = { url, options };
    return {
      status: 200,
      ok: true,
      text: async () => JSON.stringify({
        elements: [
          { type: "node", id: 42, lat: 2.5, lon: 1.5, tags: { name: "Test Hill", natural: "hill" } },
        ],
      }),
    };
  };
  const hits = await sources.overpass([1, 2, 3, 4], { profile: "hills", limit: 7 });
  const query = new URLSearchParams(request.options.body).get("data");
  assert.match(query, /node\["natural"~"\^\(hill\|peak\)\$"\]\["name"\]\(2,1,4,3\)/);
  assert.match(query, /node\["tourism"="viewpoint"\]\["name"\]\(2,1,4,3\)/);
  assert.match(query, /out center 7;/);
  assert.equal(hits[0]._meta.profile, "hills");
  await assert.rejects(
    () => sources.overpass([1, 2, 3, 4], { profile: "unsafe" }),
    /unknown Overpass profile/
  );
} finally {
  global.fetch = originalFetch;
}

console.log("hills pipeline contracts passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
