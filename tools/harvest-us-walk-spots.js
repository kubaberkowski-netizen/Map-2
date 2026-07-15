#!/usr/bin/env node
"use strict";

/*
 * Build a reviewable, state-balanced US expansion for Flaneur.
 *
 * Discovery spine:
 *   - Wikidata: coordinates, type, short description, sitelink count and
 *     structured facts (CC0)
 *   - English Wikipedia: existence/notability gate and a research-only excerpt
 *   - PublicaMundi US states GeoJSON: state boundary validation
 *
 * Default mode only writes research/us-2000/*.json. Nothing enters the app until
 * --apply is passed. Applied rows are marked quality "d" (machine draft) and
 * remain pending owner review.
 *
 * Usage:
 *   node tools/harvest-us-walk-spots.js --state AL --target 40
 *   node tools/harvest-us-walk-spots.js --all --target 40
 *   node tools/harvest-us-walk-spots.js --apply
 */

const fs = require("fs");
const path = require("path");
const acorn = require("acorn");
const M = require("./model");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "research", "us-2000");
const STATE_DIR = path.join(OUT, "states");
const RAW_DIR = path.join(OUT, ".raw");
const WIKI_EXTRACT_CACHE = path.join(RAW_DIR, "wiki-extracts.json");
const SPOTS = path.join(ROOT, "data", "spots.json");
const QUALITY = path.join(ROOT, "data", "quality.json");
const TEMPLATE = path.join(ROOT, "src", "app.template.html");
const BUILD = path.join(ROOT, "build.js");
const WIKIDATA_ENRICHED = path.join(__dirname, "wikidata-enriched.json");

const UA = "FlaneurUSResearch/1.0 (github.com/kubaberkowski-netizen/Map-2)";
const STATES_GEOJSON = "https://raw.githubusercontent.com/PublicaMundi/MappingAPI/master/data/geojson/us-states.json";
const SPARQL_ENDPOINT = "https://qlever.dev/api/wikidata";
const TARGET_DEFAULT = 40;
const MIN_SITELINKS = 2;
const QUERY_LIMIT = 1000;
const GENERATOR_VERSION = 6;
const QUERY_TYPE_PATTERN = "building|structure|museum|church|cathedral|basilica|chapel|synagogue|mosque|temple|shrine|palace|castle|tower|bridge|square|historic|heritage|courthouse|theatre|theater|cinema|opera house|cemetery|graveyard|garden|park|hall|gate|fountain|statue|monument|memorial|market|library|gallery|archive|prison|barrack|factory|brewery|mill|bath|observatory|lighthouse|pier|dock|canal|ruin|archaeological|street|arcade|passage|courtyard|estate|mansion|manor|abbey|convent|monastery|tomb|mausoleum|fort|bunker|works|exchange|hotel|restaurant|cafe|bar|pub|shop|store|bakery|club|venue|greenhouse|aquarium|planetarium|winery|distillery|promenade|public art|mural|sculpture|recording studio|zoo|visitor center|visitor centre|tourist attraction";
const STATE_ABBR = {
  Alabama: "AL", Alaska: "AK", Arizona: "AZ", Arkansas: "AR", California: "CA", Colorado: "CO",
  Connecticut: "CT", Delaware: "DE", Florida: "FL", Georgia: "GA", Hawaii: "HI", Idaho: "ID",
  Illinois: "IL", Indiana: "IN", Iowa: "IA", Kansas: "KS", Kentucky: "KY", Louisiana: "LA",
  Maine: "ME", Maryland: "MD", Massachusetts: "MA", Michigan: "MI", Minnesota: "MN", Mississippi: "MS",
  Missouri: "MO", Montana: "MT", Nebraska: "NE", Nevada: "NV", "New Hampshire": "NH", "New Jersey": "NJ",
  "New Mexico": "NM", "New York": "NY", "North Carolina": "NC", "North Dakota": "ND", Ohio: "OH",
  Oklahoma: "OK", Oregon: "OR", Pennsylvania: "PA", "Rhode Island": "RI", "South Carolina": "SC",
  "South Dakota": "SD", Tennessee: "TN", Texas: "TX", Utah: "UT", Vermont: "VT", Virginia: "VA",
  Washington: "WA", "West Virginia": "WV", Wisconsin: "WI", Wyoming: "WY",
};

const args = process.argv.slice(2);
const has = (x) => args.includes(x);
const arg = (x, fallback) => {
  const i = args.indexOf(x);
  return i >= 0 && args[i + 1] != null ? args[i + 1] : fallback;
};
const target = Math.max(1, +arg("--target", TARGET_DEFAULT));
const onlyState = String(arg("--state", "")).toUpperCase();
const applying = has("--apply");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const cap = (s) => s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
const asciiQuotes = (s) => String(s || "").replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
const norm = (s) => String(s || "").toLowerCase().normalize("NFKD")
  .replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
const hash = (s) => {
  let h = 2166136261;
  for (const ch of String(s)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
};
const isGeneratedUsId = (id) => /^us[a-z]{2}q\d+$/.test(String(id || ""));

function parsePoint(v) {
  const m = String(v || "").match(/Point\(([-\d.]+)\s+([-\d.]+)\)/);
  return m ? { lng: +m[1], lat: +m[2] } : null;
}

async function getJson(url, attempts = 4) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(60000) });
      if (r.ok) return await r.json();
      last = new Error(`HTTP ${r.status} ${r.statusText}`);
      if (![429, 500, 502, 503, 504].includes(r.status)) throw last;
    } catch (e) { last = e; }
    await sleep(1800 * (i + 1) + Math.random() * 700);
  }
  throw last || new Error("request failed");
}

async function sparql(query) {
  let last;
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch(SPARQL_ENDPOINT, {
        method: "POST", signal: AbortSignal.timeout(60000),
        headers: { "User-Agent": UA, Accept: "application/sparql-results+json", "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ query }),
      });
      if (r.ok) return await r.json();
      last = new Error(`SPARQL HTTP ${r.status} ${r.statusText}: ${(await r.text()).slice(0, 500)}`);
      if (![429, 500, 502, 503, 504].includes(r.status)) throw last;
    } catch (e) { last = e; }
    await sleep(1800 * (i + 1) + Math.random() * 700);
  }
  throw last || new Error("SPARQL request failed");
}

