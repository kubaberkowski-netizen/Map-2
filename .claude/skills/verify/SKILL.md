---
name: verify
description: Build, serve, and drive Flâneur headlessly to verify app/map changes end-to-end.
---

# Verifying Flâneur changes

Static app — no dev server. Recipe that works in the remote sandbox:

1. `npm run build` (validates + regenerates `index.html` / `spots.<hash>.js`).
2. Serve the repo root: `python3 -m http.server 8123 &` (SW/scope-safe, sidecar included).
3. Drive with `playwright-core` (install in the scratchpad, NOT the repo) using the
   pre-installed Chromium: `executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'`.

## Gotchas (each cost real time)

- **The sandbox proxy resets browser TLS** (`ERR_CONNECTION_RESET` on every external
  request from Chromium, while `curl` works). Do NOT fight it: `curl` the CDN assets
  (leaflet 1.9.4 js+css, leaflet.markercluster 1.5.3 js+css from unpkg) to a local dir,
  then `page.route(/^https?:\/\/(?!localhost)/, ...)` — `fulfill` those four from disk
  (SRI passes, they're the genuine files), `abort` everything else. Tiles/fonts/supabase
  failing is fine; markers and clusters render without them.
- **Onboarding overlay** (`.onb`) blocks all clicks on first visit — dismiss via `.onbx`.
- Map view: click the `Map` tab button (exact text). Wait for `.leaflet-container`,
  then give the CDN loader + markers ~5s.
- Marker DOM to assert on: `.mk` = individual spot pins, `.cluspin` = cluster icons,
  `.org` = origin marker (it overlaps map center — use `dispatchEvent('click')`, not
  `click()`, for elements near center).
- Grant geolocation in the context (e.g. `{latitude: 51.5138, longitude: -0.0984}`)
  to get a deterministic London boot.
- To open a marker popup, find a `.mk` whose `getBoundingClientRect()` centre is
  inside the map area and `page.mouse.click(x, y)` it — `dispatchEvent('click')` on
  the first `.mk` in DOM order does not reliably reach Leaflet's delegated handler.
- To prove marker diffing/no-rebuild, don't tag DOM elements (markercluster's
  `removeOutsideVisibleBounds` recreates them on pan) — monkey-patch `window.L.marker`
  with a counter and assert on creations instead.
- Zooming: main map has no zoom control; use `page.mouse.wheel(0, ±400)` over the map.
  Current zoom is readable from tile img URLs only when tiles load (they usually don't
  here — count `.cluspin`/`.mk` at each step instead).
