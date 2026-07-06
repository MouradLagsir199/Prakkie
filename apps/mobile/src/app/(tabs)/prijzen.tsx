import { formatEuroCents } from '@prakkie/shared';
import { useRouter } from 'expo-router';
import { ChevronDown, ChevronRight, RefreshCw, TrendingDown } from 'lucide-react-native';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useEntityRows } from '../../data';
import { authedRequest } from '../../data/api';
import { CHAIN_BRAND, chainChip, chainName, mondayOf } from '../../data/chains';
import type { RecipeRowData } from '../../data/recipes';
import { colors, fonts, radius, type } from '../../theme/tokens';

/** Prijzen — mockup 07 1:1: "Jouw mandje per supermarkt" card with brand
 *  avatars + proportional bars, F4 insight strip, deals list, aanbiedingen-rail. */

interface ChainPricing {
  chain_id: string; total_cents: number; promo_savings_cents: number; matched: number;
  unmatched: string[]; full_assortment: boolean; staleness: string | null;
}
interface CompareResult {
  home_chain: string; ranked: ChainPricing[]; partial: ChainPricing[]; cheapest_chain: string | null;
  insight: { savings_cents: number; driving_items: { name: string; delta_cents: number }[] } | null;
}
interface Deal { chain_id: string; item: string; product_name?: string; promo?: { mechanic?: string; valid_to?: string } | null; savings_cents: number }

