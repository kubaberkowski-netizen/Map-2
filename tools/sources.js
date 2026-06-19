"use strict";
/*
 * tools/sources.js — fetch adapters for the candidate sources.
 *
 * Split into two tiers:
 *
 *   READY (no key, free, implemented below):
 *     overpass()  — OpenStreetMap features in a bbox (gives name + coords + tags)
 *     wikidata()  — SPARQL: things with coords in a bbox (name + coords + desc)
 *     reddit()    — public search.json for a subreddit (text candidates, no coords)
 *     pullpush()  — pullpush.io historical Reddit search (the Pushshift successor)
 *     geocode()   — Nominatim forward geocode (fills lat/lng + postcode)
 *
 *   ADAPTER STUBS (need a key/managed service — interface only, throws if called):
 *     tiktok(), firecrawl(), apify(), googlePlaces(), claudeExtract()
 *   Each documents exactly what to drop in. They are deliberately NOT wired to
 *   the network so the ready pipeline runs with zero secrets.
 *
 * Everything is polite: a shared User-Agent, a min-interval throttle per host,
 * and bounded retry with backoff. Be a good citizen — these are free endpoints.
 */

const UA = "FlaneurSpotResearch/1.0 (personal catalogue tool; contact kuba.berkowski@gmail.com)";

const _last = new Map();
async function throttle(host, minMs) {
  const prev = _last.get(host) || 0;
  const wait = prev + minMs - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  _last.set(host, Date.now());
}

async function fetchText(url, { method = "GET", headers = {}, body, host, minMs = 1100, retries = 3 } = {}) {
  host = host || new URL(url).host;
  let attempt = 0;
  for (;;) {
    await throttle(host, minMs);
    try {
      const res = await fetch(url, { method, headers: { "User-Agent": UA, ...headers }, body });
      if (res.status === 429 || res.status >= 500) throw new Error("HTTP " + res.status);
      if (!res.ok) throw new Error("HTTP " + res.status + " " + (await res.text()).slice(0, 200));
      return await res.text();
    } catch (e) {
      if (attempt++ >= retries) throw e;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt)); // 2s,4s,8s
    }
  }
}
const fetchJSON = async (url, opts) => JSON.parse(await fetchText(url, opts));

// --- OpenStreetMap / Overpass ------------------------------------------------
// bbox is the Ci form [minLng,minLat,maxLng,maxLat]; Overpass wants S,W,N,E.
async function overpass(bbox, { limit = 200 } = {}) {
  const [w, s, e, n] = bbox;
  const sel = [
    'node["historic"]', 'way["historic"]',
    'node["tourism"~"museum|artwork|viewpoint|gallery"]', 'way["tourism"~"museum|gallery"]',
    'node["amenity"~"place_of_worship|archive|cinema"]',
    'node["building"~"folly|almshouse"]', 'way["building"~"folly|almshouse"]',
    'node["memorial"]', 'node["historic"="blue_plaque"]',
  ].map((q) => `${q}(${s},${w},${n},${e});`).join("");
  const ql = `[out:json][timeout:60];(${sel});out center ${limit};`;
  const data = await fetchJSON("https://overpass-api.de/api/interpreter", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "data=" + encodeURIComponent(ql),
    minMs: 2000,
  });
  return (data.elements || [])
    .map((el) => {
      const lat = el.lat ?? el.center?.lat, lng = el.lon ?? el.center?.lon;
      const t = el.tags || {};
      if (!t.name || lat == null || lng == null) return null;
      return {
        n: t.name, lat, lng, tags: t,
        _meta: { source: "overpass", url: `https://www.openstreetmap.org/${el.type}/${el.id}`, raw: t },
      };
    })
    .filter(Boolean);
}

// --- Wikidata SPARQL ---------------------------------------------------------
async function wikidata(bbox, { limit = 200 } = {}) {
  const [w, s, e, n] = bbox;
  const sparql = `
SELECT ?item ?itemLabel ?desc ?coord WHERE {
  SERVICE wikibase:box { ?item wdt:P625 ?coord.
    bd:serviceParam wikibase:cornerWest "Point(${w} ${s})"^^geo:wktLiteral.
    bd:serviceParam wikibase:cornerEast "Point(${e} ${n})"^^geo:wktLiteral. }
  OPTIONAL { ?item schema:description ?desc. FILTER(LANG(?desc)="en") }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
} LIMIT ${limit}`;
  const url = "https://query.wikidata.org/sparql?format=json&query=" + encodeURIComponent(sparql);
  const data = await fetchJSON(url, { headers: { Accept: "application/sparql-results+json" }, minMs: 1500 });
  return (data.results?.bindings || [])
    .map((b) => {
      const m = /Point\(([-\d.]+) ([-\d.]+)\)/.exec(b.coord?.value || "");
      if (!m || !b.itemLabel) return null;
      const name = b.itemLabel.value;
      if (/^Q\d+$/.test(name)) return null; // unlabeled item
      return {
        n: name, lat: +m[2], lng: +m[1],
        hint: b.desc?.value || "",
        _meta: { source: "wikidata", url: b.item.value, raw: b.desc?.value || "" },
      };
    })
    .filter(Boolean);
}

