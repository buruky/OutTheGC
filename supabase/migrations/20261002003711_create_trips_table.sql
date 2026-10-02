-- Roadmap step 4: "Connect Supabase" — the first real table.
-- Deliberately minimal: no owner_id (added in step 6, "Trips with permissions"),
-- no invite_code (added in step 7, "Invite codes"), no archived_at, and no RLS
-- policies yet (RLS needs auth, which doesn't exist until step 5; writing
-- policies now would just be a false sense of security on a table nobody
-- can legitimately own yet). This table is intentionally open to any request
-- using the anon or service_role key until step 6 locks it down.

create table public.trips (
  id uuid primary key default gen_random_uuid(), -- surrogate key; gen_random_uuid() comes from pgcrypto, enabled by default on Supabase projects
  name text not null, -- every trip needs a name; nothing else is required yet
  destination text, -- free-text for now; nullable since a trip might be created before a destination is picked
  start_date date, -- nullable: dates may not be known yet
  end_date date, -- nullable, same reasoning as start_date
  created_at timestamptz not null default now() -- server-assigned creation timestamp, used for ordering trip lists
);
