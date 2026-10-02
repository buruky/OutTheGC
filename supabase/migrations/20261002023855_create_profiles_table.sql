-- Roadmap step 5 ("Sign in") — the `profiles` table, filled in automatically on signup
-- via a database trigger on auth.users rather than a client-side insert, so profile
-- creation can't be skipped by a flaky signup flow (CLAUDE.md "Decisions").
-- Columns per OutTheGC-spec.md "Data model": id, username, display_name, avatar_url.

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade, -- same id as the auth.users row; cascade so a deleted auth account cleans up its profile automatically
  username text, -- nullable: nothing collects a username at signup yet (not in this step's scope)
  display_name text, -- nullable, same reasoning as username
  avatar_url text -- nullable, same reasoning as username
);

-- Row level security: default-deny on this table until a policy explicitly allows an operation.
alter table public.profiles enable row level security;

-- Any signed-in user can read any profile. Trip members will eventually need to see each
-- other's names/avatars, and a profile row has nothing sensitive worth hiding per-row, so
-- there's no reason to scope reads to trip membership the way trip data will be scoped.
-- (This is a default the supabase-expert chose for a table the spec's permission rules
-- don't cover -- worth revisiting if profiles ever grow a field that shouldn't be public.)
create policy "Authenticated users can read all profiles"
on public.profiles
for select
to authenticated
using (true);

-- A user can only update their own row. auth.uid() reads the caller's id out of their JWT,
-- so this can't be spoofed by passing a different id in the request body.
create policy "Users can update their own profile"
on public.profiles
for update
to authenticated
using (auth.uid() = id)
with check (auth.uid() = id);

-- Deliberately no insert or delete policy for the authenticated/anon roles:
-- - The only insert path is the trigger below, which runs as SECURITY DEFINER and so
--   bypasses RLS by design -- there's no legitimate client-side insert into this table.
-- - Nothing should delete a profile directly; the "on delete cascade" above handles
--   cleanup when the auth.users row itself is deleted.

-- Trigger function: runs with the privileges of its owner (SECURITY DEFINER), not the
-- caller (Supabase's internal auth service), so it can insert into public.profiles even
-- though that caller has no direct grant on the table. search_path is pinned explicitly
-- (not left to whatever the caller's search_path happens to be) so this privileged function
-- can't be tricked into resolving "profiles" against a schema an attacker controls --
-- the classic SECURITY DEFINER privilege-escalation vector.
create function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.profiles (id)
  values (new.id); -- only the id is known at signup; username/display_name/avatar_url stay null until the user sets them later (separate, future step)
  return new;
end;
$$;

-- Fires once per row inserted into auth.users (i.e. once per signup), after the row is
-- committed, so a profile is guaranteed to exist by the time anything queries for it.
create trigger on_auth_user_created
  after insert on auth.users
  for each row
  execute function public.handle_new_user();
