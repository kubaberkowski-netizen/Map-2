#!/usr/bin/env node

/**
 * Keep Capacitor-generated native project text deterministic.
 *
 * Capacitor and its platform templates occasionally emit CRLF endings, trailing
 * whitespace, or extra blank lines. Those differences are harmless to Xcode and
 * Gradle but fail the repository's strict `git diff --check` gate. Normalize
 * text only; binary assets, file permissions, and native structure stay intact.
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const TARGETS = ["android", "ios"];
// Capacitor owns each generated `public/` payload. Normalizing those files after
// `cap sync` mutates shipped third-party assets (and previously invalidated
// Leaflet's integrity hash), so only normalize native source/project text.
const SKIP_DIRS = new Set([".gradle", "build", "DerivedData", "Pods", "public"]);
const SKIP_EXTENSIONS = new Set([
  ".aab",
  ".aar",
  ".apk",
  ".class",
  ".dex",
  ".gif",
  ".ico",
  ".jar",
  ".jpeg",
  ".jpg",
  ".keystore",
  ".pdf",
  ".png",
  ".so",
  ".webp",
  ".zip",
]);

let changed = 0;

function normalizeFile(file) {
  if (SKIP_EXTENSIONS.has(path.extname(file).toLowerCase())) return;

  const input = fs.readFileSync(file);
  if (!input.length || input.includes(0)) return;

  const source = input.toString("utf8");
  const lines = source.split(/\r\n|\n|\r/).map((line) => line.replace(/[ \t]+$/g, ""));

  // Use LF everywhere, including gradlew.bat. Git treats the CR in added CRLF
  // lines as trailing whitespace, while Windows cmd accepts LF batch files.
  // Exactly one final line ending also avoids `new blank line at EOF`.
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  const output = (lines.length ? lines.join("\n") : "") + "\n";

  if (output !== source) {
    fs.writeFileSync(file, output);
    changed += 1;
    console.log(`normalized ${path.relative(ROOT, file)}`);
  }
}

function walk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.isFile()) normalizeFile(full);
  }
}

for (const target of TARGETS) walk(path.join(ROOT, target));
console.log(`✓ native text normalization complete (${changed} file${changed === 1 ? "" : "s"} changed)`);
