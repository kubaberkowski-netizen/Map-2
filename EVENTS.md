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
  ext_id text unique,                        -- dedup key for ingested events (e.g. 'tm:<id>')
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

## Server functions (`supabase/functions/`)

Both are written and committed; you deploy them with the Supabase CLI.

> If you created `events` before this change, add the dedup column once:
> `alter table public.events add column if not exists ext_id text unique;`

### `parse-link` — makes paste-a-link real
Fetches the pasted URL server-side, reads OpenGraph + JSON-LD `Event` data, returns
`{ title, venue, start, lat, lng, image }`. No secrets needed.
```bash
supabase functions deploy parse-link
```
The client already calls it (`flEvents.parseLink` → `sb.functions.invoke("parse-link")`)
and degrades gracefully until it's deployed.

### `ingest-events` — auto-fills the feed (cold-start answer)
One geo-query per city (all 115, from `cities.json`) against the **Ticketmaster
Discovery API**, mapped into `events` and upserted by `ext_id` (no duplicates).
```bash
# 1. free key from https://developer.ticketmaster.com (Discovery API)
supabase functions deploy ingest-events
supabase secrets set TICKETMASTER_KEY=<key>
# optional: review before publishing instead of going live immediately
supabase secrets set INGEST_STATUS=pending
# 2. test once
supabase functions invoke ingest-events
```
Schedule it daily (SQL editor, pg_cron + pg_net):
```sql
select cron.schedule('ingest-events','0 5 * * *', $$
  select net.http_post(
    url := 'https://fpngxchltuovtsyzigul.supabase.co/functions/v1/ingest-events',
    headers := '{"Content-Type":"application/json","Authorization":"Bearer <service_role_key>"}'::jsonb
  );
$$);
```
**Coverage caveat:** Ticketmaster is strong in UK/US/EU/AU, thin in parts of
Africa/Asia — those cities just return nothing (graceful). Add ICS feeds or other
sources later by writing more rows with a different `source` + `ext_id` prefix.

### `ingest-seatgeek` — second source, same feed
Identical shape to `ingest-events` but hits the **SeatGeek API** (one geo-query per
city) and upserts into the same `events` table with `source:"seatgeek"` and an
`ext_id` prefixed `sg:`, so the two sources merge with no duplicates. Adds concert,
sport, theatre and comedy coverage (strong in the US, decent UK/EU).
```bash
# 1. free client id from https://seatgeek.com/account/develop ("Create an app")
supabase functions deploy ingest-seatgeek
supabase secrets set SEATGEEK_CLIENT_ID=<client_id>
# optional: client secret raises the rate limit; INGEST_STATUS=pending to review first
supabase secrets set SEATGEEK_CLIENT_SECRET=<client_secret>
# 2. test once
supabase functions invoke ingest-seatgeek
```
Schedule it daily, offset from Ticketmaster so they don't run together:
```sql
select cron.schedule('ingest-seatgeek','30 5 * * *', $$
  select net.http_post(
    url := 'https://fpngxchltuovtsyzigul.supabase.co/functions/v1/ingest-seatgeek',
    headers := '{"Content-Type":"application/json","Authorization":"Bearer <service_role_key>"}'::jsonb
  );
$$);
```
The client needs no change — it reads the merged `events` table, and the Events-tab
type filter + map pins pick up SeatGeek's categories (Music/Sport/Theatre/Comedy/…)
automatically. Event images are CSP-allowed for SeatGeek hosts and any blocked/broken
thumbnail hides itself gracefully.

## Cold-start / freshness
Auto-ingest (phase 3) seeds every city so the tab is never empty; submissions +
moderation keep it current; expiry prunes itself. Until ingest ships, seed London
by hand (insert `status=approved` rows) so the surfaces have something to show.
