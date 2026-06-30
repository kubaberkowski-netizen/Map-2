# Flâneur — backend infrastructure (accounts + retention analytics)

Status: **scaffolded, dormant.** All client code ships disabled until the four
config keys in the cloud module (`src/app.template.html`, the
`/* Flâneur cloud */` block) are filled in. Nothing here changes the live app's
behaviour until you stand up the two projects below and paste keys.

Stack (decided): **Supabase** (auth + Postgres + Storage) for accounts/sync,
**PostHog** (EU, cookieless) for product analytics / retention. **EU hosting,
email magic-link** sign-in. The app stays a single static file on GitHub Pages —
no server to run; the browser talks to both services via their JS SDKs.

```
 GitHub Pages (index.html, static)
        │  (SDKs loaded AFTER the synchronous boot → offline-first preserved)
        ├──▶ PostHog (EU)   product events → retention curves, funnels, cohorts
        └──▶ Supabase (EU)  Auth (magic-link) · profiles.state(jsonb) · Storage(photos)
                            Row-Level Security: a user can touch only their row
```

---

## 1. Why this shape

- The client already persists everything in **localStorage** (the `Ae` wrapper is
  a thin async shim over it) plus **IndexedDB `flaneur-mem`** for photos. So the
  sync layer reads/writes the *same* keys directly — it does **not** need to reach
  into the minified React closure. That keeps the bundle untouched except for a
  few one-line analytics emits.
- The core progress (`flaneur-v2 = {saved, visited, verified, finds, checkinAt}`
  plus `cells`, `walks`, `mxp`, `streak`, …) is a **few KB of set-like data** →
  trivially syncable and conflict-free if we *merge by union* rather than
  last-write-wins.
- Photos are the only heavy data and are already isolated in IndexedDB → they go
  to Supabase Storage separately (Phase 2), not in the state blob.

---

## 2. Owner setup checklist (one-time, ~30 min)

### A. PostHog (analytics)
1. Create a project at **eu.posthog.com** (EU region).
2. Copy the **Project API Key** (`phc_…`) and host `https://eu.i.posthog.com`.
3. Paste into the cloud module's `CFG.posthogKey` / `CFG.posthogHost`.

### B. Supabase (accounts + sync)
1. Create a project in an **EU region** (e.g. `eu-west-2` London).
2. **Auth → Providers:** enable **Email**, turn ON *"Email OTP / magic link"*,
   turn OFF *"Confirm email"* password flow (we use magic-link only). Later add
   Google/Apple providers for one-tap.
3. **Auth → URL Configuration:** set **Site URL** to the Pages URL
   (`https://<user>.github.io/<repo>/`) and add it to **Redirect URLs**.
4. **SQL editor:** run the schema in §3.
5. **Storage:** create a private bucket `memories` (policies in §3).
6. **Project Settings → API:** copy **Project URL** + **anon public key** into
   `CFG.supabaseUrl` / `CFG.supabaseAnon`.
7. `npm run build`, commit, push. Sign-in appears (the ☁ button, bottom-left).

> The `anon` key is *meant* to be public; Row-Level Security is what protects
> data. Never ship the `service_role` key.

---

## 3. Supabase schema (run in SQL editor)

```sql
-- one row per user; holds the synced state blob
create table public.profiles (
  user_id    uuid primary key references auth.users on delete cascade,
  handle     text,
  state      jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
alter table public.profiles enable row level security;
create policy "own row read"   on public.profiles for select using (auth.uid() = user_id);
create policy "own row write"  on public.profiles for insert with check (auth.uid() = user_id);
create policy "own row update" on public.profiles for update using (auth.uid() = user_id);

-- private photo bucket, foldered by user id: memories/{uid}/{spot}.jpg
insert into storage.buckets (id, name, public) values ('memories','memories',false)
  on conflict do nothing;
create policy "own photos" on storage.objects for all
  using  (bucket_id = 'memories' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'memories' and (storage.foldername(name))[1] = auth.uid()::text);
```

Optional — if you want retention SQL *inside* Postgres in addition to PostHog,
mirror key events into an append-only table (otherwise rely on PostHog):

```sql
create table public.events (
  id bigserial primary key,
  user_id uuid references auth.users on delete set null,
  name text not null,
  ts timestamptz not null default now(),
  props jsonb not null default '{}'::jsonb
);
alter table public.events enable row level security;
create policy "insert own" on public.events for insert with check (auth.uid() = user_id);
```

---

## 4. Sync algorithm — additive, conflict-free

On login the module does a **merge pull**, never a clobber:

