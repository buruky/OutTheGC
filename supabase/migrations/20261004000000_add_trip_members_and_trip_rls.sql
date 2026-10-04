-- Roadmap step 6: "Trips with permissions" -- the core RLS of the whole app.
-- Adds trip_members, owner_id on trips, the trigger that keeps a trip's creator from
-- getting locked out of their own trip, and the RLS policies that make trips and
-- trip_members visible only to members (CLAUDE.md "Permission rules").

-- ---------------------------------------------------------------------------
-- 1. owner_id on trips
-- ---------------------------------------------------------------------------
-- Every trip needs exactly one owner (spec: "Owner: stored on trips.owner_id, so there
-- is exactly one"). References auth.users directly (not profiles) because that's the
-- durable identity column everything else keys off of, same as profiles.id and the
-- trigger below.
--
-- Added nullable first, not "not null" in one shot: step 4 added one row to `trips`
-- by hand in the dashboard ("Tokyo 2026", see roadmap step 4 notes) purely to prove
-- the app could read from the database -- it predates owner_id and has no owner to
-- backfill. Adding the column as NOT NULL in a single statement would fail against
-- that existing row. Instead: add it nullable, remove rows that have no owner (a
-- narrowly scoped delete -- only ever matches pre-owner_id leftovers, never a trip
-- someone actually owns), then tighten the column to NOT NULL with its default. Net
-- end state is identical to declaring the column NOT NULL with a default up front;
-- this just gets there without an unscoped DELETE sitting in a migration file.
alter table public.trips
  add column owner_id uuid references auth.users (id);

-- Scoped cleanup: only rows with no owner can match this, which today is exactly the
-- one leftover step-4 test row and nothing else -- it has no trip_members row and
-- nothing references it (trip_places/posts/etc. don't exist yet), so there's no
-- orphaned data left behind.
delete from public.trips where owner_id is null;

-- Now that every remaining row has (or can get) an owner, enforce it going forward.
-- `default auth.uid()` means a client can insert a trip with just a name and the
-- owner is filled in automatically from their own session -- no chance of a client
-- forgetting to set it or setting someone else's id by omission.
alter table public.trips alter column owner_id set not null;
alter table public.trips alter column owner_id set default auth.uid();

-- ---------------------------------------------------------------------------
-- 2. trip_members
-- ---------------------------------------------------------------------------
-- One row per (trip, person). Spec columns: trip_id, user_id, joined_at.
--
-- on delete behavior for user_id, and why this migration does NOT use
-- "on delete set null" despite that being the spec's pattern for saves.user_id and
-- posts.added_by:
--
-- The spec's "former member" rule ("places a person added stay on the trip, credited
-- to former member") is about *historical credit* on content rows -- a save or a post
-- someone made stays visible and attributed even after they're gone. trip_members
-- isn't content; it's the access-control list itself. A membership row only means one
-- thing: "this user currently has access to this trip." Once the account is deleted,
-- that access no longer exists for anyone -- there's no one left to credit, and
-- nothing in the spec shows a trip's member list with a "former member" placeholder
-- the way saves/posts show attribution.
--
-- There's also a concrete technical reason "set null" can't work here even if it were
-- desired: user_id is part of the primary key (trip_id, user_id), and primary key
-- columns are implicitly NOT NULL in Postgres. If user_id had "on delete set null",
-- then deleting an auth.users row that had ever joined any trip would make Postgres
-- try to null out user_id on their trip_members rows to satisfy the FK action --
-- which the primary key's NOT NULL would immediately reject, aborting the whole
-- transaction. In other words, "set null" on a primary-key column isn't just a
-- product choice here, it would be a bug that makes account deletion fail for anyone
-- who's ever been on a trip. "on delete cascade" is both the right product behavior
-- (stale access rows shouldn't linger) and the only one that's actually consistent
-- with the primary key.
create table public.trip_members (
  trip_id uuid not null references public.trips (id) on delete cascade, -- a trip going away (not currently possible -- trips are archived, never deleted -- but kept for referential integrity) takes its membership rows with it
  user_id uuid not null references auth.users (id) on delete cascade, -- see reasoning above: a deleted account loses its membership rows outright, not nulled
  joined_at timestamptz not null default now(), -- when this person joined this trip
  primary key (trip_id, user_id) -- a person is only a member of a given trip once
);

-- ---------------------------------------------------------------------------
-- 3. Trigger: adding a trip automatically makes its creator a member
-- ---------------------------------------------------------------------------
-- Same pattern as handle_new_user() for profiles (step 5): a client-side two-step
-- (insert trip, then insert membership) risks the creator getting locked out of their
-- own trip if the second call fails or is skipped. Doing it in a trigger makes trip
-- creation and membership atomic from the client's point of view -- one insert, and
-- Postgres guarantees the membership row exists before the transaction commits.
--
-- security definer: runs with the privileges of the function's owner, not the caller,
-- so it can insert into trip_members even though the calling role (authenticated) has
-- no insert grant/policy on that table -- trip_members intentionally has no
-- client-facing insert path (see the RLS section below).
--
-- search_path is pinned to (public, pg_temp) so this privileged function always
-- resolves "trip_members" against the public schema, not whatever search_path the
-- calling session happens to have -- the standard defense against the classic
-- SECURITY DEFINER schema-hijacking vector.
--
-- Scope is kept to exactly one thing: insert the one row (new trip id, its owner).
-- It takes no input beyond what's already on the row just inserted, and it can't be
-- called directly by a client to add arbitrary membership rows -- it only ever runs
-- as a side effect of a trip being created.
create function public.handle_new_trip()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.trip_members (trip_id, user_id)
  values (new.id, new.owner_id);
  return new;
end;
$$;

-- Fires once per row inserted into trips, after the row is committed, so a membership
-- row is guaranteed to exist by the time anything queries trip_members for this trip.
create trigger on_trip_created
  after insert on public.trips
  for each row
  execute function public.handle_new_trip();

-- ---------------------------------------------------------------------------
-- 4. RLS on trips
-- ---------------------------------------------------------------------------
-- Default-deny on this table from here on -- every operation needs an explicit policy.
alter table public.trips enable row level security;

-- SELECT: only members of a trip can read it. This is the policy the roadmap's
-- done-when test checks: account A cannot see account B's trip, even by guessing its
-- id -- a direct `select ... where id = '<guessed id>'` returns zero rows for a
-- non-member, not an error, because RLS filters rows before the WHERE clause is
-- even relevant.
create policy "Trip members can read their trips"
on public.trips
for select
to authenticated
using (
  exists (
    select 1
    from public.trip_members
    where trip_members.trip_id = trips.id
      and trip_members.user_id = auth.uid()
  )
);

-- INSERT: any signed-in user can create a trip, but only as themselves. The column
-- default already sets owner_id = auth.uid(), but this with check is defense in
-- depth: if a client explicitly passed a different owner_id in the insert payload
-- (bypassing the default), the insert is rejected outright rather than silently
-- "corrected" to the caller's id -- an attacker can't create a trip pre-owned by
-- someone else, and a caller can't be confused about who ends up owning what they
-- created.
create policy "Authenticated users can create trips they own"
on public.trips
for insert
to authenticated
with check (owner_id = auth.uid());

-- UPDATE: owner only, for now. Both using (can this row be touched at all) and with
-- check (is the row still valid after the update) require auth.uid() = owner_id.
-- Net effect: this also blocks the owner from reassigning owner_id to someone else in
-- the same statement -- after such an update the new row's owner_id would no longer
-- equal the caller's own id, so with check would reject it. That's an acceptable
-- default here, not a deliberate security design: ownership transfer isn't built yet
-- (spec: "the owner must pick a successor before leaving the trip or deleting their
-- account", planned for step 19), so a policy that happens to make transfer
-- impossible today is fine -- it'll need its own policy or a dedicated
-- security-definer RPC once that feature is actually built, not a vulnerability to
-- fix now.
create policy "Trip owner can update their trip"
on public.trips
for update
to authenticated
using (auth.uid() = owner_id)
with check (auth.uid() = owner_id);

-- No DELETE policy. The spec only ever archives trips (archived_at), never deletes
-- them -- leaving delete un-policied means it's default-denied for every role except
-- a direct service-role/superuser connection.

-- ---------------------------------------------------------------------------
-- 5. RLS on trip_members
-- ---------------------------------------------------------------------------
alter table public.trip_members enable row level security;

-- SELECT: a caller can see membership rows for any trip they themselves belong to.
-- This is a self-referencing policy -- the subquery (aliased tm2) reads the same
-- table the policy protects -- which is the standard, safe pattern for "show me
-- other rows in the group I'm also a member of": Postgres evaluates it as one
-- coherent correlated subquery per candidate row, not an infinite recursive policy
-- check.
create policy "Trip members can read their trip's membership rows"
on public.trip_members
for select
to authenticated
using (
  exists (
    select 1
    from public.trip_members tm2
    where tm2.trip_id = trip_members.trip_id
      and tm2.user_id = auth.uid()
  )
);

-- Deliberately no insert/update/delete policies for the authenticated role:
-- - The only legitimate insert path right now is the trigger above, which runs as
--   security definer and bypasses RLS by design.
-- - Joining a trip via invite code is step 7's job (needs its own security-definer
--   function, scoped narrowly to "insert one membership row if the code is valid and
--   the trip isn't archived") and isn't built yet.
-- - Removing a member isn't in this step's scope either -- the spec says only the
--   owner can do it, which will need its own policy or RPC later.