// --- Reddit (public, no auth) ------------------------------------------------
// Text-only leads: titles/bodies that mention places. No coords — these must go
// through geocode() (and ideally claudeExtract()) before they become rows.
async function reddit(sub, query, { sort = "relevance", limit = 50 } = {}) {
  const url =
    `https://www.reddit.com/r/${encodeURIComponent(sub)}/search.json` +
    `?q=${encodeURIComponent(query)}&restrict_sr=1&sort=${sort}&limit=${limit}&raw_json=1`;
  const data = await fetchJSON(url, { minMs: 1500 });
  return (data.data?.children || []).map((c) => {
    const p = c.data;
    return {
      text: [p.title, p.selftext].filter(Boolean).join("\n\n"),
      _meta: {
        source: "reddit", url: "https://www.reddit.com" + p.permalink,
        sub, score: p.score, title: p.title,
      },
    };
  });
}

// --- Pullpush.io (historical Reddit — the Pushshift successor) ----------------
async function pullpush(sub, query, { size = 100 } = {}) {
  const url =
    `https://api.pullpush.io/reddit/search/submission/` +
    `?subreddit=${encodeURIComponent(sub)}&q=${encodeURIComponent(query)}&size=${size}&sort=desc`;
  const data = await fetchJSON(url, { minMs: 1500 });
  return (data.data || []).map((p) => ({
    text: [p.title, p.selftext].filter(Boolean).join("\n\n"),
    _meta: {
      source: "pullpush", url: "https://www.reddit.com" + (p.permalink || ""),
      sub, score: p.score, title: p.title, created: p.utc_datetime_str,
    },
  }));
}

// --- Nominatim forward geocode (fills lat/lng + postcode) --------------------
async function geocode(name, cityName) {
  const url =
    "https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=1&q=" +
    encodeURIComponent(cityName ? `${name}, ${cityName}` : name);
  const arr = await fetchJSON(url, { minMs: 1100 }); // Nominatim: max 1 req/sec
  const hit = arr[0];
  if (!hit) return null;
  return {
    lat: +hit.lat, lng: +hit.lon,
    pc: hit.address?.postcode || "",
    display: hit.display_name,
  };
}

// --- ADAPTER STUBS (bring your own key) --------------------------------------
function notWired(name, how) {
  return async () => {
    throw new Error(
      `${name}() is a stub — it needs a key/managed service. ${how}\n` +
        `Wire it up in tools/sources.js, then add it to find-spots.js's --source switch.`
    );
  };
}
// TikTok has no usable open API. Easiest: run an Apify "TikTok Scraper" actor or
// yt-dlp to pull captions+hashtags+location tags, then feed the text to claudeExtract().
const tiktok = notWired("tiktok", "Use Apify's TikTok Scraper actor (apify()) or yt-dlp, then claudeExtract() the captions.");
// Firecrawl: turns any URL/listicle into clean markdown/JSON. Set FIRECRAWL_API_KEY,
// POST https://api.firecrawl.dev/v1/scrape {url, formats:["markdown"]}.
const firecrawl = notWired("firecrawl", "Set FIRECRAWL_API_KEY and POST to api.firecrawl.dev/v1/scrape.");
// Apify: marketplace actors (Google Maps, Instagram, TikTok). Set APIFY_TOKEN,
// POST https://api.apify.com/v2/acts/<actor>/run-sync-get-dataset-items?token=...
const apify = notWired("apify", "Set APIFY_TOKEN and run-sync-get-dataset-items on an actor id.");
// Google Places: the gold standard for canonical name + postcode + coords.
// Set GOOGLE_PLACES_KEY, call Places API (New) :searchText / :details.
const googlePlaces = notWired("googlePlaces", "Set GOOGLE_PLACES_KEY and call Places API (New) searchText/details.");
// --- Claude extraction (IMPLEMENTED) -----------------------------------------
// Turns the messy text leads from reddit()/pullpush()/tiktok() into structured
// candidate places. Uses the official Anthropic SDK (lazy-required so the rest
// of the pipeline stays dependency-free — install only if you use this):
//
//     npm install @anthropic-ai/sdk
//     export ANTHROPIC_API_KEY=sk-ant-...
//
// The output schema has NO `w` field, so the model literally cannot draft a
// writeup — `c` is constrained to the live category enum, so it can only emit a
// real slug. The owner still writes every `w` and assigns nothing here.
const EXTRACT_MODEL = process.env.FLANEUR_EXTRACT_MODEL || "claude-opus-4-8";

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

