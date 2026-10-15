import { getShareExtensionKey } from 'expo-share-intent';

/**
 * Expo Router's hook for native deeplinks that aren't ordinary app URLs.
 * This `dataUrl=<key>` redirect is `expo-share-intent`'s iOS-only mechanism
 * (confirmed in its own source: `useShareIntent.js` labels that exact
 * `url.includes(...)` check "// iOS only", and the Android native module
 * fires its share event straight from `OnCreate`/`OnNewIntent` with no
 * deeplink URL at all) — a share extension there is a separate process that
 * has to hand data back to the main app somehow, so it does it via a
 * deeplink the main app reopens on. Android currently has `disableIOS: true`
 * in app.json, so this never actually matches today; it's a no-op kept
 * ready for whenever an Apple Developer account exists and iOS is turned
 * on. Android's own "a share arrived" hook is the effect in
 * `RootNavigator` (`src/app/_layout.tsx`), not this file.
 */
export function redirectSystemPath({ path }: { path: string; initial: boolean }) {
  try {
    if (path.includes(`dataUrl=${getShareExtensionKey()}`)) return '/share-intent';
    return path;
  } catch {
    return '/';
  }
}
