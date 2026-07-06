import { AISLE_GROUPS, formatEuroCents, OVERIG_GROUP_ID } from '@prakkie/shared';
import { Check, ChevronLeft, ChevronRight, Minus, Plus, Trash2, X } from 'lucide-react-native';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ProductOptions } from '../../components/prakkie/ProductOptions';
import { deleteRow, newId, syncNow, upsertRow, useEntityRows } from '../../data';
import { authedRequest } from '../../data/api';
import { CHAIN_BRAND, chainChip, chainName } from '../../data/chains';
import { activeHouseholdId, loadHousehold, memberName, type MemberInfo } from '../../data/households';
import { kv } from '../../data/kv';
import { confirmDialog } from '../../lib/dialogs';
import { colors, fonts, radius, type } from '../../theme/tokens';

/**
 * Boodschappen (owner UX 2026-07-06, vervangt "Lijst"):
 *  - maand-kalender met puntjes op dagen waar boodschappen gepland staan;
 *  - dag openen/sluiten → de lijst(en) van die dag;
 *  - de app kiest NOOIT een product: elke regel heeft een dropdown met alle
 *    matchende producten (thumbnails) en de user bepaalt;
 *  - huishouden: lijsten gedeeld, log "wie heeft wat als laatst toegevoegd".
 */

interface ListRow { id: string; name: string; week_start?: string | null; household_id?: string | null }
interface ItemRow {
  id: string; list_id: string; name: string; quantity: number | string | null; unit: string | null;
  aisle_group_id: number | null; checked: boolean; is_manual: boolean;
  item_normalised?: string | null;
  matches?: Record<string, { sku_id: string; confidence?: number; user_pinned?: boolean }>;
  provenance?: { recipe_title?: string; title?: string }[];
  added_by?: string | null;
  created_at?: string;
  updated_at?: string;
}
interface PricedLine {
  item_id: string; matched: boolean; sku_id?: string; product_name?: string;
  packs?: number; line_price_cents?: number; promo?: unknown; promo_savings_cents?: number; confidence?: number;
}
interface ChainPricing {
  chain_id: string; total_cents: number; matched: number; unmatched: string[]; lines: PricedLine[];
}

const ALL_CHAINS = ['ah', 'jumbo', 'plus', 'dirk', 'spar', 'aldi'];
const MONTHS_NL = ['januari', 'februari', 'maart', 'april', 'mei', 'juni', 'juli', 'augustus', 'september', 'oktober', 'november', 'december'];
const DAYS_NL = ['ma', 'di', 'wo', 'do', 'vr', 'za', 'zo'];

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const todayIso = () => iso(new Date());
const dutchDate = (isoDate: string) => {
  const d = new Date(`${isoDate}T12:00:00`);
  return `${d.getDate()} ${MONTHS_NL[d.getMonth()]}`;
};

