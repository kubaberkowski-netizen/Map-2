-- Flâneur — final scores + scorers for finished sport fixtures.
-- Run this once in the Supabase SQL editor (DDL can't run over the anon REST API),
-- BEFORE the next ingest-matches run writes result-bearing rows.
--
-- The events table already carries each fixture (name/venue/lat/lng/start_at,
-- category:"Football"). These two nullable columns let the ingest backfill the
-- final score once a match has finished, so the app's Matchday log can show what
-- you saw ("2–1", scorers) for a game you checked in to. Both are optional and
-- ignored by every existing read — adding them is safe for the live app.
--
-- The ingest degrades gracefully if these columns are absent (it retries the
-- upsert without them), but until you run this the results simply won't persist.

alter table public.events add column if not exists result  text;   -- e.g. "2-1" (home-away, full time)
alter table public.events add column if not exists scorers jsonb;  -- [{"p":"Saka","team":"Arsenal","min":23}, ...]

-- Fast "did this fixture finish yet" lookups by ext_id are already covered by the
-- existing ext_id unique index; no extra index needed for the result columns.