| Field | Merge rule |
|---|---|
| `saved`, `visited`, `verified` (id sets) | **union** — you can never lose a check-in |
| `cells`, `walks` (arrays) | union by value/identity |
| `finds`, `mxp`, `streak` (counters) | **max** |
| `checkinAt` (id → timestamp map) | merge keys, prefer the **earliest** timestamp |

Merged result is written back to both localStorage and the cloud row. If the
merge changed local data, the app reloads once so React re-reads the blob at
boot. After that, pushes are **debounced** and also fire on `visibilitychange`
(hidden) and `pagehide`, diffing a hash so we only write on real change. Offline
writes already land in localStorage first; the next push reconciles.

**Web vs native caveat:** this reads `localStorage` directly. If the app is later
wrapped natively and `window.storage` is provided, expose a bridge
(`window.__flAe = Ae`) and point the module at it.

---

## 5. Privacy / consent

- PostHog runs **cookieless-friendly**, `autocapture:false`,
  `disable_session_recording:true`, `person_profiles:"identified_only"` → no
  behavioural profile until a user signs in. EU ingest only.
- `privacy.html` is updated: a row for product analytics + the account data
  (email) and the **export/delete** rights (a Supabase row + storage prefix is
  trivial to export or `delete from profiles where user_id = …`).
- CSP (inline in `index.html`) is extended: `connect-src` += Supabase +
  PostHog EU; SDKs load from the already-allowed `unpkg.com`.

---

## 6. Events instrumented (Phase 0)

`app_open` (+ `standalone` PWA flag), `check_in`, `level_up` (`level`,`tier`),
`daily_missions_complete`, `share` (`variant`), `login`. Easy follow-ups:
`spot_saved`, `world_completed`, `walk_recorded`, `city_switched`,
`onboarding_complete`.

`window.flTrack(name, props)` is a global queue that no-ops (buffers) until
PostHog finishes loading, so emits never throw and nothing is lost at startup.

---

## 7. Retention analysis (what to actually look at)

Headline in PostHog:

- **Weekly cohort retention** (W0→W1→W2…) and **DAU/WAU/MAU + DAU/MAU stickiness**.
- **Activation funnel:** `app_open` → first `check_in` → next-day return (D1) → D7.
  Find the "aha" threshold (e.g. *N check-ins in week 1 ⇒ 3× W1 retention*).

**The loop-validation experiment** — build PostHog *behavioural cohorts* and
compare each one's retention against everyone else:

| Cohort | Validates |
|---|---|
| performed `level_up` | progression pulls people back |
| performed `daily_missions_complete` | daily quests build a habit |
| performed `share` | sharing drives retention *and* acquisition |
| completed a World / explorer-map milestone | collections drive return visits |

If these cohorts retain materially better, the gamification works. If not,
that's the signal to rethink the loop — which is exactly the decision we parked
the backend behind.

> Small-N caveat: early on, retention curves are noisy. Lean on funnels and
> per-user event timelines until volume builds.

---

## 8. Cost

$0 to start: PostHog free ~1M events/mo; Supabase free tier (500 MB DB, 1 GB
storage, 50k MAU auth). Realistically ~$25–50/mo only once there's real traction.

## 10. Push notifications (retention nudges)

Client + service-worker plumbing ships **dormant** until `CFG.vapidPublic` is set
(the `🔔 Daily reminders` row in the You tab only renders once it's configured and
the user is signed in). The server sender is a Supabase Edge Function you deploy.

### A. Generate VAPID keys (you run this — private key never leaves your machine)
```bash
node -e 'const c=require("crypto");const{publicKey,privateKey}=c.generateKeyPairSync("ec",{namedCurve:"prime256v1"});const pub=publicKey.export({format:"jwk"}),pk=privateKey.export({format:"jwk"}),u=s=>Buffer.from(s,"base64url");console.log("PUBLIC :",Buffer.concat([Buffer.from([4]),u(pub.x),u(pub.y)]).toString("base64url"));console.log("PRIVATE:",pk.d);'
```
- `PUBLIC` → send to me; goes in `CFG.vapidPublic`.
- `PRIVATE` → keep; becomes an Edge Function secret (below). Never commit it.

### B. Table (run in SQL editor)
```sql
create table public.push_subscriptions (
  endpoint     text primary key,
  user_id      uuid references auth.users on delete cascade,
  subscription jsonb not null,
  updated_at   timestamptz default now(),
  created_at   timestamptz default now()
);
alter table public.push_subscriptions enable row level security;
create policy "own subs sel" on public.push_subscriptions for select using (auth.uid() = user_id);
create policy "own subs ins" on public.push_subscriptions for insert with check (auth.uid() = user_id);
create policy "own subs upd" on public.push_subscriptions for update using (auth.uid() = user_id);
create policy "own subs del" on public.push_subscriptions for delete using (auth.uid() = user_id);
```

