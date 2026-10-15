import { Stack, useRouter } from 'expo-router';
import { useShareIntentContext } from 'expo-share-intent';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { looksLikeUrl, PasteLinkModal } from '@/components/paste-link-modal';
import { PrimaryButton } from '@/components/primary-button';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { useAuth } from '@/hooks/use-auth';
import { useTheme } from '@/hooks/use-theme';
import { createTikTokPost } from '@/services/posts';
import { fetchTrips, type TripRow } from '@/services/trips';

type TripsStatus = 'loading' | 'error' | 'ready';
type CreateStatus = 'idle' | 'submitting' | 'error';

/**
 * Landing screen for a TikTok link shared into the app from Android's share
 * sheet (step 16). Reached via `+native-intent.ts`'s redirect, which fires
 * whenever the native module hands Expo Router a `dataUrl=...` deeplink —
 * both on cold start (app wasn't running) and while the app is already open
 * on some other screen, since `useShareIntentContext` (wired up in the root
 * layout's `ShareIntentProvider`) updates the same way either way.
 *
 * Picking a trip creates the post itself (there's no trip context yet, this
 * screen's whole job is getting one), then hands off to `PasteLinkModal` —
 * same processing/confirm UI step 14 built for the in-trip "paste a link"
 * flow — via its `initialPostId` prop, which skips that modal's own paste
 * stage since the post already exists.
 */
