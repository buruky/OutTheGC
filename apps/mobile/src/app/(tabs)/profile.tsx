import { useCallback, useState } from 'react';
import { StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { PrimaryButton } from '@/components/primary-button';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { useAuth } from '@/hooks/use-auth';
import { signOut } from '@/services/auth';

export default function ProfileScreen() {
  const { session } = useAuth();
  const [signingOut, setSigningOut] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // No navigation on success: clearing the session fires `onAuthStateChange`
  // (src/hooks/use-auth.tsx), and the root layout's `Stack.Protected` swaps
  // to the (auth) group on its own.
  const handleSignOut = useCallback(() => {
    setSigningOut(true);
    setErrorMessage(null);
    signOut().catch((err: unknown) => {
      setErrorMessage(err instanceof Error ? err.message : 'Something went wrong.');
      setSigningOut(false);
    });
  }, []);

  return (
    <ThemedView style={styles.container}>
      <SafeAreaView style={styles.safeArea}>
        <ThemedText type="title">Profile</ThemedText>
        {session?.user.email && (
          <ThemedText type="default" themeColor="textSecondary">
            {session.user.email}
          </ThemedText>
        )}

        <ThemedView style={styles.signOut}>
          {errorMessage && (
            <ThemedText type="small" themeColor="textSecondary">
              {errorMessage}
            </ThemedText>
          )}
          <PrimaryButton label="Sign out" onPress={handleSignOut} loading={signingOut} />
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
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.two,
  },
  signOut: {
    marginTop: Spacing.four,
    width: '100%',
    paddingHorizontal: Spacing.four,
    gap: Spacing.two,
  },
});
