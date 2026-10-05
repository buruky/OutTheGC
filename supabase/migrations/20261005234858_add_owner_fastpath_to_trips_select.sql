-- Fixes a second, more subtle bug found while verifying the recursion fix in
-- 20261005234248_fix_trip_members_rls_recursion.sql.
--
-- Symptom: after fixing the recursion, `insert into trips (...) returning *`
-- (exactly what createTrip() in the app does) still failed with
-- "42501: new row violates row-level security policy for table trips" --
-- even for a real, confirmed user. A plain INSERT without RETURNING succeeded
-- and correctly left a matching trip_members row via the on_trip_created
-- trigger (confirmed directly against the live project). A later, separate
-- SELECT on that same already-committed trip also succeeded and correctly
-- resolved is_trip_member() to true. So the trigger, the function, and the
-- policy are all individually correct -- the failure is specific to
-- INSERT ... RETURNING needing to satisfy the SELECT policy for the row
-- *within the same statement* that an AFTER ROW trigger populated the
-- trip_members row it depends on. Empirically (tested directly, not just
-- reasoned about), that cross-table dependency isn't reliably visible yet at
-- the point Postgres evaluates the RETURNING-time policy check, regardless of
-- the helper function's volatility (tested both `stable` and unmarked/
-- volatile -- no difference).
--
-- Fix: give the SELECT policy a fast path that doesn't depend on
-- trip_members at all for the owner's own row -- `owner_id` is set on the
-- very row being inserted (via the column default), not written by a
-- trigger, so there's no cross-table timing dependency to hit. This is also
-- just a better policy on its own merits, not only a workaround: the owner
-- should always be able to see their own trip, full stop, without that
-- guarantee ever depending on trip_members staying in sync. The
-- is_trip_member() check remains for every other member (added via invite
-- code in step 7+, where owner_id won't match them).

drop policy "Trip members can read their trips" on public.trips;

create policy "Trip members can read their trips"
on public.trips
for select
to authenticated
using (owner_id = auth.uid() or public.is_trip_member(id));