export default function PrijzenScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { rows: listRows } = useEntityRows('lists');
  const { rows: itemRows } = useEntityRows('list_items');
  const { rows: recipeRows } = useEntityRows('recipes');
  const [result, setResult] = useState<CompareResult | null>(null);
  const [deals, setDeals] = useState<Deal[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [railOpen, setRailOpen] = useState(false);

  // this week's list first, else the most recent one
  const weekStart = mondayOf(0);
  const list = useMemo(() => {
    const lists = listRows.map((r) => ({ id: r.id, ...(r.row as { name?: string; week_start?: string | null }) }));
    return lists.find((l) => (l.week_start ?? '').slice(0, 10) === weekStart) ?? lists[0] ?? null;
  }, [listRows, weekStart]);
  const itemCount = useMemo(
    () => itemRows.filter((r) => (r.row as { list_id?: string }).list_id === list?.id).length,
    [itemRows, list]
  );

  const load = useCallback(async () => {
    if (!list) return;
    setBusy(true);
    setError(null);
    try {
      const [cmp, dls] = await Promise.all([
        authedRequest(`/v1/lists/${list.id}/compare`),
        authedRequest(`/v1/lists/${list.id}/deals`),
      ]);
      if (!cmp.ok) throw new Error(String(cmp.status));
      setResult((await cmp.json()) as CompareResult);
      if (dls.ok) setDeals(((await dls.json()) as { deals: Deal[] }).deals);
    } catch {
      setError('Prijzen niet beschikbaar — controleer je verbinding.');
    } finally {
      setBusy(false);
    }
  }, [list?.id]);

  useEffect(() => {
    load();
  }, [load, itemCount]);

  // PR1 — recepten uit eigen bibliotheek die op actuele deals leunen
  const bonusRecipes = useMemo(() => {
    if (!deals.length) return [];
    const dealItems = deals.map((d) => d.item.toLowerCase());
    return recipeRows
      .map((row) => ({ ...(row.row as unknown as RecipeRowData), id: row.id }))
      .map((r) => ({
        recipe: r,
        hits: (r.ingredients ?? []).filter((i) =>
          dealItems.some((d) => (i.item_normalised ?? i.raw_text ?? '').toLowerCase().includes(d))
        ).length,
      }))
      .filter((x) => x.hits > 0)
      .sort((a, b) => b.hits - a.hits)
      .slice(0, 5);
  }, [deals, recipeRows]);

  const allChains = [...(result?.ranked ?? []), ...(result?.partial ?? [])];
  const maxTotal = Math.max(...allChains.map((c) => c.total_cents), 1);
  const staleness = allChains[0]?.staleness;
  const isToday = staleness && new Date(staleness).toDateString() === new Date().toDateString();
  const stalenessLabel = staleness
    ? isToday
      ? 'prijzen van vandaag'
      : `prijzen van ${new Date(staleness).toLocaleDateString('nl-NL', { day: 'numeric', month: 'long' })}`
    : '';

  const avatar = (id: string) => {
    const b = CHAIN_BRAND[id] ?? { bg: '#22301E', fg: '#fff' };
    return (
      <View style={[styles.avatar, { backgroundColor: b.bg }]}>
        <Text style={[styles.avatarText, { color: b.fg }]}>{chainChip(id)}</Text>
      </View>
    );
  };

  const chainRow = (chain: ChainPricing, isCheapest: boolean, note?: string) => (
    <View key={chain.chain_id} style={styles.mandjeRow}>
      {avatar(chain.chain_id)}
      <View style={{ flex: 1, gap: 4 }}>
        <View style={styles.mandjeTop}>
          <Text style={[styles.mandjeName, isCheapest && { fontFamily: fonts.bodyBold, color: colors.text }]}>
            {chainName(chain.chain_id)}
            {isCheapest ? <Text style={styles.voordeligstBadge}>  voordeligst</Text> : null}
            {chain.chain_id === result?.home_chain ? <Text style={styles.homeNote}>  jouw winkel</Text> : null}
            {note ? <Text style={styles.homeNote}>  {note}</Text> : null}
          </Text>
          <Text style={[styles.mandjeTotal, isCheapest && { color: colors.primary, fontFamily: fonts.bodyBold }]}>
            {formatEuroCents(chain.total_cents)}{chain.unmatched.length ? '+' : ''}
          </Text>
        </View>
        <View style={styles.barTrack}>
          <View
            style={[
              styles.barFill,
              {
                width: `${Math.round((chain.total_cents / maxTotal) * 100)}%`,
                backgroundColor: isCheapest ? colors.primary : '#AECBA8',
              },
            ]}
          />
        </View>
      </View>
    </View>
  );

  return (
    <View style={[styles.screen, { paddingTop: insets.top + 8 }]}>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <Text style={styles.title}>Prijzen & Bonus</Text>
        <Text style={styles.subtitle}>
          {list ? `${list.name ?? 'Lijst'} · ${itemCount} items${stalenessLabel ? ` · ${stalenessLabel}` : ''}` : 'nog geen lijst'}
        </Text>

        {!list ? (
          <View style={{ alignItems: 'center', gap: 14 }}>
            <Text style={[type.meta, styles.center]}>Maak eerst een boodschappenlijst — dan vergelijken we hier de supers.</Text>
            {/* PR2 — geef de lege staat een uitweg */}
            <Pressable style={styles.emptyCta} onPress={() => router.push('/lijst')}>
              <Text style={styles.emptyCtaText}>Naar de lijst →</Text>
            </Pressable>
          </View>
        ) : error ? (
          <Text style={[type.meta, styles.center]}>{error}</Text>
        ) : !result ? (
          <Text style={[type.meta, styles.center]}>{busy ? 'Prijzen vergelijken…' : ''}</Text>
        ) : (
          <>
            <View style={styles.mandjeCard}>
              <Text style={styles.cardTitle}>Jouw mandje per supermarkt</Text>
              <View style={{ gap: 10 }}>
                {result.ranked.map((c, i) => chainRow(c, i === 0))}
                {result.partial.map((c) =>
                  chainRow(c, false, c.unmatched.length ? `${c.unmatched.length} items niet in assortiment` : 'gedeeltelijk assortiment')
                )}
              </View>
              {result.insight && result.insight.savings_cents > 0 ? (
                <View style={styles.insightStrip}>
                  <TrendingDown size={15} color={colors.primary} strokeWidth={2} />
                  <Text style={styles.insightText}>
                    Deze week{' '}
                    <Text style={{ fontFamily: fonts.bodyBold }}>
                      {formatEuroCents(result.insight.savings_cents)} goedkoper bij {chainName(result.cheapest_chain ?? '')}
                    </Text>
                    {result.insight.driving_items.length
                      ? ` — vooral door ${result.insight.driving_items.slice(0, 2).map((d) => d.name).join(' en ')}`
                      : ''}
                  </Text>
                </View>
              ) : null}
            </View>

            <View style={styles.sectionRow}>
              <Text style={styles.cardTitle}>Van jouw lijst in de aanbieding</Text>
              {deals.length > 0 ? <Text style={styles.sectionLink}>Alles · {deals.length}</Text> : null}
            </View>
            {deals.length === 0 ? (
              <Text style={type.meta}>Geen actieve aanbiedingen op je lijst — we checken elke nacht opnieuw.</Text>
            ) : (
              <View style={styles.dealsCard}>
                {deals.slice(0, 6).map((d, i) => (
                  <View key={`${d.chain_id}:${d.item}:${i}`} style={[styles.dealRow, i < Math.min(deals.length, 6) - 1 && styles.dealBorder]}>
                    {avatar(d.chain_id)}
                    <View style={{ flex: 1, gap: 2, minWidth: 0 }}>
                      <Text style={styles.dealName} numberOfLines={1}>{d.product_name ?? d.item}</Text>
                      <Text style={styles.dealMechanic} numberOfLines={1}>
                        {d.promo?.mechanic ??
                          (d.promo?.valid_to
                            ? `Bonus t/m ${new Date(d.promo.valid_to).toLocaleDateString('nl-NL', { weekday: 'long' })}`
                            : 'aanbieding')}
                      </Text>
                    </View>
                    <Text style={styles.dealPrice}>−{formatEuroCents(d.savings_cents)}</Text>
                  </View>
                ))}
              </View>
            )}

            {/* PR1 — alleen tonen mét deals; tik toont de recepten die erop leunen */}
            {bonusRecipes.length > 0 ? (
              <>
                <Pressable style={styles.rail} onPress={() => setRailOpen(!railOpen)}>
                  <Text style={styles.railText}>
                    <Text style={{ fontFamily: fonts.bodyBold }}>Koken met aanbiedingen</Text> · {bonusRecipes.length}{' '}
                    {bonusRecipes.length === 1 ? 'recept leunt' : 'recepten leunen'} op deals van deze week
                  </Text>
                  {railOpen ? (
                    <ChevronDown size={14} color={colors.textSoft} strokeWidth={2.2} />
                  ) : (
                    <ChevronRight size={14} color={colors.textSoft} strokeWidth={2.2} />
                  )}
                </Pressable>
                {railOpen ? (
                  <View style={styles.dealsCard}>
                    {bonusRecipes.map(({ recipe: r, hits }, i) => (
                      <Pressable
                        key={r.id}
                        style={[styles.dealRow, i < bonusRecipes.length - 1 && styles.dealBorder]}
                        onPress={() => router.push(`/recipe/${r.id}`)}
                      >
                        <View style={{ flex: 1, gap: 2, minWidth: 0 }}>
                          <Text style={styles.dealName} numberOfLines={1}>{r.title}</Text>
                          <Text style={styles.dealMechanic}>
                            {hits} {hits === 1 ? 'ingrediënt' : 'ingrediënten'} in de bonus
                          </Text>
                        </View>
                        <ChevronRight size={14} color={colors.textSoft} strokeWidth={2.2} />
                      </Pressable>
                    ))}
                  </View>
                ) : null}
              </>
            ) : null}

            <Pressable style={styles.refresh} onPress={load}>
              <RefreshCw size={15} color={colors.primary} />
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
  content: { paddingHorizontal: 20, paddingBottom: 150 },
  title: { fontFamily: fonts.display, fontSize: 29, lineHeight: 32, color: colors.text },
  subtitle: { marginTop: 3, fontSize: 12.5, color: colors.textMuted },
  center: { textAlign: 'center', marginTop: 40 },
  mandjeCard: {
    marginTop: 14, backgroundColor: colors.surface, borderWidth: 1, borderColor: 'rgba(34,48,30,.08)',
    borderRadius: 18, padding: 16, gap: 12,
    shadowColor: '#22301E', shadowOpacity: 0.05, shadowRadius: 10, shadowOffset: { width: 0, height: 2 }, elevation: 2,
  },
  cardTitle: { fontSize: 13, fontFamily: fonts.bodyBold, color: colors.text },
  mandjeRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  avatar: { width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
  avatarText: { fontSize: 10, fontFamily: fonts.bodyBold },
  mandjeTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 },
  mandjeName: { fontSize: 13, fontFamily: fonts.bodySemiBold, color: colors.textSoft, flexShrink: 1 },
  voordeligstBadge: {
    fontSize: 10, fontFamily: fonts.bodyBold, color: colors.primary,
  },
  homeNote: { fontSize: 10.5, color: '#97A08F', fontFamily: fonts.bodyMedium },
  mandjeTotal: { fontSize: 14, fontFamily: fonts.bodySemiBold, color: colors.textSoft },
  barTrack: { height: 8, borderRadius: 4, backgroundColor: '#F0EDE3', overflow: 'hidden' },
  barFill: { height: 8, borderRadius: 4 },
  insightStrip: {
    flexDirection: 'row', alignItems: 'center', gap: 9, backgroundColor: colors.badgeBg,
    borderRadius: 12, paddingHorizontal: 13, paddingVertical: 10,
  },
  insightText: { flex: 1, fontSize: 12, color: '#3D5138' },
  sectionRow: { marginTop: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  sectionLink: { fontSize: 12, fontFamily: fonts.bodySemiBold, color: colors.primary },
  dealsCard: {
    marginTop: 8, backgroundColor: colors.surface, borderWidth: 1, borderColor: 'rgba(34,48,30,.08)',
    borderRadius: 16, overflow: 'hidden',
  },
  dealRow: { flexDirection: 'row', alignItems: 'center', gap: 11, paddingHorizontal: 14, paddingVertical: 11 },
  dealBorder: { borderBottomWidth: 1, borderBottomColor: 'rgba(34,48,30,.06)' },
  dealName: { fontSize: 13.5, fontFamily: fonts.bodySemiBold, color: colors.text },
  dealMechanic: { fontSize: 11, color: '#97A08F' },
  dealPrice: { fontSize: 13.5, fontFamily: fonts.bodyBold, color: colors.primary },
  rail: {
    marginTop: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10,
    backgroundColor: '#F3F0E7', borderRadius: 14, paddingHorizontal: 14, paddingVertical: 12,
  },
  railText: { flex: 1, fontSize: 12.5, color: colors.textSoft },
  refresh: { flexDirection: 'row', gap: 8, alignItems: 'center', justifyContent: 'center', padding: 12 },
  emptyCta: {
    backgroundColor: colors.primary, borderRadius: radius.pill, paddingHorizontal: 20, paddingVertical: 11,
  },
  emptyCtaText: { fontSize: 13.5, fontFamily: fonts.bodySemiBold, color: colors.onPrimary },
});
