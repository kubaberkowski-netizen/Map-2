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

## 9. Roadmap after Phase 1

Photos → Storage (lazy up/download, local cache); friends + city leaderboards
(new RLS tables); server-validated achievements (Edge Function) to harden the XP
economy before any social comparison ships.
