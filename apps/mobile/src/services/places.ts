/**
 * Supabase queries for a trip's pins: `places` (a real-world place, shared
 * across every trip), `trip_places` (a pin — one place merged onto one
 * trip), and `saves` (one person's save of a pin). Mirrors the live schema
 * in `supabase/migrations/20261008000000_add_places_trip_places_saves.sql`
 * — update both together if that schema changes. Follows the same pattern
 * as `src/services/trips.ts`: typed `*Row`-ish types, plain async functions
 * wrapping `supabase.from(...)`, throwing on `error`.
 */
import { supabase } from '@/lib/supabase';

export type TripPlaceCategory =
  | 'food'
  | 'views'
  | 'entertainment'
  | 'stay'
  | 'shopping'
  | 'nightlife'
  | 'other';

/** Matches `public.trip_place_category`'s enum values, in the same order as the migration. */
export const TRIP_PLACE_CATEGORIES: TripPlaceCategory[] = [
  'food',
  'views',
  'entertainment',
  'stay',
  'shopping',
  'nightlife',
  'other',
];

/** One pin on a trip's map, with everything the screen needs to render it. */
export type TripPin = {
  id: string; // trip_places.id
  tripId: string;
  placeId: string;
  category: TripPlaceCategory;
  notes: string | null;
  place: {
    id: string;
    name: string;
    address: string | null;
    latitude: number;
    longitude: number;
  };
  /** `count(*)` of `saves` rows for this pin. */
  saveCount: number;
  /** Whether the user this was fetched for has a `saves` row on this pin. */
  savedByMe: boolean;
};

// Raw shapes for the nested-select response below, before being reshaped
// into `TripPin`. `location` comes back as a hex-encoded EWKB string
// (PostgREST's wire format for a PostGIS geography column — not decoded
// JSON), parsed by `parseGeographyPoint` below. `createClient` in
// `@/lib/supabase` isn't given a generated `Database` type (none has been
// generated from the schema yet — same situation `joinTripByCode` in
// services/trips.ts already notes), so the embedded-relation select below
// types as `unknown`; these types describe what it actually returns.
type RawPlace = {
  id: string;
  name: string;
  address: string | null;
  location: string;
};

type RawTripPlace = {
  id: string;
  trip_id: string;
  place_id: string;
  category: TripPlaceCategory;
  notes: string | null;
  places: RawPlace | null;
  saves: { user_id: string | null }[];
};

/**
 * Minimal EWKB point parser. `places.location` is declared as
 * `extensions.geography(point, 4326)` — always a plain 2D point, always
 * carrying an SRID (every `geography` value does). PostgREST returns
 * PostGIS columns over the wire as hex-encoded EWKB rather than lat/lng
 * JSON, so there's no "just select the coordinates" option on a plain
 * `select`. Byte layout for exactly this shape (little-endian EWKB point
 * with an SRID):
 *   [1 byte endianness][4 bytes geom type + SRID flag][4 bytes SRID]
 *   [8 bytes X/longitude][8 bytes Y/latitude]
 * Hand-rolled instead of pulling in a WKB-parsing library — the format is
 * small, fixed, and never varies for this column (always a plain point,
 * never a line/polygon or a Z/M variant), so a general-purpose parser would
 * be pure overhead for a one-shape need.
 */
function parseGeographyPoint(hex: string): { latitude: number; longitude: number } {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  const view = new DataView(bytes.buffer);
  const littleEndian = bytes[0] === 1;
  // Bytes 1-4 (geom type + SRID flag) and 5-8 (SRID) are skipped — this
  // column only ever stores plain SRID-4326 points, so there's nothing to
  // branch on.
  const longitude = view.getFloat64(9, littleEndian);
  const latitude = view.getFloat64(17, littleEndian);
  return { latitude, longitude };
}

function toTripPin(row: RawTripPlace, userId: string): TripPin | null {
  if (!row.places) return null; // shouldn't happen (place_id is not-null + FK) — guards the type
  const { latitude, longitude } = parseGeographyPoint(row.places.location);
  return {
    id: row.id,
    tripId: row.trip_id,
    placeId: row.place_id,
    category: row.category,
    notes: row.notes,
    place: {
      id: row.places.id,
      name: row.places.name,
      address: row.places.address,
      latitude,
      longitude,
    },
    saveCount: row.saves.length,
    savedByMe: row.saves.some((save) => save.user_id === userId),
  };
}

/**
 * Every pin on a trip, with save count and "did `userId` save this"
 * precomputed. One round trip: `places` is embedded via `trip_places`'
 * `place_id` foreign key, `saves` via its reverse `trip_place_id` foreign
 * key — both auto-detected by PostgREST from the live schema's actual FK
 * constraints, no generated types required for the embed itself to work.
 */