function stateQuery(state, bbox = state.bbox) {
  const [w, s, e, n] = bbox;
  const lng = (w + e) / 2, lat = (s + n) / 2;
  const radiusKm = Math.ceil(Math.max(
    M.haversineM(lat, lng, s, w), M.haversineM(lat, lng, n, e),
  ) / 1000 + 2);
  return `PREFIX wd: <http://www.wikidata.org/entity/>
  PREFIX wdt: <http://www.wikidata.org/prop/direct/>
  PREFIX wikibase: <http://wikiba.se/ontology#>
  PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
  PREFIX schema: <http://schema.org/>
  PREFIX geo: <http://www.opengis.net/ont/geosparql#>
  PREFIX geof: <http://www.opengis.net/def/function/geosparql/>
  SELECT ?item ?itemLabel ?itemDescription ?lat ?lng ?sitelinks ?article
    (GROUP_CONCAT(DISTINCT ?typeLabel; separator="|") AS ?types)
    (SAMPLE(?adminRaw) AS ?adminLabel) WHERE {
    BIND("POINT(${lng} ${lat})"^^geo:wktLiteral AS ?center)
    ?item wdt:P625 ?coord.
    FILTER(geof:distance(?coord, ?center) <= ${radiusKm})
    BIND(geof:latitude(?coord) AS ?lat)
    BIND(geof:longitude(?coord) AS ?lng)
    ?item wikibase:sitelinks ?sitelinks; rdfs:label ?itemLabel.
    FILTER(LANG(?itemLabel)="en") FILTER(?sitelinks >= ${MIN_SITELINKS})
    FILTER NOT EXISTS { ?item wdt:P31/wdt:P279* wd:Q486972. }
    FILTER NOT EXISTS { ?item wdt:P31/wdt:P279* wd:Q56061. }
    ?item wdt:P31 ?gateType. ?gateType rdfs:label ?gateTypeLabel.
    FILTER(LANG(?gateTypeLabel)="en")
    FILTER(REGEX(LCASE(?gateTypeLabel), "${QUERY_TYPE_PATTERN}"))
    ?article schema:about ?item; schema:isPartOf <https://en.wikipedia.org/>.
    OPTIONAL { ?item schema:description ?itemDescription. FILTER(LANG(?itemDescription)="en") }
    OPTIONAL { ?item wdt:P31 ?type. ?type rdfs:label ?typeLabel. FILTER(LANG(?typeLabel)="en") }
    OPTIONAL { ?item wdt:P131 ?admin. ?admin rdfs:label ?adminRaw. FILTER(LANG(?adminRaw)="en") }
  } GROUP BY ?item ?itemLabel ?itemDescription ?lat ?lng ?sitelinks ?article
  ORDER BY DESC(?sitelinks) LIMIT ${QUERY_LIMIT}`;
}

function queryBoxes(state) {
  const [w, s, e, n] = state.bbox, width = e - w, height = n - s;
  const dense = state.abbr === "CA", borderDense = state.abbr === "NJ", mountainBorder = state.abbr === "WV";
  const cols = dense ? 4 : borderDense ? 2 : mountainBorder ? 3 : width > 20 ? 3 : width > 9 ? 2 : 1;
  const rows = dense ? 3 : borderDense ? 3 : mountainBorder ? 2 : height > 7.5 ? 2 : 1;
  const boxes = [];
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
    boxes.push([
      +(w + width * x / cols).toFixed(4), +(s + height * y / rows).toFixed(4),
      +(w + width * (x + 1) / cols).toFixed(4), +(s + height * (y + 1) / rows).toFixed(4),
    ]);
  }
  return boxes;
}

function stateRegistry(geo, qids) {
  return geo.features.filter((f) => STATE_ABBR[f.properties.name]).map((f) => ({
    name: f.properties.name, abbr: STATE_ABBR[f.properties.name], qid: qids[f.properties.name],
  })).sort((a, b) => a.name.localeCompare(b.name));
}

async function stateGeo() {
  const file = path.join(RAW_DIR, "us-states.geojson");
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
  const geo = await getJson(STATES_GEOJSON);
  fs.mkdirSync(RAW_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(geo));
  return geo;
}

async function stateQids() {
  const file = path.join(RAW_DIR, "state-qids.json");
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
  const q = `PREFIX wd: <http://www.wikidata.org/entity/>
    PREFIX wdt: <http://www.wikidata.org/prop/direct/>
    PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
    SELECT ?state ?stateLabel WHERE {
      ?state wdt:P31 wd:Q35657; wdt:P17 wd:Q30; rdfs:label ?stateLabel.
      FILTER(LANG(?stateLabel)="en")
    }`;
  const j = await sparql(q), out = {};
  for (const b of j.results.bindings) out[b.stateLabel.value] = b.state.value.split("/").pop();
  fs.mkdirSync(RAW_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(out, null, 1) + "\n");
  return out;
}

// Standard even/odd ray casting, including MultiPolygon state geometries.
function inRing(lng, lat, ring) {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if (((a[1] > lat) !== (b[1] > lat)) &&
        lng < (b[0] - a[0]) * (lat - a[1]) / ((b[1] - a[1]) || 1e-12) + a[0]) hit = !hit;
  }
  return hit;
}
function inPolygon(lng, lat, polygon) {
  if (!polygon.length || !inRing(lng, lat, polygon[0])) return false;
  for (let i = 1; i < polygon.length; i++) if (inRing(lng, lat, polygon[i])) return false;
  return true;
}
function inGeometry(lng, lat, geom) {
  if (!geom) return false;
  if (geom.type === "Polygon") return inPolygon(lng, lat, geom.coordinates);
  if (geom.type === "MultiPolygon") return geom.coordinates.some((p) => inPolygon(lng, lat, p));
  return false;
}
function walkCoords(coords, fn) {
  if (!Array.isArray(coords)) return;
  if (typeof coords[0] === "number" && typeof coords[1] === "number") fn(coords[0], coords[1]);
  else coords.forEach((x) => walkCoords(x, fn));
}
function boundsOf(geom, abbr) {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  walkCoords(geom.coordinates, (lng, lat) => {
    // The app's bbox model cannot cross the date line. The mainland/near-island
    // half of Alaska still contains far more than the 40-place target.
    if (abbr === "AK" && lng > 0) return;
    w = Math.min(w, lng); s = Math.min(s, lat); e = Math.max(e, lng); n = Math.max(n, lat);
  });
  return [w, s, e, n].map((x) => +x.toFixed(4));
}

