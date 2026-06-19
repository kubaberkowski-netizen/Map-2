# Flâneur — Functionality Review & Feature Roadmap

_Prepared from a deep read of `index.html` / `src/app.template.html`, `data/spots.json`,
`build.js`, `sw.js`, `privacy.html` and the `tools/` enrichment pipeline._
_Date: 2026-06-19._

---

## 1. What the app is today

Flâneur is a single-file React PWA that catalogues offbeat, storied places and sorts
them by distance from your live location. It ships as one self-contained `index.html`
(~4 MB, inline minified React bundle) served from GitHub Pages, with a hand-written
service worker (`sw.js`) for offline use and a static `privacy.html`.

It is a **client-only** app: all state lives in `localStorage` (via the `Ae`
wrapper, with a `window.storage` bridge hook for a possible native shell). There is
**no backend, no account, and no cross-device sync.** External calls are read-only and
optional: MapTiler (tiles), Geoapify (live "nearby places" scan), Wikipedia (reference
text + place thumbnails), and Open-Meteo (weather for "Today's Detour").

### Catalogue scale (the headline change since CLAUDE.md was written)

CLAUDE.md still describes **787 spots across 6 cities**. The live data has grown by
**~19×**:

- **15,322 spots across 71 cities** (`build.js` baseline is already updated to 15,322).
- Beyond London (996) and the original UK/EU cities, the catalogue now spans
  global metros: NYC (298), Chicago (307), LA (287), San Francisco (264), Tokyo (231),
  Seoul (220), Hong Kong (232), Singapore (224), Sydney (221), Melbourne (243),
  Buenos Aires (236), Mexico City (225), Toronto (228), Montreal (225), plus dozens of
  European cities (Berlin, Madrid, Rome, Vienna, Prague, Lisbon, Copenhagen, etc.).
- **44 categories** and **45 Worlds** (themed collections) unchanged.

### Feature inventory (everything that currently works)

**Discovery**
- Distance-sorted browse list, filtered to the active city (`Zc`).
- Category filter chips (multi-select, "select all" / reset), text search with clear.
- "Scan nearby" — live Geoapify lookup of cafés, bakeries, pubs etc. around you,
  de-duplicated against the curated set.
- **Today's Detour** — one weather-aware pick for the day ("a day for indoor corners" /
  "fine for a wander" / "wrap up — cosy picks"), with a "surprise me" mood selector
  (Caffeine, Macabre, Green & quiet, History, Music & screen, Bookish, etc.).

**Worlds (45 themed collections)** — e.g. Polish London, Music Pilgrimage, Secret Pubs,
Crime & the Macabre, Espionage, Lost Tube & Deep Shelters, Brutalist London, Queer Soho,
Matcha Mile, Natural Wine Crawl, Hidden Alleys, Greenwich Meridian. Each has live
membership matching plus optional curated `ids`, progress tracking, and a completion
trophy.

**Cities** — overview tab with a map + cards summarising spots/visited per city; picking
one re-centres the reference location and drives the geocoder, zone chips, share copy and
title. LIVE button auto-detects nearest city by bbox (snaps if >60 km away).

**Map** — Leaflet + MapTiler, tap-a-pin cards, your-location dot, dropped/pasted pins
(paste raw `lat,lng`), Google Maps directions hand-off.

**Walks**
- Auto-generated walks: pick a destination ("Walk to… Borough Market"), filter by
  category, get an ordered multi-stop route with distance/time/"to the start" estimates,
  reshuffle, drag-to-reorder, add/remove stops.
- Ad-hoc walk recording: start/pause/resume/edit/end, GPS trace drawn live, saved to
  Profile.
- Tours: structured stop-by-stop walks with "next stop", finish detection, completion.

**Tracking radar** — directional radar (150/300/600 m rings), compass heading rotation,
shows curated spots as blips, tap-to-open, add-while-tracking, "on your left/right" cues.

**Check-in** — GPS-gated check-in "on foot" (must be within ~50 m / accuracy-adjusted),
mark-visited, per-spot "visited on foot" state.

**Gamification**
- ~50 achievements across Milestones, Challenges, Collections, plus **Platinum** tier
  (London Laureate, The Knowledge, Marathon on Foot, Corner to Corner).
- Walking **streaks** with weekend grace + a banked **freeze** to cover a missed weekday.
- Profile stats: detours discovered, checked-in on foot, categories tasted, postcode
  districts, recorded walks.