### C. Edge Function `send-reminders` (supabase/functions/send-reminders/index.ts)
```ts
import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2";
const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
webpush.setVapidDetails("mailto:kuba.berkowski@gmail.com", Deno.env.get("VAPID_PUBLIC")!, Deno.env.get("VAPID_PRIVATE")!);
Deno.serve(async () => {
  const { data: subs } = await sb.from("push_subscriptions").select("endpoint, subscription, profiles(state)");
  let sent = 0; const gone: string[] = [];
  const today = new Date().toISOString().slice(0,10);
  for (const row of subs ?? []) {
    // targeting: skip anyone who already checked in today (state.checkinAt holds timestamps)
    const ci = (row as any).profiles?.state ? JSON.parse(((row as any).profiles.state["flaneur-v2"])||"{}").checkinAt||{} : {};
    const activeToday = Object.values(ci).some((t:any)=> String(t).slice(0,10)===today);
    if (activeToday) continue;
    const payload = JSON.stringify({ title:"Flâneur", body:"New daily missions are live — keep your streak alive.", url:"./", tag:"daily" });
    try { await webpush.sendNotification((row as any).subscription, payload); sent++; }
    catch (e:any) { if (e.statusCode===404||e.statusCode===410) gone.push((row as any).endpoint); }
  }
  if (gone.length) await sb.from("push_subscriptions").delete().in("endpoint", gone);
  return new Response(JSON.stringify({ sent, pruned: gone.length }), { headers:{ "Content-Type":"application/json" }});
});
```
Deploy + secrets (Supabase CLI):
```bash
supabase functions deploy send-reminders
supabase secrets set VAPID_PUBLIC=<public> VAPID_PRIVATE=<private>
# SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are injected automatically.
```

### D. Schedule it (SQL editor — pg_cron + pg_net, e.g. 18:00 daily)
```sql
select cron.schedule('daily-reminders','0 18 * * *', $$
  select net.http_post(
    url := 'https://fpngxchltuovtsyzigul.supabase.co/functions/v1/send-reminders',
    headers := '{"Content-Type":"application/json","Authorization":"Bearer <service_role_key>"}'::jsonb
  );
$$);
```

**Notes / caveats:** iOS only delivers web push to a **home-screen-installed** PWA
(iOS 16.4+). The daily 18:00 UTC fire is a v1 — proper per-user timezones and
streak-aware copy come next. Pruning on `404/410` keeps the table clean as
subscriptions expire.

## 9. Roadmap after Phase 1

Photos → Storage (lazy up/download, local cache); friends + city leaderboards
(new RLS tables); server-validated achievements (Edge Function) to harden the XP
economy before any social comparison ships.

---

## 11. Public collection links (shareable, no-login viewing)

Users publish a personal collection to a public URL anyone can open without an
account. Publishing requires the owner to be signed in; viewing does not. The
published row **denormalises** the spots (name/area/coords/category) so the
public page never needs the 4 MB catalogue.

Public URL scheme (GitHub Pages has no server rewrites, so the slug is a query
param): `https://<site>/c.html?s=<slug>`. After a move to a host with rewrites
you can serve the same page at `/c/<slug>` with no data change.

### Schema (run in SQL editor)
```sql
create table public.collections (
  slug       text primary key,
  owner_id   uuid references auth.users on delete cascade,
  name       text not null,
  emoji      text,
  note       text,
  city       text,
  spots      jsonb not null default '[]'::jsonb,   -- [{id,n,a,lat,lng,c}]
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.collections enable row level security;
create policy "public read"  on public.collections for select using (true);
create policy "owner insert" on public.collections for insert with check (auth.uid() = owner_id);
create policy "owner update" on public.collections for update using (auth.uid() = owner_id);
create policy "owner delete" on public.collections for delete using (auth.uid() = owner_id);
```

The `anon` key + `public read` policy is what lets `c.html` fetch a collection
with no session. Owners can only write/delete their own rows. Moderation for
now is manual: `delete from public.collections where slug = '…';`.

Client surface: `window.flPublish` (in the cloud module) — `.publish(col)`
upserts and returns `{slug,url}`; `.unpublish(slug)` deletes; `.signedIn()`
gates the UI; `.open()` opens the magic-link modal.

### Rich link previews (OG images)

