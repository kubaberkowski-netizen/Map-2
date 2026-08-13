"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { guessCategory } = require("../category-map");
const modelApi = require("../model");
const sources = require("../sources");

async function main() {
  const model = modelApi.loadModel();
  for (const slug of [
    "landmarktrees",
    "steps",
    "specialistshops",
    "footbridges",
    "arcades",
    "streetfurniture",
    "historicshopfronts",
    "artnouveau",
  ])
    assert.equal(model.categories.has(slug), true, `the live template defines ${slug}`);

  assert.equal(
    guessCategory(
      { name: "Ancient Oak", natural: "tree", denotation: "natural_monument" },
      model.categories
    ),
    "landmarktrees"
  );
  assert.equal(
    guessCategory({ name: "Ordinary Tree", natural: "tree" }, model.categories),
    null,
    "a generic tree is not remarkable merely because it is mapped"
  );
  assert.equal(
    guessCategory({ name: "Scholar's Steps", highway: "steps" }, model.categories),
    "steps"
  );
  assert.equal(
    guessCategory({ highway: "steps" }, model.categories),
    null,
    "unnamed functional steps do not become destinations"
  );
  assert.equal(
    guessCategory(
      { name: "Galerie Test", highway: "footway", covered: "yes" },
      model.categories
    ),
    "arcades",
    "a named covered pedestrian passage is a strong arcade mapping"
  );
  assert.equal(
    guessCategory(
      { name: "Office Corridor", highway: "corridor", covered: "yes" },
      model.categories
    ),
    null,
    "a covered building corridor is not automatically a public arcade"
  );
  assert.equal(
    guessCategory(
      { name: "River Walk Bridge", highway: "footway", bridge: "yes", foot: "yes" },
      model.categories
    ),
    "footbridges"
  );
  assert.equal(
    guessCategory({ highway: "footway", bridge: "yes" }, model.categories),
    null,
    "an unnamed functional crossing does not become a destination"
  );
  assert.equal(
    guessCategory(
      { name: "Main Road Bridge", highway: "primary", bridge: "yes", foot: "yes" },
      model.categories
    ),
    null,
    "a vehicular bridge with a pavement is outside the footbridge category"
  );
  assert.equal(
    guessCategory({ name: "The Map House", shop: "maps" }, model.categories),
    "specialistshops"
  );
  assert.equal(
    guessCategory({ name: "Ordinary Camera Shop", shop: "camera" }, model.categories),
    null,
    "broad retail lead tags still need editorial proof of genuine specialism"
  );
  assert.equal(
    guessCategory({ name: "Independent Books", shop: "books" }, model.categories),
    "bookshops",
    "existing specific retail categories keep precedence"
  );

  const template = fs.readFileSync(
    path.resolve(__dirname, "../../src/app.template.html"),
    "utf8"
  );
  assert.match(template, /landmarktrees:\{l:"Remarkable trees"/);
  assert.match(template, /steps:\{l:"Steps & stair streets"/);
  assert.match(template, /specialistshops:\{l:"Specialist shops"/);
  assert.match(template, /footbridges:\{l:"Footbridges"/);
  assert.match(template, /arcades:\{l:"Covered arcades"/);
  assert.match(template, /streetfurniture:\{l:"Street furniture"/);
  assert.match(template, /historicshopfronts:\{l:"Historic shopfronts"/);
  assert.match(template, /artnouveau:\{l:"Art Nouveau"/);
  assert.match(
    template,
    /cats:\["oddity","ghostsign","streetart","streetfurniture","steps","footbridges","specialistshops","alley","follies","canals"\]/,
    "footbridges remain browsable with Curiosities"
  );
  assert.match(
    template,
    /WOUT=new Set\(\["canals","follies","green","hills","landmarktrees","steps","footbridges","view"/,
    "footbridges remain eligible for outdoor discovery"
  );
  assert.match(
    template,
    /c:\["brutalism","artdeco","artnouveau","arcades","historicshopfronts","streetfurniture","follies","monument","square","view","steps","footbridges","alley"\]/,
    "footbridges remain browsable with the built city"
  );
  assert.match(
    template,
    /\["park","wild","hills","landmarktrees","green","canals","lido","bathhouse","maritime"\]/
  );

  // The approved research dossiers and their draft imports stay in lockstep.
  // This is deliberately stricter than build.js: it catches a sourced dossier
  // drifting away from the compact production row, or a draft being promoted
  // without the owner's editorial review.
  const spots = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, "../../data/spots.json"), "utf8")
  );
  const quality = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, "../../data/quality.json"), "utf8")
  );
  const dossierContracts = [
    {
      label: "specialist shops",
      file: "world-specialist-shops-balanced-2026-08-09.json",
      key: "included",
      category: "specialistshops",
      count: 49,
      score: (row) => row.editorial_score,
      sources: (row) => row._sources,
    },
    {
      label: "landmark trees",
      file: "europe-landmark-trees-balanced-2026-08-09.json",
      key: "included",
      category: "landmarktrees",
      count: 45,
      score: (row) => row.score,
      sources: (row) => row.sources,
    },
    {
      label: "steps",
      file: "europe-steps-balanced-2026-08-09.json",
      key: "candidates",
      category: "steps",
      count: 60,
      score: (row) => row.score,
      sources: (row) => row.sources,
    },
    {
      label: "European hills",
      file: "europe-hills-balanced-2026-08-09.json",
      key: "included",
      category: "hills",
      count: 60,
      score: (row) => row.editorial_score,
      sources: (row) => row.sources,
    },
  ];
  const importedIds = new Set();
  for (const contract of dossierContracts) {
    const dossier = JSON.parse(
      fs.readFileSync(
        path.resolve(__dirname, `../../research/${contract.file}`),
        "utf8"
      )
    );
    const rows = dossier[contract.key];
    assert.equal(rows.length, contract.count, `${contract.label} dossier count`);
    for (const row of rows) {
      assert.equal(row.c, contract.category, `${row.n} category`);
      const validation = modelApi.validateRow(
        { ...row, id: row.id || modelApi.slugify(row.n) },
        model
      );
      assert.equal(validation.ok, true, `${row.n}: ${validation.errors.join("; ")}`);
      const city = model.cityById.get(row.city);
      assert.ok(
        row.lng >= city.bbox[0] && row.lng <= city.bbox[2] &&
          row.lat >= city.bbox[1] && row.lat <= city.bbox[3],
        `${row.n} is inside the declared raw city/region bbox, without typo-tolerance margin`
      );
      assert.equal(
        modelApi.cityForPoint(row.lat, row.lng, model),
        row.city,
        `${row.n} infers to its explicit, semantically reviewed city/region`
      );
      const score = contract.score(row);
      assert.ok(score.total >= 19, `${row.n} clears the 19/25 score gate`);
      assert.ok(score.story >= 4, `${row.n} clears the story gate`);
      assert.ok(score.walkability >= 4, `${row.n} clears the walkability gate`);
      assert.ok(
        Object.values(row.confidence).every((value) => value === "high"),
        `${row.n} retains all-high confidence`
      );
      assert.ok(contract.sources(row).length >= 2, `${row.n} retains 2+ sources`);

      const matches = spots.filter(
        (spot) =>
          spot.n === row.n && spot.c === contract.category && spot.city === row.city
      );
      assert.equal(matches.length, 1, `${row.n} maps to exactly one production row`);
      const live = matches[0];
      for (const field of ["a", "pc", "c", "s", "q", "w", "city"])
        assert.equal(live[field], row[field], `${row.n} production ${field} matches`);
      assert.equal(live.lat, +row.lat.toFixed(5), `${row.n} production latitude matches`);
      assert.equal(live.lng, +row.lng.toFixed(5), `${row.n} production longitude matches`);
      assert.equal(quality.flags[live.id], "d", `${row.n} remains a draft`);
      assert.equal(importedIds.has(live.id), false, `${row.n} import id is unique`);
      importedIds.add(live.id);
    }
  }
  assert.equal(importedIds.size, 214, "all 214 approved rows are present once");
  assert.equal(quality.baseline, spots.length, "quality baseline matches catalogue");

  const originalFetch = global.fetch;
  const queries = [];
  try {
    global.fetch = async (_url, options) => {
      const query = new URLSearchParams(options.body).get("data");
      queries.push(query);
      return {
        status: 200,
        ok: true,
        text: async () => JSON.stringify({
          elements: [
            { type: "node", id: 42, lat: 2.5, lon: 1.5, tags: { name: "Test", natural: "tree", denotation: "landmark" } },
          ],
        }),
      };
    };

    const treeHits = await sources.overpass([1, 2, 3, 4], {
      profile: "landmarktrees",
      limit: 7,
    });
    await sources.overpass([1, 2, 3, 4], { profile: "steps", limit: 8 });
    await sources.overpass([1, 2, 3, 4], { profile: "footbridges", limit: 9 });
    await sources.overpass([1, 2, 3, 4], { profile: "specialistshops", limit: 10 });

    assert.match(
      queries[0],
      /node\["natural"="tree"\]\["name"\]\["denotation"~"\^\(natural_monument\|landmark\)\$"\]\(2,1,4,3\)/
    );
    assert.match(queries[1], /way\["highway"="steps"\]\["name"\]\(2,1,4,3\)/);
    assert.match(
      queries[2],
      /way\["bridge"\]\["name"\]\["highway"~"\^\(footway\|pedestrian\|path\)\$"\]\(2,1,4,3\)/
    );
    assert.match(queries[3], /node\["shop"~/);
    assert.match(queries[3], /way\["shop"~/);
    assert.equal(treeHits[0]._meta.profile, "landmarktrees");
    await assert.rejects(
      () => sources.overpass([1, 2, 3, 4], { profile: "unsafe" }),
      /unknown Overpass profile/
    );
  } finally {
    global.fetch = originalFetch;
  }

  console.log("balanced research-category pipeline contracts passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
