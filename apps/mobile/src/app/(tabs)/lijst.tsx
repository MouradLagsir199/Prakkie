import { AISLE_GROUPS, formatEuroCents, OVERIG_GROUP_ID } from '@prakkie/shared';
import { Check, ChevronLeft, ChevronRight, X } from 'lucide-react-native';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { newId, syncNow, upsertRow, useEntityRows } from '../../data';
import { authedRequest } from '../../data/api';
import { CHAIN_BRAND, chainChip, chainName, isoWeekNumber, mondayOf, weekRangeLabel } from '../../data/chains';
import { colors, fonts, radius, type } from '../../theme/tokens';

/**
 * Lijst — mockup 06 DNA (group cards, provenance sublines, dark total footer)
 * + owner deviations (2026-07-06): week-tied lists with a calendar strip,
 * per-chain price anchoring chips ("alles bij AH / Jumbo"), and a per-item
 * variant sheet that shows WHERE a price comes from per supermarket and lets
 * the user pin a different product (feeds E5 corrections).
 */

interface ListRow { id: string; name: string; week_start?: string | null }
interface ItemRow {
  id: string; list_id: string; name: string; quantity: number | string | null; unit: string | null;
  aisle_group_id: number | null; checked: boolean; is_manual: boolean;
  item_normalised?: string | null;
  matches?: Record<string, { sku_id: string; confidence?: number; user_pinned?: boolean }>;
  provenance?: { recipe_title?: string; title?: string }[];
}
interface PricedLine {
  item_id: string; matched: boolean; sku_id?: string; product_name?: string;
  packs?: number; line_price_cents?: number; promo?: unknown; promo_savings_cents?: number; confidence?: number;
}
interface ChainPricing {
  chain_id: string; total_cents: number; matched: number; unmatched: string[]; lines: PricedLine[];
}
interface Shortlist { sku_id: string; name: string; price_cents: number; promo_price_cents?: number | null; confidence: number }

const ALL_CHAINS = ['ah', 'jumbo', 'plus', 'dirk', 'spar', 'aldi'];

