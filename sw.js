/* Flâneur service worker — offline app shell + tile/asset caching */
const SHELL = "flaneur-shell-v69";
const TILES = "flaneur-tiles-v2";
const TILE_MAX = 350;

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(SHELL).then((c) => c.addAll(["./", "./index.html", "./privacy.html"]))
      .then(() => self.skipWaiting()).catch(() => {})
  );
});
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((ks) =>
      Promise.all(ks.map((k) => (k === SHELL || k === TILES ? null : caches.delete(k))))
    ).then(() => self.clients.claim())
  );
});
function trim(name, max) {
  caches.open(name).then((c) =>
    c.keys().then((ks) => { for (let i = 0; i < ks.length - max; i++) c.delete(ks[i]); })
  );
}
function isShellNav(url) {
  if (url.origin !== self.location.origin) return false;
  return url.pathname.endsWith("/") || url.pathname.endsWith("/index.html");
}
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  let url; try { url = new URL(req.url); } catch (_) { return; }

  if (req.mode === "navigate") {
    if (isShellNav(url)) {
      // Stale-while-revalidate the app shell: serve the cached index.html
      // instantly (fast cold starts on the ~4 MB file) and refresh it in the
      // background; fall back to the network when nothing is cached yet.
      e.respondWith(caches.open(SHELL).then(async (c) => {
        const hit = await c.match("./index.html");
        const net = fetch(req).then((res) => {
          if (res && res.ok) c.put("./index.html", res.clone());
          return res;
        }).catch(() => hit || caches.match("./"));
        return hit || net;
      }));
      return;
    }
    if (url.origin === self.location.origin) {
      e.respondWith(
        fetch(req).then((res) => {
          if (res && res.ok) caches.open(SHELL).then((c) => c.put(req, res.clone())).catch(() => {});
          return res;
        }).catch(() => caches.match(req).then((r) => r || caches.match("./index.html")))
      );
      return;
    }
    return;
  }
  if (/(^|\.)tile\.openstreetmap\.org$/.test(url.hostname) || /basemaps\.cartocdn\.com$/.test(url.hostname) || (url.hostname === "api.maptiler.com" && /^\/maps\//.test(url.pathname))) {
    e.respondWith(caches.open(TILES).then(async (c) => {
      const hit = await c.match(req);
      const net = fetch(req).then((res) => {
        if (res && (res.ok || res.type === "opaque")) { c.put(req, res.clone()); trim(TILES, TILE_MAX); }
        return res;
      }).catch(() => hit);
      return hit || net;
    }));
    return;
  }
  if (url.hostname === "flagcdn.com") {
    e.respondWith(caches.open(SHELL).then(async (c) => { const hit = await c.match(req); if (hit) return hit; try { const res = await fetch(req); if (res && (res.ok || res.type === "opaque")) c.put(req, res.clone()); return res; } catch (_) { return hit || Response.error(); } }));
    return;
  }
  if (url.hostname === "unpkg.com") {
    e.respondWith(caches.open(SHELL).then(async (c) => {
      const hit = await c.match(req);
      if (hit) return hit;
      try { const res = await fetch(req); if (res && (res.ok || res.type === "opaque")) c.put(req, res.clone()); return res; }
      catch (_) { return hit || Response.error(); }
    }));
    return;
  }
  if (url.origin === self.location.origin) {
    e.respondWith(caches.match(req).then((r) => r || fetch(req).then((res) => {
      if (res && res.ok && res.type === "basic") caches.open(SHELL).then((c) => c.put(req, res.clone()));
      return res;
    }).catch(() => r)));
    return;
  }
});
