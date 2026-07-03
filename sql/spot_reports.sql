-- Flâneur — spot_reports: crowd-sourced "it was shut / it's gone" reports.
-- Powers the Failure-loop consolation (gameplay Task AF): every "it was shut"
-- tap feeds an hours/status correction queue, so users become the fix for the
-- ~99% of the catalogue that carries no opening hours. Apply once in Supabase.
create table if not exists public.spot_reports (
  id          bigint generated always as identity primary key,
  spot_id     text not null,
  status      text not null check (status in ('shut','gone','moved','wrong_hours')),
  name        text,
  reporter    uuid default auth.uid(),
  created_at  timestamptz not null default now()
);
alter table public.spot_reports enable row level security;

-- Authenticated users may insert their own report; nobody reads via the API
-- (the owner reviews through the dashboard / a service-role query).
drop policy if exists "spot_reports insert own" on public.spot_reports;
create policy "spot_reports insert own"
  on public.spot_reports for insert to authenticated
  with check (reporter = auth.uid());

create index if not exists spot_reports_spot_idx on public.spot_reports (spot_id);
