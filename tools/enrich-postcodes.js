#!/usr/bin/env node
// Backfill empty `pc` (postcode) for London spots by reverse-geocoding their
// coordinates with the free postcodes.io API, storing the OUTWARD code only
// (e.g. "W10") to match the existing majority format and the district-based
// "Postcode districts" achievements. Non-London cities are skipped (UK-only API).
//
//   node tools/enrich-postcodes.js          # write changes
//   node tools/enrich-postcodes.js --dry    # report only, no write
'use strict';
const fs = require('fs');
const path = require('path');

const DRY = process.argv.includes('--dry');
const SPOTS = path.join(__dirname, '..', 'data', 'spots.json');
const API = 'https://api.postcodes.io/postcodes';
const BATCH = 100; // postcodes.io bulk reverse-geocode limit

const outward = (pc) => String(pc).trim().split(/\s+/)[0].toUpperCase();

async function reverse(batch) {
  const body = {
    geolocations: batch.map((s) => ({
      longitude: s.lng, latitude: s.lat, radius: 2000, limit: 1,
    })),
  };
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`postcodes.io ${res.status}`);
  const json = await res.json();
  return json.result || [];
}

(async () => {
  const spots = JSON.parse(fs.readFileSync(SPOTS, 'utf8'));
  const todo = spots.filter(
    (s) => s.city === 'london' && !String(s.pc || '').trim()
      && Number.isFinite(s.lat) && Number.isFinite(s.lng)
  );
  console.log(`London spots needing a postcode: ${todo.length}`);

  let filled = 0, missed = 0;
  for (let i = 0; i < todo.length; i += BATCH) {
    const batch = todo.slice(i, i + BATCH);
    const results = await reverse(batch);
    results.forEach((r, j) => {
      const nearest = r && r.result && r.result[0];
      if (nearest && nearest.postcode) {
        batch[j].pc = outward(nearest.postcode);
        filled++;
      } else {
        missed++;
        console.warn(`  no postcode for ${batch[j].id} (${batch[j].lat},${batch[j].lng})`);
      }
    });
    console.log(`  ${Math.min(i + BATCH, todo.length)}/${todo.length} done`);
  }

  console.log(`Filled ${filled}, unresolved ${missed}.`);
  if (DRY) { console.log('--dry: not writing.'); return; }
  if (filled) {
    fs.writeFileSync(SPOTS, JSON.stringify(spots, null, 1) + '\n');
    console.log('Wrote data/spots.json — run `npm run build`.');
  }
})().catch((e) => { console.error(e); process.exit(1); });