**Sharing** — canvas-generated **postcards** (Today's Detour, a Walk recap, a Trophy
unlocked, a place card) saved as images; deep share links that open straight to a place;
"invite a fellow wanderer" copy.

**Platform** — installable PWA, offline app shell + stale-while-revalidate tile cache +
cache-first Leaflet (`sw.js`); runtime Wikipedia thumbnails per place; "Pics" button to
image-search a place; privacy page; optional "Suggest a place" / "Support Flâneur" footer
links (hidden unless `FORM_URL` / `DONATE_URL` are set).

---

## 2. Strengths

- **Genuinely differentiated discovery.** Distance-sorting + Worlds + Today's Detour is a
  far more characterful model than a generic "places near me" list.
- **Deep, cohesive game loop.** Streaks, freezes, on-foot check-ins, postcards and
  platinum achievements reinforce the core "go for a walk" behaviour rather than bolting
  on points for their own sake.
- **Robust offline-first engineering.** The service worker correctly separates the app
  shell from standalone pages, and the build pipeline (`build.js`) has real validation
  (category/city slug checks, bbox sanity checks, count baselines) that protects a
  white-screen-on-malformed-edit deployment.
- **Privacy-respectful by default.** No analytics, no accounts, no tracking; all data
  stays on-device. (`GAKEY` is the Geoapify key, not Google Analytics.)

---

## 3. Risks & gaps found during review

These are ordered by how much they undercut the product as it stands.

### 3.1 Writeup quality has been diluted — this is the most important finding
The single-author, owner's-voice writeups are described in CLAUDE.md as **"the entire
point of the product."** The data no longer reflects that:

- **Median writeup length is 41 characters; ~80% (12,321 / 15,322) are under 80
  characters**; 148 are empty. The commit history shows these were mass-generated from
  OSM tags / Wikidata / Wikipedia GeoSearch ("Enrich 2,223 placeholder descriptions",
  "Add street locations to 3,301 more placeholders", etc.).
- Net effect: the catalogue grew 19× in breadth but the thing that made it _Flâneur_
  rather than a POI dump has been thinned to machine stubs in the new cities.

**This is a strategic fork, not just a data-quality nit** (see roadmap Phase 0).

### 3.2 Stale source-of-truth documentation
CLAUDE.md still claims 787 spots / 6 cities and an "owner's voice everywhere" invariant
that the data contradicts. An AI session following CLAUDE.md literally would make wrong
assumptions (e.g. about baselines, about which cities exist). The guide needs to catch up
to 71 cities / 15,322 spots.

### 3.3 Privacy page is unpublished-ready
`privacy.html` still contains `[EFFECTIVE DATE]` and two `[YOUR EMAIL]` placeholders. With
a now-global audience hitting third-party services (MapTiler, Geoapify, Wikipedia,
Open-Meteo), this should be completed before any wider launch.

### 3.4 No cross-device persistence
All progress — visits, streaks, freezes, recorded walks, achievements — is in
`localStorage`. Clearing site data, switching devices, or a browser cache eviction wipes
everything. For an app whose entire reward loop is long-running streaks and collection
completion, this is the single biggest retention risk after writeup quality.

### 3.5 Per-city polish is uneven at 71 cities
Only ~5 cities have bespoke `zones`; the rest fall back to generic handling. The walk
route-drawing, zone chips and "neighbourhood" framing were tuned for London and don't yet
have equivalents in the new metros. Worlds are almost entirely London-specific (Queer
Soho, Camden Music Mile, Wapping Pirate Pubs…), so 70 cities have rich spots but no
themed collections to pull them together.

### 3.6 Bundle weight
`index.html` is ~4 MB because all 15,322 spots are inlined and shipped on first load even
though discovery only ever reads one city (`Zc`). Every visitor downloads Tokyo + Chicago
+ Buenos Aires to look at London. This is fine offline-first today but will not scale to
200+ cities, and it hurts first-paint on mobile data.

---

## 4. Roadmap

Phases are ordered so that each one is shippable on its own and de-risks the next. Effort
is rough (S = ≤1 session, M = a few sessions, L = a project).

