import { Stack } from 'expo-router';

// Plain stack, no tab bar — this whole group only exists for signed-out
// users (gated by `Stack.Protected` in the root layout). `index` (sign in)
// is the landing screen; `sign-up` is pushed from the link on it.
export default function AuthLayout() {
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="sign-up" />
    </Stack>
  );
}
