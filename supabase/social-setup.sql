-- Flâneur — social setup (BACKEND.md §13–§20) in one go.
-- Safe to run more than once (idempotent). Paste into Supabase → SQL Editor → Run.
-- Requires the §11 `public.collections` table to already exist (it does if
-- publishing/sharing collections already works).

-- ── §13 public profiles (@username) ───────────────────────────────────────────
create table if not exists public.public_profiles (
  user_id      uuid primary key references auth.users on delete cascade,
  username     text unique not null,
  display_name text,
  bio          text,
  city         text,
  links        text,                                   -- §17
  avatar_v     bigint,                                 -- §17
  notify_prefs jsonb not null default '{}'::jsonb,     -- §18
  updated_at   timestamptz not null default now(),
  created_at   timestamptz not null default now()
);
alter table public.public_profiles add column if not exists links text;
alter table public.public_profiles add column if not exists avatar_v bigint;
alter table public.public_profiles add column if not exists notify_prefs jsonb not null default '{}'::jsonb;
-- public, opt-in leaderboard stats (written by the owner via flSocial.saveStats; see BACKEND.md §23)
alter table public.public_profiles add column if not exists checkins int     not null default 0;
alter table public.public_profiles add column if not exists km       numeric not null default 0;
alter table public.public_profiles add column if not exists visited  int     not null default 0;
alter table public.public_profiles add column if not exists worlds   int     not null default 0;
alter table public.public_profiles add column if not exists streak   int     not null default 0;
alter table public.public_profiles add column if not exists stats_at timestamptz;
create index if not exists public_profiles_checkins_idx on public.public_profiles (checkins desc);
create index if not exists public_profiles_km_idx       on public.public_profiles (km desc);
create unique index if not exists public_profiles_username_lower on public.public_profiles (lower(username));
do $$ begin
  alter table public.public_profiles add constraint username_shape check (username ~ '^[a-z0-9_]{3,20}$');
exception when duplicate_object then null; end $$;
alter table public.public_profiles enable row level security;
drop policy if exists "pp public read"  on public.public_profiles;
drop policy if exists "pp owner insert" on public.public_profiles;
drop policy if exists "pp owner update" on public.public_profiles;
drop policy if exists "pp owner delete" on public.public_profiles;
create policy "pp public read"  on public.public_profiles for select using (true);
create policy "pp owner insert" on public.public_profiles for insert with check (auth.uid() = user_id);
create policy "pp owner update" on public.public_profiles for update using (auth.uid() = user_id);
create policy "pp owner delete" on public.public_profiles for delete using (auth.uid() = user_id);

-- ── §13 follow graph ──────────────────────────────────────────────────────────
create table if not exists public.follows (
  follower_id uuid not null references auth.users on delete cascade,
  followee_id uuid not null references auth.users on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (follower_id, followee_id),
  check (follower_id <> followee_id)
);
alter table public.follows enable row level security;
drop policy if exists "follows public read" on public.follows;
drop policy if exists "follows self insert" on public.follows;
drop policy if exists "follows self delete" on public.follows;
create policy "follows public read" on public.follows for select using (true);
create policy "follows self insert" on public.follows for insert with check (auth.uid() = follower_id);
create policy "follows self delete" on public.follows for delete using (auth.uid() = follower_id);

-- ── §14 likes ─────────────────────────────────────────────────────────────────
create table if not exists public.collection_likes (
  user_id    uuid not null references auth.users on delete cascade,
  slug       text not null references public.collections(slug) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, slug)
);
alter table public.collection_likes enable row level security;
drop policy if exists "likes public read" on public.collection_likes;
drop policy if exists "likes self insert" on public.collection_likes;
drop policy if exists "likes self delete" on public.collection_likes;
create policy "likes public read" on public.collection_likes for select using (true);
create policy "likes self insert" on public.collection_likes for insert with check (auth.uid() = user_id);
create policy "likes self delete" on public.collection_likes for delete using (auth.uid() = user_id);

-- ── §15 comments ──────────────────────────────────────────────────────────────
create table if not exists public.collection_comments (
  id         bigint generated always as identity primary key,
  slug       text not null references public.collections(slug) on delete cascade,
  user_id    uuid not null references auth.users on delete cascade,
  body       text not null check (char_length(body) between 1 and 500),
  created_at timestamptz not null default now()
);
create index if not exists collection_comments_slug on public.collection_comments (slug, created_at);
alter table public.collection_comments enable row level security;
drop policy if exists "comments public read" on public.collection_comments;
drop policy if exists "comments self insert" on public.collection_comments;
drop policy if exists "comments self delete" on public.collection_comments;
create policy "comments public read" on public.collection_comments for select using (true);
create policy "comments self insert" on public.collection_comments for insert with check (auth.uid() = user_id);
create policy "comments self delete" on public.collection_comments for delete using (auth.uid() = user_id);

