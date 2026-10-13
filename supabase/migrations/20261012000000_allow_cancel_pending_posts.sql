-- Scoped fix: let a user cancel their own post while it's still `pending`
-- (i.e. before the worker has claimed it), so the worker's
-- `status=eq.pending` poll just skips it -- see paste-link-modal.tsx's
-- close-while-processing-UI gap. Explicitly NOT full mid-pipeline
-- cancellation: once the worker has claimed a row (status -> processing),
-- this UPDATE's `using` clause won't match it, so a cancel attempt on an
-- already-claimed post simply affects 0 rows -- the same no-op shape
-- worker.py's own claim race already relies on (two claim attempts on the
-- same row: the loser's `status=eq.pending` PATCH matches 0 rows). No new
-- status transition needed on the worker side for that reason.

-- ---------------------------------------------------------------------------
-- 1. posts.status: add 'canceled' to the allowed vocabulary
-- ---------------------------------------------------------------------------
-- Per the original migration's own comment, this list was deliberately
-- text+check (not an enum) because it was expected to grow -- this is
-- exactly that: drop and re-add the constraint with one more value.
alter table public.posts drop constraint posts_status_valid_values;

alter table public.posts add constraint posts_status_valid_values check (
  status in ('pending', 'processing', 'needs_confirmation', 'confirmed', 'failed', 'canceled')
);

comment on constraint posts_status_valid_values on public.posts is
  'Job-state vocabulary for the polling worker (docs/decisions/0002). Text+check, not an enum, because this list is expected to still change (step 14, crash-recovery) and a check constraint is cheap to redefine; an enum is not. canceled (added 20261012): a user backed out of the paste-link modal before the worker claimed the row.';

-- ---------------------------------------------------------------------------
-- 2. RLS: let a trip member cancel their own still-pending post
-- ---------------------------------------------------------------------------
-- Mirrors the existing INSERT policy's shape (is_trip_member(trip_id) +
-- added_by = auth.uid()) rather than inventing a new convention. Trip
-- membership is close to redundant here -- added_by = auth.uid() already
-- means they authored the row, and a non-member can't become added_by on a
-- trip's post because the INSERT policy enforced membership at insert time
-- -- but keeping both checks matches how every other trip-scoped policy in
-- this repo is written, and costs nothing.
--
-- using: only a still-pending row they own is even visible to this UPDATE's
-- row-selection -- this is also exactly what makes "worker already claimed
-- it" a clean no-op rather than something the policy has to special-case:
-- once status flips to 'processing', `status = 'pending'` here stops
-- matching, same race-handling shape as claim_post's own PATCH filter.
-- with check: the resulting row may only ever become 'canceled', AND must
-- still belong to the same trip/author -- `with check` only runs against
-- the NEW row, so without repeating the ownership/membership condition here
-- too, a user could PATCH their own pending post's `trip_id`/`added_by` to
-- arbitrary values in the same request (the `using` clause on the OLD row
-- doesn't protect the NEW row's columns). This mirrors how the existing
-- `trip_places` UPDATE policy also repeats `is_trip_member(trip_id)` in its
-- own `with check`, not a new convention.
--
-- Still deliberately not restricting content columns (caption, url, source)
-- beyond this -- no RLS policy elsewhere in this repo restricts which
-- content columns an allowed UPDATE/INSERT can touch, and a canceled row is
-- a dead end the worker/confirm RPC never read anyway, so tampering there
-- is harmless (same as inserting a fresh post with any url/caption already
-- is).
create policy "Trip members can cancel their own pending post"
on public.posts
for update
to authenticated
using (
  public.is_trip_member(trip_id)
  and added_by = auth.uid()
  and status = 'pending'
)
with check (
  status = 'canceled'
  and public.is_trip_member(trip_id)
  and added_by = auth.uid()
);
