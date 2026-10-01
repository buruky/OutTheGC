import { Link } from 'expo-router';
import { FlatList, Pressable, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { BottomTabInset, MaxContentWidth, Spacing } from '@/constants/theme';
import { FAKE_TRIPS, type Trip } from '@/data/trips';

function formatDateRange(startDate: string, endDate: string) {
  const format = (iso: string) =>
    new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return `${format(startDate)} – ${format(endDate)}`;
}

function TripRow({ trip }: { trip: Trip }) {
  return (
    <Link href={`/trip/${trip.id}`} asChild>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${trip.name}, ${trip.destination}`}
        style={({ pressed }) => pressed && styles.pressed}>
        <ThemedView type="backgroundElement" style={styles.row}>
          <ThemedText type="default">{trip.name}</ThemedText>
          <ThemedText type="small" themeColor="textSecondary">
            {trip.destination} · {formatDateRange(trip.startDate, trip.endDate)}
          </ThemedText>
        </ThemedView>
      </Pressable>
    </Link>
  );
}

export default function TripsScreen() {
  return (
    <ThemedView style={styles.container}>
      <SafeAreaView style={styles.safeArea} edges={['top', 'left', 'right']}>
        <ThemedText type="title" style={styles.title}>
          Trips
        </ThemedText>
        <FlatList
          data={FAKE_TRIPS}
          keyExtractor={(trip) => trip.id}
          renderItem={({ item }) => <TripRow trip={item} />}
          contentContainerStyle={styles.listContent}
          ListEmptyComponent={
            <ThemedText type="small" themeColor="textSecondary">
              No trips yet.
            </ThemedText>
          }
        />
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
  title: {
    paddingVertical: Spacing.four,
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