-- ── §15 friends (request/accept) ──────────────────────────────────────────────
create table if not exists public.friend_requests (
  requester_id uuid not null references auth.users on delete cascade,
  addressee_id uuid not null references auth.users on delete cascade,
  status       text not null default 'pending' check (status in ('pending','accepted')),
  created_at   timestamptz not null default now(),
  primary key (requester_id, addressee_id),
  check (requester_id <> addressee_id)
);
alter table public.friend_requests enable row level security;
drop policy if exists "fr read"   on public.friend_requests;
drop policy if exists "fr insert" on public.friend_requests;
drop policy if exists "fr accept" on public.friend_requests;
drop policy if exists "fr delete" on public.friend_requests;
create policy "fr read"   on public.friend_requests for select using (auth.uid() = requester_id or auth.uid() = addressee_id);
create policy "fr insert" on public.friend_requests for insert with check (auth.uid() = requester_id and status = 'pending');
create policy "fr accept" on public.friend_requests for update using (auth.uid() = addressee_id) with check (auth.uid() = addressee_id);
create policy "fr delete" on public.friend_requests for delete using (auth.uid() = requester_id or auth.uid() = addressee_id);

-- ── §18 blocks + reports + notification prefs (column added above) ─────────────
create table if not exists public.blocks (
  blocker_id uuid not null references auth.users on delete cascade,
  blocked_id uuid not null references auth.users on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  check (blocker_id <> blocked_id)
);
alter table public.blocks enable row level security;
drop policy if exists "blocks read self" on public.blocks;
drop policy if exists "blocks ins self"  on public.blocks;
drop policy if exists "blocks del self"  on public.blocks;
create policy "blocks read self" on public.blocks for select using (auth.uid() = blocker_id);
create policy "blocks ins self"  on public.blocks for insert with check (auth.uid() = blocker_id);
create policy "blocks del self"  on public.blocks for delete using (auth.uid() = blocker_id);

create table if not exists public.reports (
  id          bigint generated always as identity primary key,
  reporter_id uuid not null references auth.users on delete cascade,
  target_type text not null check (target_type in ('user','collection','comment')),
  target_id   text not null,
  reason      text,
  created_at  timestamptz not null default now()
);
alter table public.reports enable row level security;
drop policy if exists "reports ins self" on public.reports;
create policy "reports ins self" on public.reports for insert with check (auth.uid() = reporter_id);
-- (no select policy: read reports only via the dashboard / service role)

-- ── §19 collaborative collections ─────────────────────────────────────────────
create table if not exists public.collection_collaborators (
  slug       text not null references public.collections(slug) on delete cascade,
  user_id    uuid not null references auth.users on delete cascade,
  added_by   uuid references auth.users on delete set null,
  created_at timestamptz not null default now(),
  primary key (slug, user_id)
);
alter table public.collection_collaborators enable row level security;
drop policy if exists "cc read"      on public.collection_collaborators;
drop policy if exists "cc ins owner" on public.collection_collaborators;
drop policy if exists "cc del owner" on public.collection_collaborators;
create policy "cc read" on public.collection_collaborators for select using (true);
create policy "cc ins owner" on public.collection_collaborators for insert
  with check (exists (select 1 from public.collections c where c.slug = collection_collaborators.slug and c.owner_id = auth.uid()));
create policy "cc del owner" on public.collection_collaborators for delete
  using (exists (select 1 from public.collections c where c.slug = collection_collaborators.slug and c.owner_id = auth.uid()));

create or replace function public.is_collab(p_slug text, p_uid uuid)
  returns boolean language sql security definer stable as
$$ select exists (select 1 from public.collection_collaborators where slug = p_slug and user_id = p_uid) $$;
revoke all on function public.is_collab(text,uuid) from public;
grant execute on function public.is_collab(text,uuid) to authenticated;

drop policy if exists "collab update" on public.collections;
create policy "collab update" on public.collections for update
  using (public.is_collab(slug, auth.uid())) with check (public.is_collab(slug, auth.uid()));

