-- Ingest health tracking (audit P1.4). Each scheduled ingest upserts its row on
-- a successful run; scripts/ingest-health.mjs flags any source that goes stale.
create table if not exists public.ingest_runs (
  source   text primary key,
  ran_at   timestamptz not null default now(),
  upserted integer,
  ok       boolean not null default true
);
alter table public.ingest_runs enable row level security;  -- service role only (no anon policy)
