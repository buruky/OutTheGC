import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { KeyboardAvoidingView, Platform, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { PrimaryButton } from '@/components/primary-button';
import { TextField } from '@/components/text-field';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { MaxContentWidth, Spacing } from '@/constants/theme';
import { joinTripByCode } from '@/services/trips';

type Status = 'idle' | 'submitting' | 'error' | 'success';

/**
 * Postgres SQLSTATE `22023` ("invalid_parameter_value") is how
 * `join_trip_by_code` signals "no trip has this code" — see the comment
 * above the function in
 * `supabase/migrations/20261005235900_add_invite_code_and_join_function.sql`.
 * supabase-js surfaces it as `error.code`, so this checks that field
 * directly instead of matching on the (unstable) message text.
 */
function isInvalidCodeError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === '22023';
}

/**
 * Shared by both `/join` (blank code field) and `/join/[code]` (pre-filled
 * from a tapped invite link). `src/app/join/[code].tsx` re-exports this
 * component as its default export, so `useLocalSearchParams` below reads
 * whichever route actually matched: `{}` on plain `/join`, or `{ code }` on
 * `/join/<code>`. One screen, no duplicated UI or submit logic.
 */
export default function JoinTripScreen() {
  const router = useRouter();
  const { code: codeParam } = useLocalSearchParams<{ code?: string }>();
  const [code, setCode] = useState(codeParam ?? '');
  const [status, setStatus] = useState<Status>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [resultMessage, setResultMessage] = useState<string | null>(null);
  const [joinedTripId, setJoinedTripId] = useState<string | null>(null);

  const canSubmit = code.trim().length > 0 && status !== 'submitting';

  const handleJoin = useCallback(() => {
    const trimmed = code.trim();
    if (trimmed.length === 0) return;

    setStatus('submitting');
    setErrorMessage(null);

    joinTripByCode(trimmed)
      .then((result) => {
        setResultMessage(
          result.already_member ? `You're already in ${result.trip_name}.` : `You joined ${result.trip_name}.`,
        );
        setJoinedTripId(result.trip_id);
        setStatus('success');
      })
      .catch((err: unknown) => {
        // Don't clear `code` on error — there's nothing destructive to
        // undo, and the user should be able to fix a typo without retyping
        // the whole thing.
        setErrorMessage(
          isInvalidCodeError(err)
            ? "That code doesn't look right."
            : err instanceof Error
              ? err.message
              : 'Something went wrong.',
        );
        setStatus('error');
      });
  }, [code]);

  // Let "you joined X" / "you're already in X" sit on screen for a beat
  // before moving on, instead of navigating out from under the message the
  // instant the request resolves.
  useEffect(() => {
    if (status !== 'success' || !joinedTripId) return;
    const timer = setTimeout(() => router.replace(`/trip/${joinedTripId}`), 900);
    return () => clearTimeout(timer);
  }, [status, joinedTripId, router]);

  if (status === 'success' && resultMessage) {
    return (
      <ThemedView style={styles.container}>
        <SafeAreaView style={[styles.safeArea, styles.centered]}>
          <ThemedText type="subtitle" style={styles.centerText}>
            {resultMessage}
          </ThemedText>
        </SafeAreaView>
      </ThemedView>
    );
  }

  return (
    <ThemedView style={styles.container}>
      <SafeAreaView style={styles.safeArea} edges={['bottom', 'left', 'right']}>
        <KeyboardAvoidingView
          style={styles.flex}
          behavior={Platform.select({ ios: 'padding', default: undefined })}>
          <ThemedView style={styles.form}>
            <ThemedText type="title">Join a trip</ThemedText>

            <TextField
              label="Invite code"
              value={code}
              onChangeText={setCode}
              placeholder="ABCD2345"
              autoCapitalize="characters"
              autoCorrect={false}
              autoFocus={!codeParam}
            />

            {status === 'error' && errorMessage && (
              <ThemedText type="small" themeColor="textSecondary">
                {errorMessage}
              </ThemedText>
            )}

            <PrimaryButton
              label="Join trip"
              onPress={handleJoin}
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
  centered: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.three,
    paddingHorizontal: Spacing.four,
  },
  centerText: {
    textAlign: 'center',
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
