# Europe walk-discovery expansion: 2,000-place ledger

## Goal

Add 2,000 genuinely new European places that feel rewarding to encounter on foot: a strange facade, a pocket viewpoint, a half-hidden garden, a piece of public art, a lane with a story, or infrastructure worth stopping for. This is a discovery layer, not a generic directory of famous sights or useful businesses.

The work ships in reviewable waves of 25-40 spots. Each wave is researched, coordinate-checked, deduplicated against the live catalogue and earlier waves, imported as draft data, built, and reviewed before the next wave starts.

## Baseline audit

- Catalogue at start: 14,902 spots in 973 city/region slugs.
- Estimated European coverage: 9,819 spots across 429 city/region slugs.
- Thin coverage: 279 European city/region slugs have fewer than 10 spots.
- Existing concentration is high in a few places, led by London (1,207), Warsaw (376), Barcelona (164), Istanbul (158), Rome (150), Glasgow (147), Edinburgh (142), Oslo (141), Bristol (140), Manchester (138) and Munich (138).
- A stale 300-candidate Europe/UK/Poland research branch was reconciled before this wave: 30 exact duplicates and 46 likely name aliases were identified before coordinate-level review. It is a lead pool, not import-ready data.

## Selection rule

A candidate should have at least three of these five qualities:

1. Visual impact from the pavement.
2. A real stop-walking impulse.
3. A concise story that survives fact-checking.
4. A natural fit in a walkable route.
5. Something a person would save, share or collect.

Generic chains, routine services, weak viewpoints, ticket-dependent interiors and famous sights already well represented in the app are out. A lesser-known place next to a landmark can qualify when the encounter itself is distinct.

## Duplicate gate

Every proposed row passes all of the following before import:

- exact ID collision check;
- normalized name within city check;
- alias review for translated, shortened and local-language names;
- coordinate comparison against the current catalogue and accepted earlier waves;
- manual review of close neighbours in dense centres, where two real places can sit within 120 metres;
- source-backed confirmation that the mapped point is the described place.

The importer retains its exact ID and same-name checks. For this wave, coordinate deduplication is tightened to 30 metres after manual inspection so that distinct courtyard, lane and sculpture entries in dense historic centres are not discarded.

## Allocation by European state or territory

This is a target ledger rather than a promise to force weak candidates into a quota. If a state cannot support its allocation at the house standard, places move to a nearby under-covered state and the ledger is amended in the same pull request.

| State or territory | Target |
|---|---:|
| Albania | 35 |
| Andorra | 8 |
| Armenia | 30 |
| Austria | 45 |
| Azerbaijan | 25 |
| Belarus | 25 |
| Belgium | 45 |
| Bosnia and Herzegovina | 40 |
| Bulgaria | 45 |
| Croatia | 45 |
| Cyprus | 30 |
| Czechia | 50 |
| Denmark | 40 |
| Estonia | 30 |
| Faroe Islands | 10 |
| Finland | 40 |
| France | 80 |
| Georgia | 35 |
| Germany | 85 |
| Greece | 55 |
| Hungary | 45 |
| Iceland | 25 |
| Ireland | 45 |
| Italy | 90 |
| Kosovo | 25 |
| Latvia | 30 |
| Liechtenstein | 5 |
| Lithuania | 30 |
| Luxembourg | 15 |
| Malta | 25 |
| Moldova | 30 |
| Monaco | 5 |
| Montenegro | 25 |
| Netherlands | 50 |
| North Macedonia | 30 |
| Norway | 50 |
| Poland | 60 |
| Portugal | 50 |
| Romania | 55 |
| Russia | 30 |
| San Marino | 5 |
| Serbia | 45 |
| Slovakia | 40 |
| Slovenia | 35 |
| Spain | 85 |
| Sweden | 50 |
| Switzerland | 45 |
| Turkey | 45 |
| Ukraine | 50 |
| United Kingdom | 80 |
| Vatican City | 2 |
| **Total** | **2,000** |

## Wave 1

- 30 spots across 18 states and 20 city slugs.
- Mix: alleys, gardens, viewpoints, public sculpture, unusual architecture, social history, ruins and repurposed infrastructure.
- Seven coordinate-level aliases were removed before import: Keret House, Genex Tower, Zale Central Cemetery, Fiumei Uti Sirkert, Flakturm Augarten, Grounded Sun and Nine Views, and Jajinci.
- Source file: `research/new/europe-walk-wave-1.json`.
- Status: draft catalogue entries pending preview review.