### Phase 0 — Protect the core: writeup strategy (decide first) — **S to L**
Everything else is wasted if the catalogue reads like a POI dump. Pick a lane:
- **(a) Curate-down / tier the catalogue.** Keep the global breadth for _discovery_, but
  mark which spots have real owner writeups vs. machine stubs (e.g. a `wq` quality flag),
  and surface the authored ones first. _(S–M)_
- **(b) Author-in-the-loop enrichment.** Keep the auto-facts as a _draft_ layer the owner
  rewrites into voice, city by city, with a simple "needs voice" queue in `tools/`. _(L,
  ongoing)_
- **(c) Visibly separate the two voices** in the UI — "Jakub's note" vs. "Reference
  (Wikipedia/OSM)" — so the machine text never masquerades as the author's. _(S)_

Recommendation: do **(c) immediately** (cheap, honest, protects the brand) and **(a)** to
re-foreground the ~3,000 substantive writeups, then **(b)** as the long game.
_Also: refresh CLAUDE.md to match reality (71 cities / 15,322 spots) — half a session._

### Phase 1 — Don't lose people's progress: backup & restore — **M**
Without standing up a backend, add **export / import of all local state** (visits,
streaks, walks, achievements) as a single JSON file or a share-code, surfaced in Profile.
This is the 80/20 of "sync" with zero infra and no privacy regression. A real
account/sync layer (optional, end-to-end) can follow if demand appears, but export/import
removes the catastrophic-data-loss risk now.

### Phase 2 — Make the new cities first-class — **M to L**
- **Travel / city-switch mode**: explicit "I'm visiting Tokyo" that swaps city without
  needing GPS to be physically there (useful for trip planning before you fly).
- **Generalise zones** beyond the ~5 hand-tuned cities (derive neighbourhood chips from
  spot clustering or a per-city `zones` data pass).
- **Per-city Worlds**: at least 2–3 themed collections per major city so the Worlds tab
  isn't London-only. Many existing matchers (Coffee Crawl, Brutalist, Markets, Cemeteries)
  are city-agnostic and just need the membership scoped per city.

### Phase 3 — Trip & multi-day planning — **M**
The walk builder is strong for a single outing. The global catalogue invites a level up:
- Save a city as a **trip** with multiple planned walks across days.
- "Plan around an anchor" (hotel/Airbnb) and a time budget.
- Offline pre-download of a city's tiles + spots for a trip (ties into Phase 6).

### Phase 4 — Social proof & light UGC — **M**
Currently sharing is one-directional (postcards/links out). Low-risk additions:
- **Personal notes / private journal** per spot (stays local, exports with Phase 1).
- **Photo attach** to a check-in (local only), shown on the postcard.
- Optional **"suggest a place / correction"** flow wired to the existing `FORM_URL` hook
  (already supported, just unset).

### Phase 5 — Smarter recommendations — **M**
- "More like this" from a spot you loved (category + World adjacency + distance).
- Mood/weather/time-of-day blended Today's Detour (weather signal already exists; add
  time-of-day and "what you haven't visited" weighting).
- A gentle "you're 200 m from an unvisited [World] spot" nudge while tracking.

### Phase 6 — Performance & scale to 200+ cities — **L**
- **Split the catalogue by city** so first load ships only the active city (plus a tiny
  index for the Cities tab); lazy-load others on switch. This keeps the offline-first
  guarantee per-city while cutting first-paint payload dramatically.
- This is a build-pipeline change (`build.js` emitting per-city chunks) and a small boot
  change; it pays for itself once the catalogue keeps growing.

### Phase 7 — Native shell polish — **M**
The `window.storage` bridge and PWA install path suggest a native wrapper is plausible.
If pursued: re-confirm the tip/donation framing against App Store IAP rules (CLAUDE.md
already flags this), wire haptics for check-ins, and use native geofencing for the
"passing nearby" nudge so it works backgrounded.

---

## 5. Suggested near-term sequence

1. **Phase 0(c)** — visibly separate authored vs. reference text. _(this week)_
2. **Refresh CLAUDE.md** to 71 cities / 15,322 spots and the new writeup reality.
3. **Fill `privacy.html`** placeholders.
4. **Phase 1** — export/import of local progress.
5. **Phase 0(a)** — quality-tier the catalogue and foreground authored writeups.

Items 1–3 are each well under a session and remove the most embarrassing/risky gaps;
item 4 protects users' months-long streaks; item 5 restores the product's soul at scale.
