-- Roadmap step 13: "Turn the script into a worker." This step's own "Try"
-- assumes `posts` and `post_candidates` already exist -- no prior step created
-- them, so this migration is the groundwork the worker (pipeline-expert,
-- built after this lands) needs before it can watch for `pending` rows at
-- all. Spec: "Data model" table rows for `posts`/`post_candidates`, and the
-- "Pipeline" section's gather -> extract -> resolve -> confirm -> save flow.
-- Job-queue mechanism this schema has to support: simple polling, per
-- docs/decisions/0002-polling-job-queue.md -- the worker loops on an
-- interval, selects `pending` rows, processes them, updates status. This
-- migration does NOT build that loop (pipeline-expert's job) and does NOT
-- add the step 14 confirm action (no `post_places`, no UPDATE policy letting
-- a user set `post_candidates.selected`) -- scope is exactly "posts can be
-- created and the worker can process them," nothing past that.

-- ---------------------------------------------------------------------------
-- 1. post_source enum
-- ---------------------------------------------------------------------------
-- Spec's full stated value list: tiktok, screenshot, recording, manual.
-- Per CLAUDE.md's launch-platform decision only `tiktok` is actually
-- reachable today (screenshot is step 18, recording is "Later," and nothing
-- produces a `manual` post yet) -- but this is the same situation step 8's
-- trip_place_category enum was in: the list itself comes from the product
-- spec, not something expected to churn, so getting all four values in now
-- is cheaper than an `ALTER TYPE ... ADD VALUE` migration per future source.
-- An enum (not text+check) because, unlike `status` below, this domain is
-- genuinely closed -- there's no scenario where "screenshot" needs to be
-- renamed or removed, only new values appended, which is exactly what an
-- enum is cheap for and a free-text column buys nothing over.
create type public.post_source as enum (
  'tiktok',
  'screenshot',
  'recording',
  'manual'
);

-- ---------------------------------------------------------------------------
-- 2. posts: one share or upload -- also the processing job row itself
-- ---------------------------------------------------------------------------
-- Spec columns: trip_id, added_by, source, url, caption, status.
create table public.posts (
  id uuid primary key default gen_random_uuid(),

  -- Cascade: same reasoning as trip_places.trip_id (step 8) -- trips are
  -- archived, never deleted, by product design, so this is defensive
  -- referential integrity rather than something expected to fire in
  -- practice.
  trip_id uuid not null references public.trips (id) on delete cascade,

  -- Set null, not cascade: the spec's "former member" rule applies to posts
  -- the same way it applies to saves.user_id (step 8) -- "places a person
  -- added stay on the trip, credited to 'former member'." A deleted
  -- account's posts (and the pins they eventually produce) must not vanish,
  -- so this follows the established user-attribution pattern in this repo
  -- rather than cascading.
  added_by uuid references auth.users (id) on delete set null,

  source public.post_source not null,

  -- Nullable: a tiktok post always has a url (the shared link), but
  -- screenshot/recording posts (not built yet -- steps 18/"Later") won't --
  -- they'll carry a Storage path once that exists, not a url. Not making
  -- this NOT NULL now avoids a schema change later just to loosen it for a
  -- source this table already has to list.
  url text,

  -- Nullable: caption comes from TikTok's oEmbed response (step 10), which
  -- isn't guaranteed to return one, and doesn't apply at all to the other
  -- sources.
  caption text,

  -- Text + check, not an enum -- the opposite call from post_source just
  -- above, and deliberately so: this column is a job-state machine that is
  -- already known to need another value soon (step 14's confirm action,
  -- per the roadmap, moves a confirmed post past needs_confirmation), and
  -- plausibly a crash-recovery-driven value later (pipeline-expert's call,
  -- not built here). A check constraint is one
  -- `alter table ... drop constraint ... add constraint ...` to change;
  -- a real Postgres enum can only ever grow (ADD VALUE), never rename or
  -- remove a value, which is the wrong tradeoff for a vocabulary this
  -- unsettled. Values:
  --   - pending: inserted, not yet picked up by the worker.
  --   - processing: the worker has claimed this row and is actively
  --     extracting/resolving it. Exists specifically so a second worker
  --     pass (or a crash-recovery sweep) can tell "claimed, maybe stuck"
  --     apart from "never claimed" -- per decision 0002's own tradeoff
  --     ("a stuck/crashed job needs to be detected and retried by logic
  --     this step has to hand-build"), that logic needs a status value to
  --     key off of and a timestamp to measure staleness against
  --     (updated_at, below); this migration provides both primitives
  --     without implementing the sweep itself -- that's pipeline-expert's
  --     call on how long is "stuck" and what to do about it.
  --   - needs_confirmation: the worker finished successfully; candidates
  --     exist, waiting on step 14's confirm screen.
  --   - confirmed: foreshadowed by the roadmap's own step 14 description
  --     ("moves status further, e.g. to something like confirmed") --
  --     included now so step 14 doesn't need a second migration just to
  --     widen this list, even though nothing in this step's scope sets it.
  --   - failed: the worker hit an unrecoverable error (extraction or
  --     resolution). No separate "retrying" state -- a retry, if
  --     pipeline-expert builds one, re-enters at `pending`, it doesn't need
  --     its own status value.
  status text not null default 'pending',

  created_at timestamptz not null default now(),

  -- Bumped on every update (see the trigger below). Exists for the same
  -- crash-recovery reason `processing` does: without a timestamp, nothing
  -- can distinguish a row that's been `processing` for 3 seconds from one
  -- that's been stuck there since a worker crashed an hour ago. This
  -- migration only provides the column and the mechanism that keeps it
  -- accurate -- what counts as "too long" and what to do about it is
  -- pipeline-expert's decision, deliberately not encoded here.
  updated_at timestamptz not null default now(),

  constraint posts_status_valid_values check (
    status in ('pending', 'processing', 'needs_confirmation', 'confirmed', 'failed')
  )
);

comment on constraint posts_status_valid_values on public.posts is
  'Job-state vocabulary for the polling worker (docs/decisions/0002). Text+check, not an enum, because this list is expected to still change (step 14, crash-recovery) and a check constraint is cheap to redefine; an enum is not.';

-- Generic "touch updated_at on any row change" trigger function -- the
-- standard Postgres idiom for this, reusable by any future table that gets
-- its own updated_at column (not currently any other table in this repo,
-- but the function itself carries no posts-specific logic, so there's
-- nothing lost in making it generic rather than posts-only).
create function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger posts_set_updated_at
  before update on public.posts
  for each row
  execute function public.set_updated_at();

-- Core access pattern for this step, straight from decision 0002: "the
-- worker loops on an interval, selects pending rows from posts." A partial
-- index -- scoped to the two statuses the worker's poll (and, later, any
-- stale-job sweep) actually filters on -- keeps the index small as most
-- rows age into needs_confirmation/confirmed/failed and stop needing to be
-- found quickly, instead of indexing a column whose value distribution will
-- mostly be "done."
create index posts_pending_processing_idx on public.posts (status)
  where status in ('pending', 'processing');

-- Supports "list this trip's posts" (the confirm-screen history, step 14)
-- and is also what the RLS policies below and on post_candidates lean on --
-- Postgres does not auto-index a foreign key column, only the side it
-- references, so this needs to be explicit the same way step 8's
-- saves_user_id_idx was.
create index posts_trip_id_idx on public.posts (trip_id);

-- ---------------------------------------------------------------------------
-- 3. post_candidates: a place the extraction found, waiting on confirmation
-- ---------------------------------------------------------------------------
-- Spec columns: post_id, name, google_place_id, confidence, selected.
create table public.post_candidates (
  id uuid primary key default gen_random_uuid(),

  -- Cascade: a candidate has no reason to exist without its parent post --
  -- same "cleans up with its parent" reasoning as saves.trip_place_id
  -- cascading off trip_places (step 8), just one level up the chain.
  post_id uuid not null references public.posts (id) on delete cascade,

  -- Nullable, matching extract.py's own ExtractedPlace shape: `name` is
  -- Optional there too -- set to null specifically when a distinct real
  -- place is clearly meant but truly no name appears anywhere in the
  -- caption/hashtags (resolve_place.py's skipped_no_name case downstream).
  -- Forcing NOT NULL here would make the worker's insert fail on exactly
  -- the extraction outputs the schema needs to represent.
  name text,

  -- Nullable: only populated when resolve_place.py actually found a
  -- candidate place (match_quality confident or low_confidence). Stays
  -- null for no_match and skipped_no_name -- there is no Google place to
  -- point at yet, but the row (and its name, if any) still needs to exist
  -- so step 14's confirm screen can show "we found 'X' but couldn't match
  -- it -- search manually" per the spec's "manual search as a fallback"
  -- line, rather than silently dropping the candidate.
  --
  -- Deliberately plain text, not a foreign key to places(id): creating a
  -- `places` row here would mean extraction alone could cause a place to
  -- exist in the shared `places` table before any human confirmed it --
  -- the opposite of "extraction never auto-pins" (CLAUDE.md). The link to
  -- an actual places/trip_places row is step 14's job, once a human acts.
  google_place_id text,

  -- Extraction's own 0-1 float confidence (step 11), not resolve_place.py's
  -- MatchQuality -- that's the separate match_quality column below. Kept
  -- as its own column rather than folded into match_quality because the
  -- two signals answer different questions a future debugging session (or
  -- the eval harness) might ask separately: "how sure was the LLM this is
  -- a real, specific place" (confidence) vs. "how sure are we the Google
  -- result we found is actually that place" (match_quality). Always
  -- present -- every post_candidates row originates from one extracted
  -- candidate, and extraction always returns a confidence for each one.
  confidence numeric not null,

  -- resolve_place.py's MatchQuality, same four values, same meaning -- this
  -- is the signal that actually drives what the confirm screen shows (a
  -- confident top match vs. "didn't find it, search manually"), so it gets
  -- its own column rather than being inferred from google_place_id being
  -- null or not (null is ambiguous between no_match and skipped_no_name;
  -- this column isn't). Text+check, not an enum, for the same reason as
  -- posts.status: MatchQuality lives in pipeline-expert's Python code,
  -- which the worker's job is to track, not to fix -- if that enum's
  -- values change there, matching it here should be a cheap constraint
  -- edit, not an ALTER TYPE.
  match_quality text not null,

  -- "Extraction never auto-pins" (CLAUDE.md), made a structural fact, not a
  -- convention: this check constraint means NOTHING can insert or update
  -- this row with selected = true during this step -- not a buggy worker,
  -- not a stray UPDATE run by hand, not even the service-role key, since a
  -- CHECK constraint (unlike an RLS policy) is not bypassed by service
  -- role. RLS alone would only have blocked authenticated users, leaving
  -- the worker's own trusted-but-fallible code as the only thing standing
  -- between "extraction found a candidate" and "candidate is selected" --
  -- this constraint removes that gap entirely for this step. Step 14 is
  -- expected to `alter table public.post_candidates drop constraint
  -- post_candidates_selected_must_be_false` in its own migration, at the
  -- same time it adds the UPDATE policy that lets a human set this true.
  selected boolean not null default false,

  created_at timestamptz not null default now(),

  constraint post_candidates_match_quality_valid_values check (
    match_quality in ('confident', 'low_confidence', 'no_match', 'skipped_no_name')
  ),

  constraint post_candidates_confidence_range check (
    confidence >= 0 and confidence <= 1
  ),

  constraint post_candidates_selected_must_be_false check (selected = false)
);

comment on constraint post_candidates_selected_must_be_false on public.post_candidates is
  'Extraction never auto-pins (CLAUDE.md). Dropped by the step 14 migration alongside the UPDATE policy that lets a human confirm a candidate.';

-- Open gap, flagged rather than guessed at (same style as step 8's places
-- UPDATE/DELETE gap): extraction also produces a category per candidate
-- (roadmap step 11 -- "category, confidence" -- and the spec lists
-- labelling video types as a near-free high-priority feature), but the
-- spec's own post_candidates column list does not include one, and this
-- migration's brief was explicit about which columns to add. Not storing it
-- here means step 14's confirm action, when it creates a trip_places row,
-- currently has no extracted category to carry over and would have to
-- default every new pin to 'other'. Left for whoever builds step 14 to
-- decide (add a category column here, or re-derive it some other way) --
-- not silently dropped, called out here so it isn't missed.

-- Supports both the per-post "get candidates for the confirm screen" query
-- and the RLS policy below's join back to posts -- same auto-index gap as
-- posts.trip_id above.
create index post_candidates_post_id_idx on public.post_candidates (post_id);

-- ---------------------------------------------------------------------------
-- 4. RLS: posts
-- ---------------------------------------------------------------------------
-- "A trip and everything on it is visible only to members" (CLAUDE.md) --
-- posts are exactly that, gated the same way trip_places/saves are (step
-- 8): is_trip_member(trip_id), the existing SECURITY DEFINER helper, for
-- the same recursion-avoidance reason documented there.
alter table public.posts enable row level security;

create policy "Trip members can read their trip's posts"
on public.posts
for select
to authenticated
using (public.is_trip_member(trip_id));

-- INSERT: "any member can add posts" (CLAUDE.md) -- not owner-only. Two
-- checks: trip membership (same as every other trip-scoped INSERT in this
-- repo), and added_by = auth.uid() so a member can only ever attribute a
-- new post to themselves, never to another member -- the same pattern
-- saves.user_id's INSERT policy already uses (step 8) for the identical
-- reason.
--
-- TODO once trips.archived_at exists (same outstanding TODO as step 8's
-- trip_places/saves INSERT policies -- no roadmap step has added the column
-- yet): add
-- "and not exists (select 1 from public.trips where trips.id = trip_id and trips.archived_at is not null)"
-- to this with check, so a member can't add a post to an archived trip.
create policy "Trip members can add posts to their trip"
on public.posts
for insert
to authenticated
with check (
  public.is_trip_member(trip_id)
  and added_by = auth.uid()
);

-- No UPDATE policy for authenticated users. The worker is the only thing
-- that changes posts.status / updated_at at this step, and it runs with
-- the service role key -- which bypasses RLS by design, so it needs no
-- policy here at all, per CLAUDE.md's guidance on SECURITY DEFINER /
-- service-role scrutiny: this is deliberately not "a policy that merely
-- compiles," it's the documented reason none exists. Nothing in this
-- step's scope needs a human-triggered UPDATE on posts (step 14 might add
-- one, e.g. to let a user retry a failed post -- not built here).
--
-- No DELETE policy either -- the spec's "any member can ... delete pins"
-- is about trip_places (a pin), not posts (the job record / source link).
-- Deleting a post isn't a feature this step's scope includes; left as an
-- open gap rather than guessed at, same as places' missing UPDATE/DELETE
-- (step 8).

-- ---------------------------------------------------------------------------
-- 5. RLS: post_candidates
-- ---------------------------------------------------------------------------
-- post_candidates has no trip_id of its own -- trip membership is checked
-- by joining through posts to find which trip a given candidate's post
-- belongs to, the same shape saves' policies use via trip_places (step 8).
alter table public.post_candidates enable row level security;

create policy "Trip members can read candidates for their trip's posts"
on public.post_candidates
for select
to authenticated
using (
  exists (
    select 1
    from public.posts
    where posts.id = post_candidates.post_id
      and public.is_trip_member(posts.trip_id)
  )
);

-- No INSERT/UPDATE/DELETE policy for authenticated users. Only the worker
-- writes this table (inserting candidates after extraction+resolution),
-- and it does so via the service role key, bypassing RLS the same way it
-- does for posts.status above -- no policy needed. Step 14 will need an
-- UPDATE policy so a user can set `selected`, but that's step 14's job,
-- paired with dropping the post_candidates_selected_must_be_false check
-- constraint above -- not built prematurely here.

-- ---------------------------------------------------------------------------
-- 6. Preemptive anon revoke
-- ---------------------------------------------------------------------------
-- The realtime migration (20261008010000) found, reactively, that Postgres
-- Changes DELETE events bypass RLS entirely and are gated only by a
-- table's ordinary grants -- so trip_places/saves needed `revoke select ...
-- from anon` after the fact, once they were added to the realtime
-- publication. These two tables aren't added to supabase_realtime in this
-- migration (deliberately -- see note below), so that specific gap doesn't
-- exist yet. But since no permission rule in the spec allows anon
-- (unauthenticated) access to posts or post_candidates under any
-- operation, ever, there's no reason to wait for a future realtime
-- migration to rediscover this the hard way -- revoking now, on brand-new
-- tables where nothing yet depends on anon having any grant, costs
-- nothing. Broader than the earlier fix (all four operations, not just
-- SELECT) because this is preemptive rather than patching a proven gap.
revoke select, insert, update, delete on public.posts, public.post_candidates from anon;

-- ---------------------------------------------------------------------------
-- posts/post_candidates deliberately NOT added to supabase_realtime here.
-- ---------------------------------------------------------------------------
-- Step 14 (paste a link, confirm, pin appears live) is the step with an
-- actual UI screen that needs to react to a post's status changing or
-- candidates appearing without a refocus -- out of scope for this
-- migration's job (get posts into the pipeline at all). Revisit together
-- with step 14's migration.