When a collection is published the app renders a 1200×630 card (the `ogcard`
Cw variant) and uploads it to a public Storage bucket `cards/<slug>.png`. The
public page sets `og:image` / `twitter:image` to the deterministic URL
`<supabaseUrl>/storage/v1/object/public/cards/<slug>.png`. No DB column needed.

Create the bucket once (SQL editor):
```sql
insert into storage.buckets (id,name,public) values ('cards','cards',true)
  on conflict do nothing;
create policy "cards read"   on storage.objects for select using (bucket_id='cards');
create policy "cards write"  on storage.objects for insert with check (bucket_id='cards' and auth.role()='authenticated');
create policy "cards update"  on storage.objects for update using (bucket_id='cards' and auth.role()='authenticated');
```

Caveat: GitHub Pages can't serve per-slug `<meta>` to crawlers that don't run
JS, so the `og:image` set by `c.html`'s script is seen by JS-capable scrapers
(and by in-app sharing) but not by all of them. For **universal** unfurls,
either (a) after migrating to a host with SSR/rewrites, render `c.html` server
side with the right tags, or (b) deploy a tiny Supabase Edge Function that
returns OG-tagged HTML and redirects humans to `c.html`, then set
`CFG.ogFn` to its base URL so shared links point at it. The image URL above is
the same in all cases, so the function only needs to emit `<meta>` + a redirect.

---

## 12. AI trip planning (natural language) — `plan-trip` Edge Function

Optional, off by default. The Plan wizard shows a "✨ Plan with AI" box **only
when configured** (the client hook `window.flAIPlan` is null until `AIFN` is set),
so nothing changes until you deploy this.

