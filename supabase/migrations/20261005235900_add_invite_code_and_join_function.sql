-- Roadmap step 7: "Invite codes" -- backend half. Adds a server-generated, unique
-- invite_code per trip, and a SECURITY DEFINER function so a second account can turn
-- a code into trip_members access without needing any client-facing INSERT policy on
-- trip_members (same "the function is the only path" pattern as the creation trigger
-- in 20261004000000_add_trip_members_and_trip_rls.sql).

-- ---------------------------------------------------------------------------
-- 1. generate_invite_code(): the uniqueness-guaranteeing code generator
-- ---------------------------------------------------------------------------
-- DEFAULT expression vs. BEFORE INSERT trigger: a trigger earns its keep when you need
-- to inspect or react to other columns on NEW/OLD, or run logic conditionally across
-- multiple columns. Here the entire job is "produce one scalar value for one column
-- that wasn't supplied" -- exactly what a column DEFAULT is for. A default that calls
-- a function is already evaluated once per inserted row, before the row is written,
-- which is the same guarantee a BEFORE INSERT trigger would buy, without a second
-- piece of trigger machinery (trigger function + `create trigger`) that would just
-- wrap this same function for no added behavior. Trigger would be the right call if
-- this ever needed to, say, also touch a different column based on invite_code -- it
-- doesn't, so DEFAULT is the simpler, equally-correct choice.
--
-- Uniqueness strategy: generate a random 8-character code from an ambiguity-free
-- alphabet, check it against existing codes, and retry on collision -- a "retry loop
-- in a function used as a default," per the brief. With 32 possible characters in 8
-- positions that's 32^8 (~1.1 trillion) possible codes, so a real collision is
-- astronomically unlikely with a handful of trips, but the retry loop (bounded to 20
-- attempts so a pathological case fails loudly instead of hanging) costs nothing and
-- means the generator itself tries not to produce a duplicate, rather than relying
-- solely on the UNIQUE constraint added below to catch it after the fact. Both layers
-- stay in place: this function is the proactive check, the UNIQUE constraint is the
-- backstop that makes a collision a loud insert failure instead of a silent duplicate,
-- no matter how this function is invoked in the future.
--
-- SECURITY DEFINER: this function's uniqueness check -- "does any trip already have
-- this code" -- needs to see every trip's invite_code, not just the ones the inserting
-- user can see under the trips SELECT policy (owner fast path or trip_members
-- membership). If this ran with the caller's own privileges, the `exists (...)` check
-- would be silently filtered by RLS to only that caller's own trips, so it could
-- "clear" a code that's actually already in use by a trip the caller isn't a member
-- of -- not a security hole (the UNIQUE constraint still blocks the actual insert) but
-- a correctness gap in the one thing this function exists to do. search_path is pinned
-- to (public, pg_temp), the standard defense against a privileged function resolving
-- an unqualified table name against a schema an attacker could control.
--
-- Scope / privilege-escalation check: this function takes no arguments and returns
-- only a freshly generated, not-yet-used string -- it never returns any existing
-- trip's actual invite_code or any other row data to the caller. The elevated
-- privilege is used for exactly one internal boolean check and nothing else, so there
-- is no way to use this function to read, enumerate, or guess another trip's code.
create function public.generate_invite_code()
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  -- 32 characters: excludes 0/O, 1/I/L (visually ambiguous in most fonts), per the
  -- developer's format decision. Uppercase only -- see join_trip_by_code below for why
  -- the join side normalizes input case rather than this side emitting mixed case.
  alphabet text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  candidate text;
  attempt int := 0;
begin
  loop
    attempt := attempt + 1;
    if attempt > 20 then
      -- Should never happen at any realistic trip count (see uniqueness strategy
      -- above) -- a loud failure here means something is very wrong (e.g. the
      -- alphabet got shrunk drastically), not a case to silently paper over.
      raise exception 'generate_invite_code: could not find a unique code after % attempts', attempt - 1;
    end if;

    -- Build one 8-character candidate by picking 8 random characters from the
    -- alphabet, one per row of generate_series(1, 8).
    select string_agg(substr(alphabet, (floor(random() * length(alphabet)) + 1)::int, 1), '')
    into candidate
    from generate_series(1, 8);

    exit when not exists (select 1 from public.trips where invite_code = candidate);
  end loop;

  return candidate;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. invite_code column on trips
-- ---------------------------------------------------------------------------
alter table public.trips
  add column invite_code text;

-- Backfill: covers any trip row that already exists before this migration (e.g. the
-- real trip created while testing step 6) so the NOT NULL constraint below doesn't
-- fail against it. Safe to run even if there are zero such rows.
update public.trips
set invite_code = public.generate_invite_code()
where invite_code is null;

-- NOT NULL: every trip must have a code, no exceptions. DEFAULT: going forward, a
-- client never supplies invite_code on insert (per the developer's decision that
-- codes are server-generated only, never client-supplied) -- it's simply absent from
-- the insert payload, and this default fills it in automatically, the same pattern
-- already used for owner_id.
alter table public.trips
  alter column invite_code set not null,
  alter column invite_code set default public.generate_invite_code();

-- UNIQUE: the actual guarantee that two trips never share a code -- enforced by
-- Postgres itself, independent of anything the generator function does or doesn't
-- catch. This is also what makes the equality lookup in join_trip_by_code below use
-- an index rather than a sequential scan, for free.
alter table public.trips
  add constraint trips_invite_code_key unique (invite_code);

