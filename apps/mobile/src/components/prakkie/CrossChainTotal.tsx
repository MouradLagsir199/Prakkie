import { formatEuroCents } from '@prakkie/shared';
import { Sparkles } from 'lucide-react-native';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { chainName } from '../../data/chains';
import { planHasMatches, type BasketPlan } from '../../data/basket-plan';
import { colors, fonts, radius, shadows } from '../../theme/tokens';
import { ChainLogo } from './ChainLogo';

/**
 * Matching v2 (docs/09 Fase 5): het directe cross-supermarkt totaal + de
 * basket-optimizer (goedkoopste winkel / verdeel-besparing) en een korte
 * "nog te kiezen"-telling. Read-only naast de handmatige samenstelling; toont
 * niets zolang er nog geen gematchte regels zijn (backfill in uitvoering).
 */
export function CrossChainTotal({ plan }: { plan: BasketPlan | null }) {
  if (!planHasMatches(plan)) return null;
  const opt = plan!.optimizer;
  const totals = [...plan!.chain_totals].sort((a, b) => a.missing - b.missing || a.total_cents - b.total_cents);
  const savings = opt.savings_vs_single_cents;

  return (
    <View style={styles.card}>
      <View style={styles.headerRow}>
        <Sparkles size={15} color={colors.primary} strokeWidth={2.2} />
        <Text style={styles.title}>Direct totaal per super</Text>
        <Text style={styles.beta}>bèta</Text>
      </View>

      {opt.cheapest_single ? (
        <Text style={styles.lead}>
          Goedkoopst bij <Text style={styles.leadStrong}>{chainName(opt.cheapest_single.chain_id)}</Text>
          {'  '}<Text style={styles.leadStrong}>{formatEuroCents(opt.cheapest_single.total_cents)}</Text>
          {opt.cheapest_single.missing > 0 ? ` · ${opt.cheapest_single.missing} te kiezen` : ''}
        </Text>
      ) : null}

      {savings > 0 && opt.split ? (
        <Text style={styles.savings}>
          Verdeel over supers → bespaar {formatEuroCents(savings)}
        </Text>
      ) : null}

      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.bleed} contentContainerStyle={styles.chipRow}>
        {totals.map((t) => (
          <View key={t.chain_id} style={[styles.chip, t.complete && styles.chipComplete]}>
            <ChainLogo id={t.chain_id} size={18} />
            <Text style={styles.chipTotal}>{formatEuroCents(t.total_cents)}</Text>
            <Text style={styles.chipMeta}>{t.complete ? 'compleet' : `${t.missing} te kiezen`}</Text>
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface, borderRadius: radius.lg, borderWidth: 1,
    borderColor: colors.borderSubtle, padding: 14, gap: 8, ...shadows.card,
  },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  title: { fontSize: 14, fontFamily: fonts.bodySemiBold, color: colors.text, flex: 1 },
  beta: { fontSize: 10, fontFamily: fonts.bodyBold, color: colors.primary, backgroundColor: colors.badgeBg, borderRadius: radius.pill, paddingHorizontal: 7, paddingVertical: 2 },
  lead: { fontSize: 13, fontFamily: fonts.body, color: colors.text },
  leadStrong: { fontFamily: fonts.bodyBold, color: colors.primary },
  savings: { fontSize: 12.5, fontFamily: fonts.bodySemiBold, color: colors.primary },
  bleed: { marginHorizontal: -14 },
  chipRow: { paddingHorizontal: 14, gap: 8, flexDirection: 'row' },
  chip: {
    flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: colors.surfaceMuted,
    borderRadius: radius.pill, paddingVertical: 6, paddingHorizontal: 11, borderWidth: 1, borderColor: colors.borderControl,
  },
  chipComplete: { backgroundColor: colors.badgeBg, borderColor: 'rgba(46,107,62,.25)' },
  chipTotal: { fontSize: 13, fontFamily: fonts.bodyBold, color: colors.text },
  chipMeta: { fontSize: 10.5, fontFamily: fonts.bodyMedium, color: colors.textMuted2 },
});
