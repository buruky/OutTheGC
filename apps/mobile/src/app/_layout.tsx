import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { ActivityIndicator, StyleSheet, useColorScheme } from 'react-native';

import { AnimatedSplashOverlay } from '@/components/animated-icon';
import { ThemedView } from '@/components/themed-view';
import { AuthProvider, useAuth } from '@/hooks/use-auth';

SplashScreen.preventAutoHideAsync();

// The (tabs) group owns the tab bar (Trips/Profile). trip/[id] is pushed on
// top of it as a plain stack screen so it gets a header with a working back
// button/gesture instead of living inside the tab bar. Both only exist for
// signed-in users — `Stack.Protected`'s `guard` conditionally includes a
// screen group and auto-redirects to whichever group's guard is true, so
// signing out (session becomes null) kicks the user back to (auth)
// automatically with no manual navigation call needed.
function RootNavigator() {
  const { session, status } = useAuth();

  // Checking AsyncStorage for a persisted session is asynchronous — this
  // keeps that moment as its own state instead of rendering the (auth)
  // group (and flashing the sign-in screen) before a valid session is found.
  if (status === 'loading') {
    return (
      <ThemedView style={styles.loading}>
        <ActivityIndicator accessibilityLabel="Checking sign-in status" />
      </ThemedView>
    );
  }

  return (
    <Stack>
      <Stack.Protected guard={!!session}>
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="trip/[id]" />
        <Stack.Screen name="trip/new" options={{ title: 'New trip', presentation: 'modal' }} />
      </Stack.Protected>

      <Stack.Protected guard={!session}>
        <Stack.Screen name="(auth)" options={{ headerShown: false }} />
      </Stack.Protected>
    </Stack>
  );
}

export default function RootLayout() {
  const colorScheme = useColorScheme();
  return (
    <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
      <AnimatedSplashOverlay />
      <AuthProvider>
        <RootNavigator />
      </AuthProvider>
    </ThemeProvider>
  );
}

const styles = StyleSheet.create({
  loading: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
