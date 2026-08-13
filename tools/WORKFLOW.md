# Flâneur — city expansion & cleanup workflow

The operating manual for the two tracks: **(A) clean up the junk** and **(B) bring
every city up to the London blueprint** (more, better, authentic spots + house-voice
writeups). Read `CLAUDE.md` (build rules) and `RESEARCH-BRIEF.md` (writeup spec) first —
this is the orchestration layer that sits on top of them.

Everything is **city-at-a-time**, **batched (25–40)**, and gated by `npm run build`.
Nothing reaches the live app without passing through review.

---

## The provenance flag (foundation — read this first)

`data/quality.json` is the committed source of truth for "what is what". One flag per
spot:

| flag | meaning | who sets it |
|---|---|---|
| `a` | **authored** — the owner's voice, sacred, never overwrite | heuristic seed + human |
| `v` | verified-sourced (optional finer grade of `a`) | human |
| `d` | **machine draft, pending review** — NOT your voice yet | `write-up.js --apply` |
| `m` | thin machine stub — fair game to enrich | default |

```bash
node tools/quality.js            # (re)generate — MONOTONIC: never demotes a/v/d
node tools/quality.js --stats    # per-city authored / draft / stub / notable table
node tools/quality.js --promote  # after review: promote all drafts d → a
node tools/quality.js --set a <id>…   # hand-correct a flag
```

Regeneration is safe to run any time: `a`/`v`/`d` are sticky (human-owned); only `m`
spots get re-seeded. This replaces the old length-guessing and the lost
`/tmp/orig*.json` files. **Every other tool reads this** to know what's sacred.

---

## Track A — clean up the junk (city by city)

`prune-junk.js` already removed the obvious name-junk; the live tool is the scored
audit, which protects anything `a`/`v`/notable and only proposes actions on the rest.

```bash
node tools/audit-city.js --all              # league: prune/retag counts per city
node tools/audit-city.js manchester         # worst-scored + proposal JSON
#   → edit tools/candidates/audit-manchester.json: set each "action"
#     to "" (keep), "prune", or "retag:<city>"
node tools/audit-city.js manchester --apply # enacts approved, non-protected actions
#   → if anything was pruned: bump build.js BASELINE.entries, then npm run build
```