const PLACE_RE = /building|structure|museum|church|cathedral|basilica|chapel|synagogue|mosque|temple|shrine|palace|castle|tower|bridge|square|historic district|historic site|historic house|courthouse|theatre|theater|cinema|opera house|cemetery|graveyard|garden|urban park|city park|\bhall\b|gate|fountain|statue|monument|memorial|market|library|gallery|archive|prison|barrack|factory|brewery|mill|bath|lido|observatory|lighthouse|pier|dock|canal|ruin|archaeological|street|arcade|passage|courtyard|estate|mansion|manor|abbey|convent|monastery|tomb|mausoleum|fort|citadel|bunker|works|exchange|hotel|restaurant|cafe|\bbar\b|\bpub\b|shop|store|bakery|club|venue|greenhouse|aquarium|planetarium|winery|distillery|promenade|public art|mural|sculpture|recording studio/i;
const ADMIN_RE = /(^|\|)(u\.s\. state|state of the united states|city in the united states|big city|county seat|human settlement|county of|county in|town in|village in|census-designated place|municipality|neighborhood|borough|township|unincorporated community)(\||$)/i;
const NATURAL_RE = /mountain range|river$|tributary|watershed|lake$|reservoir$|island$|bay$|sea$|forest$|desert$|geologic formation|tectonic|valley$|peninsula$|glacier$|volcano$/i;
const TRANSPORT_RE = /railway station|railroad station|metro station|subway station|bus station|airport|air base|interchange|highway|freeway|road junction|railway line|tram stop/i;
const INSTITUTION_RE = /university|college|school|hospital|medical center|government agency|research cent(?:re|er)|company|organization|radio station|television station|sports team|military unit/i;
const EVENT_RE = /battle|war$|massacre|disaster|accident|tornado|earthquake|murder|shooting|explosion|festival|election|treaty/i;
const NON_VISITABLE_RE = /government agency|research cent(?:re|er)|administrative office|military archive|headquarters|office building|private (?:men's )?club|personal home|private residence|official residence|university house|\bcampus\b|state prison|prison for (?:men|women)|former prison|correctional cent(?:re|er)|theme park|shopping complex|shopping cent(?:re|er)|deep space station|communications complex|gigafactory/i;
const LINEAR_RE = /national historic trail|long-distance trail|scenic trail|highway|road$|route$|railway line|canal system/i;
const VANISHED_RE = /destroyed building or structure|demolish(?:ed|ition)|razed|burned down|no longer exists|former public statue|removed from public display|defunct (?:factory|plant|hotel|theatre|theater)/i;
const STRONG_RE = /museum|gallery|\bhistoric\b|heritage|memorial|monument|cathedral|basilica|palace|castle|fort|tomb|mausoleum|observatory|\bpark\b|\bgarden\b|cemetery|lighthouse|public art|mural|theatre|theater|cinema|library|market|bridge/i;

function candidateFilter(x) {
  const types = x.types || "", desc = x.description || "", all = `${types}|${desc}`;
  if (!PLACE_RE.test(all)) return false;
  if (ADMIN_RE.test(types) && !STRONG_RE.test(types)) return false;
  if (NATURAL_RE.test(types) && !/urban park|city park|garden|promenade|trail/i.test(types)) return false;
  if (TRANSPORT_RE.test(types) && !STRONG_RE.test(types)) return false;
  if (NON_VISITABLE_RE.test(`${all}|${x.n}`) && !/museum|gallery|visitor cent(?:re|er)|historic site/i.test(types)) return false;
  if (INSTITUTION_RE.test(all) && !/museum|gallery|historic building|landmark building|visitor cent(?:re|er)/i.test(types)) return false;
  if (LINEAR_RE.test(types)) return false;
  if (/fictional|website|web portal/i.test(types)) return false;
  if (/not open to (?:the )?public|closed to (?:the )?public/i.test(all)) return false;
  if (/\bCIA (?:Museum|Memorial Wall)\b/i.test(x.n)) return false;
  if (/\b(?:Giga Nevada|Gigafactory)\b/i.test(x.n)) return false;
  if (VANISHED_RE.test(all) && !/ruin|archaeological site/i.test(types)) return false;
  if (EVENT_RE.test(types) && !STRONG_RE.test(types)) return false;
  if (/list of|former country|administrative territorial entity/i.test(desc)) return false;
  return true;
}

function categoryOf(x) {
  // Classify from entity type/description, not the proper name: otherwise
  // Fort Payne Opera House becomes a fort and Motorsports Park becomes a park.
  const types = String(x.types || "").toLowerCase();
  const description = String(x.description || "").toLowerCase();
  const t = `${types}|${description}`;
  if (/synagogue/.test(t)) return "synagogue";
  if (/mosque/.test(t)) return "mosque";
  if (/masonic temple/.test(t)) return "history";
  if (/hindu temple|buddhist temple|jain temple|shinto shrine|temple/.test(t)) return "temple";
  if (/abbey|monastery|convent/.test(t)) return "monastery";
  if (/cemetery|graveyard|tomb|mausoleum|burial ground|crypt/.test(t)) return "death";
  if (/art museum|art gallery|gallery/.test(t)) return "artgallery";
  if (/recording studio|music venue|music hall|concert hall/.test(t)) return "music";
  if (/museum|aquarium|planetarium|observatory/.test(t)) return "museum";
  if (/theatre|theater|cinema|movie palace|opera house/.test(t)) return "cinema";
  if (/lighthouse|lightship|maritime|naval|harbour|harbor|pier|dock/.test(t)) return "maritime";
  if (/castle|palace|\bfort(?:ress)?\b|citadel/.test(t)) return "castle";
  if (/ruin|archaeological/.test(t)) return "ruins";
  if (/art deco|streamline moderne/.test(t)) return "artdeco";
  if (/brutalis/.test(t)) return "brutalism";
  if (/public art|mural|street art|graffiti/.test(t)) return "streetart";
  if (/library|archive/.test(t)) return "archive";
  if (/market|bazaar|marketplace/.test(t)) return "market";
  if (/stadium|arena|ballpark|motorsport racing track|sports venue/.test(types)) return "stadium";
  if (/(^|\|)(?:urban park|city park|state park|national park|park|botanical garden|public garden|garden|arboretum|greenway|promenade)(\||$)/.test(types) || /\b(?:state|national|public|urban|city|memorial|historic) park\b/.test(description)) return "park";
  if (/war memorial|military memorial/.test(t)) return "warmemory";
  if (/monument|memorial|statue|sculpture|fountain|obelisk/.test(t)) return "monument";
  if (/factory|mill|industrial|brewery|works|warehouse|power station/.test(t)) return "industrial";
  if (/church|cathedral|basilica|chapel|meeting house/.test(t)) return "church";
  if (/bridge|courthouse|historic district|historic house|mansion|manor|estate|tower|hall|building|structure/.test(t)) return "history";
  if (/bookshop|bookstore/.test(t)) return "bookshops";
  if (/bakery/.test(t)) return "bakery";
  if (/coffee|coffeehouse|cafe/.test(t)) return "coffee";
  if (/\bpub\b|tavern|\bbar\b/.test(t)) return "pub";
  if (/restaurant/.test(t)) return "food";
  return "oddity";
}

function scoreOf(x) {
  const text = `${x.types}|${x.description}`.toLowerCase();
  let score = Math.log2(1 + x.sitelinks) * 14;
  if (/national historic landmark/.test(text)) score += 32;
  if (/national register of historic places/.test(text)) score += 18;
  if (/oldest|first |only |last surviving|largest|smallest|unique/.test(text)) score += 20;
  if (/historic|heritage|landmark/.test(text)) score += 14;
  if (/art deco|brutalis|modernist|gothic revival|beaux-arts/.test(text)) score += 12;
  if (/museum|gallery|public art|mural|market|library|lighthouse|observatory/.test(text)) score += 10;
  if (/church|chapel/.test(text) && !/cathedral|basilica|historic|landmark/.test(text)) score -= 12;
  if (/house|residence/.test(text) && !/historic|museum|landmark/.test(text)) score -= 9;
  if (/stadium|arena/.test(text)) score -= 8;
  return Math.round(score);
}

function cleanDescription(desc, state) {
  let s = asciiQuotes(desc).replace(/\s+/g, " ").trim().replace(/[.;]+$/, "");
  s = s.replace(new RegExp(`^(?:[A-Z][A-Za-z.'-]*\\s*){1,5},\\s*${state},\\s*`), "");
  s = s.replace(/\s+(?:located\s+)?(?:in|near)\s+[^.;]+(?:United States(?: of America)?|USA)$/i, "");
  s = s.replace(new RegExp(`\\s+(?:located\\s+)?(?:in|near)\\s+[^,.;]+,\\s*${state}(?:,?\\s*(?:United States|USA))?$`, "i"), "");
  s = s.replace(new RegExp(`\\s+in\\s+${state}(?:,?\\s*(?:United States|USA))?$`, "i"), "");
  s = s.replace(/\s+in the United States(?: of America)?$/i, "");
  s = s.replace(/\s+in the U\.S\.$/i, "");
  s = s.replace(/^United States historic place$/i, "historic place");
  s = s.replace(/^United States National Monument$/i, "national monument");
  if (new RegExp(`^(?:[^,]+(?: County| Parish| Borough)?),\\s*${state}$`, "i").test(s)) return "storied local landmark";
  if (/^(building|structure|place|site)$/i.test(s) || s.length < 8) return "storied local landmark";
  return s;
}

function withArticle(phrase) {
  if (/^(a|an|the)\s/i.test(phrase)) return phrase;
  if (/^(honest|honor|hour|heir)/i.test(phrase)) return `an ${phrase}`;
  if (/^(unit|univers|use|user|euro|one\b)/i.test(phrase)) return `a ${phrase}`;
  if (/^[A-Z]{2,}/.test(phrase)) return `${/^[AEFHILMNORSX]/.test(phrase) ? "an" : "a"} ${phrase}`;
  return `${/^[aeiou]/i.test(phrase) ? "an" : "a"} ${phrase}`;
}

function heritageSentence(label) {
  const h = cap(label).replace(/\s+(?:listed place|listing|status)$/i, "");
  if (/^listed on\s/i.test(h)) return `${h}.`;
  if (/national register of historic places/i.test(h)) return "It is listed on the National Register of Historic Places.";
  if (/national historic landmark/i.test(h)) return "Its National Historic Landmark designation marks its wider significance.";
  return `${h} designation makes the significance official.`;
}

function hookOf(x, state) {
  const d = cleanDescription(x.description, state).replace(/^(a|an|the)\s+/i, "");
  let h = d;
  if (x.year && x.style) h = `${x.year} ${x.style.toLowerCase()} detour`;
  else if (x.year && /historic|landmark|building|house|theatre|theater/i.test(d)) h = `${x.year} ${d}`;
  h = h.replace(/\s+/g, " ").trim();
  if (h.length > 68) h = h.slice(0, 65).replace(/\s+\S*$/, "") + "...";
  return h.toLowerCase();
}

const ENDINGS = {
  history: ["History at pavement speed.", "The slower street wins.", "A detail worth leaving the direct route for."],
  museum: ["A collection with character to spare.", "Small enough to miss, good enough not to.", "A proper detour, indoors."],
  artgallery: ["Art where the walk finds it.", "A pause with better walls.", "The block's cultural punctuation mark."],
  church: ["Look up before walking on.", "Stonework worth slowing for.", "A quiet interruption to the street."],
  synagogue: ["Community history in brick and stone.", "A living layer of the neighbourhood.", "Memory built into the street."],
  mosque: ["Community history in brick and stone.", "A living layer of the neighbourhood.", "Memory built into the street."],
  temple: ["A quieter rhythm to the walk.", "Ritual and craft in plain sight.", "A living layer of the neighbourhood."],
  monastery: ["A quieter rhythm to the walk.", "The city falls away for a moment.", "Stone, silence and a useful detour."],
  death: ["The dead still shape the map.", "A quieter archive, written in stone.", "Local history with names attached."],
  park: ["A green interruption to the grid.", "Take the path that bends.", "The long way round is the point."],
  maritime: ["Salt, industry and a line to the horizon.", "A landmark that still reads from the water.", "The shoreline tells the story."],
  castle: ["Power left a very visible footprint.", "Defence turned into a detour.", "A stronghold hiding in the modern map."],
  ruins: ["Enough survives to stop the walk.", "The missing pieces do half the work.", "A fragment with a long memory."],
  artdeco: ["Geometry worth crossing the street for.", "The facade does the talking.", "Modern glamour, still on the block."],
  brutalism: ["Concrete with conviction.", "The sort of building nobody walks past neutrally.", "Heavy, strange and impossible to ignore."],
  streetart: ["The wall earned the detour.", "An outdoor gallery with no front door.", "Colour where the route least expects it."],
  archive: ["A paper trail worth following.", "The city's memory has an address.", "Records, rooms and a reason to linger."],
  market: ["Best approached hungry and without a plan.", "The useful kind of sensory overload.", "A whole neighbourhood under one roof."],
  cinema: ["A marquee worth seeing before the film.", "The building is part of the show.", "Old glamour, still taking bookings."],
  music: ["A room that changed what came out of the speakers.", "Music history with a street address.", "The building is quiet; its influence is not."],
  warmemory: ["Memory fixed into the route.", "A pause the street asks you to make.", "History with the names left in."],
  monument: ["A story planted in the public realm.", "The street's own footnote.", "Public memory, impossible to scroll past."],
  industrial: ["Industry left the interesting bits behind.", "Workaday history with real texture.", "The machinery is gone; the character stayed."],
  bookshops: ["A dangerous detour for anyone carrying a tote bag.", "Shelves worth missing the next turn for.", "The walk may end with another book."],
  coffee: ["The sort of stop that can reroute an afternoon.", "A small pause with a serious cup.", "Good reason to walk one block further."],
  bakery: ["Follow the smell, then abandon the route.", "A detour best timed before sell-out.", "The walk improves with something warm in hand."],
  pub: ["A room with more history than signage.", "The walk's natural full stop.", "Worth knowing before you need a stool."],
  food: ["A table worth bending the route around.", "The queue, if there is one, has a point.", "A neighbourhood institution, not just a meal."],
  stadium: ["A landmark even on a quiet day.", "The neighbourhood changes on matchday.", "Local ritual on a very large scale."],
  oddity: ["Exactly the sort of thing Flaneur is for.", "The unnecessary detour wins again.", "Strange enough to earn a pin."],
};

const WALK_FILLERS = [
  "Approach it on foot and the surrounding block becomes part of the visit.",
  "It works best at walking pace, when the details and its relationship to the street have time to register.",
  "Come on foot: the scale, details and setting reveal themselves before the destination does.",
];

function writeupOf(x, state) {
  const desc = cleanDescription(x.description, state).replace(/^(a|an|the)\s+/i, "");
  const phrase = desc || "storied local landmark";
  const subject = withArticle(phrase);
  const physical = /building|structure|house|church|cathedral|basilica|chapel|synagogue|mosque|temple|palace|castle|tower|bridge|courthouse|theatre|theater|cinema|hall|gate|monument|memorial|library|factory|mill|lighthouse|mansion|manor|fort/i.test(x.types || "");
  const established = /museum|artgallery|park|stadium|music/.test(x.c);
  const yearAlreadySaid = x.year && new RegExp(`\\b${x.year}\\b`).test(phrase);
  let lead;
  if (x.year && x.architect && physical && !yearAlreadySaid) lead = `Dating to ${x.year}, this ${phrase} was designed by ${x.architect}.`;
  else if (x.year && x.creator) lead = `Created in ${x.year} by ${x.creator}, this ${phrase} still rewards a closer look.`;
  else if (x.architect && physical) lead = `Designed by ${x.architect}, this ${phrase} rewards a closer look.`;
  else if (x.year && established && !yearAlreadySaid) lead = `Established in ${x.year}, this ${phrase} adds a distinctive stop to the route.`;
  else if (x.year && !yearAlreadySaid) lead = `Dating to ${x.year}, this ${phrase} carries its history into the present street.`;
  else lead = `${cap(subject)}, chosen for the story and texture it adds to an ordinary walk.`;

  const facts = [];
  if (x.style && !lead.toLowerCase().includes(x.style.toLowerCase())) facts.push(`${cap(x.style)} gives the place its visual language.`);
  if (x.heritage) facts.push(heritageSentence(x.heritage));
  if (x.namedAfter && !/(?:idae|aceae|inae)$/i.test(x.namedAfter) && norm(x.namedAfter) !== norm(state)) facts.push(`It is named for ${x.namedAfter}.`);
  if (!facts.length && x.creator && !lead.includes(x.creator)) facts.push(`The work is credited to ${x.creator}.`);

  const ends = ENDINGS[x.c] || ENDINGS.oddity;
  let out = `${lead} ${facts.slice(0, 2).join(" ")} ${ends[hash(x.qid) % ends.length]}`.replace(/\s+/g, " ").trim();
  if (out.length < 180) out += ` ${WALK_FILLERS[hash(x.qid) % WALK_FILLERS.length]}`;
  if (out.length > 338) {
    out = `${lead} ${facts[0] || ""} ${ends[hash(x.qid) % ends.length]}`.replace(/\s+/g, " ").trim();
  }
  if (out.length > 338) out = out.slice(0, 334).replace(/\s+\S*$/, "") + ".";
  return asciiQuotes(out);
}

function claimValues(entity, prop) {
  return ((entity.claims && entity.claims[prop]) || [])
    .map((c) => c.mainsnak && c.mainsnak.datavalue && c.mainsnak.datavalue.value)
    .filter(Boolean);
}
function claimIds(entity, prop) {
  return claimValues(entity, prop).map((v) => v && v.id).filter(Boolean);
}
function claimYear(entity) {
  const v = claimValues(entity, "P571")[0] || claimValues(entity, "P1619")[0];
  if (!v || !v.time) return null;
  const m = v.time.match(/^([+-])(\d{4,})-/);
  if (!m || m[1] === "-") return null;
  const y = +m[2];
  return y > 900 && y <= new Date().getUTCFullYear() ? y : null;
}

async function entities(ids, props = "claims|labels|descriptions") {
  const out = {};
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    const u = "https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&origin=*&languages=en&props=" +
      encodeURIComponent(props) + "&ids=" + encodeURIComponent(batch.join("|"));
    Object.assign(out, (await getJson(u)).entities || {});
    await sleep(120);
  }
  return out;
}

