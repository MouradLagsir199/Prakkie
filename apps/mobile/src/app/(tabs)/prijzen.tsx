import { CHAINS, formatEuroCents, type ChainId } from '@prakkie/shared';
import { RefreshCw } from 'lucide-react-native';
import { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ScreenHeader } from '../../components/prakkie/ScreenHeader';
import { useEntityRows } from '../../data';
import { authedRequest } from '../../data/api';
import { colors, radius, type } from '../../theme/tokens';

interface ChainPricing {
  chain_id: string;
  total_cents: number;
  promo_savings_cents: number;
  matched: number;
  unmatched: string[];
  full_assortment: boolean;
  staleness: string | null;
}

interface CompareResult {
  home_chain: string;
  ranked: ChainPricing[];
  partial: ChainPricing[];
  cheapest_chain: string | null;
  insight: { savings_cents: number; driving_items: { name: string; delta_cents: number }[] } | null;
}

const chainName = (id: string) => (CHAINS as Record<string, { displayName?: string }>)[id as ChainId]?.displayName ?? id.toUpperCase();

/** Prijzen — mockup 07: ranked chains, voordeligst/jouw winkel, honest gaps, staleness, F4 insight. */
export default function PrijzenScreen() {
  const insets = useSafeAreaInsets();
  const { rows: lists } = useEntityRows('lists');
  const [result, setResult] = useState<CompareResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const list = lists[0] ?? null;

  const load = useCallback(async () => {
    if (!list) return;
    setBusy(true);
    setError(null);
    try {
      const res = await authedRequest(`/v1/lists/${list.id}/compare`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setResult((await res.json()) as CompareResult);
    } catch {
      setError('Prijzen niet beschikbaar — controleer je verbinding.');
    } finally {
      setBusy(false);
    }
  }, [list?.id]);

  useEffect(() => {
    load();
  }, [load]);

  const staleness = result?.ranked[0]?.staleness ?? result?.partial[0]?.staleness;
  const stalenessLabel = staleness
    ? `prijzen van ${new Date(staleness).toLocaleDateString('nl-NL', { day: 'numeric', month: 'long' })}`
    : undefined;

  return (
    <View style={[styles.screen, { paddingTop: insets.top + 8 }]}>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <ScreenHeader title="Prijzen" contextLine={stalenessLabel ?? 'vergelijk je lijst per super'} />

        {!list ? (
          <Text style={[type.meta, styles.center]}>Maak eerst een boodschappenlijst — dan vergelijken we hier de supers.</Text>
        ) : error ? (
          <Text style={[type.meta, styles.center]}>{error}</Text>
        ) : !result ? (
          <Text style={[type.meta, styles.center]}>{busy ? 'Prijzen vergelijken…' : ''}</Text>
        ) : (
          <>
            {result.insight && result.insight.savings_cents > 0 ? (
              <View style={styles.insightCard}>
                <Text style={type.h3}>
                  {formatEuroCents(result.insight.savings_cents)} besparen bij {chainName(result.cheapest_chain ?? '')}
                </Text>
                <Text style={type.meta}>
                  Grootste verschil: {result.insight.driving_items.map((d) => `${d.name} (${formatEuroCents(d.delta_cents)})`).join(' · ')}
                </Text>
              </View>
            ) : null}

            {result.ranked.map((chain, i) => (
              <View key={chain.chain_id} style={[styles.chainRow, i === 0 && styles.chainBest]}>
                <View style={{ flex: 1 }}>
                  <Text style={type.h3}>
                    {chainName(chain.chain_id)}{' '}
                    {i === 0 ? <Text style={[type.badge, { color: colors.primary }]}>voordeligst</Text> : null}
                    {chain.chain_id === result.home_chain ? (
                      <Text style={[type.badge, { color: colors.textMuted }]}> · jouw winkel</Text>
                    ) : null}
                  </Text>
                  {chain.promo_savings_cents > 0 ? (
                    <Text style={type.meta}>waarvan {formatEuroCents(chain.promo_savings_cents)} bonusvoordeel</Text>
                  ) : null}
                </View>
                <Text style={type.h3}>{formatEuroCents(chain.total_cents)}</Text>
              </View>
            ))}

            {result.partial.length ? (
              <>
                <Text style={[type.badge, { color: colors.textMuted2, letterSpacing: 1, marginTop: 8 }]}>
                  NIET COMPLEET — EERLIJK VERGELIJKEN LUKT HIER NIET
                </Text>
                {result.partial.map((chain) => (
                  <View key={chain.chain_id} style={[styles.chainRow, { opacity: 0.75 }]}>
                    <View style={{ flex: 1 }}>
                      <Text style={type.h3}>{chainName(chain.chain_id)}</Text>
                      <Text style={type.meta}>
                        {chain.unmatched.length
                          ? `${chain.unmatched.length} item(s) niet in assortiment`
                          : 'gedeeltelijk assortiment'}
                      </Text>
                    </View>
                    <Text style={type.h3}>{formatEuroCents(chain.total_cents)}+</Text>
                  </View>
                ))}
              </>
            ) : null}

            <Pressable style={styles.refresh} onPress={load}>
              <RefreshCw size={16} color={colors.primary} />
              <Text style={[type.chip, { color: colors.primary }]}>{busy ? 'Bezig…' : 'Ververs prijzen'}</Text>
            </Pressable>
          </>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { paddingHorizontal: 16, paddingBottom: 140, gap: 10 },
  center: { textAlign: 'center', marginTop: 40 },
  insightCard: {
    backgroundColor: colors.badgeBg, borderRadius: radius.card, padding: 16, gap: 4,
    borderWidth: 1, borderColor: colors.primary,
  },
  chainRow: {
    flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: colors.surface,
    borderRadius: radius.card, padding: 16, borderWidth: 1, borderColor: colors.borderSubtle,
  },
  chainBest: { borderColor: colors.primary, borderWidth: 2 },
  refresh: { flexDirection: 'row', gap: 8, alignItems: 'center', justifyContent: 'center', padding: 12 },
});
