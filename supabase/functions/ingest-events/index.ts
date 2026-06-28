// ingest-events — seed the events feed from the Ticketmaster Discovery API,
// one geo-query per Flâneur city. Upserts into the `events` table by ext_id
// (no duplicates). Single-file (city list inlined) so it can be deployed by
// pasting into the Supabase dashboard function editor — no second file needed.
// Runs on a cron (see EVENTS.md §Ingest).
// Deploy:  paste into a dashboard function named "ingest-events"
//          (or: supabase functions deploy ingest-events)
// Secrets: TICKETMASTER_KEY  (+ optional INGEST_STATUS=pending to review first)
//          SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are injected automatically.
import { createClient } from "npm:@supabase/supabase-js@2";

const TM = Deno.env.get("TICKETMASTER_KEY")!;
const STATUS = Deno.env.get("INGEST_STATUS") || "approved"; // 'approved' | 'pending'
const RADIUS = 15; // km around each city centre
const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

const cities: Array<{ slug: string; lat: number; lng: number }> = [{slug:"london",lat:51.5132,lng:-0.1267},{slug:"fes",lat:34.0181,lng:-5.0078},{slug:"tangier",lat:35.7595,lng:-5.834},{slug:"essaouira",lat:31.5085,lng:-9.7595},{slug:"chefchaouen",lat:35.1688,lng:-5.2636},{slug:"casablanca",lat:33.5731,lng:-7.5898},{slug:"meknes",lat:33.8935,lng:-5.5473},{slug:"tetouan",lat:35.5785,lng:-5.3684},{slug:"asilah",lat:35.465,lng:-6.035},{slug:"strasbourg",lat:48.5734,lng:7.7521},{slug:"bordeaux",lat:44.8378,lng:-0.5792},{slug:"nantes",lat:47.2184,lng:-1.5536},{slug:"toulouse",lat:43.6047,lng:1.4442},{slug:"nice",lat:43.7102,lng:7.262},{slug:"lille",lat:50.6292,lng:3.0573},{slug:"johannesburg",lat:-26.15,lng:28.03},{slug:"como",lat:45.9,lng:9.15},{slug:"osaka",lat:34.6937,lng:135.5023},{slug:"kyoto",lat:35.0116,lng:135.7681},{slug:"bangkok",lat:13.7563,lng:100.5018},{slug:"hanoi",lat:21.0285,lng:105.8542},{slug:"taipei",lat:25.033,lng:121.5654},{slug:"granada",lat:37.1773,lng:-3.5986},{slug:"reykjavik",lat:64.1466,lng:-21.9426},{slug:"turin",lat:45.0703,lng:7.6869},{slug:"antwerp",lat:51.2194,lng:4.4025},{slug:"wroclaw",lat:51.1079,lng:17.0385},{slug:"valletta",lat:35.8989,lng:14.5146},{slug:"tbilisi",lat:41.7151,lng:44.8271},{slug:"cairo",lat:30.0444,lng:31.2357},{slug:"marrakech",lat:31.6295,lng:-7.9811},{slug:"delhi",lat:28.6139,lng:77.209},{slug:"rio",lat:-22.9068,lng:-43.1729},{slug:"lima",lat:-12.0464,lng:-77.0428},{slug:"auckland",lat:-36.8485,lng:174.7633},{slug:"monaco",lat:43.7384,lng:7.4246},{slug:"capetown",lat:-33.9249,lng:18.4241},{slug:"dakar",lat:14.7167,lng:-17.4677},{slug:"rabat",lat:34.0209,lng:-6.8416},{slug:"manchester",lat:53.4794,lng:-2.2453},{slug:"liverpool",lat:53.4084,lng:-2.9794},{slug:"glasgow",lat:55.8617,lng:-4.2583},{slug:"bristol",lat:51.4545,lng:-2.5879},{slug:"paris",lat:48.8566,lng:2.3522},{slug:"rome",lat:41.9028,lng:12.4964},{slug:"vienna",lat:48.2082,lng:16.3738},{slug:"berlin",lat:52.52,lng:13.405},{slug:"amsterdam",lat:52.3676,lng:4.9041},{slug:"lisbon",lat:38.7223,lng:-9.1393},{slug:"madrid",lat:40.4168,lng:-3.7038},{slug:"dublin",lat:53.3498,lng:-6.2603},{slug:"edinburgh",lat:55.9533,lng:-3.1883},{slug:"prague",lat:50.0755,lng:14.4378},{slug:"budapest",lat:47.4979,lng:19.0402},{slug:"warsaw",lat:52.2297,lng:21.0122},{slug:"krakow",lat:50.0647,lng:19.945},{slug:"copenhagen",lat:55.6761,lng:12.5683},{slug:"stockholm",lat:59.3293,lng:18.0686},{slug:"oslo",lat:59.9139,lng:10.7522},{slug:"helsinki",lat:60.1699,lng:24.9384},{slug:"barcelona",lat:41.3851,lng:2.1734},{slug:"milan",lat:45.4642,lng:9.19},{slug:"naples",lat:40.8518,lng:14.2681},{slug:"athens",lat:37.9838,lng:23.7275},{slug:"nyc",lat:40.7128,lng:-74.006},{slug:"tokyo",lat:35.6762,lng:139.6503},{slug:"sanfrancisco",lat:37.7749,lng:-122.4194},{slug:"istanbul",lat:41.0082,lng:28.9784},{slug:"birmingham",lat:52.4862,lng:-1.8904},{slug:"leeds",lat:53.8008,lng:-1.5491},{slug:"newcastle",lat:54.9783,lng:-1.6178},{slug:"cardiff",lat:51.4816,lng:-3.1791},{slug:"belfast",lat:54.5973,lng:-5.9301},{slug:"brighton",lat:50.8225,lng:-0.1372},{slug:"sheffield",lat:53.3811,lng:-1.4701},{slug:"brussels",lat:50.8503,lng:4.3517},{slug:"munich",lat:48.1351,lng:11.582},{slug:"hamburg",lat:53.5511,lng:9.9937},{slug:"zurich",lat:47.3769,lng:8.5417},{slug:"lyon",lat:45.764,lng:4.8357},{slug:"marseille",lat:43.2965,lng:5.3698},{slug:"florence",lat:43.7696,lng:11.2558},{slug:"venice",lat:45.4408,lng:12.3155},{slug:"seville",lat:37.3891,lng:-5.9845},{slug:"porto",lat:41.1579,lng:-8.6291},{slug:"valencia",lat:39.4699,lng:-0.3763},{slug:"rotterdam",lat:51.9244,lng:4.4777},{slug:"gdansk",lat:54.352,lng:18.6466},{slug:"bucharest",lat:44.4268,lng:26.1025},{slug:"sofia",lat:42.6977,lng:23.3219},{slug:"zagreb",lat:45.815,lng:15.9819},{slug:"ljubljana",lat:46.0569,lng:14.5058},{slug:"tallinn",lat:59.437,lng:24.7536},{slug:"riga",lat:56.9496,lng:24.1052},{slug:"vilnius",lat:54.6872,lng:25.2797},{slug:"belgrade",lat:44.7866,lng:20.4489},{slug:"thessaloniki",lat:40.6401,lng:22.9444},{slug:"sarajevo",lat:43.8563,lng:18.4131},{slug:"sardinia",lat:40,lng:9},{slug:"brisbane",lat:-27.4698,lng:153.0251},{slug:"nashville",lat:36.1627,lng:-86.7816},{slug:"houston",lat:29.7604,lng:-95.3698},{slug:"orlando",lat:28.5384,lng:-81.3789},{slug:"sanantonio",lat:29.4241,lng:-98.4936},{slug:"losangeles",lat:34.0522,lng:-118.2437},{slug:"chicago",lat:41.8781,lng:-87.6298},{slug:"toronto",lat:43.6532,lng:-79.3832},{slug:"montreal",lat:45.5017,lng:-73.5673},{slug:"mexicocity",lat:19.4326,lng:-99.1332},{slug:"buenosaires",lat:-34.6037,lng:-58.3816},{slug:"sydney",lat:-33.8688,lng:151.2093},{slug:"melbourne",lat:-37.8136,lng:144.9631},{slug:"singapore",lat:1.3521,lng:103.8198},{slug:"hongkong",lat:22.3193,lng:114.1694},{slug:"seoul",lat:37.5665,lng:126.978}];

