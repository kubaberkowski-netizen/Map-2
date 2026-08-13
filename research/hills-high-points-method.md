# Hills and high points research method

Date: 2026-08-09

## Decision

Add a first-class `hills` category labelled **Hills & mounds**. Rename the existing
`view` label to **Views & lookouts** without changing its slug.

The distinction is physical and useful while walking:

- `hills` is for a named natural hill, summit, peak, or intentionally formed mound
  whose landform is the reason to go and whose upper point can be reached on foot;
- `view` remains for rooftops, towers, terraces, platforms, and places whose primary
  offer is a view rather than an ascent.

At the start of this research the catalogue had 16,902 spots and 59 categories. It had no hill category,
so Primrose Hill is `wild`, Parliament Hill and One Tree Hill are `view`, and public
artificial climbs such as Malminkartanonhuippu and Górka Szczęśliwicka are also
`view`. Northala Fields, Horsenden Hill, and Box Hill are absent.

## Inclusion contract

A candidate must satisfy all of these checks:

1. It is a named hill, summit, peak, or deliberately climbable mound.
2. A legal public, designated, or explicitly permissive pedestrian route reaches
   the upper point.
3. The place has meaningful local relief (normally about 20 metres within 1 km) or
   is a deliberately designed climb such as Northala Fields.
4. At least one ordinary walking approach works as a spontaneous detour: ideally a
   short loop or no more than about 60 minutes from practical pedestrian or public-
   transport access.
5. It has a sharp visual, historical, geological, ecological, or human story.

Exclude private or `foot=no/private` land, active quarries, military land, crop land,
golf courses, construction sites, broad ranges without a visitable point, drive-up
lookouts without a meaningful ascent, prohibited burial mounds, exposed cliff edges,
and any default route needing scrambling, ladders, glacier travel, or mountaineering
equipment. Routes at `sac_scale=mountain_hiking` or harder do not qualify for random
recommendations.

