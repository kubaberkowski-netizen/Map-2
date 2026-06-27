# Flâneur — discovery places layer (storied + restaurants)

A **separate, toggleable layer** of nearby places — kept distinct from the curated
catalogue (which stays the hand-written, owner-voiced core). Goal is *quality*, not
coverage: storied/notable places and good independent food, not chains.

Sources (each dedupes independently via `ext_id` prefix, same as events):
- **Wikidata** (`wd:`) — keyless. Heritage sites, monuments, museums, archaeological
  sites, public sculpture, castles. The on-brand, storied layer. **Built.**
- **Foursquare** (`fsq:`) — needs a free key. Quality restaurants/cafés/bars,
  filtered by rating/independence. **Next (phase 2).**

## Table (run in Supabase SQL editor)
```sql
create table public.places (
  id uuid primary key default gen_random_uuid(),
  ext_id text unique,                         -- 'wd:Q123' / 'fsq:...'
  name text not null,
  category text,
  description text,
  lat double precision,
  lng double precision,
  city text,                                  -- city slug
  url text,
  image text,
  source text default 'wikidata',
  status text not null default 'approved',
  created_at timestamptz default now()
);
alter table public.places enable row level security;
create policy "places public read" on public.places for select using (status = 'approved');
create index places_city_idx on public.places (city);
```

## Ingest (GitHub Actions, no terminal)
- **Wikidata** — `scripts/ingest-wikidata.mjs` + `ingest-wikidata.yml`. Keyless;
  reuses `SUPABASE_SERVICE_ROLE_KEY`. Weekly (places are static). After the table
  exists, trigger it once to populate.
- **Foursquare** — phase 2: a `scripts/ingest-foursquare.mjs` filtered to high-rating
  food, gated on a `FOURSQUARE_KEY` repo secret.

## Display (next build)
A toggleable "✦ Storied nearby" / "🍽 Food nearby" layer on the discovery map —
distinct pin style from curated spots, off by default so the curated map stays the
hero. Wired the same way as the events map layer. (Deliberately held until the data
is in, so we can eyeball quality before surfacing it.)

---

## Enrichment: ratings · hours · photos (phase 2.1)

The client now **displays** `rating`, `hours` and `image` on discovery places
(Nearby finds rows show a thumbnail + ★rating; the place sheet shows ★rating +
🕒 hours) whenever those fields are present — so populating them lights up the UI
with no further client work.

Add the columns once (SQL editor):
```sql
alter table public.places add column if not exists rating     numeric;   -- e.g. 8.6 (FSQ) or 4.5 (stars)
alter table public.places add column if not exists popularity numeric;   -- 0..1 optional
alter table public.places add column if not exists hours      text;      -- OSM-style "Mo-Su 10:00-17:00"
-- image already exists
```

Foursquare ingest (`scripts/ingest-foursquare.mjs`, GitHub Action, gated on a
`FOURSQUARE_KEY` secret) **now does this**: per place it sets `rating` (FSQ
`rating`, 0–10), `popularity` (FSQ `popularity`, 0–1), `hours` (`hours.display`,
human-readable — the client renders it as plain text after 🕒, no parsing), and
`image` (`photos[0]` prefix + `400x400` + suffix). It filters to the food
category, **independent venues** (drops anything with a non-empty `chains` array)
and **high rating** (≥ 7.5). These are premium FSQ fields that consume API
credits; a **free-tier key returns them as null**, in which case the rating filter
is skipped and the script degrades to names + map pins (as before). Same
`ext_id='fsq:<id>'` dedup. **Run the columns SQL above before the first enriched
ingest** (the upsert sends `rating`/`popularity`/`hours`, so missing columns =
error). Wikidata places can borrow a Commons image for `image` similarly.
