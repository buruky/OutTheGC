import { DarkTheme, DefaultTheme, Stack, ThemeProvider, useRouter } from 'expo-router';
import { ShareIntentProvider, useShareIntentContext } from 'expo-share-intent';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect } from 'react';
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
  const router = useRouter();
  const { hasShareIntent, shareIntent } = useShareIntentContext();

  // Android has no `dataUrl=` deeplink to redirect on (that handoff is
  // iOS-only — the native module fires straight into `shareIntent` context
  // state via its own event emitter on both cold start and resume, with no
  // URL involved at all; see `+native-intent.ts`'s comment). This is the
  // Android-side arrival hook instead, mirroring the library's own
  // expo-router example (example/expo-router/app/index.tsx): react to
  // `shareIntent` changing rather than any router path. Depends on
  // `shareIntent` itself (not just `hasShareIntent`) so a second share while
  // the first is still unresolved re-navigates too, since `hasShareIntent`
  // alone would stay `true` across both and never retrigger this effect.
  useEffect(() => {
    if (session && hasShareIntent) router.replace('/share-intent');
  }, [session, hasShareIntent, shareIntent, router]);

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
        <Stack.Screen name="join" options={{ title: 'Join a trip', presentation: 'modal' }} />
        <Stack.Screen name="join/[code]" options={{ title: 'Join a trip', presentation: 'modal' }} />
        <Stack.Screen name="share-intent" options={{ title: 'Add to a trip', presentation: 'modal' }} />
      </Stack.Protected>

      <Stack.Protected guard={!session}>
        <Stack.Screen name="(auth)" options={{ headerShown: false }} />
      </Stack.Protected>
    </Stack>
  );
}

export default function RootLayout() {
  const colorScheme = useColorScheme();
  const router = useRouter();
  return (
    <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
      <AnimatedSplashOverlay />
      {/* Step 16: makes a shared TikTok link available to JS via
          useShareIntentContext — see src/app/share-intent.tsx (the
          destination) and the navigation effect in RootNavigator below (how
          Android gets routed there; +native-intent.ts's deeplink redirect is
          iOS-only, see its own comment). resetOnBackground clears the intent
          once the user leaves the app mid-flow, sending them back to the
          trip list instead of re-triggering the same share on next resume. */}
      <ShareIntentProvider
        options={{
          resetOnBackground: true,
          onResetShareIntent: () => router.replace('/(tabs)'),
        }}>
        <AuthProvider>
          <RootNavigator />
        </AuthProvider>
      </ShareIntentProvider>
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
