#!/usr/bin/env node

/**
 * Assemble the static web payload consumed by Capacitor.
 *
 * Flâneur's web build intentionally emits into the repository root. Capacitor
 * expects a dedicated webDir, so this script copies only deployable runtime
 * assets into native-web/ and leaves source, research data, and tooling out of
 * the native application bundle.
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "native-web");

function exists(rel) {
  return fs.existsSync(path.join(ROOT, rel));
}

function copyFile(rel) {
  const src = path.join(ROOT, rel);
  const dst = path.join(OUT, rel);
  if (!fs.existsSync(src) || !fs.statSync(src).isFile()) return false;
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  return true;
}

function copyDir(rel) {
  const src = path.join(ROOT, rel);
  if (!fs.existsSync(src) || !fs.statSync(src).isDirectory()) return;
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const child = path.join(rel, entry.name);
    if (entry.isDirectory()) copyDir(child);
    else if (entry.isFile()) copyFile(child);
  }
}

function verifyRelativeCssAssets() {
  const cssFiles = [];
  (function findCss(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) findCss(absolute);
      else if (entry.isFile() && entry.name.endsWith(".css")) cssFiles.push(absolute);
    }
  })(OUT);

  for (const cssFile of cssFiles) {
    const css = fs.readFileSync(cssFile, "utf8");
    const pattern = /url\(\s*["']?([^"')]+)["']?\s*\)/gi;
    let match;
    while ((match = pattern.exec(css))) {
      const reference = match[1].trim().split(/[?#]/, 1)[0];
      if (!reference || /^(?:https?:|data:|blob:|\/\/|#)/i.test(reference)) continue;
      const target = path.resolve(path.dirname(cssFile), reference);
      if (!target.startsWith(`${OUT}${path.sep}`) || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
        const owner = path.relative(OUT, cssFile);
        throw new Error(`native CSS asset is missing: ${owner} -> ${reference}`);
      }
    }
  }
}

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const required = [
  "index.html",
  "privacy.html",
  "terms.html",
  "c.html",
  "u.html",
  "discover.html",
  "manifest.webmanifest",
];
for (const rel of required) {
  if (!copyFile(rel)) throw new Error(`native bundle is missing required file: ${rel}`);
}

// Fonts and app icons are referenced by the generated HTML and manifest.
copyDir("fonts");
// CSS can reference sibling assets that are not present in index.html. Copy the
// complete vendored map runtimes so Leaflet's default markers/layers survive
// Capacitor packaging, then validate every relative CSS URL below.
copyDir("vendor/leaflet");
copyDir("vendor/leaflet-markercluster");
for (const name of fs.readdirSync(ROOT)) {
  if (/^icon-.*\.png$/i.test(name)) copyFile(name);
  if (/^(?:spots|fixtures)(?:\.[a-z]+)?\.[0-9a-f]+\.js$/i.test(name)) copyFile(name);
}

// Copy any additional same-origin assets linked directly from the app shell.
const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const refs = new Set();
const refPatterns = [
  /(?:src|href)=["'](?:\.\/)?([^"'?#]+)["']/gi,
  /url\(\s*["']?(?:\.\/)?([^"')?#]+)["']?\s*\)/gi,
];
for (const pattern of refPatterns) {
  let match;
  while ((match = pattern.exec(html))) {
    const rel = match[1];
    if (!rel || /^(?:https?:|data:|blob:|\/\/|#)/i.test(rel)) continue;
    refs.add(rel.replace(/^\/+/, ""));
  }
}
for (const rel of refs) {
  if (exists(rel)) {
    const stat = fs.statSync(path.join(ROOT, rel));
    if (stat.isDirectory()) copyDir(rel);
    else copyFile(rel);
  }
}

// Service workers are useful for the PWA but should not own the Capacitor
// WebView lifecycle. Remove only the known registration block from the native
// copy, and fail loudly if a future source edit changes that contract.
const nativeIndex = path.join(OUT, "index.html");
let nativeHtml = fs.readFileSync(nativeIndex, "utf8");
const serviceWorkerRegistration = /<script>if\("serviceWorker"in navigator\)[\s\S]*?<\/script>/;
if (!serviceWorkerRegistration.test(nativeHtml)) {
  throw new Error("native bundle could not locate the service-worker registration block");
}
nativeHtml = nativeHtml.replace(
  serviceWorkerRegistration,
  '<script>window.flActivateNative?window.flActivateNative():(window.__FLANEUR_NATIVE__=true,document.documentElement.setAttribute("data-fl-native","1"));</script>'
);
if (!nativeHtml.includes("window.__FLANEUR_NATIVE__=true")) {
  throw new Error("native runtime marker was not written");
}
fs.writeFileSync(nativeIndex, nativeHtml);
verifyRelativeCssAssets();

const copied = [];
(function walk(dir, prefix = "") {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = path.join(prefix, entry.name);
    if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
    else copied.push(rel);
  }
})(OUT);

console.log(`✓ native web bundle ready: ${copied.length} files in native-web/`);
