// London launch triage (co-founder plan §4.1 — the content bar).
// Buckets London's spots into ship / polish / hide by the wq quality flag and
// writeup length, ranks the polish set by how likely it is to SURFACE in a
// launch flow (so ~40 founder-hours of authoring hit the most-seen spots first),
// and emits both a machine list (data/london-triage.json) and a human worklist
// (scripts/london-polish-worklist.md). Read-only over the catalogue; no build.
//
//   ship   = wq "a" (authored/verified) — launch as-is
//   polish = wq "d" (machine draft) — AI-draft-then-human-edit for the voice
//   hide   = wq "m" (thin stub) or <80 chars — keep out of launch flows until polished
import fs from "node:fs";

const spots = JSON.parse(fs.readFileSync(new URL("../data/spots.json", import.meta.url)));
let flags = {};
try { flags = JSON.parse(fs.readFileSync(new URL("../data/quality.json", import.meta.url))).flags || {}; } catch {}

const CENTRE = { lat: 51.5074, lng: -0.1278 }; // Charing Cross-ish
const km = (a, b) => {
  const R = 6371, p = Math.PI / 180, dla = (b.lat - a.lat) * p, dlo = (b.lng - a.lng) * p;
  const s = Math.sin(dla / 2) ** 2 + Math.cos(a.lat * p) * Math.cos(b.lat * p) * Math.sin(dlo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
};
// Categories most likely to be dealt as a detour / headline a World (prominence weight).
const STORIED = new Set(["history", "death", "literary", "streetart", "ghostsign", "follies", "roman", "medieval", "espionage", "plaque", "brutalism", "artdeco", "maritime", "canals", "almshouses"]);

const lon = spots.filter((z) => z.city === "london");
function bucketOf(z) {
  const f = flags[z.id];
  const len = (z.w || "").trim().length;
  if (f === "a" || f === "v") return "ship";
  if (len < 80 || f === "m") return "hide";
  return "polish"; // "d" (machine draft) or unflagged-but-substantial
}
// Surfacing priority: central + storied category + has area/postcode context.
function prominence(z) {
  let p = 0;
  const d = (typeof z.lat === "number") ? km({ lat: z.lat, lng: z.lng }, CENTRE) : 99;
  p += Math.max(0, 12 - d);            // up to +12 for central
  if (STORIED.has(z.c)) p += 6;        // storied categories headline detours/Worlds
  if (z.a) p += 1;
  if (z.pc) p += 1;
  return Math.round(p * 10) / 10;
}

const buckets = { ship: [], polish: [], hide: [] };
for (const z of lon) buckets[bucketOf(z)].push(z);
buckets.polish.sort((a, b) => prominence(b) - prominence(a));
buckets.hide.sort((a, b) => prominence(b) - prominence(a));

const est = (n) => `${Math.round((n * 6) / 60)}–${Math.round((n * 8) / 60)}h`;
console.log(`London launch triage — ${lon.length} spots`);
console.log(`  ship   (wq a, launch as-is): ${buckets.ship.length}`);
console.log(`  polish (author for the voice): ${buckets.polish.length}  → ~${est(buckets.polish.length)} founder-time`);
console.log(`  hide   (keep out of launch flows): ${buckets.hide.length}`);

// Machine list
const out = {
  generated_note: "London launch triage — regenerate with node scripts/london-triage.mjs",
  counts: { ship: buckets.ship.length, polish: buckets.polish.length, hide: buckets.hide.length },
  polish: buckets.polish.map((z) => ({ id: z.id, n: z.n, a: z.a, pc: z.pc, c: z.c, len: (z.w || "").trim().length, prom: prominence(z) })),
  hide: buckets.hide.map((z) => ({ id: z.id, n: z.n, a: z.a, c: z.c, len: (z.w || "").trim().length })),
};
fs.writeFileSync(new URL("../data/london-triage.json", import.meta.url), JSON.stringify(out, null, 1));

// Human worklist (the founder works top-down; most-surfaced first)
let md = `# London polish worklist (co-founder plan §4.1)\n\n`;
md += `Author these for the owner's voice before a London launch — most-surfaced first. `;
md += `Ship = ${buckets.ship.length} (wq \`a\`, ready) · Polish = ${buckets.polish.length} (~${est(buckets.polish.length)}) · Hide = ${buckets.hide.length}.\n\n`;
md += `> Agents draft, you edit — never the reverse, for the voice.\n\n`;
md += `| # | Prom | Spot | Area | Cat | Len | id |\n|--:|--:|---|---|---|--:|---|\n`;
buckets.polish.forEach((z, i) => {
  md += `| ${i + 1} | ${prominence(z)} | ${z.n} | ${z.a || ""} | ${z.c} | ${(z.w || "").trim().length} | \`${z.id}\` |\n`;
});
fs.writeFileSync(new URL("./london-polish-worklist.md", import.meta.url), md);
console.log(`\nWrote data/london-triage.json and scripts/london-polish-worklist.md`);
console.log(`Top of the polish queue:`);
buckets.polish.slice(0, 8).forEach((z, i) => console.log(`  ${i + 1}. [${prominence(z)}] ${z.n} · ${z.a || ""} · ${z.c} (${(z.w || "").trim().length} chars)`));
