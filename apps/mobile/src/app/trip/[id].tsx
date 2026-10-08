import * as Clipboard from 'expo-clipboard';
import { Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Platform,
  Pressable,
  Share,
  StyleSheet,
  View,
} from 'react-native';
import MapView, { Marker, type Region } from 'react-native-maps';
import { SafeAreaView } from 'react-native-safe-area-context';

import { PrimaryButton } from '@/components/primary-button';
import { TextField } from '@/components/text-field';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { useAuth } from '@/hooks/use-auth';
import { useTheme } from '@/hooks/use-theme';
import {
  addPlaceByHand,
  deleteTripPlace,
  fetchTripPins,
  removeTripPlaceSave,
  saveTripPlace,
  TRIP_PLACE_CATEGORIES,
  type TripPin,
  type TripPlaceCategory,
} from '@/services/places';
import { fetchTripById, type TripRow } from '@/services/trips';

type Status = 'loading' | 'error' | 'not-found' | 'ready';
type PinsStatus = 'loading' | 'error' | 'ready';
type FilterMode = 'group' | 'mine';
type AddStatus = 'idle' | 'submitting' | 'error';

/**
 * `outthegc://join/<code>` — matches `app.json`'s `scheme` and the
 * `src/app/join/[code].tsx` route. Built here and in the join screen rather
 * than stored anywhere, since it's fully derived from the code.
 */
function buildInviteLink(inviteCode: string): string {
  return `outthegc://join/${inviteCode}`;
}

function formatCategoryLabel(category: TripPlaceCategory): string {
  return category.charAt(0).toUpperCase() + category.slice(1);
}

