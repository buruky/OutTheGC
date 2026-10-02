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
