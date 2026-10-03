import { Link } from 'expo-router';
import { useCallback, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { PrimaryButton } from '@/components/primary-button';
import { TextField } from '@/components/text-field';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { MaxContentWidth, Spacing } from '@/constants/theme';
import {
  isEmailNotConfirmedError,
  resendConfirmationEmail,
  signInWithEmail,
} from '@/services/auth';

type Status = 'idle' | 'submitting' | 'error';
type ResendStatus = 'idle' | 'sending' | 'sent' | 'error';

export default function SignInScreen() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // `null` until a sign-in attempt actually fails on this specific error, so
  // the resend action only ever shows next to that exact error message.
  const [emailNotConfirmed, setEmailNotConfirmed] = useState(false);
  const [resendStatus, setResendStatus] = useState<ResendStatus>('idle');

  const canSubmit = email.trim().length > 0 && password.length > 0 && status !== 'submitting';

  const handleSignIn = useCallback(() => {
    setStatus('submitting');
    setErrorMessage(null);
    setEmailNotConfirmed(false);
    setResendStatus('idle');

    // No navigation on success: `onAuthStateChange` (src/hooks/use-auth.tsx)
    // picks up the new session and the root layout's `Stack.Protected`
    // swaps to the (tabs) group on its own.
    signInWithEmail(email.trim(), password).catch((err: unknown) => {
      if (isEmailNotConfirmedError(err)) {
        setEmailNotConfirmed(true);
        setErrorMessage("You haven't confirmed your email yet. Check your inbox for the confirmation link.");
      } else {
        setErrorMessage(err instanceof Error ? err.message : 'Something went wrong.');
      }
      setStatus('error');
    });
  }, [email, password]);

  const handleResend = useCallback(() => {
    setResendStatus('sending');
    resendConfirmationEmail(email.trim())
      .then(() => setResendStatus('sent'))
      .catch(() => setResendStatus('error'));
  }, [email]);

  return (
    <ThemedView style={styles.container}>
      <SafeAreaView style={styles.safeArea}>
        <KeyboardAvoidingView
          style={styles.flex}
          behavior={Platform.select({ ios: 'padding', default: undefined })}>
          <ThemedView style={styles.form}>
            <ThemedText type="title">Sign in</ThemedText>

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
              textContentType="password"
              autoComplete="password"
              placeholder="••••••••"
            />

            {status === 'error' && errorMessage && (
              <ThemedView style={styles.errorBox}>
                <ThemedText type="small" themeColor="textSecondary">
                  {errorMessage}
                </ThemedText>
                {emailNotConfirmed && (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Resend confirmation email"
                    disabled={resendStatus === 'sending' || resendStatus === 'sent'}
                    onPress={handleResend}
                    style={({ pressed }) => pressed && styles.pressed}>
                    <ThemedText type="link" themeColor="textSecondary">
                      {resendStatus === 'sent'
                        ? 'Confirmation email resent — check your inbox.'
                        : resendStatus === 'sending'
                          ? 'Resending…'
                          : resendStatus === 'error'
                            ? "Couldn't resend — try again"
                            : 'Resend confirmation email'}
                    </ThemedText>
                  </Pressable>
                )}
              </ThemedView>
            )}

            <PrimaryButton
              label="Sign in"
              onPress={handleSignIn}
              disabled={!canSubmit}
              loading={status === 'submitting'}
            />

            <Link href="/(auth)/sign-up" accessibilityLabel="Go to create account">
              <ThemedText type="linkPrimary">Don&apos;t have an account? Create one</ThemedText>
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
  form: {
    flex: 1,
    justifyContent: 'center',
    alignSelf: 'center',
    width: '100%',
    maxWidth: MaxContentWidth,
    paddingHorizontal: Spacing.four,
    gap: Spacing.three,
  },
  errorBox: {
    gap: Spacing.one,
  },
  pressed: {
    opacity: 0.7,
  },
});
