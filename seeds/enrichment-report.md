# Enrichment (DEDUPE bucket) — cross-link report

83 seed leads matched spots already in the catalogue. The data model has **no
per-spot tags field** — thematic grouping is via curated `ids:[]` Worlds. So
"attach tags" = add the existing spot's id to the matching World collection.

## Applied (verified correct)
- **bowielondon** += `40stansfieldroad` (40 Stansfield Road — Bowie's birthplace, Brixton)
- **recorddig** += `berwick` (Berwick Street — Soho record-shop row)

## Auto-proposed but REJECTED (fuzzy-match noise — left for manual triage)
Automated tag→World matching on name-dedup produced wrong hits; not applied:
- greasycaffs += `standrewsunitedreformedc` — WRONG: that id is *St Andrew's United Reformed Church*, not the caff "Andrew's".
- greasycaffs += `cafeinthecrypt` — Cafe in the Crypt is not a greasy spoon (oddity).
- greasycaffs += `north-gower-sherlock` — Speedy's, but catalogued as a film location; borderline.
- hiddenalleys += `ziggy` — that's the Bowie Heddon St spot (already in bowielondon), not a generic alley.
- bowielondon += `denmark` — Denmark St Bowie link too tenuous (it's general Tin Pan Alley music).
- cityviews += `frankscafe` — Frank's Cafe is Peckham; cityviews = *City of London* rooftops. Geographic mismatch.

## Remaining 77 DEDUPE cross-links
The other matches carry descriptive tags (victorian, jewish, immigrant, interior,
georgian, interwar) that map to no World and no spot field — they need either a
schema change (per-spot tags + card rendering) or manual curation. Full list with
existing-spot ids + suggested tags is in `seeds/triage-report.md` (DEDUPE section).
