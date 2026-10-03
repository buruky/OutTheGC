-- Tightens the profiles SELECT policy from "any authenticated user can read any profile"
-- to "a user can only read their own profile".
--
-- Why: signup is open (enable_signup = true in supabase/config.toml), so "authenticated"
-- effectively means "anyone willing to make an account" -- the original policy from
-- 20261002023855_create_profiles_table.sql let any account holder read every user's
-- username/display_name/avatar_url. The spec lists profile visibility as an open question
-- ("Profiles: username, avatar, anything public?") that policy shouldn't have settled by
-- default. Widening this back to "co-members of a trip can see each other's profile" is
-- deferred to roadmap step 6, once trip_members exists and that condition becomes
-- expressible in a policy.
--
-- Migrations are append-only history, so this drops and recreates the policy rather than
-- editing the already-applied migration file.

-- Remove the old blanket-read policy. Dropping by name only affects this one policy --
-- RLS stays enabled on the table throughout (enable row level security was set in the
-- earlier migration and isn't touched here), so there's no window where the table is
-- unprotected.
drop policy "Authenticated users can read all profiles" on public.profiles;

-- Replace it with a policy scoped to the caller's own row. auth.uid() reads the caller's
-- id out of their JWT (set by Supabase Auth, not client-supplied), so this can't be
-- spoofed by requesting a different id -- same guarantee the existing UPDATE policy
-- already relies on.
create policy "Users can read their own profile"
on public.profiles
for select
to authenticated
using (auth.uid() = id);
