# Discovery wave two research method

Date: 2026-08-09
Catalogue snapshot: `8dcb2b20` (17,131 spots; 63 categories; 1,075 city/region entries)
Status: completed and imported as 106 unpromoted `d` drafts

This run extends the completed balanced-280 programme. The editorial, evidence,
coordinate, access, scoring and deduplication rules in
`research/balanced-280-method.md` remain binding. The number below is a ceiling,
not a quota; a shortfall is preferable to filler or invented precision.

## Target slate

| Theme | Geographic emphasis | High-confidence ceiling |
|---|---|---:|
| Hills & mounds | Outside Europe | 40 |
| Steps & stair streets | Outside Europe | 40 |
| Remarkable trees | Outside Europe | 40 |
| Specialist shops | Worldwide, avoiding wave-one repeats | 40 |
| Footbridges | Worldwide | 40 |

The intended balance is roughly 200 strict additions, with meaningful coverage
across the Americas, Asia, Africa and Oceania. Europe may contribute further
shops and footbridges, but should not dominate a second run.

## Shared admission rule

Every included row must be a distinct physical objective that rewards accidental
walking discovery. It should be visually legible or experientially memorable from
the public realm, have a concise specific story, and be reasonable to encounter on
an ordinary walk. Popularity, age, size, scenicness or novelty alone is insufficient.

Discovery sources generate leads only. Inclusion normally requires at least two
useful sources, led by a current official, municipal, land-manager, heritage-register
or first-party source that establishes identity and present access/status. Exact
coordinates need a named map object, official route endpoint or similarly defensible
basis. Missing values remain unspecified rather than being guessed.

## Existing category contracts

The `hills`, `steps`, `landmarktrees` and `specialistshops` contracts are unchanged
from `research/balanced-280-method.md`. In particular:

- no technical, exposed or seasonally hazardous hill routes;
- no indoor, station, emergency or incidental attraction-access stairs;
- no dead, generic, private-only or weakly identified trees;
- no chains, ordinary retail, appointment-only dealers or shops without a currently
  verifiable physical storefront.

## Proposed `footbridges` contract

- A named public pedestrian-only bridge, suspension bridge, footbridge or boardwalk
  where crossing the structure itself is the memorable walking experience.
- The structure must have a specific visual, engineering, social or historical story;
  a named but ordinary utilitarian crossing does not qualify.
- Current public pedestrian access and current structural status must be supported by
  an official, municipal or land-manager source. A mapped path alone is insufficient.
- Vehicular bridges with a pavement, private or appointment-only crossings, attraction
  access where the bridge is incidental, damaged/closed structures, technical routes
  and crossings requiring hazardous seasonal judgement are excluded.
- Record surface, steps, width, exposure, accessibility and operating-hour limitations
  only when a source supports them.
- Existing categories retain precedence when the bridge is merely the setting for a
  stronger museum, memorial, artwork, ruin, wildlife or industrial story.

Live presentation: slug `footbridges`, label `Footbridges`, emoji `🌉`, tint
`#DDE7E2`. The candidate, overlap and source audits established a coherent category,
and it is now registered in the live model.

## Scoring and confidence

Each included row must score at least 19/25 across visual impact, surprise, story,
walkability and shareability, with story and walkability each at least 4. Identity,
coordinates, facts, access/current status and novelty must all be `high`; scoring
cannot override a failed hard gate.

## Dedupe and production

- Compare IDs, normalised names, translated/local aliases and external IDs against
  all 17,131 snapshot rows and against every wave-two candidate.
- Under 30 metres is presumed duplicate; 30–120 metres requires manual neighbour
  review; alias/name matches within 3 km require review.
- Re-run global dedupe after all five lanes are combined and immediately before import.
- Add missing city/region entries only through a reviewed `tools/add-cities.js` plan.
- Import passing rows in bounded waves of 25–35 with `tools/add-spots.js`.
- Every new row remains quality `d`; no row is promoted in this run.
- Run category contracts, dossier/production parity, quality, mobile, build and diff
  checks before committing.

## Final result

The five lanes dispositioned 195 researched leads. The strict retained set contains
106 draft additions: 20 hills, 14 outdoor stair climbs, 24 landmark trees, 15
specialist shops and 33 footbridges. The remaining 89 leads were explicitly deferred
or excluded; the run stopped below its 200-place ceiling rather than weakening the
source, access, walkability or current-status gates.

The retained geographic balance is Americas 35, Asia 29, Oceania 20, Europe 17 and
Africa 5. A reviewed city plan added 49 registry entries (33 cities/towns and 16
genuine regions) with no existing-bbox updates. The resulting live model contains
17,237 spots, 64 categories and 1,124 city/region rows (1,123 unique slugs because of
the unchanged pre-existing duplicate `charleston`). Every imported row remains quality
`d`, pending human editorial review and promotion.

The final current-status sweep moved Umshiang Double-Decker Living Root Bridge,
Arapuni Suspension Bridge and Pedro e Inês Bridge out of the retained set: the first
failed the ordinary-walk contract, while the latter two had unresolved 2026 closure
evidence. Their dossier records preserve the evidence and reopening conditions.