async function wikiExtracts(items) {
  const out = {}, cache = {};
  if (fs.existsSync(WIKI_EXTRACT_CACHE)) Object.assign(cache, JSON.parse(fs.readFileSync(WIKI_EXTRACT_CACHE, "utf8")));
  else if (fs.existsSync(STATE_DIR)) {
    for (const file of fs.readdirSync(STATE_DIR).filter((x) => x.endsWith(".json"))) {
      for (const x of JSON.parse(fs.readFileSync(path.join(STATE_DIR, file), "utf8"))) {
        if (x._meta && x._meta.qid && x._meta.source_excerpt) cache[x._meta.qid] = x._meta.source_excerpt;
      }
    }
  }
  const pending = [];
  for (const x of items) {
    if (cache[x.qid]) out[norm(x.articleTitle)] = cache[x.qid];
    else pending.push(x);
  }
  for (let i = 0; i < pending.length; i += 20) {
    const batch = pending.slice(i, i + 20);
    const titles = batch.map((x) => x.articleTitle).join("|");
    const u = "https://en.wikipedia.org/w/api.php?action=query&format=json&origin=*&redirects=1&prop=extracts&exintro=1&explaintext=1&exsentences=3&titles=" + encodeURIComponent(titles);
    try {
      const j = await getJson(u);
      const aliases = {};
      for (const a of [...((j.query && j.query.normalized) || []), ...((j.query && j.query.redirects) || [])]) aliases[norm(a.from)] = norm(a.to);
      const pageExtracts = {};
      for (const p of Object.values((j.query && j.query.pages) || {})) {
        if (!p.title || !p.extract) continue;
        pageExtracts[norm(p.title)] = p.extract.replace(/\s+/g, " ").trim();
      }
      for (const x of batch) {
        const requested = norm(x.articleTitle);
        let resolved = requested;
        for (let hops = 0; aliases[resolved] && hops < 5; hops++) resolved = aliases[resolved];
        if (pageExtracts[resolved]) out[requested] = cache[x.qid] = pageExtracts[resolved];
      }
    } catch { /* research excerpt is useful, not required for app validity */ }
    await sleep(150);
  }
  fs.mkdirSync(RAW_DIR, { recursive: true });
  fs.writeFileSync(WIKI_EXTRACT_CACHE, JSON.stringify(cache));
  return out;
}