-- ---------------------------------------------------------------------------
-- 3. join_trip_by_code(): the only path into trip_members from an invite code
-- ---------------------------------------------------------------------------
-- Returns the trip's id and name (so the app can show "you joined Tokyo 2026")
-- plus an already_member flag. Why return trip identity at all: the calling user
-- isn't a trip_members row yet at the moment the code is looked up, so without this
-- function handing back the name directly, the app would have no way to read it --
-- the trips SELECT policy (owner fast path or is_trip_member) would still correctly
-- deny them, because they only become a member partway through this same function
-- call. Returning it as part of the function's result sidesteps that chicken-and-egg
-- problem entirely, since this function runs as SECURITY DEFINER and already had to
-- read the trip row to find it by code in the first place -- no extra privilege is
-- spent to also hand back its name.
--
-- already_member design: joining a trip you're already on is treated as a successful
-- no-op, not an error. Reasoning: re-tapping a "join" button, or reusing an invite
-- link/code you already acted on, is a benign, extremely common action with no
-- security implication (you already have legitimate access) -- it shouldn't surface
-- as a scary error state in the app. But the app still needs to be able to tell the
-- two cases apart ("you joined Tokyo 2026" vs "you're already in Tokyo 2026"), so
-- rather than picking one of those two experiences blindly, this returns a boolean
-- and leaves the wording decision to the app layer.
--
-- Error on invalid code: uses SQLSTATE 22023 ("invalid_parameter_value"), a real
-- standard Postgres error code (not a made-up string), specifically so the mobile app
-- can distinguish "bad code" from every other kind of failure by checking the error's
-- `code` field (what supabase-js surfaces from Postgres) rather than fragile string-
-- matching on the message text.
--
-- Input handling: p_code is used only as a bound value in a `where` clause
-- (`where invite_code = p_code`), never concatenated into SQL text or passed to
-- `execute`/`format` -- there is no dynamic SQL anywhere in this function, so there is
-- no injection surface regardless of what a caller passes as p_code. The one thing
-- this function does to the input is normalize case (`upper(trim(p_code))`) before
-- comparing -- generated codes are uppercase-only (see the alphabet above), so this
-- just makes the join forgiving of a code a user typed or autocapitalized in lowercase,
-- without weakening anything: codes still only ever exist in uppercase in the table.
--
-- SECURITY DEFINER scope and privilege-escalation check: this function needs elevated
-- privilege for exactly one reason -- trip_members intentionally has no client-facing
-- INSERT policy (same as the creation trigger), so inserting the new membership row
-- requires bypassing RLS. Everything else about its scope is narrow and safe to bypass
-- RLS for:
--   - It looks up a trip by invite_code -- a trip's existence-by-code isn't secret
--     information in the way another table's data might be; knowing a trip exists for
--     a given code is exactly what the code is for.
--   - The only row it ever inserts is (that trip's id, auth.uid()) -- auth.uid() comes
--     from the caller's verified JWT, not a client-supplied argument, so this can
--     never be used to add a *different* user to a trip, and it can only ever add the
--     caller to a trip whose code they actually supplied.
--   - It performs no update or delete, and it exposes no other table's data.
-- search_path is pinned to (public, pg_temp), same reasoning as generate_invite_code
-- above.
--
-- TODO once trips gets an archived_at column (no roadmap step has added it yet --
-- archiving is still unbuilt, see spec "Trip end: trips get archived"): add
-- "and archived_at is null" to the lookup below, so a leaked or old code for an
-- archived trip can't be used to join it. Flagging this now, in the migration itself,
-- so it isn't forgotten when archiving ships.
create function public.join_trip_by_code(p_code text)
returns table (trip_id uuid, trip_name text, already_member boolean)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_trip_id uuid;
  v_trip_name text;
  v_already boolean;
begin
  select trips.id, trips.name
  into v_trip_id, v_trip_name
  from public.trips
  where trips.invite_code = upper(trim(p_code));
  -- TODO (see comment above the function): add "and trips.archived_at is null" here
  -- once archiving exists, so this can't be used to join an archived trip.

  if v_trip_id is null then
    raise exception 'invalid invite code'
      using errcode = 'invalid_parameter_value'; -- SQLSTATE 22023
  end if;

  select exists (
    select 1 from public.trip_members
    where trip_members.trip_id = v_trip_id
      and trip_members.user_id = auth.uid()
  ) into v_already;

  if not v_already then
    insert into public.trip_members (trip_id, user_id)
    values (v_trip_id, auth.uid());
  end if;

  return query select v_trip_id, v_trip_name, v_already;
end;
$$;

-- Postgres grants EXECUTE on new functions to PUBLIC by default. Explicitly tighten
-- that: only authenticated callers should be able to run this (auth.uid() is null for
-- the anon role, which would try to insert a null user_id into trip_members and fail
-- on the primary key's implicit NOT NULL with a confusing error, instead of a clean
-- "you must be signed in"). Revoke-then-grant makes the intended access explicit
-- rather than relying on whatever the default happens to be.
revoke all on function public.join_trip_by_code(text) from public;
grant execute on function public.join_trip_by_code(text) to authenticated;

-- No new RLS needed on trips (reading/joining doesn't change who can select/update a
-- trip row) or trip_members (still deliberately no client-facing INSERT policy -- this
-- function, running as SECURITY DEFINER, remains the only path in, same as the
-- creation trigger).
