import { ScrollView, StyleSheet, Text, Pressable } from 'react-native';
import { colors, fonts, radius, type } from '../../theme/tokens';

export interface Chip {
  key: string;
  label: string;
}

/** Horizontally scrolling collection chips — active chip green with count (mockup 01). */
export function ChipRow({
  chips,
  activeKey,
  onSelect,
}: {
  chips: Chip[];
  activeKey: string;
  onSelect: (key: string) => void;
}) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row}>
      {chips.map((chip) => {
        const active = chip.key === activeKey;
        return (
          <Pressable
            key={chip.key}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            onPress={() => onSelect(chip.key)}
            style={[styles.chip, active && styles.chipActive]}
          >
            <Text style={[type.chip, active && styles.chipTextActive]}>{chip.label}</Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  row: {
    gap: 8,
    paddingRight: 16,
  },
  chip: {
    backgroundColor: colors.surface,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.borderControl,
    paddingHorizontal: 13,
    paddingVertical: 8,
  },
  chipActive: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  chipTextActive: {
    color: colors.onPrimary,
    fontFamily: fonts.bodySemiBold,
  },
});
