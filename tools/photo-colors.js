#!/usr/bin/env node
"use strict";
/*
 * tools/photo-colors.js — per-photo dominant (average) colour for every spot
 * thumbnail in data/photos.json, written to data/photocolors.json.
 *
 * build.js injects the colour as a per-spot `phc` field (only when the spot
 * also has `ph`), and the app paints it behind the thumbnail while the image
 * loads — the classic "blur-up" placeholder, at 7 bytes per spot and zero
 * runtime cost. Decoding uses the pre-installed Chromium (no PIL/ImageMagick
 * in the repo): images are fetched in Node at 250px (the smallest thumb width Wikimedia still renders) and averaged on a 4×4
 * canvas inside one headless page.
 *
 * Incremental: ids already present in photocolors.json are skipped, so
 * re-runs after a photo harvest only price the new ids.
 * Usage: node tools/photo-colors.js [--force]
 */
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "data", "photocolors.json");
const FORCE = process.argv.includes("--force");

const photos = (JSON.parse(fs.readFileSync(path.join(ROOT, "data", "photos.json"), "utf8")) || {}).photos || {};
let prev = {};
if (!FORCE && fs.existsSync(OUT)) {
  try { prev = (JSON.parse(fs.readFileSync(OUT, "utf8")) || {}).colors || {}; } catch (e) {}
}

// 250px Commons thumb for any photos.json URL (thumb URLs get their width
// swapped; direct file URLs get the /thumb/<hash>/<name>/250px-<name> form).
function thumb250(u) {
  if (u.includes("/thumb/")) return u.replace(/\/\d+px-([^/]+)$/, "/250px-$1");
  const m = u.match(/^(https:\/\/upload\.wikimedia\.org\/wikipedia\/[a-z_.-]+)\/([0-9a-f]\/[0-9a-f]{2})\/([^/]+)$/);
  if (m) return `${m[1]}/thumb/${m[2]}/${m[3]}/250px-${m[3]}`;
  return u;
}

(async () => {
  const todo = Object.entries(photos).filter(([id]) => !(id in prev));
  console.error(`[photo-colors] ${Object.keys(photos).length} photos, ${todo.length} to compute (${Object.keys(prev).length} cached)`);
  const colors = { ...prev };
  for (const id of Object.keys(colors)) if (!(id in photos)) delete colors[id]; // drop stale

  let chromium;
  for (const p of [path.join(ROOT, "node_modules", "playwright-core"), process.env.FL_PW || "", "playwright-core"]) {
    if (!p) continue;
    try { chromium = require(p).chromium; break; } catch (e) {}
  }
  if (!chromium) { console.error("playwright-core not found — set FL_PW to its directory"); process.exit(1); }
  const browser = await chromium.launch({ executablePath: process.env.FL_CHROME || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
  const page = await browser.newPage();

  let done = 0, fail = 0;
  const CONC = 4; // Wikimedia throttles bursts — stay polite, retry once
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const grab = async (url) => {
    for (let a = 0; a < 2; a++) {
      try {
        const r = await fetch(thumb250(url), { headers: { "User-Agent": "flaneur-photocolors/1.0 (personal app; kuba.berkowski@gmail.com)" } });
        if (!r.ok) throw new Error("HTTP " + r.status);
        const ct = r.headers.get("content-type") || "image/jpeg";
        const b = Buffer.from(await r.arrayBuffer());
        if (b.length > 400000) throw new Error("too big");
        return `data:${ct};base64,${b.toString("base64")}`;
      } catch (e) { if (a) throw e; await sleep(1200); }
    }
  };
  for (let i = 0; i < todo.length; i += 100) {
    const slice = todo.slice(i, i + 100);
    const fetched = [];
    for (let j = 0; j < slice.length; j += CONC) {
      await Promise.all(slice.slice(j, j + CONC).map(async ([id, url]) => {
        try { fetched.push({ id, d: await grab(url) }); } catch (e) { fail++; }
      }));
      await sleep(120);
    }
    const got = await page.evaluate(async (items) => {
      const out = {};
      for (const it of items) {
        try {
          const img = new Image();
          img.src = it.d;
          await img.decode();
          const c = document.createElement("canvas");
          c.width = 4; c.height = 4;
          const x = c.getContext("2d");
          x.drawImage(img, 0, 0, 4, 4);
          const p = x.getImageData(0, 0, 4, 4).data;
          let r = 0, g = 0, b = 0, n = 0;
          for (let k = 0; k < p.length; k += 4) { if (p[k + 3] < 200) continue; r += p[k]; g += p[k + 1]; b += p[k + 2]; n++; }
          if (!n) continue;
          const hex = (v) => Math.round(v / n).toString(16).padStart(2, "0");
          out[it.id] = hex(r) + hex(g) + hex(b);
        } catch (e) {}
      }
      return out;
    }, fetched);
    Object.assign(colors, got);
    done += Object.keys(got).length;
    console.error(`  ${Math.min(i + 100, todo.length)}/${todo.length} … ${done} coloured, ${fail} fetch-failed`);
  }
  await browser.close();
  fs.writeFileSync(OUT, JSON.stringify({ generated: new Date().toISOString(), colors }, null, 1) + "\n");
  console.error(`→ data/photocolors.json (${Object.keys(colors).length} colours)`);
})().catch((e) => { console.error(e); process.exit(1); });
