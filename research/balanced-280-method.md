# Balanced 280 research method

Date: 2026-08-09
Catalogue snapshot: `001e9e83` (16,917 spots; 1,019 populated city/region slugs)
Status: completed research programme; strict passing rows imported as unpromoted `d` drafts

Outcome: 275 leads were fully dispositioned. The evidence gates ultimately retained
214 drafts—60 hills, 45 landmark trees, 60 stair climbs and 49 specialist shops—and
deferred, excluded, deduplicated or post-audit-removed the remaining 61. Independent audit corrections
are recorded in `research/balanced-280-results-2026-08-09.json`.

## Programme target

The number is a ceiling, not a quota:

| Theme | Geography | High-confidence target |
|---|---|---:|
| Hills & mounds | Europe | 100 |
| Remarkable trees | Europe | 70 |
| Steps & stair streets | Europe | 60 |
| Specialist shops | Worldwide | 50 |

Only candidates that pass every identity, source, coordinate, access/status,
novelty and editorial gate may be imported. A shortfall is preferable to filler.

## Shared Flâneur contract

Every candidate must be a distinct physical objective that rewards accidental
walking discovery. It should be visually legible from the public realm, make a
walker stop, and support a concise memorable story. Generic attractions,
popularity-only picks, ordinary businesses and entries whose only claim is size,
age or a pleasant view are rejected.

Discovery sources such as OSM, Wikidata, Wikipedia, enthusiast lists and social
posts generate leads. They do not establish current access, continued existence
or a sharp factual claim. Verification normally requires at least two useful
sources, including an official, institutional, land-manager, heritage-register or
first-party source.

## Category contracts

### `hills` — Hills & mounds

- A named hill, summit, mound, hillfort, signed viewpoint or defining summit
  monument reached by a meaningful climb.
- Legal public pedestrian access on an ordinary walking route must be explicit.
- No scrambling, chains, ladders, glacier/snowfield, exposed ridge, hazardous
  crossing, tidal dependency or mountain judgement.
- A car-park-adjacent lookout is normally rejected unless the walking ascent is
  itself material and documented.
- OSM paths and right-to-roam status are lead evidence only, not access proof.

### `landmarktrees` — Remarkable trees

- A named individual living tree, not a wood, grove, park or arboretum as a whole.
- It must be officially protected/champion/heritage-listed or carry a specific,
  well-sourced cultural story.
- The tree must still stand and be reachable from, or safely visible from, a
  public path.
- Generic large/old trees, ordinary memorial plantings and private-garden-only
  specimens are rejected.

### `steps` — Steps & stair streets

- A named outdoor public stairway or stair street where the climb is the
  experience.
- It normally has roughly 40 or more steps / 10 metres of ascent, or exceptional
  documented architectural or social significance.
- Indoor, station, emergency and incidental attraction-access stairs are rejected,
  as are escalators, lifts and technical mountain routes.
- Record known step count, incline, surface, handrail, lighting and accessibility
  limitations without inventing missing details.

### `specialistshops` — Specialist shops

- A currently trading, independently visitable shop whose deep narrow inventory
  or surviving living trade is itself worth the detour.
- Examples include maps/globes, pens, magic, models, buttons/haberdashery,
  typewriters, specialist instruments, stamps/coins and similarly narrow trades.
- Existing categories retain precedence: books, records, bakery/food, wine and
  other already-modelled retail must not leak into this category.
- Chains, malls, department stores, ordinary antiques, appointment-only dealers,
  museum shops and décor-led concept stores are rejected.
- Require a first-party current site and a dated recent-activity/status check.

## Editorial score

Each retained candidate is scored 1–5 on:

1. visual impact;
2. surprise;
3. story;
4. walkability;
5. shareability.

The admission threshold is 19/25, with story and walkability each at least 4.
The score cannot override any hard source, access, status, coordinate or novelty
failure.

## Dossier contract

Every included row retains:

- exact production fields: `n`, `a`, `pc`, `lat`, `lng`, `c`, `s`, `q`, `w`, `city`;
- country, local-language aliases and stable external identifiers where present;
- atomic `_facts` linked to `_sources`;
- source type, role and `checked_at` date;
- coordinate basis;
- public access/current trading evidence and relevant limitations;
- five-factor score and accidental-discovery rationale;
- global dedupe result against commit `001e9e83`, including nearest candidate;
- confidence for identity, coordinates, facts, access/status and novelty.

All five confidence dimensions must be `high` for import. Medium rows remain in
the dossier's deferred section.

## Dedupe and import

- Compare IDs, normalized names, translated/local aliases and external IDs
  globally, not only within a city.
- Under 30 metres is presumed duplicate until proven otherwise; 30–120 metres
  requires manual neighbour review; alias/name matches within 3 km require review.
- For hills, a summit, monument and viewpoint may be adjacent but distinct; record
  the rationale instead of silently accepting both.
- Re-run dedupe after all theme shards are combined and immediately before import.
- Import only in reviewed waves of 25–35 using `tools/add-spots.js`; every new row
  remains a `d` draft in `data/quality.json`.
- Run category contracts, quality checks, mobile regression tests, build and diff
  checks after every wave. Never bulk-promote drafts.
