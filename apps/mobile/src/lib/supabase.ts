/**
 * Single shared Supabase client for the app.
 *
 * Reads the project URL and anon (public) key from env vars rather than
 * hardcoding them. `EXPO_PUBLIC_*` vars are inlined into the JS bundle at
 * build time and ship inside the installed app — fine for the anon key
 * (it's meant to be public and relies on RLS, not secrecy), never for a
 * service role key or any other secret.
 *
 * `auth.persistSession: false` is temporary: there's no Supabase Auth yet
 * (that's roadmap step 5), so there's no session to persist. Step 5 should
 * revisit this and add a `storage` adapter (e.g.
 * `@react-native-async-storage/async-storage`) so sessions survive an app
 * restart, per "Learn: sessions, auth state..." in that step.
 */
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
    persistSession: false,
  },
});
