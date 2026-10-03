import { ActivityIndicator, Pressable, StyleSheet, type GestureResponderEvent } from 'react-native';

import { ThemedText } from './themed-text';

import { Spacing } from '@/constants/theme';

type PrimaryButtonProps = {
  label: string;
  onPress: (event: GestureResponderEvent) => void;
  disabled?: boolean;
  loading?: boolean;
  accessibilityLabel?: string;
};

/** Filled action button (sign in / sign up) — `linkPrimary`'s blue (`#3c87f7`), matching the existing accent color. */
export function PrimaryButton({ label, onPress, disabled, loading, accessibilityLabel }: PrimaryButtonProps) {
  const isDisabled = disabled || loading;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: isDisabled, busy: loading }}
      disabled={isDisabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        isDisabled && styles.disabled,
        pressed && !isDisabled && styles.pressed,
      ]}>
      {loading ? <ActivityIndicator color="#ffffff" /> : <ThemedText style={styles.label}>{label}</ThemedText>}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    backgroundColor: '#3c87f7',
    borderRadius: Spacing.two,
    paddingVertical: Spacing.three,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 44,
  },
  disabled: {
    opacity: 0.5,
  },
  pressed: {
    opacity: 0.8,
  },
  label: {
    color: '#ffffff',
  },
});
