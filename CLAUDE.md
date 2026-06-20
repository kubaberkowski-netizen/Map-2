# Flâneur — maintenance guide for AI sessions

Flâneur is a personal web app cataloguing offbeat/storied places, sorted by distance
from your live location. It began as a London guide and has since grown into a
**multi-city / global** catalogue (London is still the largest city by far). Read this
fully before touching anything.

## Architecture
- The **deployed artifact is ONE self-contained HTML file** (`index.html` at the repo
  root) with an inline, **MINIFIED React bundle** (~660 KB of code) plus the inlined
  catalogue, so the file is now **~4 MB total** (the catalogue dominates). GitHub Pages serves this
  file directly from `main` / root (no `gh-pages` branch, no `/docs`). Confirm the
  source in **Settings → Pages** before pushing if in doubt — do not guess.
- A small hand-written **`sw.js`** sits at the repo root (a service worker: a
  stale-while-revalidate offline app shell + stale-while-revalidate tile cache +
  cache-first Leaflet). It is **static —
  not processed by `build.js`** — and is registered by a tiny `<script>` near the end
  of the template. Edit it directly; bump its cache-name constants when its logic
  changes so clients pick it up. The navigate handler distinguishes the **app shell**
  (`/` or `/index.html`, which uses the SPA fallback and is cached as `./index.html`)
  from **other same-origin pages** (e.g. `privacy.html`, cached under their own URL) —
  so a static page can't poison the app-shell cache or render the app instead of itself.
- **`privacy.html`** is a standalone static page at the repo root (its own inline CSS +
  CSP, no scripts, no external assets). It is **not processed by `build.js`** and is
  precached by the service worker. Linked from the app's footer ("Privacy"). Its two
  placeholders are now filled (effective date + contact email); revise it if accounts /
  payments / ads / analytics are ever added.
- The footer also exposes optional **"Suggest a place"** and **"Support Flâneur"** links,
  rendered **only when** the `FORM_URL` / `DONATE_URL` constants (inline in the template,
  next to `MTKEY`/`GAKEY`) are set to a real URL — empty by default, so no broken links
  ship. (Note: a tip/donation link inside an iOS wrapper can fall foul of App Store IAP
  rules — confirm framing before an App Store build.)
- There is now a **source + build split** (added so the catalogue is editable as
  clean JSON without touching minified code). The boot sequence is **unchanged and
  fully synchronous** — the app does NOT fetch JSON at runtime; the catalogue is
  inlined at build time.
  - `data/spots.json` — the **12,581 spots** as pretty JSON. **Source of truth for `Z`.**
  - `src/app.template.html` — the full app with the inline `Z=[…]` array literal
    replaced by the placeholder `[]/*__FLANEUR_SPOTS__*/`. **Everything else
    (`ne`, `Xr`, all app code) is byte-for-byte the deployed bundle.**
  - `build.js` (`npm run build`) — injects `spots.json` back at the placeholder as a
    compact JS literal, validates, and writes `index.html`.
- Everything **except the catalogue** is still **minified code**: edits to app logic,
  `ne`, or `Xr` are **surgical string/regex patches against `src/app.template.html`**
  (then rebuild). Treat it as production: **a malformed edit white-screens the live
  site on push.**

## Editing workflow (build step)
- **To change spots / writeups:** edit `data/spots.json` → `npm run build` → commit
  BOTH `data/spots.json` and the regenerated `index.html`.
- **To change app code, categories (`ne`), or Worlds (`Xr`):** edit
  `src/app.template.html` → `npm run build` → commit the template + `index.html`.
- `npm run build` **refuses to write `index.html`** (writes nothing) if: spots.json is
  invalid JSON, any entry is missing a required key, any `id` is duplicated, any
  entry's `c` is not a category slug **defined in the template's `ne`**, any
  entry's `city` is not a slug **defined in the template's `Ci`** (both parsed from
  the template, not hand-typed), any coordinate is non-finite/zero, or any coordinate
  lands **outside its city's `Ci` bbox** (±0.1° margin — catches wrong-city / sign-flip /
  transposed-digit typos). It **warns** (non-fatal) if the entry count differs from the
  baseline (12,581; see `BASELINE` in `build.js`), if two spots share a name within a
  city (likely duplicate spots), or
  if any writeups are empty (with a per-city count). It then re-runs the CLAUDE.md checks
  below on the generated HTML and fails loudly on any miss.
- `acorn` is the only dependency (devDependency). `node_modules/` is gitignored; run
  `npm install` once in a fresh checkout.

## Data model (violating this crashes the app)
- Entries live in an array `Z = [{id, n, a, pc, lat, lng, c, s, q, w, city}, ...]`
  - `n` = name, `a` = area, `pc` = postcode, `c` = category slug, `s` = short hook,
    `q` = Google query, `w` = writeup, `city` = city slug.
- `c` **MUST** be one of exactly **43 valid category slugs**. The code reads
  `ne[entry.c]` **unguarded**, so any unknown slug = **instant white-screen**.
- `city` **MUST** be a slug defined in the **`Ci` cities registry**. `build.js`
  rejects unknown city slugs. There are **70 cities** today, spanning the UK, Europe,
  the Americas, Asia and Australia — `london` (988) is by far the largest, followed by
  global metros (e.g. `chicago` 307, `nyc` 298, `losangeles` 287, `helsinki` 272,
  `sanfrancisco` 264, `dublin` 245, `manchester` 243, `tokyo` 231). The full list +
  per-city counts can be recomputed from `data/spots.json` at any time.
