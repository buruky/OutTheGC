-- Roadmap step 8: "Pins from the database." Adds the three tables that turn a
-- confirmed place into something that shows up on a trip's map: `places` (a
-- real-world place, shared across every trip), `trip_places` (a pin: one place
-- merged onto one trip), and `saves` (one person's save of a pin, which is what
-- "saved by N" counts). Spec: "Data model" table and the "Merged pins" /
-- "Saved by N people" / "Remove my save" / "Delete for everyone" bullets under it.
--
-- Scope, per the brief: DB and dashboard only. No app UI (that's wired up after
-- this lands), no Google Places lookup (step 12 -- google_place_id stays nullable
-- until then), no Realtime (step 9). Everything here needs to be testable by hand
-- via SQL/dashboard inserts, which is how the roadmap's "done when" gets checked:
-- two accounts saving the same place on a trip should produce one trip_places row
-- and a saves count of 2.

-- ---------------------------------------------------------------------------
-- 1. PostGIS extension
-- ---------------------------------------------------------------------------
-- `places.location` needs a real geographic point type, not two plain float
-- columns, so distance queries (today: none; later: the "suggestions within a
-- radius" open question) are built on real geodetic math instead of hand-rolled
-- haversine SQL. Installed into the `extensions` schema, not `public` -- the
-- Supabase convention for extensions, so `public` stays free of extension-owned
-- objects. config.toml's `extra_search_path = ["public", "extensions"]` is
-- already set, so unqualified PostGIS function calls (ST_MakePoint, etc.) still
-- resolve without schema-qualifying every call.
create extension if not exists postgis with schema extensions;

-- ---------------------------------------------------------------------------
-- 2. trip_place_category enum
-- ---------------------------------------------------------------------------
-- Decision already made (per CLAUDE.md/spec Open Questions #4, resolved at this
-- step): a fixed Postgres enum, not a free-text column or a lookup table. An enum
-- buys two things a lookup table wouldn't for a fixed, rarely-changing set: the
-- column itself enforces the domain (no RLS or CHECK constraint needed to reject
-- a bad category), and it's a smaller, faster column (4 bytes) than a text FK.
-- The cost -- adding a new category later requires a migration (`ALTER TYPE ...
-- ADD VALUE`) rather than an INSERT -- is acceptable since the list came from the
-- product spec, not something expected to churn.
create type public.trip_place_category as enum (
  'food',
  'views',
  'entertainment',
  'stay',
  'shopping',
  'nightlife',
  'other'
);

-- ---------------------------------------------------------------------------
-- 3. places: a real-world place, shared across every trip
-- ---------------------------------------------------------------------------
-- Spec columns: google_place_id (unique), name, address, location (PostGIS point).
-- No trip_id here on purpose -- a place isn't owned by a trip, it's a fact about
-- the world (like a row in Google's own Places database). Two different trips
-- pinning the same restaurant point at the same `places` row; what's scoped per
-- trip is the pin (`trip_places`), not the place itself.
create table public.places (
  id uuid primary key default gen_random_uuid(),

  -- Nullable for now: step 8 is hand-added places only (type a name and
  -- coordinates), so there's no Google Place id to store yet. Step 12 adds the
  -- real Google Places lookup and will start populating this. Unique so that once
  -- step 12 exists, resolving the same real place twice (from two different
  -- posts, or two different trips) finds the existing row instead of creating a
  -- duplicate -- the same merge principle as trip_places' own unique constraint,
  -- one level up. Multiple NULLs are allowed under a unique constraint in
  -- Postgres, which is exactly what's needed here: many hand-added places can
  -- all have a NULL google_place_id without conflicting with each other.
  google_place_id text unique,

  name text not null, -- every place needs a name, hand-typed for now
  address text, -- nullable: a hand-added place may not have a formatted address yet

  -- geography, not geometry: this project only ever needs "where is this point on
  -- earth" and "how far apart are two points," never planar/local-projection math,
  -- so geography's built-in geodetic distance calculations (great-circle, accounts
  -- for the earth's curvature) are the right default over geometry's flat-plane
  -- math. SRID 4326 is WGS84 -- the standard GPS latitude/longitude reference
  -- system, and what every consumer of this column (Google Places, Apple/Google
  -- Maps, react-native-maps) already speaks.
  --
  -- COLUMN ORDER WARNING: PostGIS points are constructed and read as
  -- (longitude, latitude) -- ST_MakePoint(lng, lat), never (lat, lng). This is the
  -- most common silent PostGIS bug (a point that "works" but is mirrored/rotated
  -- on the map) because it's the reverse of how humans normally say coordinates
  -- out loud. Every insert/read against this column needs to get that order right.
  location extensions.geography(point, 4326) not null,

  created_at timestamptz not null default now()
);

comment on column public.places.location is
  'WGS84 point (SRID 4326). Longitude first: ST_MakePoint(lng, lat), not (lat, lng).';

-- Spatial index: not load-bearing for anything built in this step (no radius
-- queries exist yet), but a GiST index is the standard, cheap-to-add-now,
-- expensive-to-forget index for any PostGIS column that will ever be queried by
-- distance or bounding box -- exactly the "suggestions within a radius" open
-- question. Costs a small amount of write overhead and storage today for free
-- correctness later.
create index places_location_idx on public.places using gist (location);

-- ---------------------------------------------------------------------------
-- 4. trip_places: a pin -- one place, merged onto one trip
-- ---------------------------------------------------------------------------
-- Spec columns: trip_id, place_id, category, notes; unique on (trip_id, place_id).
-- That uniqueness is the entire mechanism behind "merged pins" (spec: "the same
-- place saved more than once in a trip merges into one pin") -- a second person
-- (or a second post) pinning the same place on the same trip can't create a
-- second trip_places row at all; it just adds a `saves` row (or, later,
-- `post_places` row) pointing at the one that already exists.
create table public.trip_places (
  id uuid primary key default gen_random_uuid(),

  -- Cascade: matches trip_members.trip_id's existing pattern in this repo. Trips
  -- are archived, never deleted, by product design, so this is defensive
  -- referential integrity rather than something expected to fire in practice.
  trip_id uuid not null references public.trips (id) on delete cascade,

  -- Restrict, not cascade: a `places` row can be pinned on several *different*
  -- trips at once (that's the whole point of places being trip-agnostic). If
  -- deleting one `places` row cascaded, a single delete could silently wipe out
  -- pins on unrelated trips that happen to share the same real-world place --
  -- too wide a blast radius for an action no policy below even allows yet (there
  -- is deliberately no DELETE policy on `places` in this migration). RESTRICT
  -- costs nothing today (nothing can delete a place row anyway) and avoids
  -- building in a dangerous default for whenever a places-cleanup/merge path
  -- does get built (step 12's google_place_id reconciliation is the likely
  -- candidate) -- that future code can reassign trip_places.place_id explicitly
  -- instead of relying on an implicit cascade.
  place_id uuid not null references public.places (id) on delete restrict,

  -- NOT NULL with a default, not nullable: every pin should carry a real
  -- category once the UI/extraction supplies one, but defaulting to 'other'
  -- keeps hand-inserted test rows (this step's actual verification method) simple
  -- -- an INSERT that only specifies trip_id/place_id still succeeds instead of
  -- failing on a missing category.
  category public.trip_place_category not null default 'other',

  notes text, -- free-text, optional

  created_at timestamptz not null default now(),

  constraint trip_places_trip_id_place_id_key unique (trip_id, place_id)
);

-- ---------------------------------------------------------------------------
-- 5. saves: one person's save of a pin -- the "saved by N" count
-- ---------------------------------------------------------------------------
-- Spec columns: trip_place_id, user_id (null if account deleted); unique on
-- (trip_place_id, user_id). "Saved by N" (spec) is just `count(*)` of this table
-- grouped by trip_place_id -- no denormalized counter column, so the count can
-- never drift out of sync with the actual rows.
create table public.saves (
  id uuid primary key default gen_random_uuid(),

  -- Cascade: this is the spec's "delete for everyone" mechanism -- "delete the
  -- trip_places row; its saves ... go with it" (spec line 79). Deleting a pin
  -- deletes every save of it in the same statement, via Postgres's own FK
  -- enforcement, not application code that could forget to clean them up.
  trip_place_id uuid not null references public.trip_places (id) on delete cascade,

  -- Set null, not cascade: this is the spec's "former member" rule -- a deleted
  -- account's save stays on the pin (still counts toward "saved by N") but loses
  -- its identity. Unlike trip_members.user_id (see that migration's reasoning),
  -- user_id here is NOT part of the primary key, so "set null" doesn't hit the
  -- same NOT NULL conflict -- it's both the correct product behavior and
  -- mechanically safe.
  user_id uuid references auth.users (id) on delete set null,

  created_at timestamptz not null default now(),

  -- Multiple NULLs are allowed under this unique constraint (Postgres unique
  -- constraints don't treat NULL as equal to NULL), which is exactly right here:
  -- several different former members who each saved the same pin, now all NULL,
  -- must stay as distinct rows so the save count doesn't silently collapse them
  -- into one.
  constraint saves_trip_place_id_user_id_key unique (trip_place_id, user_id)
);

-- Supports "my saves" filtering (spec: "mine filters pins by saves.user_id = me")
-- without a sequential scan across every save on every trip the user's in. The
-- unique constraint above already gives an index with trip_place_id leading,
-- which doesn't help a plain "all my saves across trips" query.
create index saves_user_id_idx on public.saves (user_id);

-- ---------------------------------------------------------------------------
-- 6. Trigger: a pin with zero saves deletes itself
-- ---------------------------------------------------------------------------
-- Spec: "remove my save: delete my saves row. When a pin has zero saves, it is
-- deleted." The brief asks this to be called out explicitly rather than picked
-- silently:
--
-- TRIGGER (chosen) vs. APP-LAYER:
-- - Trigger: the invariant "a trip_places row with zero saves cannot exist"
--   holds no matter what deletes the last save -- the mobile app's "remove my
--   save" button, a future admin tool, a SQL script run by hand, a different
--   client built later. Correctness doesn't depend on every call site
--   remembering to also check-and-delete. The cost is the usual trigger cost:
--   the behavior lives in the database instead of in a place you can grep in
--   the app's source, so a developer reading only the mobile code could be
--   surprised that removing a save sometimes removes the pin.
-- - App-layer: simpler to read and debug one place (the mobile code for the
--   "remove my save" button) end to end, and no SQL to reason about. The risk is
--   exactly the thing a trigger prevents: any other way of deleting a save
--   (another screen added later, a direct dashboard delete, a future worker
--   action) silently leaves an orphaned zero-save pin behind, which then needs
--   its own cleanup job to find and fix later.
-- Going with the trigger: this is a data-integrity invariant ("this row's reason
-- to exist is gone"), not a UI workflow step, so it belongs next to the data,
-- the same reasoning this repo already applied to "a trip's creator becomes a
-- member" (handle_new_trip, step 6) and "an account's new row gets a profile"
-- (step 5) -- both invariants that must hold regardless of which client path
-- triggered them.
--
-- SECURITY DEFINER: deliberately decouples this invariant from whatever the
-- trip_places DELETE policy currently allows. Today that policy already permits
-- any trip member to delete any pin, so the invoking member could delete the
-- empty trip_places row themselves without elevated privilege -- but "who may
-- intentionally delete a pin for everyone" and "a pin with nobody saving it does
-- not exist" are two different rules, and the spec's own open question ("who can
-- delete someone else's pin?") says the first one might get tightened later
-- (e.g. restricted to whoever added the pin). If that happens, this cleanup
-- should still fire for a member who isn't allowed to delete *other* pins, since
-- they're not deleting someone else's pin -- they're removing their own save,
-- and a now-empty pin disappearing is a side effect of that, not a delete action
-- they're taking against a pin they don't own. Scope stays narrow: this function
-- takes no input beyond what the trigger already passes it (old.trip_place_id),
-- deletes at most one row, only when that row has become unreferenced by any
-- save, and exposes nothing to a caller. search_path pinned to (public, pg_temp)
-- for the same schema-hijacking reason as every other SECURITY DEFINER function
-- in this repo.
--
-- Cascade-safety check: if a pin is deleted directly ("delete for everyone"),
-- its saves rows cascade-delete as part of that same statement, which fires this
-- trigger once per cascaded save row. By the time each of those fires, the
-- parent trip_places row has already been removed (the cascade is a consequence
-- of that removal, not a separate later step), so this trigger's own
-- `delete from trip_places where id = ...` matches zero rows and is a harmless
-- no-op -- no error, no infinite recursion, nothing left to cascade further.
create function public.cleanup_empty_trip_place()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  delete from public.trip_places
  where id = old.trip_place_id
    and not exists (
      select 1 from public.saves where saves.trip_place_id = old.trip_place_id
    );
  return null; -- result is ignored for an AFTER trigger
end;
$$;

create trigger on_save_deleted_cleanup_empty_pin
  after delete on public.saves
  for each row
  execute function public.cleanup_empty_trip_place();

-- This function has no legitimate direct-call use case (unlike join_trip_by_code,
-- it isn't meant to be invoked via RPC by the app at all -- only by the trigger
-- above) and Supabase auto-grants EXECUTE on new public-schema functions directly
-- to anon/authenticated/service_role (the same gotcha found and fixed in step 7's
-- migrations). Revoking from anon and authenticated closes off that unintended
-- RPC surface; trigger firing itself doesn't require EXECUTE privilege on the
-- function (Postgres's trigger manager invokes it directly, gated by DML
-- privilege on the table, not by the function's own grants), so this revoke is
-- free -- "remove my save" continues to work for every trip member.
revoke all on function public.cleanup_empty_trip_place() from public;
revoke execute on function public.cleanup_empty_trip_place() from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 7. RLS: places
-- ---------------------------------------------------------------------------
-- `places` has no trip concept, so "visible only to trip members" (CLAUDE.md's
-- permission rules) doesn't apply to it directly -- trip-level privacy is
-- enforced at the `trip_places`/`saves` layer, not here. But RLS is still
-- enabled, for a narrower reason: without it, Supabase's default table grants
-- would leave this table readable and writable by the fully unauthenticated
-- `anon` role too, not just signed-in users. A place's name/address/coordinates
-- aren't secret (knowing a restaurant exists and where it is isn't a privacy
-- leak -- it's public information, same as it being in Google Places), so the
-- policy below is deliberately permissive among signed-in users; the actual
-- thing being protected against is anonymous write/read access, not member vs.
-- non-member.
alter table public.places enable row level security;

create policy "Authenticated users can read places"
on public.places
for select
to authenticated
using (true);

create policy "Authenticated users can add places"
on public.places
for insert
to authenticated
with check (true);

-- No UPDATE or DELETE policy: out of scope for this step. A place is shared
-- across every trip that's pinned it, so "who can fix a typo'd address on a
-- place three different trips are using" is a real question (does it need
-- owner-of-the-place semantics? trip-member consensus? admin-only?) that the
-- spec doesn't answer yet -- left as an open gap rather than guessed at here.
-- Both operations are default-denied for every role except a direct
-- service-role/superuser connection until that's decided.

-- ---------------------------------------------------------------------------
-- 8. RLS: trip_places
-- ---------------------------------------------------------------------------
-- "A trip and everything on it is visible only to members" (CLAUDE.md) --
-- trip_places is exactly the kind of "everything on it" that rule is about, so
-- every policy below gates on is_trip_member(trip_id), the same SECURITY DEFINER
-- helper trips/trip_members already use (step 6), for the same reason: it
-- bypasses RLS internally to avoid the self-referencing-policy recursion bug
-- fixed in 20261005234248_fix_trip_members_rls_recursion.sql, which would
-- otherwise resurface here too (trip_places' own policy would need to query
-- trip_members, which has RLS enabled).
alter table public.trip_places enable row level security;

create policy "Trip members can read their trip's pins"
on public.trip_places
for select
to authenticated
using (public.is_trip_member(trip_id));

-- INSERT: "any member can add posts, edit pins, save, unsave, and delete pins"
-- (CLAUDE.md) -- adding a pin isn't owner-only.
--
-- TODO once trips.archived_at exists (same situation as join_trip_by_code's TODO
-- in 20261005235900_add_invite_code_and_join_function.sql -- no roadmap step has
-- added the column yet): add
-- "and not exists (select 1 from public.trips where trips.id = trip_id and trips.archived_at is not null)"
-- to this with check, so a member can't add a new pin to an archived trip.
-- Flagging here now so it isn't missed when archiving ships -- this is the real
-- current gap in "nobody can edit an archived trip" for this step.
create policy "Trip members can add pins to their trip"
on public.trip_places
for insert
to authenticated
with check (public.is_trip_member(trip_id));

-- UPDATE: "edit pins" -- category/notes -- any member, not owner-only.
-- Same archived_at TODO as the INSERT policy above applies here too.
create policy "Trip members can edit pins on their trip"
on public.trip_places
for update
to authenticated
using (public.is_trip_member(trip_id))
with check (public.is_trip_member(trip_id));

-- DELETE: "delete pins" -- this is the spec's "delete for everyone" path, any
-- member, not owner-only (per CLAUDE.md's explicit list). The spec's own open
-- question ("who can delete someone else's pin?") may narrow this later; today
-- it matches CLAUDE.md's rule exactly: any member.
-- Same archived_at TODO as above applies here too.
create policy "Trip members can delete pins on their trip"
on public.trip_places
for delete
to authenticated
using (public.is_trip_member(trip_id));

-- ---------------------------------------------------------------------------
-- 9. RLS: saves
-- ---------------------------------------------------------------------------
-- saves has no trip_id column of its own -- trip membership is checked by
-- joining through trip_places to find which trip a given save's pin belongs to.
alter table public.saves enable row level security;

create policy "Trip members can read saves on their trip's pins"
on public.saves
for select
to authenticated
using (
  exists (
    select 1
    from public.trip_places
    where trip_places.id = saves.trip_place_id
      and public.is_trip_member(trip_places.trip_id)
  )
);

-- INSERT: "any member can ... save" -- but only as themselves, never on another
-- member's behalf. `user_id = auth.uid()` in the with check is what enforces
-- "not other members' saves" from CLAUDE.md -- a client can't insert a save row
-- naming a different user_id, and can't insert one with a null user_id either
-- (that only ever happens later, via the account-deletion set-null, never on
-- insert).
--
-- TODO once trips.archived_at exists: also require the trip not be archived
-- here, same reasoning as trip_places' TODOs above.
create policy "Trip members can save a pin for themselves"
on public.saves
for insert
to authenticated
with check (
  user_id = auth.uid()
  and exists (
    select 1
    from public.trip_places
    where trip_places.id = saves.trip_place_id
      and public.is_trip_member(trip_places.trip_id)
  )
);

-- DELETE: "unsave" -- a member may only remove their own save, never someone
-- else's (CLAUDE.md: "not other members' saves"). No trip-membership check is
-- needed in addition to this -- if a row's user_id matches the caller, the
-- caller is, by construction, the person who saved it; there's currently no way
-- to leave a trip, so there's no scenario where a non-member still owns a save
-- row on it.
create policy "Users can remove their own save"
on public.saves
for delete
to authenticated
using (user_id = auth.uid());

-- No UPDATE policy on saves: nothing about a save is editable in the spec (it's
-- just "does this person have this pin saved, yes or no") -- default-denied.