-- ── §20 collaborative edit activity ───────────────────────────────────────────
create table if not exists public.collection_events (
  id         bigint generated always as identity primary key,
  slug       text not null references public.collections(slug) on delete cascade,
  actor_id   uuid not null references auth.users on delete cascade,
  kind       text not null default 'edit',
  created_at timestamptz not null default now()
);
create index if not exists collection_events_slug on public.collection_events (slug, created_at desc);
alter table public.collection_events enable row level security;
drop policy if exists "ce read"       on public.collection_events;
drop policy if exists "ce ins editor" on public.collection_events;
create policy "ce read" on public.collection_events for select using (true);
create policy "ce ins editor" on public.collection_events for insert with check (
  auth.uid() = actor_id and (
    public.is_collab(slug, auth.uid())
    or exists (select 1 from public.collections c where c.slug = collection_events.slug and c.owner_id = auth.uid())
  )
);

-- ── §17 avatars storage bucket ────────────────────────────────────────────────
insert into storage.buckets (id, name, public) values ('avatars','avatars',true)
  on conflict (id) do nothing;
drop policy if exists "avatars read"   on storage.objects;
drop policy if exists "avatars write"  on storage.objects;
drop policy if exists "avatars update" on storage.objects;
create policy "avatars read"   on storage.objects for select using (bucket_id = 'avatars');
create policy "avatars write"  on storage.objects for insert with check (bucket_id = 'avatars' and name = auth.uid()::text);
create policy "avatars update" on storage.objects for update using (bucket_id = 'avatars' and name = auth.uid()::text);

-- Done. Sign in to the app, open "Profile & friends", claim a @username,
-- and the social features light up. (Push notifications, §16, are separate.)

-- ── Block enforcement (review follow-up) ─────────────────────────────────────
-- Stop a user you've blocked from following you, friend-requesting you, or
-- liking/commenting on your collections. Self-contained: safe to paste alone.
create or replace function public.is_blocked(p_blocker uuid, p_blocked uuid)
  returns boolean language sql security definer stable as
$$ select exists (select 1 from public.blocks where blocker_id = p_blocker and blocked_id = p_blocked) $$;
revoke all on function public.is_blocked(uuid,uuid) from public;
grant execute on function public.is_blocked(uuid,uuid) to authenticated;

drop policy if exists "follows self insert" on public.follows;
create policy "follows self insert" on public.follows for insert
  with check (auth.uid() = follower_id and not public.is_blocked(followee_id, auth.uid()));

drop policy if exists "fr insert" on public.friend_requests;
create policy "fr insert" on public.friend_requests for insert
  with check (auth.uid() = requester_id and status = 'pending' and not public.is_blocked(addressee_id, auth.uid()));

drop policy if exists "comments self insert" on public.collection_comments;
create policy "comments self insert" on public.collection_comments for insert
  with check (auth.uid() = user_id and not public.is_blocked((select c.owner_id from public.collections c where c.slug = collection_comments.slug), auth.uid()));

drop policy if exists "likes self insert" on public.collection_likes;
create policy "likes self insert" on public.collection_likes for insert
  with check (auth.uid() = user_id and not public.is_blocked((select c.owner_id from public.collections c where c.slug = collection_likes.slug), auth.uid()));

-- ── Discover ranking RPC (review follow-up) ──────────────────────────────────
-- Ranks ALL public collections by like count (server-side), returns just the
-- top N — so Discover no longer fetches every like row or ranks only recent ones.
create or replace function public.top_collections(lim int default 30)
returns table(slug text, name text, emoji text, city text, owner_id uuid,
              updated_at timestamptz, places int, likes bigint, liked boolean,
              author_username text, author_avatar_v bigint)
language sql stable as $$
  select c.slug, c.name, c.emoji, c.city, c.owner_id, c.updated_at,
         coalesce(jsonb_array_length(c.spots),0) as places,
         coalesce(l.cnt,0) as likes,
         exists(select 1 from public.collection_likes ml where ml.slug=c.slug and ml.user_id=auth.uid()) as liked,
         p.username, p.avatar_v
  from public.collections c
  left join (select slug, count(*) cnt from public.collection_likes group by slug) l on l.slug=c.slug
  left join public.public_profiles p on p.user_id=c.owner_id
  order by coalesce(l.cnt,0) desc, c.updated_at desc
  limit greatest(1, least(coalesce(lim,30),100));
$$;
grant execute on function public.top_collections(int) to anon, authenticated;
