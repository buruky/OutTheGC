import { StyleSheet, TextInput, type TextInputProps } from 'react-native';

import { ThemedText } from './themed-text';
import { ThemedView } from './themed-view';

import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

type TextFieldProps = TextInputProps & {
  label: string;
};

/** Labeled text input themed for light/dark, shared by the sign-in/sign-up forms. */
export function TextField({ label, style, ...rest }: TextFieldProps) {
  const theme = useTheme();

  return (
    <ThemedView style={styles.container}>
      <ThemedText type="smallBold">{label}</ThemedText>
      <TextInput
        style={[styles.input, { color: theme.text, backgroundColor: theme.backgroundElement }, style]}
        placeholderTextColor={theme.textSecondary}
        accessibilityLabel={label}
        {...rest}
      />
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: Spacing.one,
  },
  input: {
    borderRadius: Spacing.two,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    fontSize: 16,
    minHeight: 44,
  },
});
