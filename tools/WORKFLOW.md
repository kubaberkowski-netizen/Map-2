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
