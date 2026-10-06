-- Defense-in-depth cleanup, not a fix for an exploitable hole. A security-reviewer
-- pass after step 7 confirmed neither function leaks anything to anon as currently
-- written:
-- - is_trip_member(uuid): auth.uid() is null for anon, so `user_id = null` is never
--   true -- always returns false, for any input, real trip or not. No existence
--   oracle, no way to enumerate or probe trip ids.
-- - generate_invite_code(): only ever returns a fresh, not-yet-used code. Can't help
--   guess or enumerate real codes.
--
-- Revoking anyway because today's safety depends on reading each function body and
-- noticing those specific details -- a future edit (e.g. adding a parameter, changing
-- what counts as "found") could silently change that without anyone thinking to
-- re-check the grant. Scoping access to what's actually needed now costs nothing and
-- removes that whole category of future mistake.
--
-- `authenticated` keeps EXECUTE on both -- required for real use (is_trip_member is
-- called from RLS policies as the querying role; generate_invite_code backs the
-- trips.invite_code column default, evaluated on insert as the authenticated caller).
revoke execute on function public.is_trip_member(uuid) from anon;
revoke execute on function public.generate_invite_code() from anon;