async function stateMembership(rows, state) {
  const found = new Map();
  for (let i = 0; i < rows.length; i += 250) {
    const ids = rows.slice(i, i + 250).map((x) => `wd:${x.qid}`).join(" ");
    const q = `PREFIX wd: <http://www.wikidata.org/entity/>
      PREFIX wdt: <http://www.wikidata.org/prop/direct/>
      PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
      SELECT DISTINCT ?item ?adminLabel WHERE {
        VALUES ?item { ${ids} }
        ?item wdt:P131* wd:${state.qid}.
        OPTIONAL {
          ?item wdt:P131 ?admin.
          ?admin wdt:P131* wd:${state.qid}; rdfs:label ?adminLabel.
          FILTER(LANG(?adminLabel)="en")
        }
      }`;
    const j = await sparql(q);
    for (const b of j.results.bindings) {
      const qid = b.item.value.split("/").pop(), label = b.adminLabel && b.adminLabel.value;
      if (!found.has(qid) || (!found.get(qid) && label)) found.set(qid, label || "");
    }
  }
  return found;
}

function labelsFor(ids, labelEntities) {
  return ids.map((id) => labelEntities[id] && labelEntities[id].labels && labelEntities[id].labels.en && labelEntities[id].labels.en.value).filter(Boolean);
}

