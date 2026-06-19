# tools/ — spot-research pipeline

Helpers for **finding new candidate spots** (Reddit / web / OpenStreetMap /
Wikidata / TikTok) and turning them into rows that drop straight into
`data/spots.json`. Nothing here touches the live app or the catalogue
automatically — it produces a **review pile** you curate by hand.

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
| `sources.js` | Fetch adapters. **Ready (no key):** `overpass`, `wikidata`, `reddit`, `pullpush`, `geocode`. **Stubs (need a key):** `tiktok`, `firecrawl`, `apify`, `googlePlaces`, `claudeExtract`. |
| `category-map.js` | Best-effort OSM-tag → category-slug guesser. Returns `null` rather than guess wrong. |
| `find-spots.js` | The CLI that wires it all together. |
| `candidates/` | Generated output (git-ignored). One JSON file per city. |

---

## Usage

```bash
# OpenStreetMap features (museums, historic sites, follies, viewpoints…) in a city
node tools/find-spots.js --city london   --source overpass --limit 150
node tools/find-spots.js --city paris    --source wikidata

# Reddit text leads (need claudeExtract wired up to become rows — see below).
# Until then they print as a skim-list of links.
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

## Wiring up the keyed sources

The stubs throw with setup instructions. Each is a small addition to
`sources.js`:

- **`claudeExtract`** — the most valuable. Turns messy Reddit/TikTok text into
  `{n, a, c, s, city, confidence}`. Set `ANTHROPIC_API_KEY`, call the Messages
  API (`claude-opus-4-8` or `claude-sonnet-4-6`) with a JSON-schema tool.
  **Crucially: never let it produce `w`.** Once wired, the `reddit`/`pullpush`
  branches can emit real rows instead of skim-lists.
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

## Be a good citizen / ToS

- Adapters send a descriptive `User-Agent`, throttle per-host, and back off on
  429/5xx. Don't crank `--limit` into the thousands.
- Reddit & TikTok restrict commercial scraping and rate-limit hard. This is a
  personal research tool — keep it personal, prefer official APIs, cache results.
- Treat OSM/Wikidata/Atlas Obscura as the reliable spine; Reddit/TikTok as the
  flavour/discovery layer.
