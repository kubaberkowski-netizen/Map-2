# Paris deep-run research method

Date: 2026-08-09
Catalogue snapshot: `95536dfa` (17,237 spots; 140 assigned to Paris; 64 live categories)
Status: complete; 91 strict candidates imported as quality `d` drafts

This is a city-depth run for a field test during 13–16 August 2026. It audits
every live category, but the category list is a coverage checklist rather than a
quota. A place is admitted only when it is a distinct walking objective with a
specific story, current evidence and exact coordinates. Tourist fame, good reviews
or a convenient location cannot substitute for those gates.

## Baseline and ceiling

The existing Paris catalogue has 140 places across 37 of 64 live categories. All
140 are frozen as the duplicate baseline; existing drafts are not silently replaced
or promoted.

| Research lane | Principal categories | Strict inclusion ceiling |
|---|---|---:|
| Built environment & history | architecture, eras, monuments, stairs, bridges, alleys, ruins, memorials and urban oddities | 45 |
| Outdoor & nature | parks, wild places, hills, viewpoints, trees, canals, cemeteries and outdoor crossings | 35 |
| Culture, faith & commerce | museums, galleries, film, music, books, archives, places of worship, food, drink, markets and specialist retail | 50 |

The combined ceiling is 130, not a target. Research should screen substantially
more leads and preserve explicit deferred/excluded reasons. It should stop below
the ceiling rather than pad thin categories.

## Paris geography and category assignment

- Every retained point uses `city: "paris"` and lies inside the live raw Paris
  browse bbox `[2.12, 48.76, 2.47, 48.902]`.
- The physical objective, not merely its postal label, must be inside that bbox.
- Use the narrowest existing category whose contract describes why the place is
  worth the walk. Do not create a category in this run.
- Every one of the 64 categories receives one of: retained candidate(s), already
  adequately represented, researched but no strict fit, or intrinsically
  inapplicable to Paris. Inapplicable categories remain empty.
- Separate features may coexist within 120 metres only when their identities and
  walking experiences are independently defensible and the dossier records the
  neighbour review.

## Admission rule

Every included row must be a legible, named physical objective that rewards
accidental walking discovery and supports a concise memorable story. It must be
publicly and legally visitable on an ordinary walk next week. Ticketed interiors
are allowed only when the place itself is the experience and current visitor access
is established; appointment-only, private, unsafe, event-only and temporarily
closed places are deferred.

Paris-specific current-status checks include August holiday closures, exceptional
summer hours, timed-booking requirements, works, strike/service notices, heat or
water restrictions, park/night closures and business trading continuity. A current
listing cannot override a dated closure notice without later reopening evidence.
Travellers must still recheck same-day notices.

## Evidence and dossier contract

Each retained row keeps:

- production fields `n`, `a`, `pc`, `lat`, `lng`, `c`, `s`, `q`, `w`, `city`;
- French/local aliases and stable external IDs where available;
- atomic facts linked to source IDs;
- at least two useful sources, including a current municipal, land-manager,
  heritage, institutional or first-party source;
- an exact named-geometry, entrance, storefront or official destination coordinate
  basis, without invented precision;
- current access/trading evidence plus material booking, hours, surface or mobility
  limitations;
- a five-part editorial score and all-high confidence record;
- global catalogue dedupe, including the nearest existing place and any manual
  review within 120 metres.

Discovery sources, review platforms, social posts, Wikipedia, Wikidata and OSM can
generate or locate leads. They do not by themselves establish current public access,
continued retail trading or a disputed story.

## Score, search and dedupe gates

The score uses `story`, `walkability`, `distinctiveness`, `source_quality` and
`geographic_value`, each from 1–5. Inclusion requires at least 19/25, with story and
walkability each at least 4. Identity, coordinates, facts, access/status, novelty and
overall confidence must all be `high`; score cannot compensate for a failed hard
gate.

`q` is a practical place-search query containing the name plus Paris or the local
district, never an editorial action hook.

Names, translated/local aliases, external IDs and coordinates are compared against
all 17,237 catalogue rows and all candidates across the three lanes. Under 30 metres
is a presumed duplicate; 30–120 metres requires a recorded manual distinction;
name/alias matches within 3 km require review.

## Import and field-test status

Only candidates that pass the combined audit may be imported with
`tools/add-spots.js`, in bounded waves. They remain quality `d` pending human
editorial testing and promotion. The run adds a Paris-specific regression
contract, updates derived baselines, rebuilds the site and native assets, and passes
quality, category, mobile, deterministic-build and diff checks before local commit.

## Final result

The three lanes screened 324 leads and retained 91: 32 built/history, 29 outdoor
and 30 culture/commerce. The other 233 leads remain deferred or excluded in their
source dossiers. An initial six-wave import contained 92 rows; final independent
QA withdrew Grand Rocher when its apparent feature coordinate proved to be a reused
generic estate geotag. The strict bundle takes Paris from 140 to 231 rows and the
catalogue from 17,237 to 17,328. All 91 remain `d` drafts.

The additions span 36 categories and introduce 14 categories previously absent
from Paris, increasing coverage from 37 to 51 of 64 live categories. Detailed
counts, visit-window caveats and field-test clusters are recorded in
`research/paris-deep-run-results-2026-08-09.md`.
