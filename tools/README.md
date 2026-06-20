# tools/ — spot-research pipeline

Helpers for **finding new candidate spots** (Reddit / web / OpenStreetMap /
Wikidata / TikTok / Google Places) and turning them into rows that drop straight
into `data/spots.json`. Nothing here touches the live app or the catalogue
automatically — it produces a **review pile** you curate by hand.

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

> **The writeup rule still holds.** These tools **never** write the `w` field.
> Every candidate comes out with `w:""`. The writeups are the product and stay
> in your voice — see `CLAUDE.md`. The tools also leave the short hook `s` as a
> rough placeholder; rewrite it.

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
- lands inside one of the 6 city bboxes (`Ci`), assigned automatically;
- passes the **same validation `build.js` enforces** (keys, finite/non-zero
  coords, in-bbox) — so anything that survives won't be rejected at build time;
- is **not a duplicate** of an existing spot (id collision, same name in the
  same city, or within ~120 m of an existing spot).

`c` (category) is auto-filled only when confidently guessed from OSM tags;
otherwise it's `""` with `_meta.needs:["c"]` for you to pick from the 44 slugs.

---

## Files

| file | what it is |
|---|---|
| `model.js` | The data model, parsed **live** from `src/app.template.html` (category slugs + city bboxes) and `data/spots.json`. Validation + dedupe + city-assignment live here. Never hand-types slugs. |
| `sources.js` | Fetch adapters. **Ready (no key):** `overpass`, `wikidata`, `reddit`, `pullpush`, `geocode`. **Ready (needs `ANTHROPIC_API_KEY` + SDK):** `claudeExtract`. **Stubs (need a key):** `tiktok`, `firecrawl`, `apify`, `googlePlaces`. |
| `category-map.js` | Best-effort OSM-tag → category-slug guesser. Returns `null` rather than guess wrong. |
| `find-spots.js` | The CLI that wires it all together. |
| `candidates/` | Generated output (git-ignored). One JSON file per city. |

---

## Usage

```bash
# OpenStreetMap features (museums, historic sites, follies, viewpoints…) in a city
node tools/find-spots.js --city london   --source overpass --limit 150
node tools/find-spots.js --city paris    --source wikidata

# Reddit/Pullpush: become rows automatically when ANTHROPIC_API_KEY is set
# (Claude extracts named places from the text). Without the key → skim-list of links.
npm install @anthropic-ai/sdk      # one-time; intentionally NOT a project dependency
export ANTHROPIC_API_KEY=sk-ant-...
node tools/find-spots.js --city london  --source reddit   --sub london  --query "hidden OR underrated OR secret"
node tools/find-spots.js --city glasgow --source pullpush --sub glasgow --query "weird OR oddity OR forgotten"

# When you've filled in the categories (and left writeups blank), print paste-ready rows:
node tools/find-spots.js --emit london          # → stdout, schema-clean, _meta stripped
```

### Then, by hand
1. Open `tools/candidates/<city>.json`. For each row: pick a `c` from the 44
   slugs, tighten `s`. **Leave `w` blank.**
2. Write the `w` writeups yourself.
3. `node tools/find-spots.js --emit <city>` → paste the rows into `data/spots.json`.
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
- `c` is constrained to the **live 44-slug enum**, so it can only emit a real
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
