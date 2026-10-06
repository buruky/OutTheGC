/**
 * Supabase queries for the `trips` table, centralized here so the screens
 * that render trips don't each hand-roll their own `supabase.from(...)`
 * calls. `TripRow` mirrors the live schema in
 * `supabase/migrations/20261002003711_create_trips_table.sql` exactly
 * (including which columns are nullable) — update both together if the
 * schema changes.
 */
import { supabase } from '@/lib/supabase';

export type TripRow = {
  id: string;
  name: string;
  destination: string | null;
  /** Postgres `date`, serialized as `YYYY-MM-DD`. */
  start_date: string | null;
  /** Postgres `date`, serialized as `YYYY-MM-DD`. */
  end_date: string | null;
  /** Postgres `timestamptz`, serialized as an ISO 8601 string. */
  created_at: string;
  /**
   * Server-generated, unique, 8-character (see
   * `supabase/migrations/20261005235900_add_invite_code_and_join_function.sql`).
   * Never set from the client — the column default fills it in on insert.
   */
  invite_code: string;
};

export async function fetchTrips(): Promise<TripRow[]> {
  const { data, error } = await supabase
    .from('trips')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) throw error;
  return data ?? [];
}

/** Returns `null` (not an error) when no trip matches `id`. */
export async function fetchTripById(id: string): Promise<TripRow | null> {
  const { data, error } = await supabase.from('trips').select('*').eq('id', id).maybeSingle();

  if (error) throw error;
  return data;
}

export type NewTripInput = {
  name: string;
  destination?: string | null;
  start_date?: string | null;
  end_date?: string | null;
};

/**
 * Deliberately does NOT accept or set `owner_id` — the column defaults to
 * `auth.uid()` server-side (see the step 6 migration), and the insert RLS
 * policy's `with check (owner_id = auth.uid())` would reject any other value
 * anyway. A trigger on `trips` also inserts the creator's `trip_members` row
 * in the same transaction, so by the time this resolves, `fetchTripById` on
 * the new id already satisfies the membership-based select policy.
 */
export async function createTrip(input: NewTripInput): Promise<TripRow> {
  const { data, error } = await supabase
    .from('trips')
    .insert({
      name: input.name,
      destination: input.destination ?? null,
      start_date: input.start_date ?? null,
      end_date: input.end_date ?? null,
    })
    .select('*')
    .single();

  if (error) throw error;
  return data;
}

export type JoinTripResult = {
  trip_id: string;
  trip_name: string;
  already_member: boolean;
};

/**
 * Wraps the `join_trip_by_code` RPC (see
 * `supabase/migrations/20261005235900_add_invite_code_and_join_function.sql`).
 * Idempotent on the server — joining a trip you're already on resolves with
 * `already_member: true` rather than throwing. On an unrecognized code, the
 * rejected `error` has `error.code === '22023'` (Postgres SQLSTATE
 * `invalid_parameter_value`) — check that field, not the message text, to
 * show a "that code doesn't look right" message instead of a generic error.
 */
export async function joinTripByCode(code: string): Promise<JoinTripResult> {
  const { data, error } = await supabase.rpc('join_trip_by_code', { p_code: code }).single();

  if (error) throw error;
  // `createClient` in `@/lib/supabase` isn't given a generated `Database`
  // type (none has been generated from the schema yet), so `.rpc()` on an
  // unrecognized function name types its result as `unknown` rather than
  // inferring the `returns table (...)` shape from the migration. Safe to
  // assert here: the shape is exactly what `join_trip_by_code` returns.
  return data as JoinTripResult;
}
