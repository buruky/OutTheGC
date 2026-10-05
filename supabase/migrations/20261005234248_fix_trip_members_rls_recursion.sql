-- Fixes infinite recursion in the trip_members SELECT policy added in
-- 20261004000000_add_trip_members_and_trip_rls.sql.
--
-- The bug: that policy checked membership with a self-join back onto
-- trip_members itself:
--
--   using (exists (select 1 from trip_members tm2 where tm2.trip_id = trip_members.trip_id and tm2.user_id = auth.uid()))
--
-- Since trip_members has RLS enabled, the inner "select ... from trip_members tm2"
-- subquery is itself subject to this same policy -- so evaluating the policy
-- requires evaluating the policy, forever. Reproduced directly against the live
-- project: a plain authenticated insert into `trips` (which needs the `trips`
-- SELECT policy for its RETURNING clause, which queries trip_members) throws
-- "42P17: infinite recursion detected in policy for relation trip_members".
-- This broke every trip read, not just creation -- fetchTrips/fetchTripById on
-- `trips` also depend on the same broken chain.
--
-- The fix: move the membership check into a SECURITY DEFINER function. Because
-- it runs with the function owner's privilege rather than the caller's, its
-- internal query against trip_members bypasses RLS entirely -- there's nothing
-- left to recurse into. Both the `trips` and `trip_members` SELECT policies are
-- rewritten to call this function instead of inlining the subquery, so the fix
-- applies at the root for both, not just a patch on one.

create function public.is_trip_member(p_trip_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.trip_members
    where trip_id = p_trip_id and user_id = auth.uid()
  );
$$;

-- Volatility: `stable`, not `volatile` or `immutable`.
-- - Not `immutable`: the result depends on table data (trip_members) and the
--   calling session (auth.uid()), neither of which is fixed for all time.
-- - `stable` is correct, not `volatile`: stable means "returns the same result
--   for the same arguments within a single statement/table scan," which is
--   true here -- auth.uid() doesn't change mid-statement, and Postgres takes
--   its own snapshot of the data for the duration of one statement under the
--   default read-committed isolation. Membership changing between separate
--   statements in a transaction is fine and expected; stable only promises
--   consistency within one statement's execution, not across the whole
--   transaction, so that doesn't violate the marking. Volatile would be overly
--   pessimistic here and can block query-plan optimizations the planner would
--   otherwise apply when this function is called once per row during an RLS
--   check on a multi-row select.
--
-- Privilege-escalation check: this function takes only a trip id and returns
-- a boolean -- it exposes no row data, takes no caller-supplied identity (the
-- only identity used is auth.uid(), read from the verified JWT, not an
-- argument), and the one thing it does -- "is the calling user a member of
-- this trip" -- is exactly the fact RLS already needs to check anyway. It
-- can't be used to read, modify, or learn anything about trip_members beyond
-- that single yes/no fact for the caller's own identity.

drop policy "Trip members can read their trips" on public.trips;

create policy "Trip members can read their trips"
on public.trips
for select
to authenticated
using (public.is_trip_member(id));

drop policy "Trip members can read their trip's membership rows" on public.trip_members;

create policy "Trip members can read their trip's membership rows"
on public.trip_members
for select
to authenticated
using (public.is_trip_member(trip_id));