export default function LijstScreen() {
  const insets = useSafeAreaInsets();
  const { rows: listRows } = useEntityRows('lists');
  const { rows: itemRows } = useEntityRows('list_items');
  const [weekOffset, setWeekOffset] = useState(0);
  const [activeListId, setActiveListId] = useState<string | null>(null);
  const [activeChain, setActiveChain] = useState<string>('ah');
  const [pricing, setPricing] = useState<ChainPricing[] | null>(null);
  const [variantItem, setVariantItem] = useState<ItemRow | null>(null);
  const [shortlist, setShortlist] = useState<Shortlist[] | null>(null);

  const weekStart = mondayOf(weekOffset);
  const weekLists = useMemo(
    () =>
      listRows
        .map((r) => ({ ...(r.row as unknown as ListRow), id: r.id }))
        .filter((l) => (l.week_start ?? '').slice(0, 10) === weekStart),
    [listRows, weekStart]
  );
  const list = weekLists.find((l) => l.id === activeListId) ?? weekLists[0] ?? null;
  const items = useMemo(
    () => itemRows.map((r) => r.row as unknown as ItemRow).filter((i) => list && i.list_id === list.id),
    [itemRows, list]
  );
  const checkedCount = items.filter((i) => i.checked).length;

  const refreshPricing = useCallback(async () => {
    if (!list || items.length === 0) {
      setPricing(null);
      return;
    }
    try {
      await syncNow(['lists', 'list_items']);
      const res = await authedRequest(`/v1/lists/${list.id}/price?chains=${ALL_CHAINS.join(',')}`);
      if (res.ok) setPricing(((await res.json()) as { chains: ChainPricing[] }).chains);
    } catch {
      /* offline — lijst blijft bruikbaar */
    }
  }, [list?.id, items.length]);

  useEffect(() => {
    const t = setTimeout(refreshPricing, 350);
    return () => clearTimeout(t);
  }, [refreshPricing, checkedCount]);

  const activePricing = pricing?.find((c) => c.chain_id === activeChain) ?? null;
  const lineByItem = useMemo(
    () => new Map((activePricing?.lines ?? []).map((l) => [l.item_id, l])),
    [activePricing]
  );
  const cheapest = useMemo(() => {
    const complete = (pricing ?? []).filter((c) => c.unmatched.length === 0);
    return complete.length ? complete.reduce((a, b) => (a.total_cents <= b.total_cents ? a : b)) : null;
  }, [pricing]);

  const groups = useMemo(() => {
    const byAisle = new Map<number, ItemRow[]>();
    for (const item of items) {
      const key = item.aisle_group_id ?? OVERIG_GROUP_ID;
      (byAisle.get(key) ?? byAisle.set(key, []).get(key)!).push(item);
    }
    return AISLE_GROUPS.filter((g) => byAisle.has(g.id)).map((g) => ({ group: g, items: byAisle.get(g.id)! }));
  }, [items]);

  async function toggle(item: ItemRow) {
    await upsertRow('list_items', { list_id: item.list_id, name: item.name, checked: !item.checked }, item.id);
    syncNow(['list_items']).catch(() => {});
  }

  async function newList() {
    const id = newId();
    await upsertRow('lists', { name: `Lijst ${weekLists.length + 1}`, week_start: weekStart }, id);
    setActiveListId(id);
    syncNow(['lists']).catch(() => {});
  }

  async function openVariants(item: ItemRow) {
    setVariantItem(item);
    setShortlist(null);
    try {
      const term = encodeURIComponent(item.item_normalised ?? item.name);
      const res = await authedRequest(`/v1/match?item=${term}&chains=${activeChain}`);
      if (res.ok) {
        const body = (await res.json()) as { matches: Record<string, { shortlist: Shortlist[] }> };
        setShortlist(body.matches[activeChain]?.shortlist ?? []);
      }
    } catch {
      setShortlist([]);
    }
  }

  async function pinVariant(item: ItemRow, sku: Shortlist) {
    const matches = { ...(item.matches ?? {}), [activeChain]: { sku_id: sku.sku_id, confidence: 1, user_pinned: true } };
    await upsertRow('list_items', { list_id: item.list_id, name: item.name, matches }, item.id);
    // correction feeds the community learning loop (E5)
    await upsertRow('match_corrections', {
      chain_id: activeChain,
      item_normalised: item.item_normalised ?? item.name.toLowerCase(),
      chosen_sku_id: sku.sku_id,
    });
    setVariantItem(null);
    await syncNow(['list_items', 'match_corrections']).catch(() => {});
    refreshPricing();
  }

  const qtyLabel = (i: ItemRow) =>
    i.quantity ? ` · ${String(i.quantity).replace('.', ',')}${i.unit ? ` ${i.unit}` : ' st'}` : '';

  return (
    <View style={[styles.screen, { paddingTop: insets.top + 8 }]}>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        {/* week calendar strip (owner deviation: weekly lists) */}
        <View style={styles.weekRow}>
          <Pressable onPress={() => setWeekOffset(weekOffset - 1)} hitSlop={10}>
            <ChevronLeft size={18} color={colors.primary} strokeWidth={2.2} />
          </Pressable>
          <Text style={styles.weekLabel}>
            Week {isoWeekNumber(weekStart)} <Text style={type.meta}>· {weekRangeLabel(weekStart)}</Text>
          </Text>
          <Pressable onPress={() => setWeekOffset(weekOffset + 1)} hitSlop={10}>
            <ChevronRight size={18} color={colors.primary} strokeWidth={2.2} />
          </Pressable>
        </View>

        <View style={styles.tabs}>
          {weekLists.map((l) => (
            <Pressable key={l.id} onPress={() => setActiveListId(l.id)} style={[styles.tab, list?.id === l.id && styles.tabActive]}>
              <Text style={[styles.tabText, list?.id === l.id && styles.tabTextActive]}>{l.name}</Text>
            </Pressable>
          ))}
          <Pressable onPress={newList} style={styles.tab}>
            <Text style={styles.tabText}>+ Nieuw</Text>
          </Pressable>
        </View>

        {list ? (
          <>
            <View style={styles.titleRow}>
              <Text style={styles.listTitle}>{list.name}</Text>
            </View>
            <Text style={styles.metaLine}>
              {items.length} items · {checkedCount} afgevinkt · live gekoppeld aan weekplan
            </Text>

            {/* chain anchoring chips: totals + line prices per supermarkt */}
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chainRow}>
              {ALL_CHAINS.map((c) => {
                const brand = CHAIN_BRAND[c]!;
                const chainTotal = pricing?.find((p) => p.chain_id === c);
                const active = activeChain === c;
                return (
                  <Pressable key={c} onPress={() => setActiveChain(c)} style={[styles.chainChip, active && styles.chainChipActive]}>
                    <View style={[styles.chainDot, { backgroundColor: brand.bg }]}>
                      <Text style={[styles.chainDotText, { color: brand.fg }]}>{chainChip(c)}</Text>
                    </View>
                    <Text style={[styles.chainChipText, active && { color: colors.onPrimary }]}>
                      {chainTotal ? formatEuroCents(chainTotal.total_cents) : chainName(c)}
                    </Text>
                  </Pressable>
                );
              })}
            </ScrollView>

            {groups.length === 0 ? (
              <Text style={[type.meta, { textAlign: 'center', marginTop: 40 }]}>
                Nog niets op de lijst. Voeg toe vanuit een recept of het weekmenu.
              </Text>
            ) : (
              groups.map(({ group, items: groupItems }) => (
                <View key={group.id}>
                  <Text style={styles.groupTitle}>{group.nameNl}</Text>
                  <View style={styles.groupCard}>
                    {groupItems.map((item, idx) => {
                      const line = lineByItem.get(item.id);
                      const promoActive = !!line?.promo && line.promo_savings_cents! > 0;
                      const recipes = (item.provenance ?? []).map((p) => p.recipe_title ?? p.title).filter(Boolean);
                      const pinned = item.matches?.[activeChain]?.user_pinned;
                      return (
                        <View key={item.id} style={[styles.itemRow, idx < groupItems.length - 1 && styles.itemBorder]}>
                          <Pressable onPress={() => toggle(item)} hitSlop={6}>
                            <View style={[styles.checkbox, item.checked && styles.checkboxOn]}>
                              {item.checked ? <Check size={12} color={colors.onPrimary} strokeWidth={3} /> : null}
                            </View>
                          </Pressable>
                          <Pressable style={{ flex: 1, minWidth: 0 }} onPress={() => toggle(item)} onLongPress={() => openVariants(item)}>
                            <View style={styles.itemNameRow}>
                              <Text style={[styles.itemName, item.checked && styles.checkedText]} numberOfLines={1}>
                                {item.name}
                                {qtyLabel(item)}
                              </Text>
                              {recipes.length > 1 ? (
                                <Text style={styles.mergedBadge}>{recipes.length} recepten</Text>
                              ) : null}
                              {promoActive ? <Text style={styles.bonusBadge}>Bonus</Text> : null}
                            </View>
                            {!item.checked && (line?.product_name || recipes.length) ? (
                              <Text style={styles.subline} numberOfLines={1}>
                                {line?.product_name
                                  ? `${line.product_name}${pinned ? ' · door jou gekozen' : ''}${line.packs && line.packs > 1 ? ` · ${line.packs}×` : ''}`
                                  : `samengevoegd: ${recipes.join(' + ')}`}
                              </Text>
                            ) : null}
                          </Pressable>
                          <Pressable onPress={() => openVariants(item)} hitSlop={8} style={styles.priceCol}>
                            {promoActive && line?.line_price_cents !== undefined ? (
                              <Text style={styles.oldPrice}>
                                {formatEuroCents(line.line_price_cents + (line.promo_savings_cents ?? 0))}
                              </Text>
                            ) : null}
                            <Text style={[styles.price, item.checked && { color: '#B9C0B2' }]}>
                              {line?.matched && line.line_price_cents !== undefined ? formatEuroCents(line.line_price_cents) : '—'}
                            </Text>
                          </Pressable>
                        </View>
                      );
                    })}
                  </View>
                </View>
              ))
            )}
          </>
        ) : (
          <Text style={[type.meta, { textAlign: 'center', marginTop: 40 }]}>
            Nog geen lijst voor deze week. Maak er één met “+ Nieuw” of plan gerechten in.
          </Text>
        )}
      </ScrollView>

      {/* dark total footer — mockup 06 */}
      {activePricing && items.length > 0 ? (
        <View style={[styles.footerWrap, { paddingBottom: insets.bottom + 96 }]}>
          <View style={styles.footerCard}>
            <View style={{ gap: 2 }}>
              <Text style={styles.footerLabel}>Totaal bij {chainName(activeChain)}</Text>
              <Text style={styles.footerTotal}>{formatEuroCents(activePricing.total_cents)}</Text>
              {activePricing.unmatched.length ? (
                <Text style={[styles.footerLabel, { color: 'rgba(253,251,246,.75)' }]}>
                  {activePricing.unmatched.length} item(s) niet gevonden — geen neptotaal
                </Text>
              ) : null}
            </View>
            {cheapest && cheapest.chain_id !== activeChain && activePricing.total_cents > cheapest.total_cents ? (
              <Pressable style={styles.teaser} onPress={() => setActiveChain(cheapest.chain_id)}>
                <View style={styles.teaserDot} />
                <Text style={styles.teaserText}>
                  {formatEuroCents(activePricing.total_cents - cheapest.total_cents)} goedkoper bij {chainName(cheapest.chain_id)}
                </Text>
                <ChevronRight size={12} color="#FDFBF6" strokeWidth={2.2} />
              </Pressable>
            ) : null}
          </View>
        </View>
      ) : null}

      {/* variant sheet: verify where the price comes from; switch product (owner UX) */}
      {variantItem ? (
        <View style={[styles.sheet, { paddingBottom: insets.bottom + 100 }]}>
          <View style={styles.sheetHeader}>
            <Text style={type.h3} numberOfLines={1}>
              {variantItem.name} — prijscontrole
            </Text>
            <Pressable onPress={() => setVariantItem(null)} hitSlop={10}>
              <X size={20} color={colors.textSoft} />
            </Pressable>
          </View>

          <Text style={styles.sheetSection}>PER SUPERMARKT</Text>
          {(pricing ?? [])
            .filter((c) => ALL_CHAINS.includes(c.chain_id))
            .map((c) => {
              const line = c.lines.find((l) => l.item_id === variantItem.id);
              const brand = CHAIN_BRAND[c.chain_id]!;
              return (
                <View key={c.chain_id} style={styles.variantRow}>
                  <View style={[styles.chainDot, { backgroundColor: brand.bg }]}>
                    <Text style={[styles.chainDotText, { color: brand.fg }]}>{chainChip(c.chain_id)}</Text>
                  </View>
                  <Text style={[styles.subline, { flex: 1, fontSize: 12 }]} numberOfLines={1}>
                    {line?.matched ? line.product_name : 'geen match gevonden'}
                  </Text>
                  <Text style={styles.price}>
                    {line?.matched && line.line_price_cents !== undefined ? formatEuroCents(line.line_price_cents) : '—'}
                  </Text>
                </View>
              );
            })}

          <Text style={styles.sheetSection}>WISSEL PRODUCT BIJ {chainName(activeChain).toUpperCase()}</Text>
          {shortlist === null ? (
            <Text style={type.meta}>Alternatieven laden…</Text>
          ) : shortlist.length === 0 ? (
            <Text style={type.meta}>Geen alternatieven gevonden.</Text>
          ) : (
            shortlist.slice(0, 5).map((s) => (
              <Pressable key={s.sku_id} style={styles.variantRow} onPress={() => pinVariant(variantItem, s)}>
                <Text style={[type.body, { flex: 1, fontSize: 13.5 }]} numberOfLines={1}>
                  {s.name}
                </Text>
                <Text style={styles.price}>{formatEuroCents(s.promo_price_cents ?? s.price_cents)}</Text>
              </Pressable>
            ))
          )}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { paddingHorizontal: 20, paddingBottom: 220, gap: 10 },
  weekRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  weekLabel: { fontFamily: fonts.bodySemiBold, fontSize: 13, color: colors.primary },
  tabs: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  tab: {
    paddingHorizontal: 14, paddingVertical: 8, borderRadius: radius.pill,
    backgroundColor: colors.surface, borderWidth: 1, borderColor: 'rgba(34,48,30,.12)',
  },
  tabActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  tabText: { fontFamily: fonts.bodySemiBold, fontSize: 13, color: colors.textSoft },
  tabTextActive: { color: colors.onPrimary },
  titleRow: { marginTop: 2, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  listTitle: { fontFamily: fonts.display, fontSize: 25, lineHeight: 28, color: colors.text },
  metaLine: { fontSize: 12, color: colors.textMuted, marginTop: -4 },
  chainRow: { gap: 8, paddingVertical: 4 },
  chainChip: {
    flexDirection: 'row', alignItems: 'center', gap: 7, paddingHorizontal: 11, paddingVertical: 6,
    borderRadius: radius.pill, backgroundColor: colors.surface, borderWidth: 1, borderColor: 'rgba(34,48,30,.12)',
  },
  chainChipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  chainChipText: { fontFamily: fonts.bodySemiBold, fontSize: 12, color: colors.textSoft },
  chainDot: { width: 22, height: 22, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
  chainDotText: { fontSize: 8, fontFamily: fonts.bodyBold },
  groupTitle: {
    fontSize: 11.5, fontFamily: fonts.bodyBold, letterSpacing: 0.6, color: colors.textMuted, marginTop: 8, marginBottom: 7,
  },
  groupCard: {
    backgroundColor: colors.surface, borderWidth: 1, borderColor: 'rgba(34,48,30,.08)',
    borderRadius: 16, overflow: 'hidden',
  },
  itemRow: { paddingHorizontal: 14, paddingVertical: 11, flexDirection: 'row', alignItems: 'center', gap: 11 },
  itemBorder: { borderBottomWidth: 1, borderBottomColor: 'rgba(34,48,30,.06)' },
  checkbox: {
    width: 22, height: 22, borderRadius: 11, borderWidth: 1.8, borderColor: 'rgba(34,48,30,.25)',
    alignItems: 'center', justifyContent: 'center',
  },
  checkboxOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  itemNameRow: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  itemName: { fontSize: 14, color: colors.text, flexShrink: 1 },
  checkedText: { textDecorationLine: 'line-through', color: '#97A08F' },
  mergedBadge: {
    paddingHorizontal: 7, paddingVertical: 2, borderRadius: radius.pill, overflow: 'hidden',
    backgroundColor: colors.badgeBg, color: colors.primary, fontSize: 9.5, fontFamily: fonts.bodyBold,
  },
  bonusBadge: {
    paddingHorizontal: 7, paddingVertical: 2, borderRadius: radius.pill, overflow: 'hidden',
    backgroundColor: colors.bonus, color: colors.bonusText, fontSize: 9.5, fontFamily: fonts.bodyBold,
  },
  subline: { fontSize: 10.5, color: '#97A08F', marginTop: 2 },
  priceCol: { alignItems: 'flex-end', gap: 1 },
  oldPrice: { fontSize: 10.5, color: '#B9C0B2', textDecorationLine: 'line-through' },
  price: { fontSize: 13, fontFamily: fonts.bodySemiBold, color: colors.textSoft },
  footerWrap: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 20 },
  footerCard: {
    backgroundColor: '#22301E', borderRadius: 18, padding: 14, flexDirection: 'row',
    alignItems: 'center', justifyContent: 'space-between', gap: 10,
    shadowColor: '#22301E', shadowOpacity: 0.3, shadowRadius: 28, shadowOffset: { width: 0, height: 12 }, elevation: 10,
  },
  footerLabel: { fontSize: 11, color: 'rgba(253,251,246,.6)' },
  footerTotal: { fontSize: 19, fontFamily: fonts.bodyBold, color: '#FDFBF6' },
  teaser: {
    flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: 'rgba(253,251,246,.12)',
    borderRadius: 12, paddingHorizontal: 12, paddingVertical: 9,
  },
  teaserDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.bonus },
  teaserText: { fontSize: 12, color: '#FDFBF6' },
  sheet: {
    position: 'absolute', left: 0, right: 0, bottom: 0, backgroundColor: colors.surface,
    borderTopLeftRadius: 22, borderTopRightRadius: 22, padding: 20, gap: 9,
    shadowColor: '#000', shadowOpacity: 0.14, shadowRadius: 18, shadowOffset: { width: 0, height: -6 }, elevation: 12,
  },
  sheetHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  sheetSection: {
    fontSize: 11, fontFamily: fonts.bodyBold, letterSpacing: 0.6, color: colors.textMuted, marginTop: 8,
  },
  variantRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 7 },
});