- Categories are defined in `ne = {slug:{l, e, t}, ...}` (43 slugs;
  l=label, e=emoji, t=tint colour).
- Cities are defined in `Ci = [{id, name, label, e, lat, lng, bbox, blurb}, ...]`
  (inline in the template). Adding a city = append a `Ci` entry + spots tagged with
  its `city` slug. A "Cities" overview tab (map + cards) summarises spots/visited per
  city; picking one sets `cityId` and recentres the reference location on it.
- **Discovery is filtered by `cityId`** via `Zc = useMemo(Z.filter(z=>z.city===cityId))`.
  The browse list, walk candidates, radar, map markers, Worlds counts and add-stop
  search all read `Zc` (spread pools `[...Zc,...J]`, `[...Zc.filter(Me.match)…]`).
  **`Z` stays global** for id lookups (`Z.find`), achievement/postcode/name indexes,
  the OSM dedup set, profile visited counts, and the module-level World-layer setup
  (which runs outside the component, so `Zc` is out of scope there). `cityId` defaults
  to `london`; the "Cities" tab switches it. The filter is live now that there are
  multiple cities.
- The app is **city-driven** via `cyo = useMemo(Ci.find(z=>z.id===cityId)||Ci[0])`:
  the LIVE button detects the nearest city by bbox/centre (snapping to the nearest
  if you're >60 km from all of them), the geocoder uses `cyo.bbox` + `cyo.name`, the
  zone chips use `cyo.zones` (only `london` falls back to the inline `Wu` list; other cities without `zones` render no zone chips, not London’s), and the tab
  title + share + OSM-toggle copy use `cyo.label`. The static `<title>`/manifest now
  read "Flâneur — London" (default boot) — `document.title` is updated at runtime per city.
- Themed collections ("Worlds") live in
  `Xr = [{id, name, cats, e, blurb, match: e=>…, osm, tag, ids?}, ...]` (80 entries).
  Membership is `wmem(World, spot)` = `World.match(spot) || World.ids?.includes(spot.id)`,
  so an optional `ids:[…]` curated list force-includes specific spots irrespective
  of category. All discovery/count call sites go through `wmem` — never `.match`
  directly.

## The "never touch writeups" rule
- The single-author writeups (the `w` fields) are the **entire point of the product** —
  they are the owner's voice. **NEVER rewrite, "improve," or invent writeup text.**
  Add sourced facts only when explicitly asked. Writeups are now edited in
  `data/spots.json` (the `w` field of each entry), then `npm run build`.
- **Reality check (post-scale-up):** with the catalogue at 12,581 spots, the **majority
  of `w` fields are now short machine-generated stubs** from the `tools/` enrichment
  pipeline (OSM / Wikidata / Wikipedia) — median length ~41 chars, ~80% under 80 chars,
  ~150 empty. The "owner's voice" rule still applies to the **authored** writeups (do not
  overwrite them); the machine stubs are fair game to enrich/replace when asked. If you
  add a feature that distinguishes the two, prefer a quality flag over guessing from
  length. See `ROADMAP.md` for the strategy discussion.
- `ne` (43 categories) and `Xr` (80 Worlds, which contain live `match: e=>…`
  functions and are **not serialisable**) **stay inline in `src/app.template.html`** —
  only `Z` was extracted to JSON.

## Validation recipe — run before EVERY commit, no exceptions
1. Extract the inline `<script>` body to a temp `.js` and run `node --check` on it.
2. Confirm counts via grep on the HTML:
   - **entries** — `id:"…",n:"` → should be **12,581** (keep in sync with `build.js`'s `BASELINE`)
     `grep -oE 'id:"[^"]*",n:"' index.html | wc -l`
   - **Worlds** — `match:\s*e\s*=>` → should be **80** (do NOT count `osm:`)
     `grep -oE 'match:[[:space:]]*e[[:space:]]*=>' index.html | wc -l`
   - **categories** — `(\w+):\{l:"` inside the `ne={…}` block → should be **43**
     `grep -oE '[A-Za-z0-9_]+:\{l:"' index.html | wc -l`
3. `node --check` catches syntax but **NOT stale variable references** — if you insert
   code that uses a variable, confirm it's declared earlier in the **same scope**.

## Syncing a brand-new one-file build (from the owner's external builder)
When given a whole new minified one-file build, you must **re-derive the source split**
(the new bundle has its own minified code, so the old template/JSON no longer match):
1. Locate the new build's `Z` array literal with **acorn** (find the `VariableDeclarator`
   named `Z` whose init is the only large `ArrayExpression`) — never regex/brace-count,
   entries contain brackets in strings.
2. Eval that exact literal → `JSON.stringify(data,null,1)` → overwrite `data/spots.json`.
3. Replace that span in the new build with `[]/*__FLANEUR_SPOTS__*/` → overwrite
   `src/app.template.html`.
4. `npm run build`, then run the validation recipe on `index.html`. Sanity-check it is
   the newer build by confirming recent feature strings (e.g. `proxprompt`, `wmleg`,
   `toastnote`) are present.

## Git rules
- No history rewrites, no force-push.
- Ask before anything destructive beyond replacing the single app HTML file.
- Push only to the branch GitHub Pages builds from (verify in Pages settings).
