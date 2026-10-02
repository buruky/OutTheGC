/**
 * Hardcoded pin data for roadmap step 3 (the map).
 *
 * Real Tokyo-area coordinates, keyed by tripId so each trip can have its own
 * pins once this becomes a Supabase query (steps 4/8). `latitude`/`longitude`
 * match react-native-maps' `LatLng` shape — note this is the reverse order
 * from PostGIS, which stores points as `(longitude, latitude)`.
 */
export type Place = {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
};

export const FAKE_PLACES_BY_TRIP: Record<string, Place[]> = {
  'tokyo-2026': [
    { id: 'shibuya-crossing', name: 'Shibuya Crossing', latitude: 35.6595, longitude: 139.7005 },
    { id: 'senso-ji', name: 'Sensō-ji Temple', latitude: 35.7148, longitude: 139.7967 },
    { id: 'tsukiji-outer-market', name: 'Tsukiji Outer Market', latitude: 35.6654, longitude: 139.7707 },
    { id: 'meiji-jingu', name: 'Meiji Jingu Shrine', latitude: 35.6764, longitude: 139.6993 },
    { id: 'tokyo-tower', name: 'Tokyo Tower', latitude: 35.6586, longitude: 139.7454 },
  ],
};

export function getPlacesForTrip(tripId: string): Place[] {
  return FAKE_PLACES_BY_TRIP[tripId] ?? [];
}
