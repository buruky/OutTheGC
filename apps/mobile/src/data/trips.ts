/**
 * Hardcoded trip data for roadmap step 2 (screens and navigation).
 *
 * Field names deliberately mirror the real `trips` table from
 * OutTheGC-spec.md (name, destination, start_date, end_date) so step 4 can
 * swap this module for a Supabase query without changing the screens that
 * consume it.
 *
 * Note: real `trips.id` values will be Postgres-generated UUIDs. The slug
 * ids below are just readable placeholders — nothing here depends on the id
 * format, since route params from `useLocalSearchParams` are always strings.
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
