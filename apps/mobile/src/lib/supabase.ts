/**
 * Single shared Supabase client for the app.
 *
 * Reads the project URL and anon (public) key from env vars rather than
 * hardcoding them. `EXPO_PUBLIC_*` vars are inlined into the JS bundle at
 * build time and ship inside the installed app — fine for the anon key
 * (it's meant to be public and relies on RLS, not secrecy), never for a
 * service role key or any other secret.
 *
 * Auth (step 5): sessions persist across app restarts via AsyncStorage
 * (Expo's blessed key-value storage, works in Expo Go — no native config
 * needed) and refresh themselves automatically while the app is open.
 * `detectSessionInUrl: false` because that option is for parsing an OAuth
 * redirect out of a browser URL on web; there's no URL to parse on native,
 * and leaving it on can throw trying to read `window.location`.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    'Missing EXPO_PUBLIC_SUPABASE_URL or EXPO_PUBLIC_SUPABASE_ANON_KEY. Check apps/mobile/.env.local.',
  );
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    storage: AsyncStorage,
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false,
  },
});
