import { Stack, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { StyleSheet } from 'react-native';
import MapView, { Marker, type Region } from 'react-native-maps';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { getPlacesForTrip, type Place } from '@/data/places';
import { getTripById } from '@/data/trips';
import { useTheme } from '@/hooks/use-theme';

export default function TripDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const trip = getTripById(id);
  const places = getPlacesForTrip(id);
  const [selectedPlace, setSelectedPlace] = useState<Place | null>(null);
  const theme = useTheme();

  if (!trip) {
    return (
      <ThemedView style={styles.container}>
        <Stack.Screen options={{ title: 'Trip not found' }} />
        <SafeAreaView style={styles.safeArea}>
          <ThemedText type="subtitle">Trip not found</ThemedText>
          <ThemedText type="small" themeColor="textSecondary">
            No trip matches id &quot;{id}&quot;.
          </ThemedText>
        </SafeAreaView>
      </ThemedView>
    );
  }

  // Center the map on the first pin when there are pins; otherwise fall back
  // to a wide world view rather than guessing a region from `trip.destination`
  // (no geocoding exists yet — that's step 12's Google Places lookup).
  const initialRegion: Region = places[0]
    ? { latitude: places[0].latitude, longitude: places[0].longitude, latitudeDelta: 0.1, longitudeDelta: 0.1 }
    : { latitude: 0, longitude: 0, latitudeDelta: 60, longitudeDelta: 60 };

  return (
    <ThemedView style={styles.container}>
      <Stack.Screen options={{ title: trip.name }} />
      <SafeAreaView style={styles.safeArea} edges={['bottom', 'left', 'right']}>
        <ThemedView style={styles.header}>
          <ThemedText type="title">{trip.name}</ThemedText>
          <ThemedText type="default" themeColor="textSecondary">
            {trip.destination}
          </ThemedText>
          <ThemedText type="small" themeColor="textSecondary">
            {trip.startDate} – {trip.endDate}
          </ThemedText>
        </ThemedView>

        <ThemedView style={styles.mapContainer}>
          {places.length > 0 ? (
            <MapView style={styles.map} initialRegion={initialRegion}>
              {places.map((place) => (
                <Marker
                  key={place.id}
                  coordinate={{ latitude: place.latitude, longitude: place.longitude }}
                  title={place.name}
                  onPress={() => setSelectedPlace(place)}
                />
              ))}
            </MapView>
          ) : (
            <ThemedView style={[styles.map, styles.emptyMap, { backgroundColor: theme.backgroundElement }]}>
              <ThemedText type="small" themeColor="textSecondary">
                No pins yet for this trip.
              </ThemedText>
            </ThemedView>
          )}

          {selectedPlace && (
            <ThemedView
              style={[styles.card, { backgroundColor: theme.backgroundElement }]}
              accessibilityRole="text"
              accessibilityLabel={`Selected place: ${selectedPlace.name}`}>
              <ThemedText type="smallBold">{selectedPlace.name}</ThemedText>
            </ThemedView>
          )}
        </ThemedView>
      </SafeAreaView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  safeArea: {
    flex: 1,
  },
  header: {
    padding: Spacing.four,
    gap: Spacing.two,
  },
  mapContainer: {
    flex: 1,
  },
  map: {
    flex: 1,
  },
  emptyMap: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  card: {
    position: 'absolute',
    left: Spacing.four,
    right: Spacing.four,
    bottom: Spacing.four,
    padding: Spacing.three,
    borderRadius: Spacing.two,
  },
});
