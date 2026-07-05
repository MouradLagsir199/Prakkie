import { StyleSheet, Text, View } from 'react-native';
import { colors, radius, type } from '../../theme/tokens';

function formatEuroCents(cents: number): string {
  const euros = Math.floor(cents / 100);
  const rest = cents % 100;
  return `€ ${euros},${String(rest).padStart(2, '0')}`;
}

/** "€ 1,85 p.p." pill — pale-green background, green bold text (mockup 01). */
export function PricePill({ cents }: { cents: number }) {
  return (
    <View style={styles.pricePill}>
      <Text style={[type.badge, { color: colors.primary }]}>{formatEuroCents(cents)} p.p.</Text>
    </View>
  );
}

/** Yellow "Bonus-tip" badge overlaid on the card photo (mockup 01). */
export function BonusBadge({ label = 'Bonus-tip' }: { label?: string }) {
  return (
    <View style={styles.bonusBadge}>
      <Text style={[type.badge, { color: colors.bonusText }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pricePill: {
    backgroundColor: colors.badgeBg,
    borderRadius: radius.pill,
    paddingHorizontal: 8,
    paddingVertical: 3,
    alignSelf: 'flex-start',
  },
  bonusBadge: {
    backgroundColor: colors.bonus,
    borderRadius: radius.pill,
    paddingHorizontal: 8,
    paddingVertical: 3,
    alignSelf: 'flex-start',
  },
});