function category(seg?: string) {
  const s = (seg || "").toLowerCase();
  if (s.includes("music")) return "Music";
  if (s.includes("sport")) return "Sport";
  if (s.includes("arts") || s.includes("theatre") || s.includes("theater")) return "Arts";
  if (s.includes("film")) return "Film";
  return "Event";
}

// A short description: prefer Ticketmaster's own copy, else synthesise a
// non-redundant genre line (genre/subGenre aren't shown in the card meta).
function describe(e: any): string | null {
  const own = (e.info || e.pleaseNote || "").trim();
  if (own) return own.length > 300 ? own.slice(0, 297) + "…" : own;
  const cl = e.classifications?.[0];
  const parts = [cl?.genre?.name, cl?.subGenre?.name]
    .filter((x: string) => x && x !== "Undefined" && x !== "Other");
  return parts.length ? parts.join(" · ") : null;
}

Deno.serve(async () => {
  if (!TM) return new Response(JSON.stringify({ error: "TICKETMASTER_KEY not set" }), { status: 500 });
  let upserted = 0, cityHits = 0;
  for (const c of cities) {
    const u = `https://app.ticketmaster.com/discovery/v2/events.json?apikey=${TM}` +
      `&latlong=${c.lat},${c.lng}&radius=${RADIUS}&unit=km&size=50&sort=date,asc`;
    let data: any;
    try { const r = await fetch(u); if (!r.ok) { await sleep(220); continue; } data = await r.json(); }
    catch { await sleep(220); continue; }

    const evs = data?._embedded?.events || [];
    const rows = evs.map((e: any) => {
      const v = e._embedded?.venues?.[0];
      const start = e.dates?.start?.dateTime || (e.dates?.start?.localDate ? `${e.dates.start.localDate}T19:00:00Z` : null);
      return {
        ext_id: "tm:" + e.id,
        name: e.name,
        description: describe(e),
        category: category(e.classifications?.[0]?.segment?.name),
        venue: v?.name || null,
        lat: v?.location ? +v.location.latitude : null,
        lng: v?.location ? +v.location.longitude : null,
        city: c.slug,
        start_at: start,
        end_at: e.dates?.end?.dateTime || start,
        url: e.url || null,
        image: e.images?.find((i: any) => i.width >= 640)?.url || e.images?.[0]?.url || null,
        source: "ticketmaster",
        status: STATUS,
      };
    }).filter((x: any) => x.name && isFinite(x.lat) && isFinite(x.lng) && x.start_at);

    if (rows.length) {
      const { error } = await sb.from("events").upsert(rows, { onConflict: "ext_id" });
      if (!error) { upserted += rows.length; cityHits++; }
    }
    await sleep(220); // stay under Ticketmaster's 5 req/s
  }
  return new Response(JSON.stringify({ upserted, cities_with_events: cityHits }), {
    headers: { "Content-Type": "application/json" },
  });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