An absent OSM access tag is unknown, not proof of access. For Great Britain, verify
the route with a council, land manager, rights-of-way map, National Trust, or other
official source. The government's [right-to-roam guidance](https://www.gov.uk/right-of-way-open-access-land/use-your-right-to-roam)
notes that mapped access land can still contain excepted private uses; the
[Countryside Code](https://www.gov.uk/government/publications/the-countryside-code/the-countryside-code-advice-for-countryside-visitors)
recommends marked paths unless wider access is clear.

## Discovery and validation

### OpenStreetMap lead generation

Use named landforms as the primary lead pool and viewpoints only as secondary clues:

```overpass
(
  nwr["natural"~"^(hill|peak)$"]["name"](bbox);
  nwr["tourism"="viewpoint"]["name"](bbox);
);
out center tags;
```

OSM defines [`natural=peak`](https://wiki.openstreetmap.org/wiki/Tag:natural%3Dpeak)
as the summit of a hill or mountain. A [`tourism=viewpoint`](https://wiki.openstreetmap.org/wiki/Tag:tourism%3Dviewpoint)
is a good view and can coexist with a peak; it is not by itself a hill. Require a
nearby connected `highway=footway|path|steps|track|bridleway` and capture `access`,
`foot`, `surface`, `incline`, `step_count`, `handrail`, `wheelchair`, `lit`,
`opening_hours`, and `fee`. Use [`sac_scale`](https://wiki.openstreetmap.org/wiki/Key:sac_scale)
and [`trail_visibility`](https://wiki.openstreetmap.org/wiki/Key:trail_visibility)
as rejection signals, not as substitutes for an official access check.

Do not auto-import spoil heaps, landfills, quarries, or embankments. Designed urban
mounds are inconsistently mapped and require council or land-manager research.

### Wikidata enrichment

Use the class families hill (`Q54050`), mountain (`Q8502`), summit (`Q207326`), and
artificial hill (`Q10460934`), retrieving coordinates (`P625`), elevation (`P2044`),
aliases, image, and official website.

```sparql
VALUES ?class { wd:Q54050 wd:Q8502 wd:Q207326 wd:Q10460934 }
?item wdt:P31/wdt:P279* ?class;
      wdt:P625 ?coord.
OPTIONAL { ?item wdt:P2044 ?elevation. }
```

For rural Great Britain, [OS Terrain 50](https://www.ordnancesurvey.co.uk/products/os-terrain-50)
can rank broad relief. Its 50 m grid is not precise enough to validate small urban
mounds or final pedestrian routing.

### Required research fields

Keep production fields plus provenance in the committed research JSON:

```json
{
  "n": "Example Hill",
  "city": "london",
  "c": "hills",
  "lat": 51.5,
  "lng": -0.1,
  "w": "Draft house-voice copy",
  "_facts": ["Source-supported facts"],
  "_sources": ["https://official.example/place"],
  "access": {
    "status": "public path",
    "difficulty": "ordinary walking",
    "checked_at": "2026-08-09"
  },
  "confidence": "high"
}
```

Production import strips research metadata, so the research file must remain in the
repository. New production rows stay quality flag `d` until individually reviewed.

## Legacy recategorisation audit

Thirteen existing spots moved to `hills`; their names, coordinates, writeups, and
quality flags were left untouched. This was a taxonomy-only migration, reviewed
against the same public walk-up-landform rule:

| Existing spots | Decision basis |
| --- | --- |
| `primrosehill`, `parliament-hill`, `henrysmound` | Explicit public summits or steep mounds. The land managers describe [Primrose Hill's summit](https://www.royalparks.org.uk/visit/parks/regents-park-primrose-hill/primrose-hill), [Parliament Hill at 98 m](https://www.cityoflondon.gov.uk/things-to-do/green-spaces/hampstead-heath/where-to-go-at-hampstead-heath/parliament-hill-viewpoint), and [King Henry's steep mound](https://www.royalparks.org.uk/visit/parks/richmond-park/king-henrys-mound). |
| `onetreehill`, `stavehill`, `telegraphhillpark`, `blythehillfields` | Named London hill or designed mound reached through public open space. Lewisham documents public access to [Blythe Hill](https://lewisham.gov.uk/inmyarea/openspaces/parks/blythe-hill) and [Telegraph Hill Park](https://lewisham.gov.uk/inmyarea/openspaces/parks/telegraph-hill-park); its planning study records extensive views from Blythe Hill's upper ground. |
| `malminkartanonhuippu` | Helsinki's former landfill hill has fitness stairs and a summit observation platform; the city is planning further public-recreation improvements at [Malminkartanonhuippu](https://www.hel.fi/en/news/the-plans-for-malminkartanonhuippu-will-take-shape-in-the-next-few-years-comment-on-the-preliminary). |
| `kopiecpisudskiego`, `kopieckrakusa` | Kraków's established public mounds are literal climbable landforms; the city treats them as a linked mountain-running route in its [Three Mounds Run](https://krakow.pl/aktualnosci/264125,202,komunikat,za_nami_15__bieg_trzech_kopcow.html). |
| `kopiecmoczydowski`, `gorkaszczesliwicka`, `kopacwila` | Warsaw's public artificial hills. City sources describe [Moczydło's mound and panorama](https://eko.um.warszawa.pl/-/park-moczydlo), [Szczęśliwicka as a year-round walking hill](https://en.um.warszawa.pl/-/article-112), and [Kopa Cwila as Ursynów's highest artificial summit](https://ursynow.um.warszawa.pl/-/park-im-romana-kozlowskiego). |

`pointhill` was reviewed but left in `view`: the official destination is **The
Point**, a viewpoint off Point Hill, while Point Hill itself is the adjoining road.
That does not meet the stricter named-landform contract without further relief and
route evidence.

## Earlier repository workflow recovered from history

The reusable pattern came from four generations of work:

1. PR #1 / `56179cec0736` introduced `find-spots.js`, `sources.js`,
   `category-map.js`, and `model.js`: source adapter → geocode → city/bbox check →
   category guess → schema validation → exact/name/proximity dedupe.
2. The themed rounds `e75b28d5`, `8898f98e`, `a859cb19`, and `51f1b8ab` used
   12–13 discovery agents, followed by `process-trending.js` geocoding and dedupe.
   Git records Claude Opus 4.8 co-authorship, but not durable names for individual
   agents.
3. PR #31 / `507e59ba8de` used committed sourced dossiers and
   `add-spots.js --proximity 30` for a 30-place editorial production wave.
4. PR #38 / `4dff9ceb2fa` used a deterministic QLever/Wikidata/Wikipedia harvester,
   point-in-polygon checks, 80 m global dedupe, and draft flags for 2,000 US rows.

The country lead-list PR #28 is useful for ideas but lacks production coordinates and
fully verified citations. It should not be imported directly. The high-volume US run
also demonstrates why quotas cannot replace access and editorial review.

For this category, retain the strongest parts of those workflows: parallel thematic
discovery, source dossiers, live schema parsing, manual access review, exact and fuzzy
alias review, a close-neighbour report at 30 m, draft flags, and a full generated build.

```bash
node tools/find-spots.js --city london --source overpass --profile hills --limit 150
node tools/add-spots.js england --file research/new/uk-hills-high-points.json --proximity 30 --dry
node tools/add-spots.js england --file research/new/uk-hills-high-points.json --proximity 30
node tools/quality.js --check
npm run build
git diff --check
```

## Ranked follow-on taxonomy

| Rank | Concept | Recommended treatment | Main risk |
| ---: | --- | --- | --- |
| 1 | Hills & mounds | Category now | Access and route difficulty |
| 2 | Steps & steep streets | Next category pilot | Routine stairs create noise |
| 3 | Caves & grottos | Category after safety pilot | Closures and equipment needs |
| 4 | Springs & wells | Later category | Never imply water is potable |
| 5 | Footbridges, stepping stones & fords | World first | Flooding and seasonality |
| 6 | Wildlife hides | World first | Often secondary to a reserve |
| 7 | Trig points & survey marks | Collectible World | Too small for a primary type |
| 8 | Quarries, spoil heaps & earthworks | Curated World | Active/private sites |
| 9 | Tidal crossings & walkable islands | Curated World | Requires current tide access |
| 10 | Bandstands & park pavilions | World | Usually secondary to a park |
| 11 | Mazes & labyrinths | World | Sparse, ticketed, or seasonal |
| 12 | Holloways, green lanes & ancient paths | Curated World | Inconsistent source tagging |

The later cross-category **High Ground** World can combine hills, monumental steps,
free climbable towers, castles, and follies. It should complement rather than replace
the physical `hills` category.
