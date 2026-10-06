import { Link } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { BottomTabInset, MaxContentWidth, Spacing } from '@/constants/theme';
import { fetchTrips, type TripRow } from '@/services/trips';

function formatDateRange(startDate: string | null, endDate: string | null) {
  if (!startDate || !endDate) return 'Dates TBD';
  const format = (iso: string) =>
    new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return `${format(startDate)} – ${format(endDate)}`;
}

function TripRowItem({ trip }: { trip: TripRow }) {
  return (
    <Link href={`/trip/${trip.id}`} asChild>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${trip.name}, ${trip.destination ?? 'destination TBD'}`}
        style={({ pressed }) => pressed && styles.pressed}>
        <ThemedView type="backgroundElement" style={styles.row}>
          <ThemedText type="default">{trip.name}</ThemedText>
          <ThemedText type="small" themeColor="textSecondary">
            {trip.destination ?? 'Destination TBD'} · {formatDateRange(trip.start_date, trip.end_date)}
          </ThemedText>
        </ThemedView>
      </Pressable>
    </Link>
  );
}

export default function TripsScreen() {
  const [trips, setTrips] = useState<TripRow[]>([]);
  const [status, setStatus] = useState<'loading' | 'error' | 'ready'>('loading');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // `load` itself must not call setState synchronously — only from inside
  // the then/catch callbacks, once the fetch actually settles. That keeps it
  // safe to call directly from the mount effect below (lint:
  // react-hooks/set-state-in-effect) while still being reusable for retry.
  const load = useCallback(() => {
    fetchTrips()
      .then((rows) => {
        setTrips(rows);
        setStatus('ready');
      })
      .catch((err: unknown) => {
        setErrorMessage(err instanceof Error ? err.message : 'Something went wrong.');
        setStatus('error');
      });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const retry = useCallback(() => {
    setStatus('loading');
    setErrorMessage(null);
    load();
  }, [load]);

  return (
    <ThemedView style={styles.container}>
      <SafeAreaView style={styles.safeArea} edges={['top', 'left', 'right']}>
        <ThemedView style={styles.titleRow}>
          <ThemedText type="title">Trips</ThemedText>
          <ThemedView style={styles.titleActions}>
            <Link href="/join" asChild>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Join a trip with a code"
                style={({ pressed }) => [styles.newTripButton, pressed && styles.pressed]}>
                <ThemedText type="linkPrimary">Join with code</ThemedText>
              </Pressable>
            </Link>
            <Link href="/trip/new" asChild>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Create a new trip"
                style={({ pressed }) => [styles.newTripButton, pressed && styles.pressed]}>
                <ThemedText type="linkPrimary">+ New trip</ThemedText>
              </Pressable>
            </Link>
          </ThemedView>
        </ThemedView>

        {status === 'loading' && (
          <ThemedView style={styles.centered}>
            <ActivityIndicator accessibilityLabel="Loading trips" />
          </ThemedView>
        )}

        {status === 'error' && (
          <ThemedView style={styles.centered}>
            <ThemedText type="small" themeColor="textSecondary">
              Couldn&apos;t load trips{errorMessage ? `: ${errorMessage}` : '.'}
            </ThemedText>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Retry loading trips"
              onPress={retry}
              style={({ pressed }) => [styles.retryButton, pressed && styles.pressed]}>
              <ThemedText type="link">Retry</ThemedText>
            </Pressable>
          </ThemedView>
        )}

        {status === 'ready' && (
          <FlatList
            data={trips}
            keyExtractor={(trip) => trip.id}
            renderItem={({ item }) => <TripRowItem trip={item} />}
            contentContainerStyle={styles.listContent}
            ListEmptyComponent={
              <ThemedText type="small" themeColor="textSecondary">
                No trips yet.
              </ThemedText>
            }
          />
        )}
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
    paddingHorizontal: Spacing.four,
    alignSelf: 'center',
    width: '100%',
    maxWidth: MaxContentWidth,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: Spacing.four,
  },
  titleActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
  },
  newTripButton: {
    minHeight: 44,
    minWidth: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.three,
  },
  retryButton: {
    padding: Spacing.two,
  },
  listContent: {
    gap: Spacing.three,
    paddingBottom: BottomTabInset + Spacing.three,
  },
  row: {
    padding: Spacing.three,
    borderRadius: Spacing.three,
    gap: Spacing.one,
  },
  pressed: {
    opacity: 0.7,
  },
});
