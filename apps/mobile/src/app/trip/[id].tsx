import * as Clipboard from 'expo-clipboard';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, Share, StyleSheet } from 'react-native';
import MapView, { Marker, type Region } from 'react-native-maps';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { getPlacesForTrip, type Place } from '@/data/places';
import { fetchTripById, type TripRow } from '@/services/trips';
import { useTheme } from '@/hooks/use-theme';

type Status = 'loading' | 'error' | 'not-found' | 'ready';

/**
 * `outthegc://join/<code>` — matches `app.json`'s `scheme` and the
 * `src/app/join/[code].tsx` route. Built here and in the join screen rather
 * than stored anywhere, since it's fully derived from the code.
 */
function buildInviteLink(inviteCode: string): string {
  return `outthegc://join/${inviteCode}`;
}

export default function TripDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [trip, setTrip] = useState<TripRow | null>(null);
  const [status, setStatus] = useState<Status>('loading');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [selectedPlace, setSelectedPlace] = useState<Place | null>(null);
  const [copied, setCopied] = useState(false);
  const copiedResetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const theme = useTheme();

  // Clears on unmount so a pending "reset the copied label" timer never
  // fires a setState after this screen is gone.
  useEffect(() => {
    return () => {
      if (copiedResetTimer.current) clearTimeout(copiedResetTimer.current);
    };
  }, []);

  const handleCopyCode = useCallback((inviteCode: string) => {
    Clipboard.setStringAsync(inviteCode)
      .then(() => {
        setCopied(true);
        if (copiedResetTimer.current) clearTimeout(copiedResetTimer.current);
        copiedResetTimer.current = setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {
        // Clipboard access can fail on some Android configurations; silently
        // no-op rather than showing a scary error for a convenience action.
      });
  }, []);

  const handleShareInvite = useCallback((tripName: string, inviteCode: string) => {
    Share.share({
      message: `Join my trip "${tripName}" on OutTheGC: ${buildInviteLink(inviteCode)}`,
      url: buildInviteLink(inviteCode), // iOS-only field; Android reads the link from `message`.
    }).catch(() => {
      // User-cancelled shares also reject on some platforms — no error UI needed.
    });
  }, []);

  // Hardcoded pins keyed by trip id — stays this way until step 8 ("Pins
  // from the database") adds `places`/`trip_places`. Not touched by the
  // step 4 Supabase swap.
  const places = getPlacesForTrip(id);

  // `load` itself must not call setState synchronously — only from inside
  // the then/catch callbacks, once the fetch actually settles. That keeps it
  // safe to call directly from the mount effect below (lint:
  // react-hooks/set-state-in-effect) while still being reusable for retry.
  const load = useCallback(() => {
    fetchTripById(id)
      .then((row) => {
        setTrip(row);
        setStatus(row ? 'ready' : 'not-found');
      })
      .catch((err: unknown) => {
        setErrorMessage(err instanceof Error ? err.message : 'Something went wrong.');
        setStatus('error');
      });
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  const retry = useCallback(() => {
    setStatus('loading');
    setErrorMessage(null);
    load();
  }, [load]);

  if (status === 'loading') {
    return (
      <ThemedView style={styles.container}>
        <Stack.Screen options={{ title: 'Loading…' }} />
        <SafeAreaView style={[styles.safeArea, styles.centered]}>
          <ActivityIndicator accessibilityLabel="Loading trip" />
        </SafeAreaView>
      </ThemedView>
    );
  }

  if (status === 'error') {
    return (
      <ThemedView style={styles.container}>
        <Stack.Screen options={{ title: 'Error' }} />
        <SafeAreaView style={[styles.safeArea, styles.centered]}>
          <ThemedText type="small" themeColor="textSecondary">
            Couldn&apos;t load this trip{errorMessage ? `: ${errorMessage}` : '.'}
          </ThemedText>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Retry loading trip"
            onPress={retry}
            style={({ pressed }) => [styles.retryButton, pressed && styles.pressed]}>
            <ThemedText type="link">Retry</ThemedText>
          </Pressable>
        </SafeAreaView>
      </ThemedView>
    );
  }

  if (status === 'not-found' || !trip) {
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
            {trip.destination ?? 'Destination TBD'}
          </ThemedText>
          <ThemedText type="small" themeColor="textSecondary">
            {trip.start_date ?? '?'} – {trip.end_date ?? '?'}
          </ThemedText>

          <ThemedView style={styles.inviteRow}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Invite code ${trip.invite_code}. Double tap to copy.`}
              onPress={() => handleCopyCode(trip.invite_code)}
              style={({ pressed }) => [
                styles.inviteCodeChip,
                { backgroundColor: theme.backgroundElement },
                pressed && styles.pressed,
              ]}>
              <ThemedText type="code">{trip.invite_code}</ThemedText>
              <ThemedText type="small" themeColor="textSecondary">
                {copied ? 'Copied!' : 'Tap to copy'}
              </ThemedText>
            </Pressable>

            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Share invite link"
              onPress={() => handleShareInvite(trip.name, trip.invite_code)}
              style={({ pressed }) => [styles.shareButton, pressed && styles.pressed]}>
              <ThemedText type="linkPrimary">Share invite</ThemedText>
            </Pressable>
          </ThemedView>
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
  centered: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.three,
  },
  retryButton: {
    padding: Spacing.two,
  },
  pressed: {
    opacity: 0.7,
  },
  header: {
    padding: Spacing.four,
    gap: Spacing.two,
  },
  inviteRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
    marginTop: Spacing.one,
  },
  inviteCodeChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    minHeight: 44,
    paddingHorizontal: Spacing.three,
    borderRadius: Spacing.two,
  },
  shareButton: {
    minHeight: 44,
    paddingHorizontal: Spacing.two,
    alignItems: 'center',
    justifyContent: 'center',
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
