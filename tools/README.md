# tools/ — spot-research pipeline

Helpers for **finding new candidate spots** (Reddit / web / OpenStreetMap /
Wikidata / TikTok / Google Places) and turning them into rows that drop straight
into `data/spots.json`. Discovery commands produce a **review pile**; the explicit
apply tools (`add-spots.js` and `add-cities.js`) write only after a dry-run/review.

> **New here? Read [`WORKFLOW.md`](./WORKFLOW.md) first.** It is the end-to-end
> operating manual for the two tracks — **(A)** cleaning up junk and **(B)**
> expanding cities to the London blueprint with house-voice writeups — and ties
> the tools below into one batched, build-gated assembly line. Key pieces it adds:
>
> - **`quality.js` + `data/quality.json`** — the durable per-spot provenance flag
>   (`a`uthored / `v`erified / `d`raft / `m`achine-stub). The source of truth for
>   "what's sacred", replacing length-guessing and the old `/tmp/orig*.json` files.
> - **`audit-city.js`** — scored, per-city junk audit (Track A).
> - **`blueprint.js`** — measures any city's gap vs London (Track B targeting).
> - **`dossier.js`** — the sourced-facts contract between research and writing.
> - **`write-up.js`** — the house-voice writer (few-shot on authored London).
> - **`add-spots.js`** — bring in NEW write-up-worthy spots a discovery pass found
>   (not yet in the app), through the same validate/dedupe gates as the build.
> - **`audit-research-bundle.js`** — audit several cross-city dossiers together
>   for editorial gates, sources, confidence, city fit and global deduplication.
> - **`add-cities.js`** — append audited `Ci`/`flCO` registry entries from a city-plan
>   dossier before importing rows whose city slugs do not yet exist.

> **The writeup rule still holds.** Discovery tools never invent the `w` field and
> emit candidates with `w:""`. `add-spots.js` may copy a reviewed dossier's supplied
> `w` verbatim, but marks every added row `d` (machine draft pending human review).
> The writeups are the product — see `CLAUDE.md`.

Zero new dependencies — pure Node (uses the `acorn` already in `devDependencies`
and the built-in `fetch`). Run `npm install` once in a fresh checkout.

---

## The pipeline

```
gather → enrich (geocode) → assign city → guess category →
validate (build.js rules) → dedupe (vs data/spots.json) → candidates/<city>.json
```