Function: `supabase/functions/plan-trip/index.ts` — takes `{city,days,prompt,spots}`
(the client sends the city's spot list as `{id,n,c}`), asks Claude to pick a
walkable, on-brand set, and returns `{ids,note}` (ids restricted to the input).

Deploy:
```bash
supabase functions deploy plan-trip --no-verify-jwt
supabase secrets set ANTHROPIC_API_KEY=sk-ant-...      # (optionally ANTHROPIC_MODEL)
```
Then, in `src/app.template.html`, set the constant
`AIFN = "https://<project-ref>.functions.supabase.co/plan-trip"`, add that origin
to the inline CSP `connect-src`, and `npm run build`. The box appears and routes
free-text trips into the existing optimiser. Cost is ~1 cheap Haiku call per plan.

---

## 13. Social: public profiles (`@username`) + follow graph

Layer on top of §11 public collections. Identity is a public, no-login-to-view
profile keyed by a unique `@username`; the social graph is a one-way **follow**.
Both tables are publicly readable (so profiles/counts render without a session)
but only the owner/follower can write their own rows. The private synced state
(`profiles.state`, §3) stays separate — this is *public* identity only.

Client surface (cloud module): `window.flSocial` — `myProfile()`, `getProfile(username)`,
`saveProfile({username,display_name,bio,city})`, `collectionsOf(uid)`,
`follow(uid)`/`unfollow(uid)`/`isFollowing(uid)`, `counts(uid)`, `following()`,
`profileUrl(username)`. The in-app UI is `window.flSocialUI()` (a bottom-sheet,
opened by the "Profile & friends" button in the You tab). Public profile page:
`u.html?u=<username>` (mirrors `c.html`, anon read-only).

### Schema (run once in the SQL editor)
```sql
-- public identity (separate from the private profiles.state blob in §3)
create table public.public_profiles (
  user_id      uuid primary key references auth.users on delete cascade,
  username     text unique not null,
  display_name text,
  bio          text,
  city         text,
  updated_at   timestamptz not null default now(),
  created_at   timestamptz not null default now()
);
alter table public.public_profiles enable row level security;
create policy "pp public read"  on public.public_profiles for select using (true);
create policy "pp owner insert" on public.public_profiles for insert with check (auth.uid() = user_id);
create policy "pp owner update" on public.public_profiles for update using (auth.uid() = user_id);
create policy "pp owner delete" on public.public_profiles for delete using (auth.uid() = user_id);
-- enforce handle shape + case-insensitive uniqueness
create unique index public_profiles_username_lower on public.public_profiles (lower(username));
alter table public.public_profiles add constraint username_shape
  check (username ~ '^[a-z0-9_]{3,20}$');

-- one-way follow graph
create table public.follows (
  follower_id uuid not null references auth.users on delete cascade,
  followee_id uuid not null references auth.users on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (follower_id, followee_id),
  check (follower_id <> followee_id)
);
alter table public.follows enable row level security;
create policy "follows public read" on public.follows for select using (true);
create policy "follows self insert" on public.follows for insert with check (auth.uid() = follower_id);
create policy "follows self delete" on public.follows for delete using (auth.uid() = follower_id);
```

Notes / next steps: usernames are lowercased + shape-checked client- and
DB-side; uniqueness is enforced by the lower() index. Moderation is manual for
now (`delete from public.public_profiles where username='…'`). Natural follow-ups:
an in-app feed of followed users' newest collections, like/save counts on
collections, and `#u=<username>` deep-linking from `u.html` into the app.

---

## 14. Social: likes + feed (extends §13)

A heart/save on public collections, plus an in-app feed of the newest
collections from people you follow. Likes are public-read (counts render on
`c.html` and in the feed without a session); only the liker can add/remove
their own like. The feed is purely client-side (no new table): it reads your
follows, fetches those owners' collections newest-first, and tallies likes.

Client surface (cloud module, on `window.flSocial`): `like(slug)`,
`unlike(slug)`, `hasLiked(slug)`, `likeCount(slug)`, and `feed(limit)` (returns
collections enriched with `author`, `likes`, `liked`). The feed + heart buttons
live in the "Profile & friends" sheet; `u.html`'s CTA deep-links to
`./#u=<username>` which opens that profile in-app.

### Schema (run once in the SQL editor — after §13)
```sql
create table public.collection_likes (
  user_id    uuid not null references auth.users on delete cascade,
  slug       text not null references public.collections(slug) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, slug)
);
alter table public.collection_likes enable row level security;
create policy "likes public read" on public.collection_likes for select using (true);
create policy "likes self insert" on public.collection_likes for insert with check (auth.uid() = user_id);
create policy "likes self delete" on public.collection_likes for delete using (auth.uid() = user_id);
```

Everything degrades gracefully if this table is absent (counts read as 0, the
feed still lists collections) — so it can be added independently of §13.

---

## 15. Social: comments on collections + friends (request/accept)

### Comments
Public-read comments on any published collection (rendered read-only on
`c.html` with a count; posted/deleted in-app via the comment sheet opened from
a collection in the feed/Discover). Client: `flSocial.comments(slug)`,
`addComment(slug,body)`, `deleteComment(id)`, `commentCount(slug)`.

```sql
create table public.collection_comments (
  id         bigint generated always as identity primary key,
  slug       text not null references public.collections(slug) on delete cascade,
  user_id    uuid not null references auth.users on delete cascade,
  body       text not null check (char_length(body) between 1 and 500),
  created_at timestamptz not null default now()
);
create index collection_comments_slug on public.collection_comments (slug, created_at);
alter table public.collection_comments enable row level security;
create policy "comments public read" on public.collection_comments for select using (true);
create policy "comments self insert" on public.collection_comments for insert with check (auth.uid() = user_id);
create policy "comments self delete" on public.collection_comments for delete using (auth.uid() = user_id);
```

### Friends (request/accept, layered on §13 follow)
A mutual tier with a pending→accepted handshake. Client:
`friendStatus(uid)` (none/pending_out/pending_in/friends), `sendFriendRequest`,
`acceptFriendRequest`, `declineFriendRequest`, `cancelFriendRequest`,
`unfriend`, `incomingRequests()`, `friends()`. The "Profile & friends" sheet
shows incoming requests (Accept/Decline), a Friends list, and an Add-friend
button on every person card.

```sql
create table public.friend_requests (
  requester_id uuid not null references auth.users on delete cascade,
  addressee_id uuid not null references auth.users on delete cascade,
  status       text not null default 'pending' check (status in ('pending','accepted')),
  created_at   timestamptz not null default now(),
  primary key (requester_id, addressee_id),
  check (requester_id <> addressee_id)
);
alter table public.friend_requests enable row level security;
-- either party may read the row
create policy "fr read"   on public.friend_requests for select
  using (auth.uid() = requester_id or auth.uid() = addressee_id);
-- only the requester creates the pending row
create policy "fr insert" on public.friend_requests for insert
  with check (auth.uid() = requester_id and status = 'pending');
-- only the addressee can accept (flip to accepted)
create policy "fr accept" on public.friend_requests for update
  using (auth.uid() = addressee_id) with check (auth.uid() = addressee_id);
-- either party may remove (cancel / decline / unfriend)
create policy "fr delete" on public.friend_requests for delete
  using (auth.uid() = requester_id or auth.uid() = addressee_id);
```

All of this degrades gracefully if the tables are absent.

---

## 16. Social push notifications — `notify-social` Edge Function

Sends a Web Push when someone follows you, likes/comments on your collection,
or sends/accepts a friend request. Reuses the §10 push plumbing
(`push_subscriptions` table, the SW `push` handler, the `flPush` subscribe UI).
No new tables. **Dormant** until you (a) have §10 push working — VAPID keys set,
`CFG.vapidPublic` filled, a user subscribed — and (b) deploy this function.

Flow: a social action (`follow`/`like`/`comment`/friend) calls the client hook
`flNotify(type, targetUserId, {name})` best-effort. It POSTs to the function
**with the actor's JWT**; the function derives the *actor* from that token (so
the "who" can't be spoofed), looks up the *target's* subscriptions, and sends a
templated push. Bad tokens / self-targets / missing subscriptions are no-ops,
and the client swallows all failures so the underlying action never breaks.

Deploy (JWT verification ON — note: NOT `--no-verify-jwt`):
```bash
supabase functions deploy notify-social
supabase secrets set VAPID_PUBLIC=<public> VAPID_PRIVATE=<private>
# SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are injected automatically.
```
The client targets `<supabaseUrl>/functions/v1/notify-social` automatically
(derived from `CFG.supabaseUrl`); if the function isn't deployed the POST 404s
and is ignored. Pruning on 404/410 keeps `push_subscriptions` clean.

---

## 17. Richer profiles — avatars + links

Adds a profile photo and a link to §13 public profiles. Avatars are stored in a
public `avatars` Storage bucket at the deterministic path `avatars/<user_id>`
(client-resized to 256×256 JPEG before upload); a bump column `avatar_v` on
public_profiles both signals "has avatar" and cache-busts the URL. A free-text
`links` column holds one website/social URL. Client: `flSocial.avatarUrl(p)`,
`uploadAvatar(file)`; `saveProfile` now also takes `links`. Avatars render on
person cards, comments, activity, friend requests, the profile editor and
`u.html`; the app/`u.html` CSP `img-src` now allows `*.supabase.co`.

### Schema (run once — extends §13)
```sql
alter table public.public_profiles add column if not exists avatar_v bigint;
alter table public.public_profiles add column if not exists links text;

insert into storage.buckets (id,name,public) values ('avatars','avatars',true)
  on conflict do nothing;
create policy "avatars read"   on storage.objects for select using (bucket_id='avatars');
create policy "avatars write"  on storage.objects for insert
  with check (bucket_id='avatars' and (storage.foldername(name))[1] is not null and name = auth.uid()::text);
create policy "avatars update"  on storage.objects for update
  using (bucket_id='avatars' and name = auth.uid()::text);
```
(The object name is exactly the uploader's `user_id`, so the policy ties each
file to its owner.) Degrades gracefully: no `avatar_v` → initials fallback.

---

## 18. Notification preferences · block · report

- **Notification prefs:** a `notify_prefs jsonb` column on public_profiles
  ({follow,like,comment,friend} → bool, absence = on). Toggled in the
  "Notifications" section of the Profile sheet; `notify-social` reads the
  target's prefs and skips muted types.
- **Block:** a `blocks` table. The client caches the blocker's set and filters
  blocked users out of feed / Discover / following / friends / suggestions /
  activity; the ⋯ menu on a person card blocks/unblocks. `notify-social` skips
  sending if the target has blocked the actor.
- **Report:** a `reports` table (user/collection/comment + free-text reason),
  posted from the ⋯ menu. No public read — moderate via the dashboard.

Client: `flSocial.getPrefs/savePrefs`, `block/unblock/isBlocked/blockedSet`,
`report(kind,id,reason)`. All degrade gracefully if the tables/column are absent.

```sql
alter table public.public_profiles add column if not exists notify_prefs jsonb not null default '{}'::jsonb;

create table public.blocks (
  blocker_id uuid not null references auth.users on delete cascade,
  blocked_id uuid not null references auth.users on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  check (blocker_id <> blocked_id)
);
alter table public.blocks enable row level security;
create policy "blocks read self" on public.blocks for select using (auth.uid() = blocker_id);
create policy "blocks ins self"  on public.blocks for insert with check (auth.uid() = blocker_id);
create policy "blocks del self"  on public.blocks for delete using (auth.uid() = blocker_id);

create table public.reports (
  id          bigint generated always as identity primary key,
  reporter_id uuid not null references auth.users on delete cascade,
  target_type text not null check (target_type in ('user','collection','comment')),
  target_id   text not null,
  reason      text,
  created_at  timestamptz not null default now()
);
alter table public.reports enable row level security;
create policy "reports ins self" on public.reports for insert with check (auth.uid() = reporter_id);
-- no select policy: only service_role / dashboard can read reports.
```
(`notify-social` reads notify_prefs + blocks via the service role, so no extra
read policies are needed for it.)

---

## 19. Collaborative collections

A published collection (§11) can be co-edited. The owner invites collaborators
by @username; collaborators can add/remove places in the shared `collections`
row. Editing is read-modify-write on the `spots` jsonb (last-write-wins; fine at
this scale). Adding places works by **merging in one of your own published
collections** (union by spot id) — no catalogue access needed in the cloud
module. UI: a "Collaborate" sheet (Your collections / Shared with you sections
in the Profile sheet) — manage collaborators, remove places, merge places in.

Client: `flSocial.collaborators/addCollaborator/removeCollaborator/
sharedWithMe/collectionSpots/mergeIntoCollection/removeSpotFromCollection`.

### Schema (run once — extends §11)
```sql
create table public.collection_collaborators (
  slug       text not null references public.collections(slug) on delete cascade,
  user_id    uuid not null references auth.users on delete cascade,
  added_by   uuid references auth.users on delete set null,
  created_at timestamptz not null default now(),
  primary key (slug, user_id)
);
alter table public.collection_collaborators enable row level security;
create policy "cc read" on public.collection_collaborators for select using (true);
-- only the collection's owner manages its collaborators
create policy "cc ins owner" on public.collection_collaborators for insert
  with check (exists (select 1 from public.collections c where c.slug = collection_collaborators.slug and c.owner_id = auth.uid()));
create policy "cc del owner" on public.collection_collaborators for delete
  using (exists (select 1 from public.collections c where c.slug = collection_collaborators.slug and c.owner_id = auth.uid()));

-- let collaborators UPDATE the shared collection (in addition to the §11 owner policy)
create or replace function public.is_collab(p_slug text, p_uid uuid)
  returns boolean language sql security definer stable as
$$ select exists (select 1 from public.collection_collaborators where slug = p_slug and user_id = p_uid) $$;
revoke all on function public.is_collab(text,uuid) from public;
grant execute on function public.is_collab(text,uuid) to authenticated;
create policy "collab update" on public.collections for update
  using (public.is_collab(slug, auth.uid())) with check (public.is_collab(slug, auth.uid()));
```
Degrades gracefully if the table/policy/function are absent.

---

## 20. Collaborative collections: realtime presence + edit activity

- **Realtime presence:** the Collaborate sheet joins a Supabase channel
  `collab:<slug>` (presence + broadcast — no DB/replication setup needed). It
  shows "● here now" avatars of other collaborators viewing the same
  collection, and rebroadcasts an `edit` event on add/remove so everyone's
  place list refreshes live. The channel is removed on close.
- **Edit activity:** add/remove on a shared collection inserts a row into
  `collection_events`; the Activity feed then surfaces "X edited “collection”"
  for collections you own or collaborate on (excluding your own edits).

```sql
create table public.collection_events (
  id         bigint generated always as identity primary key,
  slug       text not null references public.collections(slug) on delete cascade,
  actor_id   uuid not null references auth.users on delete cascade,
  kind       text not null default 'edit',
  created_at timestamptz not null default now()
);
create index collection_events_slug on public.collection_events (slug, created_at desc);
alter table public.collection_events enable row level security;
create policy "ce read" on public.collection_events for select using (true);
-- only someone who can actually edit the collection may log an event for it
create policy "ce ins editor" on public.collection_events for insert with check (
  auth.uid() = actor_id and (
    public.is_collab(slug, auth.uid())
    or exists (select 1 from public.collections c where c.slug = collection_events.slug and c.owner_id = auth.uid())
  )
);
```
(`is_collab` is the SECURITY DEFINER function from §19.) Presence/broadcast need
no SQL — they work as long as Realtime is enabled on the project (default).
Everything degrades gracefully if the table/Realtime are unavailable.

---

## 21. Block enforcement (RLS)

Hardens §18 blocks so a blocked user can't *interact*, not just be hidden. A
`SECURITY DEFINER public.is_blocked(blocker,blocked)` is added, and the insert
policies for `follows`, `friend_requests`, `collection_comments` and
`collection_likes` now reject the row when the target (or the collection owner)
has blocked the actor. See the tail of `supabase/social-setup.sql`; it's
self-contained and idempotent, so it can be pasted on its own after the rest.

---

## 22. Discover ranking RPC + misc review follow-ups

- `top_collections(lim)` RPC ranks **all** public collections by like count
  server-side and returns the top N (with place count, the caller's `liked`
  flag, and author handle/avatar). Discover (`flSocial.discover` + `discover.html`)
  calls it and **falls back** to the old client-side tally if it's absent — so
  no behaviour change until you add it, then better ranking + far less data
  transferred. Self-contained; paste it on its own.
- Collaborative-merge spot cap aligned to 200 (matches publish).
- Re-added author avatars on feed/Discover collection cards (regressed during a
  refactor).

---

## 23. Leaderboards (public stats on `public_profiles`)

A leaderboard ranks **flâneurs who have a public profile** (a `@username`) by
public stat columns. The private synced state (`profiles.state`, §3) stays
per-user/RLS-locked — leaderboards only ever read the *opt-in public* numbers a
user writes to their own `public_profiles` row.

Add the stat columns (idempotent — safe to paste on its own):
```sql
alter table public.public_profiles
  add column if not exists checkins int     not null default 0,
  add column if not exists km       numeric not null default 0,
  add column if not exists visited  int     not null default 0,
  add column if not exists worlds   int     not null default 0,
  add column if not exists streak   int     not null default 0,
  add column if not exists stats_at timestamptz;
-- public read is already granted by the §13 "pp public read" policy; the owner
-- "pp owner update" policy lets each user write only their own stats.
create index if not exists public_profiles_checkins_idx on public.public_profiles (checkins desc);
create index if not exists public_profiles_km_idx       on public.public_profiles (km desc);
```

Client surface (cloud module, `window.flSocial`):
- `saveStats(o?)` — writes the signed-in user's public stats (`checkins`, `km`,
  `visited`, `worlds`, `streak`) onto their existing `public_profiles` row (an
  `update` keyed on `user_id` — a no-op until a `@username` is claimed, and it
  skips all-zero rows so it can never wipe real stats). With no argument it reads
  `window.__flStats`,
  which the app keeps current from local progress (verified set size, summed
  walk distance, places visited, Worlds completed, day streak). Called
  automatically (debounced) when those totals change, and again when the
  Leaderboard tab is opened. No-op when signed out / no public profile.
