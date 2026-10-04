import { useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { KeyboardAvoidingView, Platform, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { PrimaryButton } from '@/components/primary-button';
import { TextField } from '@/components/text-field';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { MaxContentWidth, Spacing } from '@/constants/theme';
import { createTrip } from '@/services/trips';

type Status = 'idle' | 'submitting' | 'error';

// Plain `YYYY-MM-DD` check — matches the Postgres `date` column's expected
// format. Not a full calendar picker (not asked for yet per the roadmap);
// this just turns a malformed date into a clear inline error instead of a
// raw Postgres error after a round trip.
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function validateDate(label: string, value: string): string | null {
  if (value.trim().length === 0) return null;
  return DATE_PATTERN.test(value.trim()) ? null : `${label} should look like YYYY-MM-DD.`;
}

export default function NewTripScreen() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [destination, setDestination] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const canSubmit = name.trim().length > 0 && status !== 'submitting';

  const handleCreate = useCallback(() => {
    const trimmedName = name.trim();
    if (trimmedName.length === 0) return;

    const startDateError = validateDate('Start date', startDate);
    const endDateError = validateDate('End date', endDate);
    const dateError = startDateError ?? endDateError;
    if (dateError) {
      setStatus('error');
      setErrorMessage(dateError);
      return;
    }

    setStatus('submitting');
    setErrorMessage(null);

    createTrip({
      name: trimmedName,
      destination: destination.trim() || null,
      start_date: startDate.trim() || null,
      end_date: endDate.trim() || null,
    })
      .then((trip) => {
        // `replace`, not `push`: the empty form shouldn't sit in the back
        // stack between the trip list and the trip that was just created.
        router.replace(`/trip/${trip.id}`);
      })
      .catch((err: unknown) => {
        setErrorMessage(err instanceof Error ? err.message : 'Something went wrong.');
        setStatus('error');
      });
  }, [name, destination, startDate, endDate, router]);

  return (
    <ThemedView style={styles.container}>
      <SafeAreaView style={styles.safeArea} edges={['bottom', 'left', 'right']}>
        <KeyboardAvoidingView
          style={styles.flex}
          behavior={Platform.select({ ios: 'padding', default: undefined })}>
          <ThemedView style={styles.form}>
            <TextField label="Name" value={name} onChangeText={setName} placeholder="Tokyo 2026" autoFocus />

            <TextField
              label="Destination (optional)"
              value={destination}
              onChangeText={setDestination}
              placeholder="Tokyo, Japan"
            />

            <TextField
              label="Start date (optional)"
              value={startDate}
              onChangeText={setStartDate}
              placeholder="YYYY-MM-DD"
              autoCorrect={false}
            />

            <TextField
              label="End date (optional)"
              value={endDate}
              onChangeText={setEndDate}
              placeholder="YYYY-MM-DD"
              autoCorrect={false}
            />

            {status === 'error' && errorMessage && (
              <ThemedText type="small" themeColor="textSecondary">
                {errorMessage}
              </ThemedText>
            )}

            <PrimaryButton
              label="Create trip"
              onPress={handleCreate}
              disabled={!canSubmit}
              loading={status === 'submitting'}
            />
          </ThemedView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  flex: {
    flex: 1,
  },
  safeArea: {
    flex: 1,
  },
  form: {
    flex: 1,
    alignSelf: 'center',
    width: '100%',
    maxWidth: MaxContentWidth,
    paddingHorizontal: Spacing.four,
    paddingTop: Spacing.four,
    gap: Spacing.three,
  },
});
