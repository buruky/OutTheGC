import { Link, Stack } from 'expo-router';
import { useCallback, useState } from 'react';
import { KeyboardAvoidingView, Platform, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { PrimaryButton } from '@/components/primary-button';
import { TextField } from '@/components/text-field';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { MaxContentWidth, Spacing } from '@/constants/theme';
import { signUpWithEmail } from '@/services/auth';

type Status = 'idle' | 'submitting' | 'error' | 'submitted';

export default function SignUpScreen() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const canSubmit = email.trim().length > 0 && password.length >= 6 && status !== 'submitting';

  const handleSignUp = useCallback(() => {
    setStatus('submitting');
    setErrorMessage(null);

    // The project requires email confirmation, so this does NOT sign the
    // user in — there's no session yet. Success here just means the account
    // was created; the "ready" state below, not a redirect, reflects that.
    signUpWithEmail(email.trim(), password)
      .then(() => setStatus('submitted'))
      .catch((err: unknown) => {
        setErrorMessage(err instanceof Error ? err.message : 'Something went wrong.');
        setStatus('error');
      });
  }, [email, password]);

  if (status === 'submitted') {
    return (
      <ThemedView style={styles.container}>
        <Stack.Screen options={{ headerShown: false }} />
        <SafeAreaView style={[styles.safeArea, styles.centered]}>
          <ThemedText type="title" style={styles.centerText}>
            Check your email
          </ThemedText>
          <ThemedText type="default" themeColor="textSecondary" style={styles.centerText}>
            We sent a confirmation link to {email.trim()}. Click it, then come back and sign in.
          </ThemedText>
          <Link href="/(auth)" accessibilityLabel="Back to sign in">
            <ThemedText type="linkPrimary">Back to sign in</ThemedText>
          </Link>
        </SafeAreaView>
      </ThemedView>
    );
  }

  return (
    <ThemedView style={styles.container}>
      <SafeAreaView style={styles.safeArea}>
        <KeyboardAvoidingView
          style={styles.flex}
          behavior={Platform.select({ ios: 'padding', default: undefined })}>
          <ThemedView style={styles.form}>
            <ThemedText type="title">Create account</ThemedText>

            <TextField
              label="Email"
              value={email}
              onChangeText={setEmail}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
              textContentType="emailAddress"
              autoComplete="email"
              placeholder="you@example.com"
            />

            <TextField
              label="Password"
              value={password}
              onChangeText={setPassword}
              secureTextEntry
              textContentType="newPassword"
              autoComplete="new-password"
              placeholder="At least 6 characters"
            />

            {status === 'error' && errorMessage && (
              <ThemedText type="small" themeColor="textSecondary">
                {errorMessage}
              </ThemedText>
            )}

            <PrimaryButton
              label="Create account"
              onPress={handleSignUp}
              disabled={!canSubmit}
              loading={status === 'submitting'}
            />

            <Link href="/(auth)" accessibilityLabel="Go to sign in">
              <ThemedText type="linkPrimary">Already have an account? Sign in</ThemedText>
            </Link>
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
    justifyContent: 'center',
    alignSelf: 'center',
    width: '100%',
    maxWidth: MaxContentWidth,
    paddingHorizontal: Spacing.four,
    gap: Spacing.three,
  },
});
