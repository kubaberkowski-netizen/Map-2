# Flâneur — writeup research brief (for AI agents)

How to turn the catalogue's machine-stub writeups into the owner's house voice,
without breaking the app or the product. Read `CLAUDE.md` first; this is the
content-research companion to it.

## The state of play (why this matters)

- 15,322 spots; **~87% still have a machine-generated stub** (`w` ≤ 80 chars, e.g.
  *"Church in Vienna. Catholic denomination."*) or a Wikipedia auto-extract
  (*"X is a Y located at…"*). Only ~13% are in the owner's voice — and those are
  mostly **London**.
- There are **zero truly-empty writeups**. "Locations with no writeups" means
  **stubs**, not blanks.
- The product is *offbeat/storied places with a voice* — not a gazetteer. A spot
  earns a writeup because it has **a story worth telling**, not because it exists.

## Target selection (do this, not "all stubs")

1. **Notable-but-weak pool.** Prioritise spots whose `id` is in
   `tools/wiki-enriched.json` or `tools/wikidata-enriched.json` **and** whose
   current `w` is a stub/extract. ~1,800 spots qualify.
2. **Geofence — CRITICAL.** The catalogue's city bboxes are wide and have swept in
   out-of-region junk. Before writing, compute each spot's distance from the city
   centre (`Ci` lat/lng) and **drop anything implausibly far** (e.g. ~45 of
   London's 71 "notable" stubs are actually Surrey/Kent listed buildings 20–40 km
   out, tagged `city:"london"`). These should be pruned/retagged, not written up.
3. **Editorial filter.** Even after geofencing, the Wikidata flag over-selects
   **Grade II listed cottages** ("Rose Cottage", "Redlands Farmhouse", "80 And 82,
   High Street") and dull suburban churches. Skip anything with no real hook.
   Favour storied categories: `oddity, history, death, roman, medieval, follies,
   streetart, literary, film, museum, faith` (when the faith site has a story),
   iconic `pub`s, etc.
4. Work **one city at a time**, starting with London, then the metros with the most
   notable-but-weak spots (Leeds, Rome, Sheffield, Amsterdam, Barcelona, Edinburgh,
   Venice, Florence, San Francisco…).

## Hard rules (each is a real mistake we've hit)

1. **Never overwrite an authored writeup.** Anything already in the owner's voice
   (punchy, leads with a hook, > ~160 chars, no "X is a Y" opening) is sacred —
   especially London. When unsure, leave it.
2. **Never create a duplicate spot.** Many "new" spots already exist under another
   id (`regency` vs `regency-cafe-westminster`). Check name + city against
   `data/spots.json` first and **enrich the existing id** instead.
3. **Source everything.** Corroborate each notable claim against a reliable source
   (Wikipedia, official site, reputable press, Historic England). **Frame folklore
   explicitly as legend** ("the story goes…", "said to…") — never assert it. If the
   facts are thin, **write short rather than invent**. Do not pad.

## Writeup spec (house voice)

- **Lead with the hook.** Never open "The X is a Y…".
- End on a short, punchy fragment — the house signature.
- **220–320 characters.** One tight paragraph. (Drafts drift long — keep it tight.)
- Straight ASCII `'` and `"`; **keep diacritics** (`São`, `Tōshō-gū`); no URLs,
  citations, or markdown in the text; **no `€`/`EUR`** (the catalogue uses neither).
- Match the existing register — see any London writeup for tone. Examples:
  - *"The Art Deco caff of every London film you've seen — Layer Cake's most famous
    scene was shot in this room… National treasure status, unofficially."*
  - *"Three concrete prongs rake at the sky outside Tempelhof — one for each air
    corridor the Allies were allowed into blockaded West Berlin… the 'hunger rake.'"*

## Adding a genuinely new spot

- Real coordinates **inside the city's `Ci` bbox** (the build enforces ±0.1°).
- Valid `c` (one of 44 category slugs in `ne`) and `city` (a `Ci` slug).
- No id or name collision within the city.
- **Bump `BASELINE.entries` in `build.js`** — the generated-count check is fatal,
  not a warning — and keep the count in `CLAUDE.md` in sync.

## Workflow & definition of done

1. Branch **fresh from `main`** (never from the old `claude/*` research branches —
   they sit on a stale, pre-de-branding bundle).
2. Edit `data/spots.json` only. For enrichment, the diff must touch **only `w`
   lines**.
3. `npm run build` **must pass** (validates category/city slugs, coords-in-bbox,
   duplicate ids/names, then re-runs the CLAUDE.md checks). It refuses to write
   `index.html` on any violation.
4. Commit **both** `data/spots.json` and the regenerated `index.html`.
5. **Batches of ~25–40 per branch/PR**, one city or theme each, so review stays
   meaningful and a bad fact is easy to catch.

## Known data-quality cleanup (separate from writeups)

- **Mis-tagged out-of-region spots**: listed buildings swept into the wrong city
  (Surrey → `london`, etc.). Worth a `tools/`-driven audit (distance-from-centre)
  to retag or prune. `tools/prune-junk.js` is the starting point.
- **Listed-building cottages** with generic names and no story: candidates for
  pruning so they stop diluting discovery.
