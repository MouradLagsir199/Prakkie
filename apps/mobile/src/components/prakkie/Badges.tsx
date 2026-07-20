import { StyleSheet, Text, View } from 'react-native';
import { colors, radius, type } from '../../theme/tokens';

function formatEuroCents(cents: number): string {
  const euros = Math.floor(cents / 100);
  const rest = cents % 100;
  return `€ ${euros},${String(rest).padStart(2, '0')}`;
}

/**
 * "€ 1,85 p.p." pill — REDESIGN 1a: on photos a frosted-cream chip, in
 * content flow the pale-green variant.
 */
export function PricePill({ cents, onPhoto }: { cents: number; onPhoto?: boolean }) {
  return (
    <View style={[styles.pricePill, onPhoto && styles.pricePillPhoto]}>
      <Text style={[type.badge, { color: colors.primary }]}>{formatEuroCents(cents)} p.p.</Text>
    </View>
  );
}

/** Yellow "Bonus-tip" badge overlaid on the card photo. */
export function BonusBadge({ label = 'Bonus-tip' }: { label?: string }) {
  return (
    <View style={styles.bonusBadge}>
      <Text style={[type.badge, { fontSize: 9.5, color: colors.bonusText }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pricePill: {
    backgroundColor: colors.badgeBg,
    borderRadius: radius.pill,
    paddingHorizontal: 9,
    paddingVertical: 4,
    alignSelf: 'flex-start',
  },
  pricePillPhoto: {
    backgroundColor: 'rgba(253,251,246,0.9)',
  },
  bonusBadge: {
    backgroundColor: colors.bonus,
    borderRadius: radius.pill,
    paddingHorizontal: 8,
    paddingVertical: 4,
    alignSelf: 'flex-start',
  },
});
