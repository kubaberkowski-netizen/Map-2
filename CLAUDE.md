# Flâneur — maintenance guide for AI sessions

Flâneur is a personal web app cataloguing offbeat/storied London places, sorted by
distance from your live location. Read this fully before touching anything.

## Architecture
- The **deployed artifact is ONE self-contained HTML file** (`index.html` at the repo
  root) with an inline, **MINIFIED React bundle** (~660 KB). GitHub Pages serves this
  file directly from `main` / root (no `gh-pages` branch, no `/docs`). Confirm the
  source in **Settings → Pages** before pushing if in doubt — do not guess.
- There is now a **source + build split** (added so the catalogue is editable as
  clean JSON without touching minified code). The boot sequence is **unchanged and
  fully synchronous** — the app does NOT fetch JSON at runtime; the catalogue is
  inlined at build time.
  - `data/spots.json` — the **739 spots** as pretty JSON. **Source of truth for `Z`.**
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
  invalid JSON, any entry is missing a required key, any `id` is duplicated, or any
  entry's `c` is not a category slug **defined in the template's `ne`** (parsed from
  the template, not hand-typed). It warns if the entry count differs from 739, then
  re-runs the CLAUDE.md checks below on the generated HTML and fails loudly on any miss.
- `acorn` is the only dependency (devDependency). `node_modules/` is gitignored; run
  `npm install` once in a fresh checkout.

## Data model (violating this crashes the app)
- Entries live in an array `Z = [{id, n, a, pc, lat, lng, c, s, q, w}, ...]`
  - `n` = name, `a` = area, `pc` = postcode, `c` = category slug, `s` = short hook,
    `q` = Google query, `w` = writeup.
- `c` **MUST** be one of exactly **44 valid category slugs**. The code reads
  `ne[entry.c]` **unguarded**, so any unknown slug = **instant white-screen**.
- Categories are defined in `ne = {slug:{l, e, t}, ...}` (44 slugs;
  l=label, e=emoji, t=tint colour).
- Themed collections ("Worlds") live in
  `Xr = [{id, name, cats, e, blurb, match: e=>…, osm, tag}, ...]` (45 entries).
  The `match` predicate defines membership.

## The "never touch writeups" rule
- The single-author writeups (the `w` fields) are the **entire point of the product** —
  they are the owner's voice. **NEVER rewrite, "improve," or invent writeup text.**
  Add sourced facts only when explicitly asked. Writeups are now edited in
  `data/spots.json` (the `w` field of each entry), then `npm run build`.
- `ne` (44 categories) and `Xr` (45 Worlds, which contain live `match: e=>…`
  functions and are **not serialisable**) **stay inline in `src/app.template.html`** —
  only `Z` was extracted to JSON.

## Validation recipe — run before EVERY commit, no exceptions
1. Extract the inline `<script>` body to a temp `.js` and run `node --check` on it.
2. Confirm counts via grep on the HTML:
   - **entries** — `id:"…",n:"` → should be **739**
     `grep -oE 'id:"[^"]*",n:"' index.html | wc -l`
   - **Worlds** — `match:\s*e\s*=>` → should be **45** (do NOT count `osm:`)
     `grep -oE 'match:[[:space:]]*e[[:space:]]*=>' index.html | wc -l`
   - **categories** — `(\w+):\{l:"` inside the `ne={…}` block → should be **44**
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