What it scores on: notable/authored backing (keep), generic type-word names, chains,
war-memorial/mundane-Wikidata noise, duplicate names, and **geofence outliers**
(distance from the city centre relative to the city's own bbox; proposes `retag:<city>`
when another city's bbox claims the point better). Work worst-first off the `--all` table.

---

## Track B — the expansion assembly line

Four stages, each a tool (or a subagent fan-out). The key idea: **fact-gathering and
prose are separate** so "source everything / never invent" stays enforceable.

```
1 blueprint  →  2 source  →  3 research  →  4 write  →  review → build
  (gap map)     (candidates)  (dossiers)    (drafts)
                    │
   already in app ──┤── enrich existing stub: dossier.js → write-up.js
                    └── NOT in app yet:       discovery subagent → add-spots.js  (Stage 2b)
```

### Stage 1 — blueprint (what's missing)

```bash
node tools/blueprint.js                 # league table: every city vs London
node tools/blueprint.js rome            # full gap report for one city
```

Gives the **notable-but-weak pool** (prime writeup targets) and the **category gaps**
(London's mix scaled to the city → what to go source). Note: some categories are
London-specific (`polish`, `pieandmash`, `matcha`, `pop`) — ignore those rows; act on
the structural ones (`food`, `green`, `music`, `film`, `coffee`, `pub`…).

### Stage 2 — source new candidates

Existing spine (OSM/Wikidata) + the discovery layer that finds **local legends** —
the thousands-of-reviews places OSM/Wikidata miss:

```bash
node tools/find-spots.js --city rome --source overpass --broad   # on-theme OSM
node tools/find-spots.js --city rome --source overpass --profile landmarktrees
node tools/find-spots.js --city rome --source overpass --profile steps
node tools/find-spots.js --city rome --source overpass --profile footbridges
node tools/find-spots.js --city rome --source wikidata
node tools/find-spots.js --city rome --source googlePlaces \
      --query "famous trattoria" --minReviews 2000               # needs GOOGLE_PLACES_KEY
node tools/find-spots.js --city rome --source reddit --sub rome \
      --query "hidden OR underrated OR institution"               # needs ANTHROPIC_API_KEY
node tools/find-spots.js --emit rome     # paste-ready rows (c filled, w blank) → data/spots.json
```

All sources flow through the same **geocode → bbox-validate → dedupe** path
(`model.js`), so a candidate that survives won't break the build and won't duplicate an
existing spot. Fill each `c`, leave `w` blank, paste in, `npm run build`. **Bump
`BASELINE.entries`** when the count grows.

> Sourcing priorities for "authentic local": Google Places (review-count signal) +
> the city's **native subreddit / local-language forums** via `reddit`/`pullpush` +
> `claudeExtract`. Treat TikTok/YouTube (via `apify` + `claudeExtract`) as flavour, not
> spine. Honour each source's ToS — keep it personal, prefer official APIs (see README).

#### Stage 2b — discovery by subagent (no keys; capture what's NOT in the app yet)

The keyed sources above need network/secrets. When those aren't available, a **discovery
subagent** is the zero-key alternative — and it's how you capture write-up-worthy places
the catalogue is simply *missing*. Brief one agent with: the city's existing spot names
(so it avoids duplicates), the **live category slugs**, and the city **bbox**. Ask it to
return ~7 new offbeat/storied places as rows with `{n, a, c, lat, lng, hook, facts,
sources, confidence}` — real coordinates inside the bbox, cited. It writes
`research/new/<city>.json`.

```bash
node tools/add-spots.js edinburgh --dry   # validate (slug/bbox/coords) + dedupe report
node tools/add-spots.js edinburgh         # append the valid, non-duplicate rows
#   → assigns ids, bumps build.js BASELINE.entries, flags each new spot "d"

# Object dossiers can be applied in bounded, restartable waves:
node tools/add-spots.js london --file research/run.json --key included --offset 0 --limit 25 --dry
node tools/add-spots.js london --file research/run.json --key included --offset 0 --limit 25
# then repeat at --offset 25, 50, ... (`--limit` is the wave size)
npm run build
```

For a research run spanning several categories or cities, audit all dossiers as one
set before registering cities or importing any wave:

```bash
node tools/audit-research-bundle.js research/run-hills.json research/run-steps.json research/run-shops.json
```

The bundle audit enforces the 19/25 score and story/walkability floors, all-high
confidence, two useful sources including an official/manager/first-party source,
live category and city semantics, query shape, aliases, external IDs, and global
catalogue plus candidate-to-candidate proximity. Unknown city slugs are reported as
registry gaps; every other failure is blocking. In dense catalogues, candidate pairs
under 30 m are presumed duplicates. Pairs from 30–119 m need a named, written
`dedupe.internal_neighbours` distinction on either row. A raw-in-bbox city assignment
may override a broader overlapping `region:true` inference with a warning; ordinary
city/city conflicts and out-of-bbox points remain failures.

When a run proposes a new category, record an explicit include/exclude contract in
the dossier before registering the slug. The Paris signature pass established three
reusable object classes:

- `arcades`: named public covered commercial passages whose walk-through route and
  surviving structure are the experience; exclude malls, ordinary corridors and
  private/event-only galleries.
- `streetfurniture`: individually distinctive civic objects with a recurring public
  function and a first/last/protected/custom provenance; exclude generic serial
  benches, lamps, kiosks and station interiors.
- `historicshopfronts`: intact fitted former-trade frontages visible from public
  pavement; exclude active shops selected for their stock, generic old fronts and
  painted advertisements (`ghostsign`).
- `artnouveau`: complete, individually documented street-facing compositions in
  Art Nouveau or a direct regional equivalent; exclude token motifs, interior-only
  decoration, serial civic objects and living-use places with a more specific type.

New style, retail or civic-object categories remain editorial by default. Only
`arcades` has a conservative automatic mapping: a named pedestrian/footway feature
tagged `covered=yes` or `tunnel=building_passage`. Every candidate still needs the
normal source, access, coordinate and dedupe review.

`add-spots.js` runs each discovered row through the **same gates build.js enforces** and
the same dedupe as the finder, so a hallucinated coordinate or a place that already exists
is rejected, not shipped. New spots can carry a writeup already (write it in Stage 4 from
the same facts) or land with `w:""` and flow through the normal enrichment like any stub.
**Coordinates from an LLM are the risk** — the bbox check catches gross errors, but
spot-check the pins on a map before promoting `d`→`a`.

For dossier objects, `--key <name>` selects an array such as `included` or
`candidates`; omit it for a top-level array. `--offset` is zero-based and `--limit`
must be a positive integer. The positional city must be live and supplies only the
fallback city/name for rows that omit `city`; explicit per-row city slugs are kept.
Always run the exact wave with `--dry` before applying it.

If those rows use new audited city/area slugs, register them first from the QA plan:

```bash
node tools/add-cities.js research/city-registry-plan.json --dry
node tools/add-cities.js research/city-registry-plan.json
```

`add-cities.js` reads
`recommendation.preserving_dossier_city_semantics.proposed_entries`, refuses any id
already present in `Ci` or `flCO`, appends the `Ci` entries and country mappings, adds
optional country flags, and parses the edited main script before writing. A reviewed
plan may also provide `bbox_updates:[{id,bbox}]` for existing, semantically correct
city/metro groupings; the tool refuses unknown ids, malformed boxes and attempts to
update a newly proposed id in the same plan. It changes `src/app.template.html` only;
follow it with `npm run build`. Use `region:1` only for genuine broad areas, not as a
shortcut around the normal city bbox gate.

### Stage 3 — research into dossiers (the fan-out)

A dossier is **sourced facts, not prose** (`research/dossiers/<city>.json`). Generate
blank templates for the writeup pool, then fill them:

```bash
node tools/dossier.js template rome --limit 40   # → research/dossiers/rome.todo.json
node tools/dossier.js validate rome              # check facts+sources present
```

**This is where Claude Code subagents fan out.** Dispatch one researcher per ~25-spot
batch with a brief like:

> _For each spot in `research/dossiers/rome.todo.json`, use WebSearch/WebFetch
> (Wikipedia, official sites, reputable press, local-language sources) to gather 2–5
> atomic, checkable facts and at least one source URL each. Frame folklore as legend.
> If facts are thin, say so (`confidence:"thin"`) — do not pad. Fill `facts`, `sources`,
> `hook`, `legend`, `confidence`. **Do not write the `w` field.** Output the completed
> dossier JSON._

Rename `rome.todo.json` → `rome.json` when filled. Running many researchers in parallel
is the throughput lever.

### Stage 4 — write (house voice)

```bash
node tools/write-up.js rome --dry     # inspect the exact prompt (real London exemplars)
node tools/write-up.js rome           # → research/drafts/rome.json (flags spec issues)
#   review/edit the drafts
node tools/write-up.js rome --apply   # writes into data/spots.json, marks ids "d"
node tools/quality.js --promote       # after YOU approve the diff: d → a
npm run build
```

The writer is few-shot-primed on real **authored London** writeups, grounded **only** in
the dossier facts, and validates each draft against the spec (length, ASCII quotes, no
URLs/€, no gazetteer opener). Drafts land as `d` — **never silently your voice**. You
read the diff, then `--promote` the good ones.

---

## Definition of done (per city/batch)

1. Branch fresh; one city or theme; **25–40 spots**.
2. `data/spots.json` diff is intentional: enrichment touches only `w`; new spots are
   valid (category/city slug, in-bbox, no dup) and `BASELINE.entries` is bumped.
3. `node tools/quality.js` regenerated; drafts reviewed and `--promote`d (or left `d`).
4. `npm run build` passes (it re-runs the CLAUDE.md checks and refuses on any miss).
5. Commit **both** `data/spots.json` and the regenerated `index.html` (+ `quality.json`).

## Keys & egress (what needs what)

| capability | needs | notes |
|---|---|---|
| audit / blueprint / quality / dossier templates | nothing | pure local, runs offline |
| OSM / Wikidata / Reddit sourcing | network egress | free; hosts in `README.md` |
| Google Places sourcing | `GOOGLE_PLACES_KEY` + egress | bills per call |
| Reddit→rows, writeups | `ANTHROPIC_API_KEY` + `@anthropic-ai/sdk` | SDK not a project dep |

This sandbox blocks egress by default — open the hosts in the environment's network
policy before running the networked stages.