function existingCityFor(lat, lng, cities) {
  const inside = cities.filter((c) => lng >= c.bbox[0] && lng <= c.bbox[2] && lat >= c.bbox[1] && lat <= c.bbox[3]);
  if (!inside.length) return null;
  // Prefer the tightest existing metro over broad legacy regions.
  inside.sort((a, b) => ((a.bbox[2] - a.bbox[0]) * (a.bbox[3] - a.bbox[1])) - ((b.bbox[2] - b.bbox[0]) * (b.bbox[3] - b.bbox[1])));
  return inside[0].id;
}

async function structuredFacts(rows) {
  const values = rows.map((x) => `wd:${x.qid}`).join(" ");
  const q = `PREFIX wd: <http://www.wikidata.org/entity/>
    PREFIX wdt: <http://www.wikidata.org/prop/direct/>
    PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
    SELECT ?item ?kind ?value ?valueLabel WHERE {
      VALUES ?item { ${values} }
      VALUES (?property ?kind) {
        (wdt:P571 "inception") (wdt:P1619 "completion")
        (wdt:P84 "architect") (wdt:P149 "style") (wdt:P1435 "heritage")
        (wdt:P138 "namedAfter") (wdt:P170 "creator")
      }
      ?item ?property ?value.
      OPTIONAL { ?value rdfs:label ?valueLabel. FILTER(LANG(?valueLabel)="en") }
    }`;
  const j = await sparql(q), out = new Map(rows.map((x) => [x.qid, {
    inception: [], completion: [], architect: [], style: [], heritage: [], namedAfter: [], creator: [],
  }]));
  for (const b of j.results.bindings) {
    const qid = b.item.value.split("/").pop(), kind = b.kind.value, f = out.get(qid);
    if (!f) continue;
    if (kind === "inception" || kind === "completion") f[kind].push(b.value.value);
    else if (b.valueLabel) f[kind].push(b.valueLabel.value);
  }
  return out;
}

function factYear(values) {
  const years = values.map((v) => String(v).match(/^\+?(\d{4,})-/)).filter(Boolean).map((m) => +m[1])
    .filter((y) => y > 900 && y <= new Date().getUTCFullYear());
  return years.length ? Math.min(...years) : null;
}

function globalDuplicate(x, points) {
  const nn = norm(x.n);
  for (const p of points) {
    if (nn === norm(p.n) && x.city && p.city === x.city && !x.city.startsWith("us-")) return `same name in ${x.city}: ${p.n}`;
    const d = M.haversineM(x.lat, x.lng, p.lat, p.lng);
    if (d < 80) return `${Math.round(d)}m from ${p.n}`;
    if (d < 3000 && nn === norm(p.n)) return `same name ${Math.round(d)}m from ${p.n}`;
  }
  return null;
}

function categoryCap(c, relaxed = 0) {
  const base = { history: 8, church: 4, museum: 6, park: 4, monument: 4, castle: 4,
    death: 4, industrial: 4, maritime: 4, artgallery: 4, oddity: 5, stadium: 1 };
  if (c === "stadium") return 1;
  return (base[c] || 3) + relaxed;
}

function selectBalanced(rows, wanted) {
  const selected = [], used = new Set(), cats = {}, groups = {};
  for (const relax of [0, 2, 5, 99]) {
    for (const x of rows) {
      if (selected.length >= wanted) break;
      if (used.has(x.qid)) continue;
      const g = norm(x.group || x.area || "unknown");
      if ((cats[x.c] || 0) >= categoryCap(x.c, relax)) continue;
      if ((groups[g] || 0) >= 4 + relax) continue;
      selected.push(x); used.add(x.qid); cats[x.c] = (cats[x.c] || 0) + 1; groups[g] = (groups[g] || 0) + 1;
    }
    if (selected.length >= wanted) break;
  }
  return selected;
}

async function enrichSelected(rows, state) {
  const structured = await structuredFacts(rows);
  const extracts = await wikiExtracts(rows);
  return rows.map((x) => {
    const f = structured.get(x.qid) || {};
    const out = {
      ...x, year: factYear(f.inception || []) || factYear(f.completion || []),
      architect: [...new Set(f.architect || [])].slice(0, 2).join(" and "),
      style: [...new Set(f.style || [])][0] || "",
      heritage: [...new Set(f.heritage || [])][0] || "",
      namedAfter: [...new Set(f.namedAfter || [])][0] || "",
      creator: [...new Set(f.creator || [])].slice(0, 2).join(" and "),
      sourceExcerpt: extracts[norm(x.articleTitle)] || "",
    };
    out.s = hookOf(out, state.name);
    out.w = writeupOf(out, state.name);
    return out;
  });
}