/**
 * @param {Array<{text:string,_meta:object}>} posts  text leads from reddit/pullpush/tiktok
 * @param {{cityName:string, categories:string[], batchSize?:number}} opts
 * @returns {Promise<Array>}  hits: {n, a, c, s, _meta:{source,url,confidence,reason,via}}
 */
async function claudeExtract(posts, { cityName, categories, batchSize = 12 } = {}) {
  if (!process.env.ANTHROPIC_API_KEY)
    throw new Error("claudeExtract() needs ANTHROPIC_API_KEY in the environment.");
  if (!cityName || !Array.isArray(categories) || !categories.length)
    throw new Error("claudeExtract() needs { cityName, categories } from the model.");

  let Anthropic;
  try {
    Anthropic = require("@anthropic-ai/sdk");
  } catch {
    throw new Error(
      "claudeExtract() needs the Anthropic SDK. Install it (it is intentionally not a " +
        "project dependency):\n    npm install @anthropic-ai/sdk"
    );
  }
  const client = new Anthropic(); // reads ANTHROPIC_API_KEY from env

  // Structured-outputs schema. No `w`. `c` constrained to the live slug set.
  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      spots: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            n: { type: "string", description: "Proper name of the place" },
            a: { type: "string", description: "Neighbourhood / area within the city" },
            c: { type: "string", enum: categories, description: "Best-fit category slug" },
            s: { type: "string", description: "A short, factual hook (max ~8 words). NOT a writeup." },
            confidence: { type: "number", description: "0..1 — how sure this is a real, themed place" },
            reason: { type: "string", description: "One line: why it fits an offbeat/storied catalogue" },
            source_url: { type: "string", description: "URL of the post this place came from" },
          },
          required: ["n", "a", "c", "s", "confidence", "reason", "source_url"],
        },
      },
    },
    required: ["spots"],
  };

  const system =
    `You extract candidate places for a curated catalogue of offbeat, storied, ` +
    `or characterful spots in ${cityName}. From the supplied social posts, pull only ` +
    `real, specific, visitable places physically in ${cityName} (a named museum, pub, ` +
    `cafe, building, monument, alley, shop, viewpoint, etc.). Skip events, generic ` +
    `advice, whole neighbourhoods, chains, and anything outside ${cityName}. ` +
    `Pick the single best-fitting category slug for each. Write `+"`s`"+` as a terse ` +
    `factual hook, never prose. You are NOT writing descriptions — a human writes those.`;

  const out = [];
  for (const batch of chunk(posts, batchSize)) {
    const corpus = batch
      .map((p, i) => `### POST ${i + 1} — SOURCE: ${p._meta?.url || "unknown"}\n${p.text}`)
      .join("\n\n");

    let resp;
    try {
      resp = await client.messages.create({
        model: EXTRACT_MODEL,
        max_tokens: 16000,
        thinking: { type: "adaptive" },
        output_config: { format: { type: "json_schema", schema } },
        system,
        messages: [
          {
            role: "user",
            content:
              `Extract themed candidate places from these posts. Copy the matching ` +
              `SOURCE url into each spot's source_url.\n\n${corpus}`,
          },
        ],
      });
    } catch (e) {
      console.error(`  ⚠ claudeExtract batch failed (${e.message}) — skipping ${batch.length} post(s)`);
      continue;
    }

    if (resp.stop_reason === "refusal") {
      console.error("  ⚠ claudeExtract: a batch was declined by the model — skipping it");
      continue;
    }

    const textBlock = (resp.content || []).find((b) => b.type === "text");
    let parsed;
    try {
      parsed = JSON.parse(textBlock?.text || "{}");
    } catch {
      console.error("  ⚠ claudeExtract: could not parse model output for a batch — skipping");
      continue;
    }

    for (const sp of parsed.spots || []) {
      if (!sp.n || !categories.includes(sp.c)) continue;
      out.push({
        n: sp.n,
        a: sp.a || "",
        c: sp.c,
        s: sp.s || "",
        _meta: {
          source: (batch[0]._meta?.source || "reddit") + "+claude",
          url: sp.source_url || batch[0]._meta?.url || "",
          confidence: typeof sp.confidence === "number" ? sp.confidence : null,
          reason: sp.reason || "",
          via: EXTRACT_MODEL,
        },
      });
    }
  }
  return out;
}

module.exports = {
  overpass, wikidata, reddit, pullpush, geocode,
  tiktok, firecrawl, apify, googlePlaces, claudeExtract,
  _internal: { fetchText, fetchJSON },
};
