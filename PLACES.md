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