Each emitted row is in the **exact `spots.json` schema** plus a `_meta` block
(provenance + what's still missing). A row is only ever kept if it:
- lands inside a city or region bbox from the live `Ci` registry, assigned automatically;
- passes the **same validation `build.js` enforces** (keys, finite/non-zero
  coords, in-bbox) — so anything that survives won't be rejected at build time;
- is **not a duplicate** of an existing spot (id collision, same name in the
  same city, or within ~120 m of an existing spot).

`c` (category) is auto-filled only when confidently guessed from OSM tags;
otherwise it's `""` with `_meta.needs:["c"]` for you to pick from the live slugs.

---

## Files

| file | what it is |
|---|---|
| `model.js` | The data model, parsed **live** from `src/app.template.html` (category slugs + city bboxes) and `data/spots.json`. Validation + dedupe + city-assignment live here. Never hand-types slugs. |
| `sources.js` | Fetch adapters. **Ready (no key):** `overpass`, `wikidata`, `reddit`, `pullpush`, `geocode`. **Ready (needs `ANTHROPIC_API_KEY` + SDK):** `claudeExtract`. **Stubs (need a key):** `tiktok`, `firecrawl`, `apify`, `googlePlaces`. |
| `category-map.js` | Best-effort OSM-tag → category-slug guesser. Returns `null` rather than guess wrong. |
| `find-spots.js` | The CLI that wires it all together. |
| `audit-research-bundle.js` | Audits one or more top-level `included` arrays together: production schema, 19/25 score gate, source roles, all-high confidence, live cities/categories, aliases, external IDs and global/candidate proximity. Reports missing city slugs without writing. Dense-city pairs under 30 m are presumed duplicates; pairs from 30–119 m need a named `dedupe.internal_neighbours` review. |

New category slugs need an include/exclude contract in their research dossier before
they are added to the live template. Automatic mapping stays deliberately narrow:
for example, `arcades` only maps from a named pedestrian/footway feature tagged as a
covered or building passage. `streetfurniture` and `historicshopfronts` remain
editorial categories because a generic civic fixture or merely old storefront is not
a destination. `artnouveau` also remains editorial: the whole exterior composition,
not one floral door or interior detail, must clear the style contract.
| `add-spots.js` | Validates, dedupes and appends new rows; supports array selection with `--key`, `--offset` and `--limit`; bumps the baseline and flags additions `d`. |
| `add-cities.js` | Adds audited city metadata to `Ci` and `flCO` (plus optional country-flag additions) from a registry-plan JSON. Always dry-run first. |
| `candidates/` | Generated output (git-ignored). One JSON file per city. |

---

## Usage

```bash
# OpenStreetMap features (museums, historic sites, follies, viewpoints…) in a city
node tools/find-spots.js --city london   --source overpass --limit 150
node tools/find-spots.js --city london   --source overpass --profile hills --limit 150
node tools/find-spots.js --city paris    --source overpass --profile landmarktrees --limit 150
node tools/find-spots.js --city lisbon   --source overpass --profile steps --limit 150
node tools/find-spots.js --city sydney   --source overpass --profile footbridges --limit 150
node tools/find-spots.js --city tokyo    --source overpass --profile specialistshops --limit 150
node tools/find-spots.js --city paris    --source wikidata

# Reddit/Pullpush: become rows automatically when ANTHROPIC_API_KEY is set
# (Claude extracts named places from the text). Without the key → skim-list of links.
npm install @anthropic-ai/sdk      # one-time; intentionally NOT a project dependency
export ANTHROPIC_API_KEY=sk-ant-...
node tools/find-spots.js --city london  --source reddit   --sub london  --query "hidden OR underrated OR secret"
node tools/find-spots.js --city glasgow --source pullpush --sub glasgow --query "weird OR oddity OR forgotten"

# When you've filled in the categories (and left writeups blank), print paste-ready rows:
node tools/find-spots.js --emit london          # → stdout, schema-clean, _meta stripped

# Audit cross-city dossiers together before changing either registry or catalogue:
node tools/audit-research-bundle.js research/run-hills.json research/run-steps.json

# Register city slugs required by an audited cross-city dossier (template only):
node tools/add-cities.js research/city-registry-plan.json --dry
node tools/add-cities.js research/city-registry-plan.json

# Import one bounded wave from a top-level dossier array:
node tools/add-spots.js london --file research/run.json --key included --offset 0 --limit 25 --dry
node tools/add-spots.js london --file research/run.json --key included --offset 0 --limit 25
# Continue with --offset 25, 50, ...; --limit is the number selected in that wave.
```

When a point lies inside its explicitly declared city bbox but `cityForPoint()`
prefers an overlapping `region:true` catchment, the bundle audit keeps the more
specific city assignment and prints a warning. It still rejects out-of-bbox rows
and conflicts between two ordinary city/town entries.

`--key <name>` selects an array such as `included` or `candidates` from an object
dossier (omit it for a top-level array). `--offset` is a zero-based starting index;
`--limit` must be a positive integer. The positional city must already exist and is
the fallback for rows without `city`; an explicit per-row city is preserved and
validated against live `Ci`. `add-cities.js` expects
`recommendation.preserving_dossier_city_semantics.proposed_entries`, refuses existing
ids, updates `Ci`/`flCO`, and syntax-checks the edited main script. The same section may
also carry guarded `bbox_updates:[{id,bbox}]` for an existing city or metro whose honest
catchment is too tight; unknown ids and invalid/non-increasing bboxes are rejected. Run
`npm run build` after either apply command.

### Then, by hand
1. Open `tools/candidates/<city>.json`. For each row: pick a `c` from the live
   slugs, tighten `s`. **Leave `w` blank.**
2. Write the `w` writeups yourself.
3. `node tools/find-spots.js --emit <city>` → paste the rows into `data/spots.json`,
   or use `add-spots.js` after reviewing its `--dry` report.
4. `npm run build` (re-validates everything and regenerates `index.html`).

---

## The Claude extraction step (implemented)

`claudeExtract` is **already wired up** — it's what turns Reddit/Pullpush/TikTok
*text* into structured candidate rows. It uses the official `@anthropic-ai/sdk`,
lazy-required so the rest of the pipeline stays dependency-free (CLAUDE.md keeps
`acorn` as the only project dependency):

```bash
npm install @anthropic-ai/sdk          # install only if you use this step
export ANTHROPIC_API_KEY=sk-ant-...
# optional: export FLANEUR_EXTRACT_MODEL=claude-sonnet-4-6   # default is claude-opus-4-8
```

How it stays safe:
- The structured-output **schema has no `w` field**, so the model *cannot* draft
  a writeup — every `w` is still yours to write.
- `c` is constrained to the **live category enum**, so it can only emit a real
  category (no white-screen risk, nothing to hand-fix).
- It returns `{n, a, c, s, confidence, reason, source_url}`; rows still pass
  through geocode → bbox-validate → dedupe before landing in `candidates/`.

## Wiring up the remaining keyed sources

These are still stubs that throw setup instructions. Each is a small addition to
`sources.js`:

- **`firecrawl`** — listicles → clean markdown/JSON. `FIRECRAWL_API_KEY`,
  `POST https://api.firecrawl.dev/v1/scrape`.
- **`apify`** — marketplace actors (TikTok, Instagram, Google Maps).
  `APIFY_TOKEN`, `run-sync-get-dataset-items`.
- **`googlePlaces`** — canonical name + postcode + coords (great for `pc`/`q`).
  `GOOGLE_PLACES_KEY`, Places API (New).
- **`tiktok`** — no open API; go via `apify` (TikTok Scraper actor) or `yt-dlp`,
  then `claudeExtract` the captions/hashtags/location tags.

---

## Network egress

The ready sources call these hosts — allow them in your environment's egress
settings (this sandbox blocks them by default):

- `overpass-api.de` (OpenStreetMap / Overpass)
- `query.wikidata.org` (Wikidata SPARQL)
- `nominatim.openstreetmap.org` (geocoding — **max 1 req/sec**, already throttled)
- `www.reddit.com`, `api.pullpush.io` (Reddit)
- `api.anthropic.com` (only if you use the `claudeExtract` step)

## Be a good citizen / ToS

- Adapters send a descriptive `User-Agent`, throttle per-host, and back off on
  429/5xx. Don't crank `--limit` into the thousands.
- Reddit & TikTok restrict commercial scraping and rate-limit hard. This is a
  personal research tool — keep it personal, prefer official APIs, cache results.
- Treat OSM/Wikidata/Atlas Obscura as the reliable spine; Reddit/TikTok as the
  flavour/discovery layer.

## Review desk (lighthouse-city writeups)

`npm run review` → http://localhost:5177. Pick a city, edit or approve each
machine writeup (`d`/`m` flags) in your own voice; saving writes `w` to
data/spots.json and promotes the flag to `a` in data/quality.json. Authored
(`a`/`v`) spots are never queued and the API refuses to modify them. Both
files are backed up to data/.review-backup-<ts>/ at server start. After a
sitting: `npm run build`, review the diff, commit.