export default function BoodschappenScreen() {
  const insets = useSafeAreaInsets();
  const { rows: listRows } = useEntityRows('lists');
  const { rows: itemRows } = useEntityRows('list_items');
  const [monthOffset, setMonthOffset] = useState(0);
  const [selectedDate, setSelectedDate] = useState<string | null>(todayIso());
  const [activeListId, setActiveListId] = useState<string | null>(null);
  const [activeChain, setActiveChain] = useState<string>('ah');
  const [pricing, setPricing] = useState<ChainPricing[] | null>(null);
  const [detailItem, setDetailItem] = useState<ItemRow | null>(null);
  const [nameDraft, setNameDraft] = useState('');
  const [quickAdd, setQuickAdd] = useState('');
  const [members, setMembers] = useState<MemberInfo[]>([]);

  // naam-bewerken in de item-sheet: draft volgt het geopende item
  useEffect(() => {
    setNameDraft(detailItem?.name ?? '');
  }, [detailItem?.id]);

  useEffect(() => {
    kv.getItem('prakkie.homechain').then((c) => c && ALL_CHAINS.includes(c) && setActiveChain(c)).catch(() => {});
    loadHousehold().then((h) => setMembers(h.members)).catch(() => {});
  }, []);

  const lists = useMemo(
    () => listRows.map((r) => ({ ...(r.row as unknown as ListRow), id: r.id })),
    [listRows]
  );
  const dateOf = (l: ListRow) => (l.week_start ?? '').slice(0, 10);
  const dotDates = useMemo(() => new Set(lists.map(dateOf).filter(Boolean)), [lists]);

  // month grid
  const monthStart = useMemo(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth() + monthOffset, 1);
  }, [monthOffset]);
  const grid = useMemo(() => {
    const startCol = (monthStart.getDay() + 6) % 7; // monday = 0
    const daysInMonth = new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 0).getDate();
    const cells: (string | null)[] = [];
    for (let i = 0; i < startCol; i++) cells.push(null);
    for (let d = 1; d <= daysInMonth; d++) cells.push(iso(new Date(monthStart.getFullYear(), monthStart.getMonth(), d)));
    while (cells.length % 7 !== 0) cells.push(null);
    return cells;
  }, [monthStart]);

  const dayLists = useMemo(
    () => (selectedDate ? lists.filter((l) => dateOf(l) === selectedDate) : []),
    [lists, selectedDate]
  );
  const list = dayLists.find((l) => l.id === activeListId) ?? dayLists[0] ?? null;
  const items = useMemo(
    () => itemRows.map((r) => r.row as unknown as ItemRow).filter((i) => list && i.list_id === list.id),
    [itemRows, list]
  );
  const checkedCount = items.filter((i) => i.checked).length;

  // log: wie heeft als laatst iets toegevoegd (huishouden)
  const lastAdded = useMemo(() => {
    const withTime = items.filter((i) => i.created_at);
    if (!withTime.length) return null;
    const last = withTime.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0]!;
    const who = memberName(members, last.added_by);
    return who ? { who, what: last.name } : null;
  }, [items, members]);

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

  // "de app doet nooit een voorspelling": het hoofdtotaal telt alleen door de
  // user gekozen producten; de keten-chips blijven de snelle auto-schatting.
  const chosenTotal = useMemo(() => {
    let cents = 0;
    let chosen = 0;
    for (const item of items) {
      if (!item.matches?.[activeChain]?.user_pinned) continue;
      const line = lineByItem.get(item.id);
      if (line?.matched && line.line_price_cents != null) {
        cents += line.line_price_cents;
        chosen++;
      }
    }
    return { cents, chosen, open: items.length - chosen };
  }, [items, lineByItem, activeChain]);

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

  async function newList(date: string): Promise<string> {
    const id = newId();
    await upsertRow(
      'lists',
      {
        name: dayLists.length ? `Lijst ${dayLists.length + 1}` : `Boodschappen ${dutchDate(date)}`,
        week_start: date,
        household_id: await activeHouseholdId(), // gedeeld met het huishouden
      },
      id
    );
    setActiveListId(id);
    syncNow(['lists']).catch(() => {});
    return id;
  }

  /** quick-add: offline-first; verrijking (term/qty/schap) online; product kiest de user zelf. */
  async function addManual() {
    const typed = quickAdd.trim();
    if (!typed || !selectedDate) return;
    setQuickAdd('');
    const listId = list?.id ?? (await newList(selectedDate));
    const itemId = newId();
    await upsertRow('list_items', { list_id: listId, name: typed, is_manual: true }, itemId);
    syncNow(['list_items']).catch(() => {});
    try {
      const res = await authedRequest(`/v1/match?item=${encodeURIComponent(typed)}&chains=${activeChain}`);
      if (res.ok) {
        const body = (await res.json()) as {
          item: string; aisle_group_id: number | null; quantity: number | null; unit: string | null;
        };
        await upsertRow(
          'list_items',
          {
            list_id: listId,
            name: body.quantity != null ? body.item : typed,
            quantity: body.quantity,
            unit: body.unit,
            item_normalised: body.item,
            aisle_group_id: body.aisle_group_id,
            is_manual: true,
          },
          itemId
        );
        await syncNow(['list_items']).catch(() => {});
        refreshPricing();
      }
    } catch {
      /* offline: item blijft onder Overig */
    }
  }

  async function pinProduct(item: ItemRow, sku: { sku_id: string }) {
    const matches = { ...(item.matches ?? {}), [activeChain]: { sku_id: sku.sku_id, confidence: 1, user_pinned: true } };
    await upsertRow('list_items', { list_id: item.list_id, name: item.name, matches }, item.id);
    await upsertRow('match_corrections', {
      chain_id: activeChain,
      item_normalised: item.item_normalised ?? item.name.toLowerCase(),
      chosen_sku_id: sku.sku_id,
    });
    setDetailItem(null);
    await syncNow(['list_items', 'match_corrections']).catch(() => {});
    refreshPricing();
  }

  async function removeItem(item: ItemRow) {
    setDetailItem(null);
    await deleteRow('list_items', item.id);
    syncNow(['list_items']).catch(() => {});
    refreshPricing();
  }

  /** hele lijst weg — met bevestiging; items gaan mee. */
  async function removeList(target: ListRow) {
    const ok = await confirmDialog({
      title: 'Lijst verwijderen?',
      message: `“${target.name}” en alle items verdwijnen — ook voor je huishouden.`,
      confirmLabel: 'Verwijderen',
      destructive: true,
    });
    if (!ok) return;
    const children = itemRows
      .map((r) => ({ id: r.id, row: r.row as unknown as ItemRow }))
      .filter((r) => r.row.list_id === target.id);
    for (const c of children) await deleteRow('list_items', c.id);
    await deleteRow('lists', target.id);
    setActiveListId(null);
    setPricing(null);
    syncNow(['lists', 'list_items']).catch(() => {});
  }

  /** item hernoemen: user-tekst wint, normalisatie + schap worden opnieuw afgeleid. */
  async function renameItem(item: ItemRow) {
    const next = nameDraft.trim();
    if (!next || next === item.name) return;
    await upsertRow('list_items', { list_id: item.list_id, name: next, quantity: item.quantity, unit: item.unit }, item.id);
    setDetailItem({ ...item, name: next, item_normalised: null });
    syncNow(['list_items']).catch(() => {});
    try {
      const res = await authedRequest(`/v1/match?item=${encodeURIComponent(next)}&chains=${activeChain}`);
      if (res.ok) {
        const body = (await res.json()) as { item: string; aisle_group_id: number | null };
        await upsertRow(
          'list_items',
          { list_id: item.list_id, name: next, item_normalised: body.item, aisle_group_id: body.aisle_group_id },
          item.id
        );
        setDetailItem((d) => (d && d.id === item.id ? { ...d, item_normalised: body.item } : d));
        await syncNow(['list_items']).catch(() => {});
        refreshPricing();
      }
    } catch {
      /* offline: naam staat, verrijking volgt */
    }
  }

  async function bumpQty(item: ItemRow, delta: number) {
    const current = Number(item.quantity) || 1;
    const next = Math.max(1, Math.round((current + delta) * 100) / 100);
    await upsertRow('list_items', { list_id: item.list_id, name: item.name, quantity: next, unit: item.unit }, item.id);
    setDetailItem({ ...item, quantity: next });
    syncNow(['list_items']).catch(() => {});
    refreshPricing();
  }

  const qtyLabel = (i: ItemRow) =>
    i.quantity ? ` · ${String(i.quantity).replace('.', ',')}${i.unit ? ` ${i.unit}` : ' st'}` : '';
  const initialOf = (userId: string | null | undefined) =>
    (memberName(members, userId) ?? '?').slice(0, 1).toUpperCase();

  return (
    <View style={[styles.screen, { paddingTop: insets.top + 8 }]}>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <Text style={styles.title}>Boodschappen</Text>

        {/* maand-kalender met puntjes op geplande boodschappen */}
        <View style={styles.calCard}>
          <View style={styles.calHeader}>
            <Pressable onPress={() => setMonthOffset(monthOffset - 1)} hitSlop={10}>
              <ChevronLeft size={18} color={colors.primary} strokeWidth={2.2} />
            </Pressable>
            <Text style={styles.calMonth}>
              {MONTHS_NL[monthStart.getMonth()]} {monthStart.getFullYear()}
            </Text>
            <Pressable onPress={() => setMonthOffset(monthOffset + 1)} hitSlop={10}>
              <ChevronRight size={18} color={colors.primary} strokeWidth={2.2} />
            </Pressable>
          </View>
          <View style={styles.calWeekRow}>
            {DAYS_NL.map((d) => (
              <Text key={d} style={styles.calWeekday}>{d}</Text>
            ))}
          </View>
          <View style={styles.calGrid}>
            {grid.map((date, i) => {
              if (!date) return <View key={`x${i}`} style={styles.calCell} />;
              const selected = date === selectedDate;
              const isToday = date === todayIso();
              return (
                <Pressable
                  key={date}
                  style={styles.calCell}
                  onPress={() => setSelectedDate(selected ? null : date)}
                >
                  <View style={[styles.calDay, isToday && styles.calToday, selected && styles.calSelected]}>
                    <Text style={[styles.calDayText, selected && { color: colors.onPrimary }]}>
                      {Number(date.slice(8))}
                    </Text>
                  </View>
                  <View style={[styles.calDot, { opacity: dotDates.has(date) ? 1 : 0 }]} />
                </Pressable>
              );
            })}
          </View>
        </View>

        {selectedDate ? (
          <>
            <View style={styles.dayHeader}>
              <Text style={styles.dayTitle}>{dutchDate(selectedDate)}</Text>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 16 }}>
                {list ? (
                  <Pressable onPress={() => removeList(list)} hitSlop={10} accessibilityLabel="Lijst verwijderen">
                    <Trash2 size={16} color={colors.danger} strokeWidth={2} />
                  </Pressable>
                ) : null}
                <Pressable onPress={() => setSelectedDate(null)} hitSlop={10}>
                  <X size={17} color={colors.textSoft} />
                </Pressable>
              </View>
            </View>

            {dayLists.length > 1 ? (
              <View style={styles.tabs}>
                {dayLists.map((l) => (
                  <Pressable key={l.id} onPress={() => setActiveListId(l.id)} style={[styles.tab, list?.id === l.id && styles.tabActive]}>
                    <Text style={[styles.tabText, list?.id === l.id && styles.tabTextActive]}>{l.name}</Text>
                  </Pressable>
                ))}
              </View>
            ) : null}

            {/* quick-add — werkt ook zonder lijst (maakt er één voor deze dag) */}
            <View style={styles.quickAddRow}>
              <TextInput
                style={styles.quickAddInput}
                placeholder="Voeg toe: melk, 2 kg aardappelen…"
                placeholderTextColor="#97A08F"
                value={quickAdd}
                onChangeText={setQuickAdd}
                onSubmitEditing={addManual}
                returnKeyType="done"
              />
              <Pressable accessibilityLabel="Toevoegen" style={styles.quickAddBtn} onPress={addManual}>
                <Plus size={18} color={colors.onPrimary} strokeWidth={2.4} />
              </Pressable>
            </View>

            {list ? (
              <>
                <Text style={styles.metaLine}>
                  {items.length} items · {checkedCount} afgevinkt
                  {lastAdded ? ` · laatst: ${lastAdded.who} — ${lastAdded.what}` : ''}
                </Text>

                {/* keten-chips: snelle auto-totalen ("alles bij AH") — schatting */}
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
                          {chainTotal ? `± ${formatEuroCents(chainTotal.total_cents)}` : chainName(c)}
                        </Text>
                      </Pressable>
                    );
                  })}
                </ScrollView>

                {groups.length === 0 ? (
                  <Text style={[type.meta, { textAlign: 'center', marginTop: 30 }]}>
                    Nog niets op de lijst. Typ hierboven, of voeg toe vanuit een recept of het weekmenu.
                  </Text>
                ) : (
                  groups.map(({ group, items: groupItems }) => (
                    <View key={group.id}>
                      <Text style={styles.groupTitle}>{group.nameNl}</Text>
                      <View style={styles.groupCard}>
                        {groupItems.map((item, idx) => {
                          const line = lineByItem.get(item.id);
                          const pinned = !!item.matches?.[activeChain]?.user_pinned;
                          const promoActive = pinned && !!line?.promo && line.promo_savings_cents! > 0;
                          const recipes = (item.provenance ?? []).map((p) => p.recipe_title ?? p.title).filter(Boolean);
                          return (
                            <View key={item.id} style={[styles.itemRow, idx < groupItems.length - 1 && styles.itemBorder]}>
                              <Pressable onPress={() => toggle(item)} hitSlop={6}>
                                <View style={[styles.checkbox, item.checked && styles.checkboxOn]}>
                                  {item.checked ? <Check size={12} color={colors.onPrimary} strokeWidth={3} /> : null}
                                </View>
                              </Pressable>
                              <Pressable style={{ flex: 1, minWidth: 0 }} onPress={() => toggle(item)} onLongPress={() => setDetailItem(item)}>
                                <View style={styles.itemNameRow}>
                                  <Text style={[styles.itemName, item.checked && styles.checkedText]} numberOfLines={1}>
                                    {item.name}
                                    {qtyLabel(item)}
                                  </Text>
                                  {members.length > 1 && item.added_by ? (
                                    <View style={styles.byChip}>
                                      <Text style={styles.byChipText}>{initialOf(item.added_by)}</Text>
                                    </View>
                                  ) : null}
                                  {recipes.length > 1 ? (
                                    <Text style={styles.mergedBadge}>{recipes.length} recepten</Text>
                                  ) : null}
                                  {promoActive ? <Text style={styles.bonusBadge}>Bonus</Text> : null}
                                </View>
                                {!item.checked ? (
                                  pinned && line?.product_name ? (
                                    <Text style={styles.subline} numberOfLines={1}>
                                      {line.product_name} · door jou gekozen{line.packs && line.packs > 1 ? ` · ${line.packs}×` : ''}
                                    </Text>
                                  ) : recipes.length ? (
                                    <Text style={styles.subline} numberOfLines={1}>uit: {recipes.join(' + ')}</Text>
                                  ) : null
                                ) : null}
                              </Pressable>
                              {/* de user bepaalt: zonder keuze geen productprijs, wel een duidelijke knop */}
                              <Pressable onPress={() => setDetailItem(item)} hitSlop={8} style={styles.priceCol}>
                                {pinned && line?.matched && line.line_price_cents !== undefined ? (
                                  <>
                                    {promoActive ? (
                                      <Text style={styles.oldPrice}>
                                        {formatEuroCents(line.line_price_cents + (line.promo_savings_cents ?? 0))}
                                      </Text>
                                    ) : null}
                                    <Text style={[styles.price, item.checked && { color: '#B9C0B2' }]}>
                                      {formatEuroCents(line.line_price_cents)}
                                    </Text>
                                  </>
                                ) : (
                                  <View style={styles.choosePill}>
                                    <Text style={styles.choosePillText}>Kies</Text>
                                  </View>
                                )}
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
              <Text style={[type.meta, { textAlign: 'center', marginTop: 20 }]}>
                Nog geen boodschappen op {dutchDate(selectedDate)}. Typ hierboven je eerste item.
              </Text>
            )}
          </>
        ) : (
          <Text style={[type.meta, { textAlign: 'center', marginTop: 26 }]}>
            Tik een dag aan — puntjes zijn dagen met boodschappen.
          </Text>
        )}
      </ScrollView>

      {/* totaal: alleen wat de user zelf koos; chips blijven de schatting */}
      {list && items.length > 0 && selectedDate ? (
        <View style={[styles.footerWrap, { paddingBottom: insets.bottom + 96 }]}>
          <View style={styles.footerCard}>
            <View style={{ gap: 2, flex: 1 }}>
              <Text style={styles.footerLabel}>Jouw keuzes bij {chainName(activeChain)}</Text>
              <Text style={styles.footerTotal}>{formatEuroCents(chosenTotal.cents)}</Text>
              <Text style={[styles.footerLabel, { color: 'rgba(253,251,246,.75)' }]}>
                {chosenTotal.open > 0
                  ? `${chosenTotal.open} item${chosenTotal.open === 1 ? '' : 's'} nog te kiezen`
                  : 'alles gekozen — geen verrassingen'}
              </Text>
            </View>
          </View>
        </View>
      ) : null}

      {/* item-sheet: hoeveelheid, verwijderen, per-supermarkt, en DE productkeuze */}
      {detailItem ? (
        <View style={[styles.sheet, { paddingBottom: insets.bottom + 100 }]}>
          <View style={styles.sheetHeader}>
            {/* naam is bewerkbaar — user-tekst wint, schap/match herleiden mee */}
            <TextInput
              style={styles.nameEdit}
              value={nameDraft}
              onChangeText={setNameDraft}
              onEndEditing={() => renameItem(detailItem)}
              onSubmitEditing={() => renameItem(detailItem)}
              returnKeyType="done"
            />
            <Pressable onPress={() => setDetailItem(null)} hitSlop={10}>
              <X size={20} color={colors.textSoft} />
            </Pressable>
          </View>

          <View style={styles.qtyRow}>
            <View style={styles.qtyStepper}>
              <Pressable onPress={() => bumpQty(detailItem, -1)} hitSlop={8} style={styles.qtyBtn}>
                <Minus size={15} color={colors.text} strokeWidth={2.2} />
              </Pressable>
              <Text style={styles.qtyValue}>
                {String(detailItem.quantity ?? 1).replace('.', ',')}{detailItem.unit ? ` ${detailItem.unit}` : '×'}
              </Text>
              <Pressable onPress={() => bumpQty(detailItem, 1)} hitSlop={8} style={styles.qtyBtn}>
                <Plus size={15} color={colors.text} strokeWidth={2.2} />
              </Pressable>
            </View>
            <Pressable style={styles.removeBtn} onPress={() => removeItem(detailItem)}>
              <Trash2 size={15} color={colors.danger} strokeWidth={2} />
              <Text style={styles.removeText}>Verwijder</Text>
            </Pressable>
          </View>

          <Text style={styles.sheetSection}>KIES JOUW PRODUCT BIJ {chainName(activeChain).toUpperCase()}</Text>
          <ScrollView style={{ maxHeight: 300 }} showsVerticalScrollIndicator={false}>
            <ProductOptions
              term={detailItem.item_normalised ?? detailItem.name}
              chain={activeChain}
              currentSku={detailItem.matches?.[activeChain]?.user_pinned ? detailItem.matches[activeChain]!.sku_id : null}
              onPick={(o) => pinProduct(detailItem, o)}
            />
          </ScrollView>

          <Text style={styles.sheetSection}>PER SUPERMARKT (JOUW KEUZE)</Text>
          {(pricing ?? [])
            .filter((c) => ALL_CHAINS.includes(c.chain_id))
            .map((c) => {
              const line = c.lines.find((l) => l.item_id === detailItem.id);
              const chosenHere = !!detailItem.matches?.[c.chain_id]?.user_pinned;
              const brand = CHAIN_BRAND[c.chain_id]!;
              return (
                <View key={c.chain_id} style={styles.variantRow}>
                  <View style={[styles.chainDot, { backgroundColor: brand.bg }]}>
                    <Text style={[styles.chainDotText, { color: brand.fg }]}>{chainChip(c.chain_id)}</Text>
                  </View>
                  <Text style={[styles.subline, { flex: 1, fontSize: 12 }]} numberOfLines={1}>
                    {chosenHere && line?.matched ? line.product_name : 'nog geen keuze'}
                  </Text>
                  <Text style={styles.price}>
                    {chosenHere && line?.matched && line.line_price_cents !== undefined
                      ? formatEuroCents(line.line_price_cents)
                      : '—'}
                  </Text>
                </View>
              );
            })}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { paddingHorizontal: 20, paddingBottom: 220, gap: 10 },
  title: { fontFamily: fonts.display, fontSize: 29, lineHeight: 32, color: colors.text },
  calCard: {
    backgroundColor: colors.surface, borderRadius: 18, padding: 14, gap: 8,
    borderWidth: 1, borderColor: 'rgba(34,48,30,.08)',
  },
  calHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  calMonth: { fontFamily: fonts.bodySemiBold, fontSize: 14, color: colors.text, textTransform: 'capitalize' },
  calWeekRow: { flexDirection: 'row' },
  calWeekday: { flex: 1, textAlign: 'center', fontSize: 10.5, fontFamily: fonts.bodyBold, color: colors.textMuted },
  calGrid: { flexDirection: 'row', flexWrap: 'wrap' },
  calCell: { width: `${100 / 7}%`, alignItems: 'center', paddingVertical: 3, gap: 2 },
  calDay: { width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
  calToday: { borderWidth: 1.5, borderColor: colors.primary },
  calSelected: { backgroundColor: colors.primary },
  calDayText: { fontSize: 12.5, color: colors.text },
  calDot: { width: 5, height: 5, borderRadius: 3, backgroundColor: colors.primary },
  dayHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 4 },
  dayTitle: { fontFamily: fonts.display, fontSize: 21, lineHeight: 25, color: colors.text },
  tabs: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  tab: {
    paddingHorizontal: 14, paddingVertical: 8, borderRadius: radius.pill,
    backgroundColor: colors.surface, borderWidth: 1, borderColor: 'rgba(34,48,30,.12)',
  },
  tabActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  tabText: { fontFamily: fonts.bodySemiBold, fontSize: 13, color: colors.textSoft },
  tabTextActive: { color: colors.onPrimary },
  quickAddRow: { flexDirection: 'row', gap: 8 },
  quickAddInput: {
    flex: 1, backgroundColor: colors.surface, borderRadius: 13, paddingHorizontal: 13, paddingVertical: 10,
    borderWidth: 1, borderColor: 'rgba(34,48,30,.12)', fontSize: 13.5, color: colors.text,
  },
  quickAddBtn: {
    width: 42, borderRadius: 13, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center',
  },
  metaLine: { fontSize: 12, color: colors.textMuted },
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
  byChip: {
    width: 17, height: 17, borderRadius: 9, backgroundColor: colors.badgeBg,
    alignItems: 'center', justifyContent: 'center',
  },
  byChipText: { fontSize: 9, fontFamily: fonts.bodyBold, color: colors.primary },
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
  choosePill: {
    paddingHorizontal: 11, paddingVertical: 6, borderRadius: radius.pill,
    backgroundColor: colors.badgeBg, borderWidth: 1, borderColor: 'rgba(46,107,62,.25)',
  },
  choosePillText: { fontSize: 11.5, fontFamily: fonts.bodyBold, color: colors.primary },
  footerWrap: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 20 },
  footerCard: {
    backgroundColor: '#22301E', borderRadius: 18, padding: 14, flexDirection: 'row',
    alignItems: 'center', justifyContent: 'space-between', gap: 10,
    shadowColor: '#22301E', shadowOpacity: 0.3, shadowRadius: 28, shadowOffset: { width: 0, height: 12 }, elevation: 10,
  },
  footerLabel: { fontSize: 11, color: 'rgba(253,251,246,.6)' },
  footerTotal: { fontSize: 19, fontFamily: fonts.bodyBold, color: '#FDFBF6' },
  sheet: {
    position: 'absolute', left: 0, right: 0, bottom: 0, backgroundColor: colors.surface,
    borderTopLeftRadius: 22, borderTopRightRadius: 22, padding: 20, gap: 9,
    shadowColor: '#000', shadowOpacity: 0.14, shadowRadius: 18, shadowOffset: { width: 0, height: -6 }, elevation: 12,
  },
  sheetHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  nameEdit: {
    flex: 1, fontSize: 16, fontFamily: fonts.bodyBold, color: colors.text, padding: 0,
    borderBottomWidth: 1, borderBottomColor: 'rgba(34,48,30,.15)', paddingBottom: 3,
  },
  sheetSection: {
    fontSize: 11, fontFamily: fonts.bodyBold, letterSpacing: 0.6, color: colors.textMuted, marginTop: 8,
  },
  qtyRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  qtyStepper: {
    flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: colors.bg,
    borderRadius: radius.pill, paddingHorizontal: 8, paddingVertical: 5,
    borderWidth: 1, borderColor: 'rgba(34,48,30,.1)',
  },
  qtyBtn: {
    width: 26, height: 26, borderRadius: 13, backgroundColor: colors.surface, alignItems: 'center',
    justifyContent: 'center', borderWidth: 1, borderColor: 'rgba(34,48,30,.12)',
  },
  qtyValue: { fontSize: 13, fontFamily: fonts.bodySemiBold, color: colors.text, minWidth: 40, textAlign: 'center' },
  removeBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 6, paddingHorizontal: 4 },
  removeText: { fontSize: 12.5, fontFamily: fonts.bodySemiBold, color: colors.danger },
  variantRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 7 },
});