export async function fetchTripPins(tripId: string, userId: string): Promise<TripPin[]> {
  const { data, error } = await supabase
    .from('trip_places')
    .select('id, trip_id, place_id, category, notes, places(id, name, address, location), saves(user_id)')
    .eq('trip_id', tripId);

  if (error) throw error;

  return ((data ?? []) as unknown as RawTripPlace[])
    .map((row) => toTripPin(row, userId))
    .filter((pin): pin is TripPin => pin !== null);
}

export type NewPlaceInput = {
  name: string;
  latitude: number;
  longitude: number;
  address?: string | null;
  category?: TripPlaceCategory;
};

const UNIQUE_VIOLATION = '23505';

/**
 * Adds a hand-typed place to a trip, as the given user's first save of it.
 *
 * No fuzzy *or* exact matching against existing `places` rows — every call
 * creates a fresh `places` row. That's a deliberate scope call, not an
 * oversight: step 12's Google Places lookup is what gives a real key
 * (`google_place_id`) to match candidate places against, and guessing at
 * matching logic now (e.g. "same name within N meters") risks silently
 * merging two actually-different places sharing a common name. Until then,
 * two people hand-typing the same coordinates separately get two separate
 * pins rather than one merged one — a real, accepted gap (see the report
 * this function ships with).
 *
 * The `trip_places` unique-violation fallback below is still real
 * protection, not dead code: it's exactly the mechanism a future
 * `places`-reuse path (step 12, or a "merge these two places" admin
 * action) needs to land safely without a second migration — if a
 * `places` row ever does get reused across two inserts that both try to
 * pin it on the same trip, this folds into a save on the existing pin
 * instead of erroring, matching "the same place saved more than once
 * merges into one pin."
 */
export async function addPlaceByHand(tripId: string, userId: string, input: NewPlaceInput): Promise<void> {
  const { data: place, error: placeError } = await supabase
    .from('places')
    .insert({
      name: input.name,
      address: input.address ?? null,
      // COLUMN ORDER WARNING (see the migration's own comment on this
      // column): PostGIS points are longitude first. EWKT text assigned to
      // a `geography` column casts implicitly (PostGIS registers an
      // "AS ASSIGNMENT" cast from `text`), so a plain string insert works
      // here without a dedicated RPC or raw SQL.
      location: `SRID=4326;POINT(${input.longitude} ${input.latitude})`,
    })
    .select('id')
    .single();

  if (placeError) throw placeError;

  const { tripPlaceId } = await upsertTripPlace(tripId, place.id, input.category ?? 'other');
  await saveTripPlace(tripPlaceId, userId);
}

async function upsertTripPlace(
  tripId: string,
  placeId: string,
  category: TripPlaceCategory,
): Promise<{ tripPlaceId: string }> {
  const { data, error } = await supabase
    .from('trip_places')
    .insert({ trip_id: tripId, place_id: placeId, category })
    .select('id')
    .single();

  if (!error) return { tripPlaceId: data.id };
  if (error.code !== UNIQUE_VIOLATION) throw error;

  // Duplicate on (trip_id, place_id) — this place is already pinned on this
  // trip. Merge: find the existing pin instead of erroring.
  const { data: existing, error: fetchError } = await supabase
    .from('trip_places')
    .select('id')
    .eq('trip_id', tripId)
    .eq('place_id', placeId)
    .single();

  if (fetchError) throw fetchError;
  return { tripPlaceId: existing.id };
}

/** Saves a pin as the given user. A no-op (not an error) if they've already saved it. */
export async function saveTripPlace(tripPlaceId: string, userId: string): Promise<void> {
  const { error } = await supabase.from('saves').insert({ trip_place_id: tripPlaceId, user_id: userId });
  if (error && error.code !== UNIQUE_VIOLATION) throw error;
}

/**
 * Removes the given user's save from a pin. If that was the pin's last
 * save, a DB trigger deletes the `trip_places` row too (and, transitively,
 * nothing else — there's nothing left to cascade from there yet) — nothing
 * extra to do here; the caller just needs to refetch so the UI reflects it.
 */
export async function removeTripPlaceSave(tripPlaceId: string, userId: string): Promise<void> {
  const { error } = await supabase
    .from('saves')
    .delete()
    .eq('trip_place_id', tripPlaceId)
    .eq('user_id', userId);

  if (error) throw error;
}

/** Deletes a pin for everyone (its `saves` rows cascade-delete with it). */
export async function deleteTripPlace(tripPlaceId: string): Promise<void> {
  const { error } = await supabase.from('trip_places').delete().eq('id', tripPlaceId);
  if (error) throw error;
}
