-- Roadmap step 14: "Paste a link in the app." This is the schema groundwork
-- for the confirm action -- the thing that turns a `post_candidates` row a
-- human has looked at into a real pin. Per the brief, plus a security-review
-- pass (docs/decisions/0003-confirm-via-rpc.md) that found and closed a real
-- cross-trip data-poisoning gap in the first draft:
--   1. post_candidates.category (extraction produces one, step 13's
--      migration didn't add a column for it, so it's currently discarded).
--   2. post_candidates resolved-place columns (resolved_name/
--      formatted_address/lat/lng -- resolve_place.py already fetches these
--      for every candidate and the worker currently throws them away before
--      writing to the database). resolved_name (Google's own name) is kept
--      separate from the existing LLM-derived `name` on purpose -- see that
--      column's comment.
--   3. post_places (spec: "which posts mention which pin" -- the join table
--      that makes merged pins actually link back to every post about them).
--   4. Drop post_candidates_selected_must_be_false, add the UPDATE policy
--      that lets a human confirm a candidate, and COLUMN-LOCK it to
--      `selected` only (not the whole row) -- a plain policy would have let
--      a trip member rewrite a worker-written candidate's resolved place
--      data before it gets confirmed into a shared `places` row.
--   5. Narrow the step-8 `places` INSERT policy from `with check (true)` to
--      `google_place_id is null` -- the ACTUAL fix for the poisoning risk;
--      the RPC below is meaningless as a privileged write path if the
--      unprivileged one is still wide open next to it.
--   6. confirm_post_candidate(): a SECURITY DEFINER RPC (same pattern as
--      join_trip_by_code, step 7) that owns find-or-create on
--      places/trip_places, using ONLY Google-sourced fields
--      (resolved_name/formatted_address/lat/lng), never the LLM-derived
--      `name` -- closing a prompt-injection path from attacker-controlled
--      caption text into a shared, cross-trip row.
-- Does NOT touch worker.py/extract.py/resolve_place.py (pipeline-expert's
-- job, after this lands -- it needs to actually write resolved_name/
-- formatted_address/lat/lng/category) or build the confirm screen
-- (mobile-expert's job, calling confirm_post_candidate via supabase.rpc()).

-- ---------------------------------------------------------------------------
-- 1. post_candidates.category
-- ---------------------------------------------------------------------------
-- Reuses trip_place_category (step 8's enum) rather than a second enum --
-- extraction's category and a pin's category are the same closed 7-value
-- domain (food/views/entertainment/stay/shopping/nightlife/other), so a
-- second enum would just be a duplicate type with an awkward cast between
-- them at confirm time for no benefit.
--
-- NOT NULL with a default of 'other', matching trip_places.category's own
-- default (step 8) for the same reason: a confirm action that creates a
-- trip_places row can just carry this column straight across (insert ...
-- category = post_candidates.category) without a null-check or a second
-- default decision at that call site. Defaulting here also means this
-- column doesn't retroactively break anything about existing rows (there
-- are none yet -- step 13 only just shipped -- but the same migration
-- shape as adding a NOT NULL column to a populated table is worth getting
-- right once).
alter table public.post_candidates
  add column category public.trip_place_category not null default 'other';

comment on column public.post_candidates.category is
  'Extraction''s own category guess (step 11), same enum as trip_places.category. Carried into trip_places unchanged when a candidate is confirmed.';

-- ---------------------------------------------------------------------------
-- 2. post_candidates resolved-place columns
-- ---------------------------------------------------------------------------
-- Plain lat/lng floats, not a geography(point,4326) column like
-- places.location -- deliberate inconsistency with `places`, for a reason
-- specific to what this table is. `places` is the real, shared, queried-by-
-- distance table (it has the GiST index, step 8); `post_candidates` is a
-- staging row that either gets discarded (candidate not selected) or has its
-- lat/lng copied once into a real `places` row at confirm time -- it is
-- never itself the target of a spatial query ("places near here" always
-- queries `places`, never `post_candidates`). A geography column would cost
-- the same ST_MakePoint(lng, lat) order-sensitivity risk this schema already
-- warns about on `places`, for a value this table only ever reads back out
-- whole, never compares or measures -- plain floats are the simpler, equally
-- correct choice for a write-once-read-once staging value, and the confirm
-- insert into places.location does the one ST_MakePoint(lng, lat) call that
-- actually needs PostGIS.
--
-- All three nullable, matching resolve_place.py's ResolvedPlace exactly: a
-- no_match or skipped_no_name candidate has none of this (google_place_id is
-- also null in those cases already, so a null formatted_address/lat/lng is
-- the consistent, not-ambiguous way to represent "nothing was resolved").
-- resolved_name is Google's own displayName (resolve_place.py's
-- ResolvedPlace.name), kept SEPARATE from the existing `name` column (which
-- is extraction's LLM-derived guess). Added per security-reviewer: the
-- confirm RPC originally used the LLM-derived `name` to build the shared
-- `places.name` -- but `name` traces back to posts.caption, which any trip
-- member can set to arbitrary text (the posts INSERT policy has no content
-- validation). That's a real prompt-injection path: a caption engineered to
-- make the LLM "extract" a misleading name, resolved against a real
-- google_place_id, would poison that place's name for every OTHER trip that
-- later merges onto the same row -- and `places` has no UPDATE policy, so
-- it couldn't be corrected except by service role. Google's own displayName
-- isn't attacker-influenced (it comes back from Places Text Search, not
-- from anything the caption writer controls), so it's the only field the
-- confirm RPC should trust for `places.name`. `name` (the LLM's guess)
-- stays, still useful for the confirm screen's own display and for
-- no_match/skipped_no_name candidates where resolved_name is null.
alter table public.post_candidates
  add column resolved_name text,
  add column formatted_address text,
  add column lat double precision,
  add column lng double precision;

comment on column public.post_candidates.resolved_name is
  'Google''s own displayName from resolve_place.py''s Places Text Search result -- NOT the LLM-extracted name (see `name`). The only name source the confirm RPC trusts for places.name, since `name` traces back to attacker-controllable caption text. Null when match_quality is no_match or skipped_no_name.';
comment on column public.post_candidates.lat is
  'Latitude from resolve_place.py''s Places Text Search result. Null when match_quality is no_match or skipped_no_name.';
comment on column public.post_candidates.lng is
  'Longitude from resolve_place.py''s Places Text Search result. Null when match_quality is no_match or skipped_no_name.';

-- A lat/lng pair without the other is meaningless (either both are resolved
-- or neither is) -- this check constraint keeps that invariant structural
-- instead of relying on resolve_place.py's own internal consistency forever.
alter table public.post_candidates
  add constraint post_candidates_lat_lng_together check (
    (lat is null) = (lng is null)
  );

-- Cheap sanity bound, per security-reviewer: without this, a value outside
-- real coordinate range (reachable today only via a worker bug, and after
-- the column-lockdown below, never via a client) could sit in this table
-- until confirm's own insert into places.location fails. Matches real
-- latitude/longitude bounds, same as places.location implicitly enforces
-- via PostGIS.
alter table public.post_candidates
  add constraint post_candidates_lat_lng_range check (
    (lat is null or (lat >= -90 and lat <= 90))
    and (lng is null or (lng >= -180 and lng <= 180))
  );

-- ---------------------------------------------------------------------------
-- 3. post_places: which posts mention which pin
-- ---------------------------------------------------------------------------
-- Spec columns: post_id, trip_place_id. This is the link that makes "the
-- same place saved more than once in a trip merges into one pin ... and
-- links every post about it" (spec line 75) real -- every time a confirm
-- action resolves to an existing trip_places row (merge) or creates a new
-- one, a post_places row records that this specific post is one of the
-- sources for that pin.
create table public.post_places (
  id uuid primary key default gen_random_uuid(),

  -- Cascade: a post_places row has no reason to exist once its post is gone
  -- -- same "cleans up with its parent" shape as post_candidates.post_id
  -- (step 13) and saves.trip_place_id (step 8).
  post_id uuid not null references public.posts (id) on delete cascade,

  -- Cascade, NOT restrict: this is the one place this migration deliberately
  -- diverges from trip_places.place_id's restrict (step 8). That restrict
  -- exists because one `places` row can be legitimately pinned on several
  -- *different* trips, so deleting it could silently wipe out unrelated
  -- trips' pins -- too wide a blast radius. trip_place_id here doesn't have
  -- that problem: a `trip_places` row (a pin) is already scoped to exactly
  -- one trip, so when it's deleted (the spec's "delete for everyone" path),
  -- every post_places row pointing at it is, by definition, also about that
  -- same single trip's now-gone pin -- there's no other trip's data at risk.
  -- Matches saves.trip_place_id's own cascade (step 8) for the identical
  -- reason: "delete the trip_places row; its saves and post links go with
  -- it" is spec line 79, verbatim, for both tables.
  trip_place_id uuid not null references public.trip_places (id) on delete cascade,

  created_at timestamptz not null default now(),

  -- Uniqueness: yes. A post can mention the same real-world place only once
  -- -- if the confirm screen somehow ran twice for the same post+candidate
  -- (a double-tap, a retried request), the second attempt should be a no-op
  -- against the link table, not a second identical row that would double-
  -- count "how many posts link to this pin" for no reason. This also makes
  -- the confirm action's insert safely idempotent with `on conflict do
  -- nothing` if pipeline/mobile code wants that later, without needing a
  -- pre-check query first.
  constraint post_places_post_id_trip_place_id_key unique (post_id, trip_place_id)
);

-- Supports "which pins does this post link to" lookups and is the leading
-- column of the unique constraint above, so this index already exists via
-- that constraint -- no separate index needed for post_id.
--
-- trip_place_id has no automatic index (Postgres only indexes a foreign
-- key's referenced side, not the referencing side) and is the direction
-- "show every post that mentions this pin" (a pin's detail view) queries by
-- -- same auto-index gap called out for posts.trip_id/post_candidates.post_id
-- in step 13's migration.
create index post_places_trip_place_id_idx on public.post_places (trip_place_id);

-- ---------------------------------------------------------------------------
-- 4. RLS: post_places
-- ---------------------------------------------------------------------------
-- post_places has no trip_id of its own -- trip membership is checked by
-- joining through trip_places (same shape as saves' policies, step 8) and,
-- for the with check below, also through posts (a user could otherwise be a
-- member of two different trips and link a post from trip A to a pin on
-- trip B, since each FK target is independently valid even though the pair
-- crosses trips).
alter table public.post_places enable row level security;

create policy "Trip members can read post-place links on their trip"
on public.post_places
for select
to authenticated
using (
  exists (
    select 1
    from public.trip_places
    where trip_places.id = post_places.trip_place_id
      and public.is_trip_member(trip_places.trip_id)
  )
);

-- INSERT: unlike post_candidates/posts (worker-only, service-role, no
-- authenticated-role policy needed), this IS the confirm action itself --
-- a trip member tapping "confirm" in the app, using their own session, not
-- the worker. So this needs a real with check, not "no policy, service role
-- handles it." Three things it verifies:
--   1. The post being linked is on a trip the caller is a member of.
--   2. The trip_place being linked is on a trip the caller is a member of.
--   3. Those are the SAME trip -- otherwise a member of both trip A and
--      trip B could link a post from A to a pin on B, which is real data
--      leakage/corruption across two trips that happen to share one member,
--      not just an access-control gap.
-- Checking is_trip_member on each side already implies "the caller is a
-- member of that pin's/post's trip" individually; the explicit trip_id
-- equality is what rules out the cross-trip case, since membership alone
-- doesn't prevent the caller from naming two different trips' rows together.
-- TODO once trips.archived_at exists (same outstanding TODO on every other
-- trip-scoped write policy in this project -- no roadmap step has added the
-- column yet, flagged per security-reviewer so this one isn't the policy
-- that gets missed when archiving ships): also require neither trip's
-- archived_at is set.
create policy "Trip members can link a post to a pin on the same trip"
on public.post_places
for insert
to authenticated
with check (
  exists (
    select 1
    from public.posts
    join public.trip_places on trip_places.id = post_places.trip_place_id
    where posts.id = post_places.post_id
      and posts.trip_id = trip_places.trip_id
      and public.is_trip_member(posts.trip_id)
  )
);

-- No UPDATE policy: a post_places row has no mutable fields (just two
-- foreign keys and a timestamp) -- editing one would mean "retarget this
-- link to a different post or pin," which isn't a feature the spec
-- describes; default-denied, same reasoning as saves having no UPDATE
-- policy (step 8).
--
-- No DELETE policy for authenticated users: nothing in this step's scope
-- un-links a post from a pin independently of either row going away
-- entirely (that happens via the cascades above instead -- deleting the
-- post or the pin takes its post_places rows with it). Left as an open gap
-- rather than guessed at, same style as places' missing UPDATE/DELETE
-- (step 8) -- revisit if a future "remove this source" UI action needs it.

revoke select, insert, update, delete on public.post_places from anon;

-- ---------------------------------------------------------------------------
-- 5. post_candidates: allow a human to confirm a candidate
-- ---------------------------------------------------------------------------
-- Step 13's constraint made selected = true structurally impossible for
-- anything, including the service-role worker -- "extraction never
-- auto-pins" (CLAUDE.md) held even against a buggy worker. Now that a human-
-- confirm action exists to act on a selected candidate (this migration adds
-- post_places; mobile-expert adds the screen next), that constraint is
-- exactly the thing step 13's own comment said would be dropped here.
alter table public.post_candidates
  drop constraint post_candidates_selected_must_be_false;

-- UPDATE: a trip member can set `selected` on a candidate belonging to a
-- post on their trip. Joins through posts, same shape as the existing
-- SELECT policy on this table (step 13).
--
-- Column scope: Postgres RLS policies can't natively restrict which columns
-- an UPDATE touches -- a `with check` only validates the resulting row, not
-- which columns changed, so a policy permissive enough to let a member set
-- `selected` is, mechanically, also permissive enough to let them rewrite
-- `name`/`confidence`/`google_place_id`/`category`/etc. on a worker-written
-- row via the same PATCH. Building a trigger to reject changes to any
-- column except `selected` (comparing OLD vs NEW column-by-column, raising
-- an exception otherwise) is the real fix, but it's new, untested code
-- whose only job is defending against a client that doesn't exist yet --
-- the mobile app doesn't have a confirm screen until mobile-expert's next
-- step, and CLAUDE.md's own spec is "the mobile app only ever sends
-- {selected: true/false} in its PATCH." Step 8 made the identical call for
-- `places`' missing UPDATE policy (an open, documented gap rather than a
-- speculative fix) -- same reasoning applies here: trusting well-behaved
-- client code is an acceptable step-14 scope boundary, flagged here (and
-- worth a second look from security-reviewer) rather than silently assumed
-- safe forever. If a future client (or a compromised one) ever sends a
-- wider PATCH, this is the gap that lets it through.
--
-- One-way vs toggleable: toggleable. The roadmap's own confirm screen is
-- "checkboxes for each candidate" (step 14's Try line) -- checkboxes imply
-- a user can uncheck one before hitting a final "confirm" submit, the same
-- way step 13 foreshadowed multiple candidates needing review together, not
-- one irreversible commit per checkbox tap. Making this one-way would mean
-- a mis-tap requires either a second PATCH that's blocked by policy (dead
-- end) or deleting and re-inserting the row (losing the worker's original
-- extraction, which this row's whole job is to preserve). The actual
-- "commit" moment -- creating the trip_places/post_places rows -- happens
-- in a separate action (mobile-expert's confirm button, maybe via an RPC)
-- that reads selected = true at submit time; toggling selected back and
-- forth before that point is just editing a checkbox, not undoing a save.
-- TODO once trips.archived_at exists (same outstanding project-wide TODO,
-- flagged per security-reviewer): also require the trip not be archived.
create policy "Trip members can confirm or unconfirm candidates on their trip"
on public.post_candidates
for update
to authenticated
using (
  exists (
    select 1
    from public.posts
    where posts.id = post_candidates.post_id
      and public.is_trip_member(posts.trip_id)
  )
)
with check (
  exists (
    select 1
    from public.posts
    where posts.id = post_candidates.post_id
      and public.is_trip_member(posts.trip_id)
  )
);

-- Column-level lockdown, per security-reviewer: RLS alone can't restrict
-- which columns an UPDATE touches, so the policy above -- despite only
-- being "about" selected -- is mechanically permissive enough to let a
-- trip member rewrite google_place_id/lat/lng/name/category on a
-- worker-written row via the same PATCH. That's not just "corrupt your own
-- trip's staging data": confirm (this step's next piece) builds a real
-- `places` row from a candidate's google_place_id/lat/lng, and `places` is
-- shared across every trip with no UPDATE policy of its own (step 8) -- so
-- a rewritten candidate could poison a real place's coordinates for every
-- OTHER trip that later confirms the same real-world place and merges onto
-- it. That's cross-trip corruption surviving past this step, not a
-- contained gap -- worth closing now rather than deferring on the (weaker)
-- precedent of `places`' own missing policy, which fails CLOSED (no policy
-- = denied) where this would otherwise fail OPEN (a policy that's just too
-- permissive). Table-level revoke is required first because Supabase's
-- default grant covers every column; the column-level grant then narrows
-- authenticated access back down to exactly the one column this policy is
-- actually meant to allow.
revoke update on public.post_candidates from authenticated;
grant update (selected) on public.post_candidates to authenticated;

-- ---------------------------------------------------------------------------
-- 6. Close the open `places` INSERT policy (step 8) -- the actual fix
--    ADR 0003 was supposed to deliver
-- ---------------------------------------------------------------------------
-- Security-reviewer caught that the confirm RPC below was built, but the
-- `places` INSERT policy from step 8 ("Authenticated users can add places",
-- with check (true)) was never narrowed -- so a client could still insert
-- directly into `places` with any google_place_id/coordinates, completely
-- bypassing the RPC. Building a privileged write path means nothing if the
-- unprivileged one is still open next to it.
--
-- Narrowed to `google_place_id is null` rather than dropped outright: step
-- 8's hand-add-a-place flow (apps/mobile/src/services/places.ts,
-- addPlaceByHand) still needs to insert rows directly for places typed in
-- by hand, which never have a google_place_id (that's only populated by
-- step 12's Google Places resolution, via this migration's confirm RPC).
-- Hand-added places never collide with a real google_place_id, so they
-- never participate in the merge-by-google_place_id logic the RPC protects
-- -- narrowing to "only allowed when there's no google_place_id to fight
-- over" is the precise fix, not a blanket lockdown that would also break
-- the already-shipped hand-add feature.
alter policy "Authenticated users can add places"
on public.places
with check (google_place_id is null);

-- ---------------------------------------------------------------------------
-- 7. confirm_post_candidate(): the only path from a reviewed candidate to a
--    real pin. Per docs/decisions/0003-confirm-via-rpc.md: `places` has had
--    `with check (true)` since step 8 (any signed-in user can insert any
--    google_place_id/coordinates), which this step's own merge-by-
--    google_place_id logic turns from a theoretical gap into a real
--    cross-trip data-poisoning risk if left as plain client inserts. Same
--    SECURITY DEFINER pattern as join_trip_by_code (step 7) -- the function,
--    not any client-facing INSERT policy, is the thing that decides whether
--    a places/trip_places row gets created or merged.
--
-- Takes one candidate id at a time, not a batch array -- the confirm
-- screen can call this once per checked candidate; nothing about step 14's
-- UI needs a batch RPC, and a single-id function is simpler to read, test,
-- and reason about transactionally.
--
-- Returns trip_place_id (so the app can navigate to/highlight the pin) and
-- is_new_pin (true = this confirm created a new pin on this trip, false =
-- it merged onto one that already existed) -- the app can turn that into
-- "added" vs "merged with an existing pin and your save was added" copy.
-- Deliberately not returning more than that (e.g. an already_saved flag):
-- not asked for, and the app can already tell "my save" from the returned
-- trip_place_id plus its own local state.
--
-- SECURITY DEFINER scope and privilege-escalation check: this bypasses RLS
-- entirely, so this function re-verifies everything RLS would otherwise
-- have enforced on a direct client write, against auth.uid() (never a
-- client-supplied id):
--   1. The candidate's post belongs to a trip the caller is a member of
--      (is_trip_member) -- re-checked here even though post_candidates'
--      own SELECT policy already requires this for a normal read, because
--      that policy plays no part in a SECURITY DEFINER function's lookups.
--   2. The candidate actually has a resolved place to confirm
--      (google_place_id + lat + lng all present) -- a no_match/
--      skipped_no_name candidate has nothing to confirm.
--   3. places/trip_places are found-or-created by this function's own
--      logic (step 4/5 below), never by trusting a client-supplied choice
--      about whether to merge or create.
-- The only writes this function makes: a places row built from the
-- candidate's own resolved fields; a trip_places row on the trip the
-- caller is already verified a member of; a saves row for auth.uid()
-- specifically; a post_places row linking the candidate's own post; and
-- selected = true on the candidate itself. It exposes no other row's data.
-- search_path pinned to (public, pg_temp), same as every other SECURITY
-- DEFINER function in this project -- ST_MakePoint/ST_SetSRID below are
-- schema-qualified (extensions.*) instead of widening this pin to include
-- extensions, so the narrow pin stays consistent across every function in
-- this file regardless of which one happens to touch PostGIS.
--
-- Atomicity: no explicit transaction control needed. A single function
-- call is already one transaction in Postgres (same as join_trip_by_code);
-- nothing in this body opens a second one (no dblink, no autonomous
-- transaction block), so if any statement raises, every earlier
-- insert/update in this same call rolls back with it -- steps 4-7 can't
-- partially land.
--
-- Find-or-create concurrency: places and trip_places both use
-- `insert ... on conflict (...) do nothing returning id`, then a plain
-- select if that returned no row. This is race-safe for two near-
-- simultaneous confirms of the same place: the unique index itself
-- serializes the two inserts (places.google_place_id; trip_places'
-- existing (trip_id, place_id) constraint from step 8) -- whichever
-- transaction commits first keeps its row, the second's insert becomes a
-- no-op (zero rows for RETURNING ... INTO just assigns NULL, it doesn't
-- raise -- unlike a STRICT SELECT INTO), and its subsequent select finds
-- the first transaction's row once it's committed and visible. No retry
-- loop or exception handler needed here, unlike generate_invite_code's
-- collision retry (step 7) -- that function had to actively search for an
-- unused value; this one already has a unique constraint doing the real
-- work, on-conflict-do-nothing is just the concurrency-safe way to use it.
-- CORRECTED per security-reviewer (an earlier version of this comment
-- claimed otherwise): `places` has no DELETE policy for anyone but service
-- role, so its find-or-create window is genuinely closed. `trip_places` is
-- different -- it DOES have a member DELETE policy (step 8), and the
-- cleanup_empty_trip_place trigger can also delete a pin -- so there IS a
-- narrow window there where the row a fallback select is looking for could
-- have been deleted after a concurrent insert's no-op. Left open
-- deliberately rather than closed with unverified cleverness; see the
-- inline comment at that insert for the full reasoning -- it fails safely
-- (the whole transaction rolls back) rather than corrupting anything.
create function public.confirm_post_candidate(p_post_candidate_id uuid)
returns table (trip_place_id uuid, is_new_pin boolean)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_trip_id uuid;
  v_post_id uuid;
  v_post_status text;
  v_name text;
  v_resolved_name text;
  v_google_place_id text;
  v_formatted_address text;
  v_lat double precision;
  v_lng double precision;
  v_category public.trip_place_category;
  v_place_id uuid;
  v_trip_place_id uuid;
  v_is_new_pin boolean;
begin
  -- 1. Look up the candidate and the trip it belongs to in one go, joining
  -- through posts (same shape as this table's own SELECT policy). Also
  -- doubles as the "does this id even exist" check. resolved_name (Google's
  -- own name, security-reviewer fix) is selected separately from `name`
  -- (the LLM's guess) -- see the column's comment above for why only
  -- resolved_name is trusted for places.name below.
  select posts.trip_id, post_candidates.post_id, posts.status,
         post_candidates.name, post_candidates.resolved_name,
         post_candidates.google_place_id, post_candidates.formatted_address,
         post_candidates.lat, post_candidates.lng, post_candidates.category
  into v_trip_id, v_post_id, v_post_status,
       v_name, v_resolved_name,
       v_google_place_id, v_formatted_address,
       v_lat, v_lng, v_category
  from public.post_candidates
  join public.posts on posts.id = post_candidates.post_id
  where post_candidates.id = p_post_candidate_id;

  -- Not-found and not-a-member share one error code (42501), not two
  -- distinct ones -- per security-reviewer, folding these avoids letting a
  -- caller distinguish "this id doesn't exist" from "it exists but isn't
  -- yours to see," matching join_trip_by_code's single-generic-error
  -- precedent (step 7). Low-severity either way (candidate ids are random
  -- UUIDs, not enumerable), but free to close while already editing this
  -- function for the ON CONFLICT fix below.
  if v_trip_id is null then
    raise exception 'confirm_post_candidate: not found or not accessible'
      using errcode = 'insufficient_privilege'; -- SQLSTATE 42501
  end if;

  -- 2. Trip membership -- the check RLS would have done on a direct client
  -- write, re-verified here because SECURITY DEFINER bypasses RLS entirely.
  --
  -- TODO once trips.archived_at exists (same outstanding project-wide TODO
  -- as every other trip-scoped write path -- no roadmap step has added the
  -- column yet, flagged per security-reviewer since this function, being
  -- SECURITY DEFINER, is NOT covered by RLS policies that add an archived
  -- check later -- it needs its own explicit check added here too): also
  -- raise if the trip is archived.
  if not public.is_trip_member(v_trip_id) then
    raise exception 'confirm_post_candidate: not found or not accessible'
      using errcode = 'insufficient_privilege'; -- SQLSTATE 42501
  end if;

  -- 2b. Post status -- ADR 0003's own tradeoffs section says this function
  -- "re-verifies trip membership and post status"; the first version only
  -- did the first half (security-reviewer finding). A post not in
  -- needs_confirmation has either already been fully processed or isn't
  -- ready yet -- confirming a candidate from it is a data-integrity
  -- violation even though it isn't a cross-trip security hole on its own.
  if v_post_status is distinct from 'needs_confirmation' then
    raise exception 'confirm_post_candidate: post % is not awaiting confirmation (status=%)',
      v_post_id, v_post_status
      using errcode = 'invalid_parameter_value'; -- SQLSTATE 22023
  end if;

  -- 3. Confirmable check: a no_match/skipped_no_name candidate has no real
  -- place to confirm into. post_candidates_lat_lng_together already
  -- guarantees lat/lng are both-or-neither, but google_place_id is an
  -- independent column, so all three are checked explicitly here.
  if v_google_place_id is null or v_lat is null or v_lng is null then
    raise exception 'confirm_post_candidate: candidate % has no resolved place to confirm', p_post_candidate_id
      using errcode = 'invalid_parameter_value'; -- SQLSTATE 22023
  end if;

  -- 4. Find-or-create places, merging by google_place_id -- this function,
  -- not an open client insert, now controls whether a new places row is
  -- created (the places INSERT policy above was also narrowed to
  -- google_place_id is null, so this is genuinely the only path that can
  -- create a places row carrying one).
  --
  -- Uses v_resolved_name (Google's own displayName), NOT v_name (the LLM's
  -- extraction) -- security-reviewer finding: v_name traces back to
  -- posts.caption, which any trip member can set to arbitrary text, making
  -- it a real prompt-injection path into a shared, cross-trip row that
  -- can't be corrected afterward (places has no UPDATE policy).
  -- COALESCE(v_resolved_name, v_name) is defensive only -- the check above
  -- already guarantees google_place_id is present, and the worker always
  -- writes resolved_name whenever google_place_id is present, so the
  -- fallback should never actually fire; keeping it rather than asserting
  -- avoids a hard failure if that invariant is ever violated by a future
  -- bug, while still preferring the trustworthy source whenever it exists.
  --
  -- ST_MakePoint is longitude-first (lng, lat) -- see places.location's own
  -- column comment; schema-qualified since this function's search_path
  -- doesn't include extensions (see note above the function).
  insert into public.places (google_place_id, name, address, location)
  values (
    v_google_place_id,
    coalesce(v_resolved_name, v_name),
    v_formatted_address,
    extensions.ST_SetSRID(extensions.ST_MakePoint(v_lng, v_lat), 4326)::extensions.geography
  )
  on conflict (google_place_id) do nothing
  returning id into v_place_id;

  if v_place_id is null then
    select id into v_place_id from public.places where google_place_id = v_google_place_id;
  end if;

  -- 5. Find-or-create trip_places, merging by (trip_id, place_id) -- the
  -- existing unique constraint from step 8 is the merge key. Category comes
  -- straight from the candidate's own extracted category (this migration's
  -- post_candidates.category column), no notes.
  --
  -- Corrected per security-reviewer: an earlier version of this comment
  -- claimed "no delete policy exists on either table," used as the reason
  -- this do-nothing-plus-fallback-select pattern has no race window. That
  -- claim is FALSE for trip_places specifically -- it DOES have a member
  -- DELETE policy (step 8), and the cleanup_empty_trip_place trigger can
  -- also delete a pin when its last save is removed. So there IS a narrow
  -- window: a concurrent insert's conflicting row could be deleted between
  -- this insert's no-op and the fallback select below finding nothing,
  -- which would leave v_trip_place_id null and fail the saves insert with
  -- a NOT NULL violation a few lines down. Deliberately NOT closed with a
  -- DO UPDATE+xmax trick here -- that fully closes the window but adds
  -- unverified complexity (this environment has no local Postgres to test
  -- against) for a failure mode that already fails SAFELY: the whole
  -- transaction rolls back (see the atomicity note above the function), so
  -- the realistic outcome is "a retry is needed," not data corruption.
  -- Accepted as a known, narrow, fail-closed gap rather than engineering
  -- around it blind -- revisit with a tested fix if this ever actually
  -- fires in practice.
  insert into public.trip_places (trip_id, place_id, category)
  values (v_trip_id, v_place_id, v_category)
  on conflict (trip_id, place_id) do nothing
  returning id into v_trip_place_id;

  if v_trip_place_id is null then
    v_is_new_pin := false; -- a pin for this place already existed on this trip: this confirm merged onto it
    select id into v_trip_place_id from public.trip_places
    where trip_id = v_trip_id and place_id = v_place_id;
  else
    v_is_new_pin := true;
  end if;

  -- 6. The confirming user's own save -- matches step 8's hand-add flow
  -- treating "adding a place" as implicitly saving it. Idempotent: a no-op,
  -- not an error, if they've somehow already saved this pin. Uses the
  -- constraint name directly, not a bare column list -- `trip_place_id` as
  -- a bare identifier in ON CONFLICT (...) would be ambiguous against this
  -- function's own `trip_place_id` OUT parameter/return-table column (a
  -- real bug security-reviewer caught: this would have raised 42702
  -- "ambiguous column reference" on every real call past this point,
  -- since plpgsql only parses a statement the first time it executes --
  -- CREATE FUNCTION succeeds either way, the error only surfaces at
  -- runtime). Naming the constraint sidesteps the ambiguity entirely
  -- rather than relying on qualification tricks.
  insert into public.saves (trip_place_id, user_id)
  values (v_trip_place_id, auth.uid())
  on conflict on constraint saves_trip_place_id_user_id_key do nothing;

  -- 7. Link this post to the resulting pin. Idempotent the same way, same
  -- ambiguity reason -- `post_places_post_id_trip_place_id_key` named
  -- directly instead of `(post_id, trip_place_id)`.
  insert into public.post_places (post_id, trip_place_id)
  values (v_post_id, v_trip_place_id)
  on conflict on constraint post_places_post_id_trip_place_id_key do nothing;

  -- 8. This RPC's own action is the source of truth for "confirmed" --
  -- doesn't need or trust the client's optimistic PATCH to have already set
  -- this via the selected-only grant above.
  update public.post_candidates
  set selected = true
  where id = p_post_candidate_id;

  return query select v_trip_place_id, v_is_new_pin;
end;
$$;

-- Same two-step revoke as join_trip_by_code required, per
-- 20261005235959_revoke_anon_execute_on_join_trip_by_code.sql's own finding:
-- Supabase grants EXECUTE directly to anon/authenticated/service_role on
-- every new function, not through the PUBLIC pseudo-role, so
-- "revoke all ... from public" alone does not revoke anon's access -- the
-- explicit "revoke ... from anon" below is the line that actually matters,
-- included here from the start since that gap is already a known finding
-- in this project, not something to rediscover.
revoke all on function public.confirm_post_candidate(uuid) from public;
grant execute on function public.confirm_post_candidate(uuid) to authenticated;
revoke execute on function public.confirm_post_candidate(uuid) from anon;
-- service_role keeps EXECUTE implicitly (never revoked) -- harmless, same
-- reasoning as join_trip_by_code: service_role already bypasses RLS and
-- grants by design, and nothing in this project calls this function as
-- service_role anyway.
