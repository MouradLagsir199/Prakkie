import { LinearGradient } from 'expo-linear-gradient';
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { colors, fonts, gradients, radius, shadows } from '../../theme/tokens';

/**
 * Primary gradient CTA — REDESIGN 1a/1b/1c: subtle top-lit green gradient,
 * radius 17, inset top highlight, big soft green shadow.
 */
export function CTAButton({
  label,
  icon,
  onPress,
  disabled,
  style,
}: {
  label: string;
  icon?: ReactNode;
  onPress?: () => void;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [styles.wrap, disabled && styles.disabled, pressed && styles.pressed, style]}
    >
      <LinearGradient
        colors={gradients.primary}
        start={{ x: 0.2, y: 0 }}
        end={{ x: 0.5, y: 1 }}
        style={styles.inner}
      >
        <View style={styles.highlight} pointerEvents="none" />
        {icon}
        <Text style={styles.label}>{label}</Text>
      </LinearGradient>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrap: {
    borderRadius: radius.cta,
    ...shadows.cta,
  },
  inner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 9,
    borderRadius: radius.cta,
    paddingVertical: 15,
    paddingHorizontal: 20,
    overflow: 'hidden',
  },
  highlight: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 1.5,
    backgroundColor: 'rgba(255,255,255,0.22)',
  },
  label: {
    fontFamily: fonts.bodySemiBold,
    fontSize: 15,
    color: colors.onPrimary,
  },
  pressed: {
    opacity: 0.88,
  },
  disabled: {
    opacity: 0.45,
  },
});
