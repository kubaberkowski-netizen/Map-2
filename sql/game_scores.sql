-- Flâneur — daily game leaderboard
-- Run this once in the Supabase SQL editor (DDL can't run over the anon REST API).
-- Backs window.flGameScore(game, score) writes and the Play-tab leaderboard reads.
--
-- Games are playable signed-out, so rows are keyed by a client-generated
-- anonymous player id (`pid`, stored in localStorage). `user_id` is attached
-- opportunistically when a Supabase session exists, but is never required.
-- This is a casual, low-stakes board: the policies below are deliberately
-- permissive (anyone may insert/update a row). There is no money or identity
-- riding on it, and `pid` is client-supplied so stricter row-ownership checks
-- would be theatre. If you ever want to lock it down, gate insert/update on
-- `auth.uid() = user_id` and require sign-in to post.

create table if not exists public.game_scores (
  id         bigint generated always as identity primary key,
  pid        text not null,                              -- anonymous player id (localStorage)
  name       text not null default 'Flâneur',           -- display handle
  user_id    uuid references auth.users(id) on delete set null,
  game       text not null,                              -- 'time' | 'pinworld' | 'plaqueworld' | 'connections' | 'warmer'
  day        date not null default (now() at time zone 'utc')::date,
  score      integer not null default 0,
  city       text,
  created_at timestamptz not null default now(),
  unique (pid, game, day)                                -- one score per player, per game, per day
);

alter table public.game_scores enable row level security;

-- Public read (anon + authed) — the board is world-visible.
drop policy if exists "game_scores_read" on public.game_scores;
create policy "game_scores_read" on public.game_scores
  for select using (true);

-- Anyone may insert their daily score.
drop policy if exists "game_scores_insert" on public.game_scores;
create policy "game_scores_insert" on public.game_scores
  for insert with check (true);

-- Anyone may update a row (needed so upsert-on-conflict can refresh today's score/name).
drop policy if exists "game_scores_update" on public.game_scores;
create policy "game_scores_update" on public.game_scores
  for update using (true) with check (true);

-- Fast "top N for a game today" reads.
create index if not exists game_scores_board_idx
  on public.game_scores (game, day, score desc);

-- Fast "a player's best ever" reads (all-time board).
create index if not exists game_scores_alltime_idx
  on public.game_scores (game, score desc);
