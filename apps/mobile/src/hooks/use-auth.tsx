/**
 * Tracks the current Supabase auth session for the whole app.
 *
 * `getSession()` reads whatever was restored from AsyncStorage on launch
 * (resolves once, synchronously-ish after startup) and
 * `onAuthStateChange` fires after that for every later change (sign in,
 * sign out, token refresh). Both are needed: the first gives us the
 * already-persisted session without waiting on a network round trip, the
 * second keeps us in sync afterwards. `status` separates "still checking
 * for a persisted session" from "checked, and there isn't one" so the
 * root layout can show a loading state instead of flashing the sign-in
 * screen before a valid session is found.
 */
import type { Session } from '@supabase/supabase-js';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

import { supabase } from '@/lib/supabase';

type AuthContextValue = {
  session: Session | null;
  status: 'loading' | 'ready';
};

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready'>('loading');

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setStatus('ready');
    });

    const { data: subscription } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      setStatus('ready');
    });

    return () => subscription.subscription.unsubscribe();
  }, []);

  return <AuthContext.Provider value={{ session, status }}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within an AuthProvider.');
  return context;
}
