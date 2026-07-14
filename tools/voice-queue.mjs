#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const spotsPath = path.join(root, 'data', 'spots.json');
const qualityPath = path.join(root, 'data', 'quality.json');
const outPath = path.join(root, 'data', 'voice-queue.json');

function argValue(name, fallback = '') {
  const prefix = `--${name}=`;
  const hit = process.argv.find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

const limit = Math.max(1, Number.parseInt(argValue('limit', '250'), 10) || 250);
const cityFilter = argValue('city', '').trim().toLowerCase();
const spots = readJson(spotsPath);
const quality = readJson(qualityPath);
const flags = quality.flags || {};
const notable = new Set(quality.notable || []);

function wordCount(text) {
  return String(text || '').trim().split(/\s+/).filter(Boolean).length;
}

function scoreSpot(spot) {
  const flag = flags[spot.id] || '';
  const words = wordCount(spot.w);
  let score = 0;
  if (flag === 'm') score += 1000;
  else if (flag === 'd') score += 700;
  else if (flag === 'v') score += 250;
  if (!spot.w || !String(spot.w).trim()) score += 500;
  else if (words < 20) score += 300;
  else if (words < 45) score += 150;
  if (notable.has(spot.id)) score += 120;
  if (spot.city === 'london') score += 35;
  return score;
}

const candidates = spots
  .filter((spot) => spot && spot.id && (!cityFilter || spot.city === cityFilter))
  .map((spot) => ({
    id: spot.id,
    name: spot.n || '',
    city: spot.city || '',
    category: spot.c || '',
    area: spot.a || '',
    quality: flags[spot.id] || '',
    notable: notable.has(spot.id),
    words: wordCount(spot.w),
    hook: spot.s || '',
    current: spot.w || '',
    score: scoreSpot(spot),
  }))
  .filter((spot) => spot.quality !== 'a' && spot.score > 0)
  .sort((a, b) => b.score - a.score || a.words - b.words || a.city.localeCompare(b.city) || a.name.localeCompare(b.name));

const queue = candidates.slice(0, limit).map(({ score, ...spot }) => spot);
const byQuality = queue.reduce((acc, spot) => {
  const key = spot.quality || 'unflagged';
  acc[key] = (acc[key] || 0) + 1;
  return acc;
}, {});
const byCity = queue.reduce((acc, spot) => {
  acc[spot.city] = (acc[spot.city] || 0) + 1;
  return acc;
}, {});

const output = {
  generated: new Date().toISOString(),
  source: {
    spots: path.relative(root, spotsPath),
    quality: path.relative(root, qualityPath),
  },
  filters: {
    city: cityFilter || null,
    limit,
  },
  totalCandidates: candidates.length,
  counts: {
    byQuality,
    topCities: Object.entries(byCity)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 20)
      .map(([city, count]) => ({ city, count })),
  },
  queue,
};

fs.writeFileSync(outPath, `${JSON.stringify(output, null, 2)}\n`);
console.log(`Wrote ${path.relative(root, outPath)} with ${queue.length} of ${candidates.length} candidate writeups.`);
if (cityFilter) console.log(`City filter: ${cityFilter}`);
console.log(`Quality mix: ${Object.entries(byQuality).map(([k, v]) => `${k}:${v}`).join(' ') || 'none'}`);