export default function TripDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { session } = useAuth();
  const userId = session?.user.id;

  const [trip, setTrip] = useState<TripRow | null>(null);
  const [status, setStatus] = useState<Status>('loading');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const copiedResetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const theme = useTheme();

  const [pins, setPins] = useState<TripPin[]>([]);
  const [pinsStatus, setPinsStatus] = useState<PinsStatus>('loading');
  const [pinsErrorMessage, setPinsErrorMessage] = useState<string | null>(null);
  const [selectedPinId, setSelectedPinId] = useState<string | null>(null);
  const [filterMode, setFilterMode] = useState<FilterMode>('group');
  const [actionPending, setActionPending] = useState(false);

  const [addModalVisible, setAddModalVisible] = useState(false);
  const [addName, setAddName] = useState('');
  const [addAddress, setAddAddress] = useState('');
  const [addLatitude, setAddLatitude] = useState('');
  const [addLongitude, setAddLongitude] = useState('');
  const [addCategory, setAddCategory] = useState<TripPlaceCategory>('other');
  const [addStatus, setAddStatus] = useState<AddStatus>('idle');
  const [addErrorMessage, setAddErrorMessage] = useState<string | null>(null);

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

  // Real pins from the database (step 8), replacing the step-3 hardcoded
  // set. No Realtime yet (step 9) — refetching on focus, and after every
  // local mutation (save/remove save/delete/add), is the "good enough for
  // now" sync story the brief calls out. `useFocusEffect` already runs its
  // callback once on initial mount, so this is the only load trigger pins
  // need — no separate mount `useEffect`.
  const loadPins = useCallback(() => {
    if (!userId) return;
    setPinsStatus('loading');
    setPinsErrorMessage(null);
    fetchTripPins(id, userId)
      .then((rows) => {
        setPins(rows);
        setPinsStatus('ready');
      })
      .catch((err: unknown) => {
        setPinsErrorMessage(err instanceof Error ? err.message : 'Something went wrong.');
        setPinsStatus('error');
      });
  }, [id, userId]);

  useFocusEffect(
    useCallback(() => {
      loadPins();
    }, [loadPins]),
  );

  const visiblePins = useMemo(
    () => (filterMode === 'mine' ? pins.filter((pin) => pin.savedByMe) : pins),
    [pins, filterMode],
  );

  const selectedPin = useMemo(
    () => pins.find((pin) => pin.id === selectedPinId) ?? null,
    [pins, selectedPinId],
  );

  const handleToggleSave = useCallback(
    (pin: TripPin) => {
      if (!userId || actionPending) return;
      setActionPending(true);
      const action = pin.savedByMe ? removeTripPlaceSave(pin.id, userId) : saveTripPlace(pin.id, userId);
      action
        .then(() => loadPins())
        .catch((err: unknown) => {
          Alert.alert('Something went wrong', err instanceof Error ? err.message : 'Please try again.');
        })
        .finally(() => setActionPending(false));
    },
    [userId, actionPending, loadPins],
  );

  const handleDeletePin = useCallback(
    (pin: TripPin) => {
      if (actionPending) return;
      Alert.alert('Delete this pin?', `"${pin.place.name}" will be removed for everyone on this trip.`, [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete for everyone',
          style: 'destructive',
          onPress: () => {
            setActionPending(true);
            deleteTripPlace(pin.id)
              .then(() => {
                setSelectedPinId(null);
                loadPins();
              })
              .catch((err: unknown) => {
                Alert.alert(
                  'Something went wrong',
                  err instanceof Error ? err.message : 'Please try again.',
                );
              })
              .finally(() => setActionPending(false));
          },
        },
      ]);
    },
    [actionPending, loadPins],
  );

  const resetAddForm = useCallback(() => {
    setAddName('');
    setAddAddress('');
    setAddLatitude('');
    setAddLongitude('');
    setAddCategory('other');
    setAddStatus('idle');
    setAddErrorMessage(null);
  }, []);

  const handleOpenAddModal = useCallback(() => {
    resetAddForm();
    setAddModalVisible(true);
  }, [resetAddForm]);

  const handleCloseAddModal = useCallback(() => {
    if (addStatus === 'submitting') return;
    setAddModalVisible(false);
  }, [addStatus]);

  const handleSubmitAddPlace = useCallback(() => {
    if (!userId) return;

    const trimmedName = addName.trim();
    if (trimmedName.length === 0) {
      setAddStatus('error');
      setAddErrorMessage('Name is required.');
      return;
    }

    // `Number('')` is `0`, not `NaN` — an empty field would otherwise
    // silently validate as a real coordinate (0, 0) instead of erroring.
    const trimmedLatitude = addLatitude.trim();
    const latitude = Number(trimmedLatitude);
    if (trimmedLatitude.length === 0 || !Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
      setAddStatus('error');
      setAddErrorMessage('Latitude must be a number between -90 and 90.');
      return;
    }

    const trimmedLongitude = addLongitude.trim();
    const longitude = Number(trimmedLongitude);
    if (
      trimmedLongitude.length === 0 ||
      !Number.isFinite(longitude) ||
      longitude < -180 ||
      longitude > 180
    ) {
      setAddStatus('error');
      setAddErrorMessage('Longitude must be a number between -180 and 180.');
      return;
    }

    setAddStatus('submitting');
    setAddErrorMessage(null);

    addPlaceByHand(id, userId, {
      name: trimmedName,
      latitude,
      longitude,
      address: addAddress.trim() || null,
      category: addCategory,
    })
      .then(() => {
        setAddModalVisible(false);
        resetAddForm();
        loadPins();
      })
      .catch((err: unknown) => {
        setAddErrorMessage(err instanceof Error ? err.message : 'Something went wrong.');
        setAddStatus('error');
      });
  }, [id, userId, addName, addLatitude, addLongitude, addAddress, addCategory, resetAddForm, loadPins]);

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
  // (no geocoding exists yet — that's step 12's Google Places lookup). Based
  // on every pin, not just the filtered set, so toggling the my/group filter
  // never jumps the map (react-native-maps only honors `initialRegion` once,
  // on first mount, anyway).
  const initialRegion: Region = pins[0]
    ? { latitude: pins[0].place.latitude, longitude: pins[0].place.longitude, latitudeDelta: 0.1, longitudeDelta: 0.1 }
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

          <PrimaryButton label="+ Add a place" onPress={handleOpenAddModal} />
        </ThemedView>

        <ThemedView style={styles.mapContainer}>
          {pinsStatus === 'loading' && pins.length === 0 ? (
            <ThemedView style={[styles.map, styles.emptyMap, { backgroundColor: theme.backgroundElement }]}>
              <ActivityIndicator accessibilityLabel="Loading pins" />
            </ThemedView>
          ) : pinsStatus === 'error' ? (
            <ThemedView style={[styles.map, styles.emptyMap, { backgroundColor: theme.backgroundElement }]}>
              <ThemedText type="small" themeColor="textSecondary">
                Couldn&apos;t load pins{pinsErrorMessage ? `: ${pinsErrorMessage}` : '.'}
              </ThemedText>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Retry loading pins"
                onPress={loadPins}
                style={({ pressed }) => [styles.retryButton, pressed && styles.pressed]}>
                <ThemedText type="link">Retry</ThemedText>
              </Pressable>
            </ThemedView>
          ) : visiblePins.length > 0 ? (
            <MapView style={styles.map} initialRegion={initialRegion}>
              {visiblePins.map((pin) => (
                <Marker
                  key={pin.id}
                  coordinate={{ latitude: pin.place.latitude, longitude: pin.place.longitude }}
                  title={pin.place.name}
                  onPress={() => setSelectedPinId(pin.id)}
                />
              ))}
            </MapView>
          ) : (
            <ThemedView style={[styles.map, styles.emptyMap, { backgroundColor: theme.backgroundElement }]}>
              <ThemedText type="small" themeColor="textSecondary">
                {filterMode === 'mine' ? "You haven't saved any pins yet." : 'No pins yet for this trip.'}
              </ThemedText>
            </ThemedView>
          )}

          <ThemedView
            style={[styles.filterRow, { backgroundColor: theme.backgroundElement }]}
            accessibilityRole="tablist">
            <Pressable
              accessibilityRole="tab"
              accessibilityState={{ selected: filterMode === 'group' }}
              accessibilityLabel="Show pins saved by the whole group"
              onPress={() => setFilterMode('group')}
              style={[
                styles.filterButton,
                filterMode === 'group' && { backgroundColor: theme.backgroundSelected },
              ]}>
              <ThemedText type="small" themeColor={filterMode === 'group' ? 'text' : 'textSecondary'}>
                Group
              </ThemedText>
            </Pressable>
            <Pressable
              accessibilityRole="tab"
              accessibilityState={{ selected: filterMode === 'mine' }}
              accessibilityLabel="Show only pins I've saved"
              onPress={() => setFilterMode('mine')}
              style={[
                styles.filterButton,
                filterMode === 'mine' && { backgroundColor: theme.backgroundSelected },
              ]}>
              <ThemedText type="small" themeColor={filterMode === 'mine' ? 'text' : 'textSecondary'}>
                Mine
              </ThemedText>
            </Pressable>
          </ThemedView>

          {selectedPin && (
            <ThemedView
              style={[styles.card, { backgroundColor: theme.backgroundElement }]}
              accessibilityRole="text"
              accessibilityLabel={`Selected place: ${selectedPin.place.name}. Saved by ${selectedPin.saveCount} ${selectedPin.saveCount === 1 ? 'person' : 'people'}.`}>
              <ThemedText type="smallBold">{selectedPin.place.name}</ThemedText>
              {selectedPin.place.address && (
                <ThemedText type="small" themeColor="textSecondary">
                  {selectedPin.place.address}
                </ThemedText>
              )}
              <ThemedText type="small" themeColor="textSecondary">
                Saved by {selectedPin.saveCount} {selectedPin.saveCount === 1 ? 'person' : 'people'}
              </ThemedText>

              <ThemedView style={styles.cardActions}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={selectedPin.savedByMe ? 'Remove my save' : 'Save this place'}
                  accessibilityState={{ disabled: actionPending }}
                  disabled={actionPending}
                  onPress={() => handleToggleSave(selectedPin)}
                  style={({ pressed }) => [
                    styles.cardButton,
                    pressed && !actionPending && styles.pressed,
                    actionPending && styles.disabled,
                  ]}>
                  <ThemedText type="linkPrimary">
                    {selectedPin.savedByMe ? 'Remove my save' : 'Save'}
                  </ThemedText>
                </Pressable>

                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Delete this pin for everyone"
                  accessibilityState={{ disabled: actionPending }}
                  disabled={actionPending}
                  onPress={() => handleDeletePin(selectedPin)}
                  style={({ pressed }) => [
                    styles.cardButton,
                    pressed && !actionPending && styles.pressed,
                    actionPending && styles.disabled,
                  ]}>
                  <ThemedText type="small" themeColor="textSecondary">
                    Delete for everyone
                  </ThemedText>
                </Pressable>
              </ThemedView>
            </ThemedView>
          )}
        </ThemedView>
      </SafeAreaView>

      <Modal visible={addModalVisible} animationType="slide" onRequestClose={handleCloseAddModal}>
        <ThemedView style={styles.container}>
          <SafeAreaView style={styles.safeArea} edges={['top', 'bottom', 'left', 'right']}>
            <ThemedView style={styles.modalHeader}>
              <ThemedText type="subtitle">Add a place</ThemedText>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Close"
                accessibilityState={{ disabled: addStatus === 'submitting' }}
                disabled={addStatus === 'submitting'}
                onPress={handleCloseAddModal}
                style={({ pressed }) => [
                  styles.closeButton,
                  pressed && addStatus !== 'submitting' && styles.pressed,
                  addStatus === 'submitting' && styles.disabled,
                ]}>
                <ThemedText type="link">Close</ThemedText>
              </Pressable>
            </ThemedView>

            <ThemedView style={styles.form}>
              <TextField
                label="Name"
                value={addName}
                onChangeText={setAddName}
                placeholder="Ichiran Ramen"
                autoFocus
              />

              <TextField
                label="Address (optional)"
                value={addAddress}
                onChangeText={setAddAddress}
                placeholder="1-22-7 Jinnan, Shibuya"
              />

              <ThemedView style={styles.coordinateRow}>
                <ThemedView style={styles.coordinateField}>
                  <TextField
                    label="Latitude"
                    value={addLatitude}
                    onChangeText={setAddLatitude}
                    placeholder="35.6595"
                    // iOS's "numeric" pad has no minus sign; coordinates can
                    // be negative, so iOS gets the punctuation-aware variant
                    // instead. Android's "numeric" keyboard already includes
                    // "-" and ".".
                    keyboardType={Platform.select({ ios: 'numbers-and-punctuation', default: 'numeric' })}
                  />
                </ThemedView>
                <ThemedView style={styles.coordinateField}>
                  <TextField
                    label="Longitude"
                    value={addLongitude}
                    onChangeText={setAddLongitude}
                    placeholder="139.7005"
                    keyboardType={Platform.select({ ios: 'numbers-and-punctuation', default: 'numeric' })}
                  />
                </ThemedView>
              </ThemedView>

              <ThemedView style={styles.categoryField}>
                <ThemedText type="smallBold">Category</ThemedText>
                <View style={styles.categoryChips}>
                  {TRIP_PLACE_CATEGORIES.map((category) => (
                    <Pressable
                      key={category}
                      accessibilityRole="button"
                      accessibilityLabel={`Category: ${formatCategoryLabel(category)}`}
                      accessibilityState={{ selected: addCategory === category }}
                      onPress={() => setAddCategory(category)}
                      style={({ pressed }) => [
                        styles.categoryChip,
                        { backgroundColor: theme.backgroundElement },
                        addCategory === category && { backgroundColor: theme.backgroundSelected },
                        pressed && styles.pressed,
                      ]}>
                      <ThemedText type="small" themeColor={addCategory === category ? 'text' : 'textSecondary'}>
                        {formatCategoryLabel(category)}
                      </ThemedText>
                    </Pressable>
                  ))}
                </View>
              </ThemedView>

              {addStatus === 'error' && addErrorMessage && (
                <ThemedText type="small" themeColor="textSecondary">
                  {addErrorMessage}
                </ThemedText>
              )}

              <PrimaryButton
                label="Add place"
                onPress={handleSubmitAddPlace}
                loading={addStatus === 'submitting'}
                disabled={addStatus === 'submitting'}
              />
            </ThemedView>
          </SafeAreaView>
        </ThemedView>
      </Modal>
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
  disabled: {
    opacity: 0.4,
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
    gap: Spacing.two,
  },
  filterRow: {
    position: 'absolute',
    top: Spacing.four,
    left: Spacing.four,
    flexDirection: 'row',
    borderRadius: Spacing.two,
    overflow: 'hidden',
  },
  filterButton: {
    minHeight: 44,
    minWidth: 72,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: Spacing.three,
  },
  card: {
    position: 'absolute',
    left: Spacing.four,
    right: Spacing.four,
    bottom: Spacing.four,
    padding: Spacing.three,
    borderRadius: Spacing.two,
    gap: Spacing.one,
  },
  cardActions: {
    flexDirection: 'row',
    gap: Spacing.three,
    marginTop: Spacing.one,
  },
  cardButton: {
    minHeight: 44,
    justifyContent: 'center',
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: Spacing.four,
  },
  closeButton: {
    minHeight: 44,
    minWidth: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  form: {
    paddingHorizontal: Spacing.four,
    gap: Spacing.three,
  },
  coordinateRow: {
    flexDirection: 'row',
    gap: Spacing.three,
  },
  coordinateField: {
    flex: 1,
  },
  categoryField: {
    gap: Spacing.two,
  },
  categoryChips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.two,
  },
  categoryChip: {
    minHeight: 44,
    paddingHorizontal: Spacing.three,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: Spacing.two,
  },
});