async function harvestState(state, feature, basePoints, usCities) {
  const finalPath = path.join(STATE_DIR, state.abbr + ".json");
  if (has("--resume") && fs.existsSync(finalPath)) {
    const done = JSON.parse(fs.readFileSync(finalPath, "utf8"));
    if (done.length === target && done.every((x) => x._meta && x._meta.generator_version === GENERATOR_VERSION)) {
      return { rows: done, eligible: done.length, raw: "checkpoint", rejected: { boundary: 0, type: 0, duplicate: 0 } };
    }
  }
  const rawPath = path.join(RAW_DIR, state.abbr + ".json");
  let bindings;
  if (fs.existsSync(rawPath) && !has("--refresh")) bindings = JSON.parse(fs.readFileSync(rawPath, "utf8"));
  else {
    const boxes = queryBoxes(state);
    bindings = [];
    for (let i = 0; i < boxes.length; i++) {
      if (boxes.length > 1) process.stderr.write(`[${state.abbr}] source tile ${i + 1}/${boxes.length}\n`);
      const j = await sparql(stateQuery(state, boxes[i]));
      bindings.push(...j.results.bindings);
    }
    fs.mkdirSync(RAW_DIR, { recursive: true });
    fs.writeFileSync(rawPath, JSON.stringify(bindings));
  }

  const byQid = new Map();
  for (const b of bindings) {
    const qid = b.item.value.split("/").pop();
    if (byQid.has(qid)) continue;
    const x = {
      qid, n: b.itemLabel.value, description: b.itemDescription ? b.itemDescription.value : "",
      lat: +(+b.lat.value).toFixed(5), lng: +(+b.lng.value).toFixed(5),
      sitelinks: +b.sitelinks.value, types: b.types ? b.types.value : "",
      area: b.adminLabel ? b.adminLabel.value : state.name,
      article: b.article.value, articleTitle: decodeURIComponent((b.article.value.split("/wiki/")[1] || "").replace(/_/g, " ")),
    };
    byQid.set(qid, x);
  }

  const rejected = { boundary: 0, type: 0, duplicate: 0 };
  let rows = [...byQid.values()].filter((x) => {
    if (state.abbr === "AK" && x.lng > 0) { rejected.boundary++; return false; }
    if (!inGeometry(x.lng, x.lat, feature.geometry)) { rejected.boundary++; return false; }
    if (!candidateFilter(x)) { rejected.type++; return false; }
    x.city = existingCityFor(x.lat, x.lng, usCities) || `us-${state.abbr.toLowerCase()}`;
    const dup = globalDuplicate(x, basePoints);
    if (dup) { rejected.duplicate++; x.duplicate = dup; return false; }
    return true;
  });
  rows.forEach((x) => {
    x.c = categoryOf(x); x.score = scoreOf(x);
    x.group = x.city.startsWith("us-") ? x.area : x.city;
  });
  rows.sort((a, b) => b.score - a.score || b.sitelinks - a.sitelinks || a.n.localeCompare(b.n));

  // Validate the ranked pool in fixed-ID batches. This is much faster than
  // traversing P131* inside a dense geospatial query and catches border-edge
  // or historically moved entities before selection.
  const verified = [];
  let chosen = [];
  for (let i = 0; i < rows.length && chosen.length < target; i += 400) {
    const batch = rows.slice(i, i + 400);
    const members = await stateMembership(batch, state);
    for (const x of batch) {
      if (!members.has(x.qid)) continue;
      if (members.get(x.qid)) x.area = members.get(x.qid);
      x.group = x.city.startsWith("us-") ? x.area : x.city;
      const dup = globalDuplicate(x, verified);
      if (dup) { rejected.duplicate++; continue; }
      verified.push(x);
    }
    chosen = selectBalanced(verified, target);
  }
  rows = verified;
  if (chosen.length < target) throw new Error(`${state.name}: only ${chosen.length}/${target} eligible candidates; lower --target or widen discovery`);
  const enriched = await enrichSelected(chosen, state);
  const out = enriched.map((x) => ({
    id: `us${state.abbr.toLowerCase()}${x.qid.toLowerCase()}`,
    n: x.n, a: x.area || state.name, pc: "", lat: x.lat, lng: x.lng, c: x.c,
    s: x.s, q: `${x.n} ${state.name}`, w: x.w, city: x.city,
    _meta: {
      state: state.name, state_abbr: state.abbr, qid: x.qid,
      generator_version: GENERATOR_VERSION,
      score: x.score, sitelinks: x.sitelinks, types: x.types.split("|").filter(Boolean),
      facts: [
        x.description && `Wikidata description: ${x.description}`,
        x.year && `Inception/opening year: ${x.year}`,
        x.architect && `Architect: ${x.architect}`,
        x.style && `Architectural style: ${x.style}`,
        x.heritage && `Heritage designation: ${x.heritage}`,
        x.namedAfter && `Named after: ${x.namedAfter}`,
        x.creator && `Creator: ${x.creator}`,
      ].filter(Boolean),
      sources: [x.article, `https://www.wikidata.org/wiki/${x.qid}`],
      source_excerpt: x.sourceExcerpt,
      quality: "d",
    },
  }));

  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(finalPath, JSON.stringify(out, null, 1) + "\n");
  return { rows: out, eligible: rows.length, raw: byQid.size, rejected };
}

function scriptBodyOf(html) {
  const o = html.indexOf("<script>"), c = html.indexOf("</script>", o + 8);
  if (o < 0 || c < 0) throw new Error("could not locate app script");
  return { body: html.slice(o + 8, c), offset: o + 8 };
}
function findDeclarator(ast, name, type) {
  let hit = null;
  (function walk(n) {
    if (!n || typeof n.type !== "string" || hit) return;
    if (n.type === "VariableDeclarator" && n.id && n.id.name === name && n.init && n.init.type === type) { hit = n; return; }
    for (const k in n) {
      const v = n[k];
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v.type === "string") walk(v);
    }
  })(ast);
  return hit;
}
function num(n) { return Number.isInteger(n) ? String(n) : String(+n.toFixed(5)); }

function addStateRegions(states) {
  let html = fs.readFileSync(TEMPLATE, "utf8");
  const { body, offset } = scriptBodyOf(html);
  const ast = acorn.parse(body, { ecmaVersion: "latest" });
  const ci = findDeclarator(ast, "Ci", "ArrayExpression");
  if (!ci) throw new Error("could not parse Ci registry");
  const existing = new Set(ci.init.elements.map((el) => {
    if (!el || el.type !== "ObjectExpression") return null;
    const p = el.properties.find((x) => x.key && (x.key.name === "id" || x.key.value === "id"));
    return p && p.value && p.value.value;
  }).filter(Boolean));
  const missing = states.filter((s) => !existing.has(`us-${s.abbr.toLowerCase()}`));
  if (!missing.length) return 0;
  const items = missing.map((s) => `{id:"us-${s.abbr.toLowerCase()}",name:${JSON.stringify(s.name)},label:${JSON.stringify(s.name)},e:"🇺🇸",lat:${num(s.lat)},lng:${num(s.lng)},bbox:[${s.bbox.map(num).join(",")}],region:1,blurb:${JSON.stringify(`Storied streets, local landmarks and worthwhile detours across ${s.name}.`)}}`);
  const at = offset + ci.init.end - 1;
  html = html.slice(0, at) + "," + items.join(",") + html.slice(at);
  fs.writeFileSync(TEMPLATE, html);
  return missing.length;
}

function serializeQuality(o) {
  const flags = Object.entries(o.flags).map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(",\n");
  const notable = o.notable.map((id) => `  ${JSON.stringify(id)}`).join(",\n");
  return `{\n "generated": ${JSON.stringify(o.generated)},\n "baseline": ${o.baseline},\n "counts": ${JSON.stringify(o.counts)},\n "flags": {\n${flags}\n },\n "notable": [\n${notable}\n ]\n}\n`;
}