export default function ShareIntentScreen() {
  const router = useRouter();
  const { session } = useAuth();
  const userId = session?.user.id;
  const theme = useTheme();
  const { shareIntent, hasShareIntent } = useShareIntentContext();

  const sharedUrl = (shareIntent.webUrl ?? shareIntent.text ?? '').trim();
  const hasValidUrl = hasShareIntent && looksLikeUrl(sharedUrl);

  const [trips, setTrips] = useState<TripRow[]>([]);
  const [tripsStatus, setTripsStatus] = useState<TripsStatus>('loading');
  const [tripsError, setTripsError] = useState<string | null>(null);

  const [pickedTripId, setPickedTripId] = useState<string | null>(null);
  const [createdPostId, setCreatedPostId] = useState<string | null>(null);
  const [createStatus, setCreateStatus] = useState<CreateStatus>('idle');
  const [createError, setCreateError] = useState<string | null>(null);

  // No synchronous setState in the body — only from inside the then/catch
  // callbacks once the fetch settles — so this stays safe to call directly
  // from the mount effect below (lint: react-hooks/set-state-in-effect),
  // matching `(tabs)/index.tsx`'s identical `load`/`retry` split.
  const loadTrips = useCallback(() => {
    fetchTrips()
      .then((rows) => {
        setTrips(rows);
        setTripsStatus('ready');
      })
      .catch((err: unknown) => {
        setTripsError(err instanceof Error ? err.message : 'Something went wrong.');
        setTripsStatus('error');
      });
  }, []);

  useEffect(() => {
    if (hasValidUrl) loadTrips();
  }, [hasValidUrl, loadTrips]);

  const retryLoadTrips = useCallback(() => {
    setTripsStatus('loading');
    setTripsError(null);
    loadTrips();
  }, [loadTrips]);

  const handlePickTrip = useCallback(
    (tripId: string) => {
      if (!userId || createStatus === 'submitting') return;
      setCreateStatus('submitting');
      setCreateError(null);
      createTikTokPost(tripId, userId, sharedUrl)
        .then(({ id }) => {
          setPickedTripId(tripId);
          setCreatedPostId(id);
          setCreateStatus('idle');
        })
        .catch((err: unknown) => {
          setCreateError(err instanceof Error ? err.message : 'Something went wrong.');
          setCreateStatus('error');
        });
    },
    [userId, createStatus, sharedUrl],
  );

  // Both the modal's "close" and "confirmed" paths land here: there's
  // nothing behind this screen to refetch (unlike the in-trip paste flow),
  // so the next useful place is the trip the post just went to.
  const handleDone = useCallback(() => {
    if (pickedTripId) router.replace(`/trip/${pickedTripId}`);
    else router.replace('/(tabs)');
  }, [pickedTripId, router]);

  if (!hasValidUrl) {
    return (
      <ThemedView style={styles.container}>
        <Stack.Screen options={{ title: 'Add to a trip' }} />
        <SafeAreaView style={[styles.safeArea, styles.centered]}>
          <ThemedText type="default">No shared link found.</ThemedText>
          <PrimaryButton label="Go to Trips" onPress={() => router.replace('/(tabs)')} />
        </SafeAreaView>
      </ThemedView>
    );
  }

  return (
    <ThemedView style={styles.container}>
      <Stack.Screen options={{ title: 'Add to a trip' }} />
      <SafeAreaView style={styles.safeArea} edges={['top', 'bottom', 'left', 'right']}>
        <ThemedView style={styles.header}>
          <ThemedText type="subtitle">Add this to a trip</ThemedText>
          <ThemedText type="small" themeColor="textSecondary" numberOfLines={1}>
            {sharedUrl}
          </ThemedText>
        </ThemedView>

        {tripsStatus === 'loading' && (
          <ThemedView style={styles.centered}>
            <ActivityIndicator accessibilityLabel="Loading trips" />
          </ThemedView>
        )}

        {tripsStatus === 'error' && (
          <ThemedView style={styles.centered}>
            <ThemedText type="small" themeColor="textSecondary">
              Couldn&apos;t load trips{tripsError ? `: ${tripsError}` : '.'}
            </ThemedText>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Retry loading trips"
              onPress={retryLoadTrips}
              style={({ pressed }) => [styles.retryButton, pressed && styles.pressed]}>
              <ThemedText type="link">Retry</ThemedText>
            </Pressable>
          </ThemedView>
        )}

        {tripsStatus === 'ready' && (
          <FlatList
            data={trips}
            keyExtractor={(trip) => trip.id}
            renderItem={({ item }) => (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Add to ${item.name}`}
                accessibilityState={{ disabled: createStatus === 'submitting' }}
                disabled={createStatus === 'submitting'}
                onPress={() => handlePickTrip(item.id)}
                style={({ pressed }) => [
                  styles.row,
                  { backgroundColor: theme.backgroundElement },
                  pressed && styles.pressed,
                  createStatus === 'submitting' && styles.disabled,
                ]}>
                <ThemedText type="default">{item.name}</ThemedText>
                <ThemedText type="small" themeColor="textSecondary">
                  {item.destination ?? 'Destination TBD'}
                </ThemedText>
              </Pressable>
            )}
            contentContainerStyle={styles.listContent}
            ListEmptyComponent={
              <ThemedText type="small" themeColor="textSecondary">
                No trips yet — create one first.
              </ThemedText>
            }
          />
        )}

        {createStatus === 'submitting' && (
          <ThemedView style={styles.inlineLoading}>
            <ActivityIndicator accessibilityLabel="Adding to trip" />
          </ThemedView>
        )}

        {createStatus === 'error' && createError && (
          <ThemedText type="small" themeColor="textSecondary">
            {createError}
          </ThemedText>
        )}
      </SafeAreaView>

      <PasteLinkModal
        key={createdPostId ?? 'none'}
        visible={!!createdPostId}
        tripId={pickedTripId ?? ''}
        userId={userId}
        initialPostId={createdPostId ?? undefined}
        onClose={handleDone}
        onConfirmed={handleDone}
      />
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
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.three,
  },
  header: {
    gap: Spacing.one,
    paddingVertical: Spacing.four,
  },
  retryButton: {
    padding: Spacing.two,
  },
  listContent: {
    gap: Spacing.three,
    paddingBottom: Spacing.four,
  },
  row: {
    padding: Spacing.three,
    borderRadius: Spacing.three,
    gap: Spacing.one,
    minHeight: 44,
  },
  pressed: {
    opacity: 0.7,
  },
  disabled: {
    opacity: 0.5,
  },
  inlineLoading: {
    paddingVertical: Spacing.three,
    alignItems: 'center',
  },
});
