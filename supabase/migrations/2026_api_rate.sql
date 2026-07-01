-- Rolling-window rate limiter for the public edge functions (audit P0.3/P0.4).
-- The functions write/read this via the service role; anon has no access.
create table if not exists public.api_rate (
  id  bigserial primary key,
  fn  text not null,
  key text not null,           -- "ip:<addr>" or "u:<user_id>"
  ts  timestamptz not null default now()
);
create index if not exists api_rate_lookup on public.api_rate (fn, key, ts desc);
alter table public.api_rate enable row level security;   -- no policies => anon denied; service_role bypasses RLS

-- Housekeeping: drop rows older than a day so the table stays tiny. Schedule
-- with pg_cron if available, or fold into a daily edge job:
--   select cron.schedule('api_rate_gc','7 3 * * *', $$delete from public.api_rate where ts < now() - interval '1 day'$$);
