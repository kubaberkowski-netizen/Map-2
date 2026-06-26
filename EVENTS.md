# Flâneur — events + user submissions

Events are **fundamentally different from spots**: spots are evergreen and baked
into the static build; events are time-bound and must be a **live Supabase feed**
fetched at runtime (additive, after the synchronous boot — offline-first intact).
Expired events disappear for free (the query filters `end_at >= now()`).

Pipeline: **submit → moderate → publish.** Submissions land `pending`; you approve
in the Supabase Table Editor (flip `status` to `approved`); only approved + future
events are publicly readable (enforced by RLS). Auto-ingest writes events directly.

## Build phases
1. **Foundation (done):** schema + RLS, `flEvents`/`flSubmit` API, in-app submission
   form (event + place) with paste-a-link auto-fill, sign-in gated, Curator analytics.
2. **Surfaces (next):** a "What's on nearby" strip on the home surface + a full
   **Events tab** (list + map, date-sorted Today / Weekend / Upcoming, filters).
3. **Server (next):** `parse-link` Edge Function (OpenGraph/JSON-LD auto-fill) +
   `ingest-events` Edge Function (Eventbrite / ICS feeds) on a cron, writing
   `status=approved, source=...` rows. Snap-a-flyer (LLM vision) is the phase-2 wow.

## Schema (run in Supabase SQL editor)
```sql
-- live events feed
create table public.events (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  category text,
  venue text,
  lat double precision,
  lng double precision,
  city text,                                 -- city slug (matches Ci)
  start_at timestamptz,
  end_at timestamptz,
  url text,
  image text,
  source text default 'submission',          -- submission | eventbrite | ics | ...
  status text not null default 'pending',    -- pending | approved | rejected
  submitted_by uuid references auth.users on delete set null,
  created_at timestamptz default now()
);
alter table public.events enable row level security;
create policy "events public read" on public.events for select
  using (status = 'approved' and (end_at is null or end_at >= now()));
create policy "events submit" on public.events for insert
  with check (auth.uid() = submitted_by and status = 'pending');
create index events_city_start_idx on public.events (city, start_at);

-- place suggestions feed the CURATED catalogue (reviewed, then promoted into
-- data/spots.json by hand — protects the owner's-voice rule). Not shown live.
create table public.place_submissions (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  area text,
  note text,
  lat double precision,
  lng double precision,
  city text,
  status text not null default 'pending',
  submitted_by uuid references auth.users on delete set null,
  created_at timestamptz default now()
);
alter table public.place_submissions enable row level security;
create policy "places submit" on public.place_submissions for insert
  with check (auth.uid() = submitted_by and status = 'pending');
create policy "places own read" on public.place_submissions for select
  using (auth.uid() = submitted_by);
```

## Moderation (v1, zero UI)
Review in **Supabase → Table Editor**: filter `status = pending`, sanity-check
coords/date, set `status = approved` (or `rejected`). Approved events appear in the
app on next load. For places, copy good ones into `data/spots.json` and rebuild.

## Client API (in the cloud module)
- `flEvents.list(citySlug)` → approved, non-expired events for a city.
- `flEvents.parseLink(url)` → calls the `parse-link` Edge Function (graceful until deployed).
- `flSubmit.open(citySlug)` → the submission modal (event/place toggle).
- `flSubmit.event(row)` / `flSubmit.place(row)` → insert `pending` (sign-in required).

## Cold-start / freshness
Auto-ingest (phase 3) seeds every city so the tab is never empty; submissions +
moderation keep it current; expiry prunes itself. Until ingest ships, seed London
by hand (insert `status=approved` rows) so the surfaces have something to show.
