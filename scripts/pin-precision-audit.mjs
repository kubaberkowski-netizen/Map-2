// Pin precision audit — flags catalogue entries whose stored coordinates are too coarse to
// place a pin accurately. Coordinate precision is inferred from decimal places of lat/lng:
//   5 dp ~ 1 m · 4 dp ~ 11 m · 3 dp ~ 55 m · 2 dp ~ 550 m · <=1 dp ~ 5 km+.
// Anything at <= 3 dp on either axis is "a bit off"; <= 2 dp is a genuinely wrong pin.
// Read-only over data/spots.json. Writes data/pin-precision-audit.json (worst first) — a worklist
// for the re-geocoding pass. No catalogue mutation, no build.
import fs from "node:fs";

const spots = JSON.parse(fs.readFileSync(new URL("../data/spots.json", import.meta.url)));
const dp = (x) => { const s = String(x); const i = s.indexOf("."); return i < 0 ? 0 : s.length - i - 1; };
// worst-case metres implied by the coarser of the two axes
const M = [11100, 1110, 111, 55, 11, 1, 1];
const worst = (z) => M[Math.min(dp(z.lat), dp(z.lng))] ?? 1;

const rows = spots
  .map((z) => ({ id: z.id, n: z.n, a: z.a, pc: z.pc, c: z.c, city: z.city, q: z.q, lat: z.lat, lng: z.lng,
                 latdp: dp(z.lat), lngdp: dp(z.lng), mindp: Math.min(dp(z.lat), dp(z.lng)), err_m: worst(z) }))
  .filter((r) => r.mindp <= 3)
  .sort((a, b) => a.mindp - b.mindp || b.err_m - a.err_m);

const byCity = {};
for (const r of rows) byCity[r.city] = (byCity[r.city] || 0) + 1;
const buckets = { "<=1dp (>1km)": 0, "2dp (~500m)": 0, "3dp (~55m)": 0 };
for (const r of rows) buckets[r.mindp <= 1 ? "<=1dp (>1km)" : r.mindp === 2 ? "2dp (~500m)" : "3dp (~55m)"]++;

console.log(`Pin precision audit — ${spots.length} spots`);
console.log(`  imprecise (<=3dp on an axis): ${rows.length} (${(100 * rows.length / spots.length).toFixed(1)}%)`);
for (const [k, v] of Object.entries(buckets)) console.log(`    ${k}: ${v}`);
console.log(`  worst offenders:`);
rows.slice(0, 12).forEach((r) => console.log(`    ~${r.err_m}m  ${r.n} · ${r.a || ""} · ${r.pc || ""} (${r.city}) [${r.lat},${r.lng}]`));

fs.writeFileSync(new URL("../data/pin-precision-audit.json", import.meta.url), JSON.stringify({
  generated_note: "regenerate with node scripts/pin-precision-audit.mjs",
  total: spots.length, imprecise: rows.length, buckets, by_city: byCity, rows,
}, null, 1));
console.log(`\nWrote data/pin-precision-audit.json (${rows.length} rows, worst first)`);