- `leaderboard(metric, limit)` — `metric` ∈ `checkins|km|visited|worlds|streak`;
  returns the top `limit` public profiles (default 50) ordered by that column,
  with `username/display_name/avatar_v` for rendering.

UI: the social page (`flSocialUI`, now a **full page**, not a bottom sheet) has a
**Leaderboard** tab with a metric toggle; the signed-in user's row is
highlighted. **Until the columns above exist the queries error and are caught —
the board simply shows "no one yet", nothing breaks.**

---

## 24. Match fixtures in the events feed (`ingest-matches`)

Football fixtures are ingested into the same `public.events` table as the other
sources, so they inherit the What's-on list, map pins, type filters and
in-person check-in for free. Appeals to a broader user base ("I was at the
match") and is just one source among many on the platform.

- **Source:** [Football-Data.org](https://www.football-data.org/) free tier.
  It returns kickoff + teams but **no stadium coordinates**, and the events row
  needs `lat/lng` + a Flâneur `city` slug. So `scripts/data/team-venues.json`
  maps each home club to its ground (`{aliases, city, lat, lng, venue}`) and a
  fixture is ingested **only if its home club's stadium is in a city we cover** —
  any other club is skipped (and logged so the map can be extended). Same-stadium
  clubs (Inter/AC Milan, Roma/Lazio) intentionally share coords.
- **Script:** `scripts/ingest-matches.mjs` — for the free-tier competitions
  (`PL, ELC, PD, SA, BL1, FL1, DED, PPL, CL`) it pulls `status=SCHEDULED`
  fixtures within the next 60 days, matches the home team (accent/suffix-tolerant
  name match), and upserts rows `{ext_id:"fd:<id>", category:"Sport",
  source:"matches", start_at:kickoff, end_at:kickoff+2h, …}` keyed on `ext_id`.
  Because the feed query drops events once `end_at < now`, a match naturally
  leaves the feed ~2h after kickoff.
- **Workflow:** `.github/workflows/ingest-matches.yml` — daily 05:30 UTC +
  manual. Add **one repo secret**: `FOOTBALL_DATA_KEY` (free, register at
  football-data.org → API token); it reuses `SUPABASE_SERVICE_ROLE_KEY`.
- **Matchday check-in window (app):** `flCheckinBtn` gates `source:"matches"`
  events to **~2h before kickoff → ~2h after full time** ("⏳ Check in opens on
  matchday" / "⏱ Match has ended"); outside that it falls through to the normal
  600 m proximity gate. Non-match events are unaffected. Makes "I was here for
  the match" feel real and curbs drive-by check-ins.
- **Extending coverage:** add clubs to `team-venues.json` (the script logs
  unmatched home teams each run); for more leagues/sports later, a paid
  Football-Data plan or a second source (e.g. TheSportsDB for US majors) can
  upsert into the same table with its own `source` tag.
