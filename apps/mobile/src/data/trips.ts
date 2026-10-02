/**
 * Hardcoded trip data from roadmap step 2 (screens and navigation).
 *
 * As of step 4 ("Connect Supabase"), the Trips tab and trip detail screen
 * read from `src/services/trips.ts` (a real `trips` table query) instead of
 * this file — nothing in `src/app/` imports `FAKE_TRIPS` or `getTripById`
 * anymore. Left in place as a reference for the shape the UI expected
 * before the swap; safe to delete once that history isn't useful.
 *
 * Note: real `trips.id` values are Postgres-generated UUIDs, unlike the
 * slug ids below — nothing here depends on the id format, since route
 * params from `useLocalSearchParams` are always strings.
 */
export type Trip = {
  id: string;
  name: string;
  destination: string;
  startDate: string;
  endDate: string;
};

export const FAKE_TRIPS: Trip[] = [
  {
    id: 'tokyo-2026',
    name: 'Tokyo Spring Trip',
    destination: 'Tokyo, Japan',
    startDate: '2026-03-10',
    endDate: '2026-03-18',
  },
  {
    id: 'lisbon-2026',
    name: 'Lisbon Long Weekend',
    destination: 'Lisbon, Portugal',
    startDate: '2026-05-22',
    endDate: '2026-05-26',
  },
  {
    id: 'mexico-city-2026',
    name: 'Mexico City Food Crawl',
    destination: 'Mexico City, Mexico',
    startDate: '2026-07-02',
    endDate: '2026-07-09',
  },
];

export function getTripById(id: string): Trip | undefined {
  return FAKE_TRIPS.find((trip) => trip.id === id);
}
