/**
 * Supabase Auth calls, centralized here for the same reason as
 * `services/trips.ts`: screens shouldn't hand-roll their own
 * `supabase.auth.*` calls.
 *
 * The project requires email confirmation (deliberate choice, see
 * CLAUDE.md), so `signUpWithEmail` does NOT return a signed-in session —
 * only `signInWithEmail` (after the user clicks the confirmation link)
 * does. Callers must not treat a successful signup as a successful login.
 */
import { isAuthApiError } from '@supabase/supabase-js';

import { supabase } from '@/lib/supabase';

export async function signUpWithEmail(email: string, password: string): Promise<void> {
  const { error } = await supabase.auth.signUp({ email, password });
  if (error) throw error;
}

export async function signInWithEmail(email: string, password: string): Promise<void> {
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
}

export async function signOut(): Promise<void> {
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}

/** Re-sends the "confirm your account" email, for when sign-in fails with `isEmailNotConfirmedError`. */
export async function resendConfirmationEmail(email: string): Promise<void> {
  const { error } = await supabase.auth.resend({ type: 'signup', email });
  if (error) throw error;
}

/**
 * True when `error` is Supabase's "you haven't clicked the confirmation
 * link yet" error, as opposed to a wrong password or any other failure.
 * Checked by `error.code` (a stable machine-readable string) rather than
 * `error.message` (user-facing text that could change wording).
 */
export function isEmailNotConfirmedError(error: unknown): boolean {
  return isAuthApiError(error) && error.code === 'email_not_confirmed';
}
