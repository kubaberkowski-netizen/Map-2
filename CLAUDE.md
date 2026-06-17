# Flâneur — maintenance guide for AI sessions

Flâneur is a personal web app cataloguing offbeat/storied London places, sorted by
distance from your live location. Read this fully before touching anything.

## Architecture
- The **entire app is ONE self-contained HTML file** (`index.html` at the repo root)
  with an inline, **MINIFIED React bundle** (~660 KB). There is no `src/`, no build
  step in the repo: **the deployed HTML *is* the artifact**.
- GitHub Pages serves this file directly. Confirm the exact source branch/folder in
  the repo's **Settings → Pages** before pushing — do not guess.
- All edits are **surgical string/regex patches against minified code**. Treat it as
  production: **a malformed edit white-screens the live site on push.**

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
  Add sourced facts only when explicitly asked.

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

## Syncing a new build
When given an updated one-file build, replace `index.html` with it, then run the full
validation recipe above. Sanity-check it's actually the newer build by confirming
recent feature strings are present (e.g. `proxprompt`, `wmleg`, `toastnote`).

## Git rules
- No history rewrites, no force-push.
- Ask before anything destructive beyond replacing the single app HTML file.
- Push only to the branch GitHub Pages builds from (verify in Pages settings).
