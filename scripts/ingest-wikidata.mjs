// Ingest "storied" places near each city from Wikidata (keyless) into Supabase.
// Heritage sites, monuments, museums, archaeological sites, public sculpture.
// Runs in GitHub Actions — see .github/workflows/ingest-wikidata.yml.
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, [INGEST_STATUS]
import fs from "node:fs";

const SB_URL = process.env.SUPABASE_URL || "https://fpngxchltuovtsyzigul.supabase.co";
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const STATUS = process.env.INGEST_STATUS || "approved";
const RADIUS = 5; // km
if (!SB_KEY) { console.error("Missing SUPABASE_SERVICE_ROLE_KEY."); process.exit(1); }

const cities = JSON.parse(
  fs.readFileSync(new URL("../supabase/functions/ingest-events/cities.json", import.meta.url))
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// P18 comes back as an http Special:FilePath URL pointing at the full-res
// original. Force https (else it's blocked as mixed content on the https app)
// and ask Commons for a 400px-wide thumbnail so the discovery cards stay light.
function commonsThumb(u) {
  if (!u) return null;
  u = u.replace(/^http:/i, "https:");
  if (/Special:FilePath/i.test(u)) u += (u.includes("?") ? "&" : "?") + "width=400";
  return u;
}

// storied types: monument, memorial, tourist attraction, archaeological site,
// sculpture, museum, historic site, heritage building, castle, statue
const TYPES = ["Q4989906","Q5003624","Q570116","Q839954","Q860861","Q33506","Q1081138","Q35112127","Q23413","Q179700"];
function query(lat, lng) {
  return `SELECT ?item ?itemLabel ?itemDescription ?lat ?lon ?typeLabel ?image ?article WHERE {
  SERVICE wikibase:around { ?item wdt:P625 ?loc.
    bd:serviceParam wikibase:center "Point(${lng} ${lat})"^^geo:wktLiteral.
    bd:serviceParam wikibase:radius "${RADIUS}". bd:serviceParam wikibase:distance ?dist. }
  ?item wdt:P31 ?type. VALUES ?type { ${TYPES.map((t) => "wd:" + t).join(" ")} }
  OPTIONAL { ?item wdt:P18 ?image. }
  OPTIONAL { ?article schema:about ?item; schema:isPartOf <https://en.wikipedia.org/>. }
  BIND(geof:latitude(?loc) AS ?lat) BIND(geof:longitude(?loc) AS ?lon)
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
} ORDER BY ?dist LIMIT 60`;
}

let upserted = 0, hits = 0;
for (const c of cities) {
  const url = "https://query.wikidata.org/sparql?format=json&query=" + encodeURIComponent(query(c.lat, c.lng));
  let data;
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 45000);
    const r = await fetch(url, { headers: { "User-Agent": "FlaneurBot/1.0 (https://kubaberkowski-netizen.github.io/Map-2/)", Accept: "application/sparql-results+json" }, signal: ac.signal });
    clearTimeout(t);
    if (!r.ok) { await sleep(1200); continue; }
    data = await r.json();
  } catch { await sleep(1200); continue; }

  const seen = new Set();
  const rows = (data?.results?.bindings || []).map((b) => {
    const qid = (b.item?.value || "").split("/").pop();
    const lat = +b.lat?.value, lng = +b.lon?.value;
    return {
      ext_id: "wd:" + qid,
      name: b.itemLabel?.value || qid,
      category: b.typeLabel?.value || "Place",
      description: b.itemDescription?.value || null,
      lat, lng,
      city: c.slug,
      url: b.article?.value || `https://www.wikidata.org/wiki/${qid}`,
      image: commonsThumb(b.image?.value),
      source: "wikidata",
      status: STATUS,
    };
  }).filter((x) => x.name && /^Q\d+$/.test(x.ext_id.slice(3)) && isFinite(x.lat) && isFinite(x.lng) && !x.name.startsWith("Q") && (seen.has(x.ext_id) ? false : seen.add(x.ext_id)));

  if (rows.length) {
    const res = await fetch(`${SB_URL}/rest/v1/places?on_conflict=ext_id`, {
      method: "POST",
      headers: { apikey: SB_KEY, Authorization: "Bearer " + SB_KEY,
        "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(rows),
    });
    if (res.ok) { upserted += rows.length; hits++; }
    else console.error(`${c.slug}: ${res.status} ${await res.text()}`);
  }
  await sleep(1200); // be gentle with the Wikidata Query Service
}
console.log(`Wikidata: upserted ${upserted} storied places across ${hits} cities.`);