function applyRows(states, rows) {
  if (rows.length !== states.length * target) throw new Error(`refusing apply: ${rows.length} rows, expected ${states.length * target}`);
  const regionAdds = addStateRegions(states);
  const clean = rows.map((x) => {
    const { _meta, ...z } = x;
    return z;
  });
  const old = JSON.parse(fs.readFileSync(SPOTS, "utf8"));
  const priorGenerated = old.filter((z) => isGeneratedUsId(z.id));
  const base = old.filter((z) => !isGeneratedUsId(z.id));
  const taken = new Set(base.map((z) => z.id));
  for (const z of clean) {
    if (taken.has(z.id)) throw new Error(`duplicate id on apply: ${z.id}`);
    taken.add(z.id);
  }
  fs.writeFileSync(SPOTS, JSON.stringify(base.concat(clean), null, 1) + "\n");

  const q = JSON.parse(fs.readFileSync(QUALITY, "utf8"));
  for (const id of Object.keys(q.flags)) if (isGeneratedUsId(id)) delete q.flags[id];
  for (const z of clean) q.flags[z.id] = "d";
  q.notable = [...new Set([...(q.notable || []).filter((id) => !isGeneratedUsId(id)), ...clean.map((z) => z.id)])].sort();
  q.baseline = base.length + clean.length;
  q.generated = new Date().toISOString();
  const vals = Object.values(q.flags);
  q.counts = { a: vals.filter((x) => x === "a").length, v: vals.filter((x) => x === "v").length,
    d: vals.filter((x) => x === "d").length, m: vals.filter((x) => x === "m").length, notable: q.notable.length };
  fs.writeFileSync(QUALITY, serializeQuality(q));

  const manifest = JSON.parse(fs.readFileSync(WIKIDATA_ENRICHED, "utf8"));
  fs.writeFileSync(WIKIDATA_ENRICHED, JSON.stringify([...new Set(manifest.filter((id) => !isGeneratedUsId(id)).concat(clean.map((z) => z.id)))]) + "\n");

  let build = fs.readFileSync(BUILD, "utf8");
  build = build.replace(/(BASELINE\s*=\s*\{\s*entries:\s*)\d+/, `$1${base.length + clean.length}`);
  fs.writeFileSync(BUILD, build);
  return { regionAdds, old: old.length, replaced: priorGenerated.length, added: clean.length, total: base.length + clean.length };
}

async function mapLimit(items, n, fn) {
  const out = new Array(items.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

async function main() {
  if (!has("--all") && !onlyState && !applying) {
    console.error("usage: --all [--target 40] | --state AL [--target 40] | --apply");
    process.exit(1);
  }
  fs.mkdirSync(OUT, { recursive: true });
  const [geo, stateIds] = await Promise.all([stateGeo(), stateQids()]);
  const states = stateRegistry(geo, stateIds);
  const features = new Map(geo.features.map((f) => [f.properties.name, f]));
  for (const s of states) {
    const f = features.get(s.name);
    if (!f) throw new Error(`no boundary for ${s.name}`);
    if (!s.qid) throw new Error(`no Wikidata state id for ${s.name}`);
    s.bbox = boundsOf(f.geometry, s.abbr);
    s.lng = +((s.bbox[0] + s.bbox[2]) / 2).toFixed(4);
    s.lat = +((s.bbox[1] + s.bbox[3]) / 2).toFixed(4);
  }
  const selectedStates = states.filter((s) => !onlyState || s.abbr === onlyState);
  if (!selectedStates.length) throw new Error(`unknown state ${onlyState}`);

  const catalogue = JSON.parse(fs.readFileSync(SPOTS, "utf8")).filter((z) => !isGeneratedUsId(z.id));
  const basePoints = catalogue.map((z) => ({ n: z.n, lat: z.lat, lng: z.lng, city: z.city }));
  const model = M.loadModel();
  // Only existing US city/region entries are candidates for assignment. Country
  // flag is not exposed by model.js, so use the conservative continental bounds
  // and exclude known non-US global centres by checking the current US spot set.
  const usCityIds = new Set(catalogue.filter((z) => z.lat >= 18 && z.lat <= 72 && z.lng >= -180 && z.lng <= -65).map((z) => z.city));
  const usCities = model.cities.filter((c) => usCityIds.has(c.id) && !c.id.startsWith("us-"));

  const existingByState = {};
  for (const s of states) existingByState[s.abbr] = 0;
  for (const z of catalogue) {
    for (const s of states) {
      const f = features.get(s.name);
      if ((s.abbr !== "AK" || z.lng <= 0) && inGeometry(z.lng, z.lat, f.geometry)) { existingByState[s.abbr]++; break; }
    }
  }

  let results;
  if (applying) {
    results = selectedStates.map((s) => {
      const file = path.join(STATE_DIR, s.abbr + ".json");
      if (!fs.existsSync(file)) throw new Error(`missing ${path.relative(ROOT, file)}; harvest --all first`);
      return { state: s, rows: JSON.parse(fs.readFileSync(file, "utf8")) };
    });
  } else {
    results = await mapLimit(selectedStates, 1, async (s) => {
      const f = features.get(s.name);
      process.stderr.write(`[${s.abbr}] harvesting ${s.name}...\n`);
      const r = await harvestState(s, f, basePoints, usCities);
      process.stderr.write(`[${s.abbr}] ${r.rows.length} selected from ${r.eligible} eligible (${r.raw} source items)\n`);
      return { state: s, ...r };
    });
  }

  const allRows = results.flatMap((r) => r.rows);
  const summary = {
    generated: new Date().toISOString(), target_per_state: target, additions: allRows.length,
    methodology: "Wikidata/Wikipedia-backed, state-boundary checked, globally spatial-deduped, category and locality balanced; writeups are structured-fact drafts pending review.",
    sources: [STATES_GEOJSON, SPARQL_ENDPOINT, "https://en.wikipedia.org/"],
    states: results.map((r) => ({ abbr: r.state.abbr, name: r.state.name, existing: existingByState[r.state.abbr], drafted: r.rows.length,
      categories: Object.fromEntries(Object.entries(r.rows.reduce((o, x) => (o[x.c] = (o[x.c] || 0) + 1, o), {})).sort((a, b) => b[1] - a[1])) })),
  };
  fs.writeFileSync(path.join(OUT, "summary.json"), JSON.stringify(summary, null, 1) + "\n");
  fs.writeFileSync(path.join(OUT, "candidates.json"), JSON.stringify(allRows, null, 1) + "\n");
  if (!fs.existsSync(path.join(OUT, "README.md"))) {
    fs.writeFileSync(path.join(OUT, "README.md"), "# US 2,000-place draft\n\nGenerated by `node tools/harvest-us-walk-spots.js --all --target 40`. Every row has an English Wikipedia article, a Wikidata entity and coordinates validated inside its state boundary. App prose is a machine draft (`d`) built only from Wikidata structured facts and remains pending review. `.raw/` is an untracked request cache.\n");
  }

  if (applying) {
    const applied = applyRows(states, allRows);
    console.log(JSON.stringify({ ...applied, states: states.length }, null, 2));
  } else {
    console.log(`wrote ${allRows.length} candidates across ${results.length} state(s) → ${path.relative(ROOT, OUT)}`);
  }
}

main().catch((e) => { console.error("✗ " + (e.stack || e.message)); process.exit(1); });
