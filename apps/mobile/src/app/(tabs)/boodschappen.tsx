import { AISLE_GROUPS, formatEuroCents, OVERIG_GROUP_ID } from '@prakkie/shared';
import { Check, ChevronLeft, ChevronRight, Minus, Plus, Search, Trash2, X } from 'lucide-react-native';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  CrossChainOptions,
  CrossChainRow,
  useCrossChainOptions,
  type CrossChainOption,
} from '../../components/prakkie/ProductOptions';
import { deleteRow, newId, syncNow, upsertRow, useEntityRows } from '../../data';
import { authedRequest } from '../../data/api';
import { addDays, CHAIN_BRAND, chainChip, chainName, mondayOf, weekRangeLabel } from '../../data/chains';
import { activeHouseholdId, loadHousehold, memberName, type MemberInfo } from '../../data/households';
import { kv } from '../../data/kv';
import { confirmDialog } from '../../lib/dialogs';
import { colors, fonts, radius, type } from '../../theme/tokens';

/**
 * Boodschappen (owner UX 2026-07-07, tweede iteratie):
 *  - week-strip (7 dagen, pijlen ← →) met puntjes op dagen met een lijst;
 *  - zoek-eerst: één zoekbalk, resultaten uit ál je supers in één lijst,
 *    goedkoopste bovenaan — tikken = op de lijst mét jouw productkeuze;
 *  - één lijst (per schap), géén per-supermarkt-tabs meer;
 *  - "Waar ga je halen?": alles-bij-X totalen per super + slim verdelen
 *    over 2+ winkels met de besparing erbij — de user beslist;
 *  - de app kiest NOOIT een product; huishouden-log blijft.
 */

interface ListRow { id: string; name: string; week_start?: string | null; household_id?: string | null }
interface MatchEntry { sku_id: string; confidence?: number; user_pinned?: boolean; preferred?: boolean }
interface ItemRow {
  id: string; list_id: string; name: string; quantity: number | string | null; unit: string | null;
  aisle_group_id: number | null; checked: boolean; is_manual: boolean;
  item_normalised?: string | null;
  matches?: Record<string, MatchEntry>;
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

const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const dutchDate = (isoDate: string) => {
  const d = new Date(`${isoDate}T12:00:00`);
  return `${d.getDate()} ${MONTHS_NL[d.getMonth()]}`;
};

/** de keuze van de user voor dit item: eerst expliciet verkozen, dan gepind */
function chosenChainOf(item: ItemRow, myChains: string[]): string | null {
  const m = item.matches ?? {};
  const preferred = Object.keys(m).find((c) => m[c]?.preferred && m[c]?.user_pinned);
  if (preferred) return preferred;
  return [...myChains, ...Object.keys(m)].find((c) => m[c]?.user_pinned) ?? null;
}

export default function BoodschappenScreen() {
  const insets = useSafeAreaInsets();
  const { rows: listRows } = useEntityRows('lists');
  const { rows: itemRows } = useEntityRows('list_items');
  const [weekOffset, setWeekOffset] = useState(0);
  const [selectedDate, setSelectedDate] = useState<string>(todayIso());
  const [activeListId, setActiveListId] = useState<string | null>(null);
  const [myChains, setMyChains] = useState<string[]>(['ah']);
  const [pricing, setPricing] = useState<ChainPricing[] | null>(null);
  const [detailItem, setDetailItem] = useState<ItemRow | null>(null);
  const [nameDraft, setNameDraft] = useState('');
  const [search, setSearch] = useState('');
  const [searchDebounced, setSearchDebounced] = useState('');
  const [members, setMembers] = useState<MemberInfo[]>([]);

  // naam-bewerken in de item-sheet: draft volgt het geopende item
  useEffect(() => {
    setNameDraft(detailItem?.name ?? '');
  }, [detailItem?.id]);

  useEffect(() => {
    const t = setTimeout(() => setSearchDebounced(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  // jouw supers uit Profiel: kv-cache direct, /v1/me als waarheid
  useEffect(() => {
    (async () => {
      try {
        const cached = await kv.getItem('prakkie.mychains');
        if (cached) {
          const arr = (JSON.parse(cached) as string[]).filter((c) => ALL_CHAINS.includes(c));
          if (arr.length) setMyChains(arr);
        }
      } catch { /* cache is optioneel */ }
      try {
        const res = await authedRequest('/v1/me');
        if (res.ok) {
          const me = (await res.json()) as { home_chain_ids?: string[] };
          const arr = (me.home_chain_ids ?? []).filter((c) => ALL_CHAINS.includes(c));
          if (arr.length) {
            setMyChains(arr);
            kv.setItem('prakkie.mychains', JSON.stringify(arr)).catch(() => {});
          }
        }
      } catch { /* offline: cache/fallback */ }
    })();
    loadHousehold().then((h) => setMembers(h.members)).catch(() => {});
  }, []);

  const lists = useMemo(
    () => listRows.map((r) => ({ ...(r.row as unknown as ListRow), id: r.id })),
    [listRows]
  );
  const dateOf = (l: ListRow) => (l.week_start ?? '').slice(0, 10);
  const dotDates = useMemo(() => new Set(lists.map(dateOf).filter(Boolean)), [lists]);

  // week-strip: 7 dagen, pijlen wisselen van week
  const weekStart = useMemo(() => mondayOf(weekOffset), [weekOffset]);
  const weekDays = useMemo(
    () => [0, 1, 2, 3, 4, 5, 6].map((i) => addDays(weekStart, i)),
    [weekStart]
  );
  function shiftWeek(delta: number) {
    const idx = weekDays.indexOf(selectedDate);
    const next = mondayOf(weekOffset + delta);
    setWeekOffset(weekOffset + delta);
    setSelectedDate(addDays(next, idx >= 0 ? idx : 0)); // zelfde weekdag in de nieuwe week
  }
  function jumpToToday() {
    setWeekOffset(0);
    setSelectedDate(todayIso());
  }

  const dayLists = useMemo(
    () => lists.filter((l) => dateOf(l) === selectedDate),
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
      const res = await authedRequest(`/v1/lists/${list.id}/price?chains=${myChains.join(',')}`);
      if (res.ok) setPricing(((await res.json()) as { chains: ChainPricing[] }).chains);
    } catch {
      /* offline — lijst blijft bruikbaar */
    }
  }, [list?.id, items.length, myChains.join(',')]);

  useEffect(() => {
    const t = setTimeout(refreshPricing, 350);
    return () => clearTimeout(t);
  }, [refreshPricing, checkedCount]);

  // prijsregels per keten per item
  const linesByChain = useMemo(() => {
    const m = new Map<string, Map<string, PricedLine>>();
    for (const c of pricing ?? []) m.set(c.chain_id, new Map(c.lines.map((l) => [l.item_id, l])));
    return m;
  }, [pricing]);

  const lineFor = (item: ItemRow, chain: string | null) =>
    chain ? linesByChain.get(chain)?.get(item.id) : undefined;

  // "de app doet nooit een voorspelling": het hoofdtotaal telt alleen door de
  // user gekozen producten — bij de keten waar de user ze koos.
  const chosenTotal = useMemo(() => {
    let cents = 0;
    let chosen = 0;
    for (const item of items) {
      const chain = chosenChainOf(item, myChains);
      const line = lineFor(item, chain);
      if (chain && line?.matched && line.line_price_cents != null) {
        cents += line.line_price_cents;
        chosen++;
      }
    }
    return { cents, chosen, open: items.length - chosen };
  }, [items, linesByChain, myChains]);

  // Waar ga je halen? — alles-bij-X per super + slim verdelen over winkels
  const storeAdvice = useMemo(() => {
    if (!pricing || items.length === 0) return null;
    const singles = myChains
      .map((c) => pricing.find((p) => p.chain_id === c))
      .filter((p): p is ChainPricing => !!p)
      .sort((a, b) => a.unmatched.length - b.unmatched.length || a.total_cents - b.total_cents);
    if (!singles.length) return null;
    const best = singles[0]!;

    let split: { total: number; counts: Map<string, number>; missing: number } | null = null;
    if (myChains.length >= 2) {
      let total = 0;
      let missing = 0;
      const counts = new Map<string, number>();
      for (const item of items) {
        let bestLine: { chain: string; cents: number } | null = null;
        for (const c of myChains) {
          const l = linesByChain.get(c)?.get(item.id);
          if (l?.matched && l.line_price_cents != null && (bestLine === null || l.line_price_cents < bestLine.cents)) {
            bestLine = { chain: c, cents: l.line_price_cents };
          }
        }
        if (!bestLine) { missing++; continue; }
        total += bestLine.cents;
        counts.set(bestLine.chain, (counts.get(bestLine.chain) ?? 0) + 1);
      }
      split = { total, counts, missing };
    }
    const savings = split ? best.total_cents - split.total : 0;
    return { singles, best, split, savings };
  }, [pricing, items, myChains, linesByChain]);

  const groups = useMemo(() => {
    const byAisle = new Map<number, ItemRow[]>();
    for (const item of items) {
      const key = item.aisle_group_id ?? OVERIG_GROUP_ID;
      (byAisle.get(key) ?? byAisle.set(key, []).get(key)!).push(item);
    }
    return AISLE_GROUPS.filter((g) => byAisle.has(g.id)).map((g) => ({ group: g, items: byAisle.get(g.id)! }));
  }, [items]);

  // zoekresultaten over ál je supers, goedkoopste eerst
  const searchOptions = useCrossChainOptions(searchDebounced || null, myChains);

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

  /** zoek-eerst: op de lijst — mét productkeuze (tap op resultaat) of zonder. */
  async function addFromSearch(option?: CrossChainOption) {
    const typed = search.trim();
    if (!typed) return;
    setSearch('');
    setSearchDebounced('');
    const listId = list?.id ?? (await newList(selectedDate));
    const itemId = newId();
    await upsertRow(
      'list_items',
      {
        list_id: listId,
        name: typed,
        is_manual: true,
        ...(option
          ? { matches: { [option.chain]: { sku_id: option.sku_id, confidence: 1, user_pinned: true, preferred: true } } }
          : {}),
      },
      itemId
    );
    if (option) {
      await upsertRow('match_corrections', {
        chain_id: option.chain,
        item_normalised: typed.toLowerCase(),
        chosen_sku_id: option.sku_id,
      });
    }
    syncNow(['list_items', 'match_corrections']).catch(() => {});
    // verrijking (hoeveelheid/schap/normalisatie) — offline blijft het item gewoon staan
    try {
      const res = await authedRequest(`/v1/match?item=${encodeURIComponent(typed)}&chains=${myChains[0]}`);
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
      }
    } catch { /* offline: item blijft onder Overig */ }
    refreshPricing();
  }

  /** productkeuze (cross-chain): de gekozen keten wordt dé keten van dit item. */
  async function pinProduct(item: ItemRow, option: CrossChainOption) {
    const matches: Record<string, MatchEntry> = {};
    for (const [c, entry] of Object.entries(item.matches ?? {})) {
      const { preferred: _preferred, ...rest } = entry;
      matches[c] = rest;
    }
    matches[option.chain] = { sku_id: option.sku_id, confidence: 1, user_pinned: true, preferred: true };
    await upsertRow('list_items', { list_id: item.list_id, name: item.name, matches }, item.id);
    await upsertRow('match_corrections', {
      chain_id: option.chain,
      item_normalised: item.item_normalised ?? item.name.toLowerCase(),
      chosen_sku_id: option.sku_id,
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
      const res = await authedRequest(`/v1/match?item=${encodeURIComponent(next)}&chains=${myChains[0]}`);
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
  const chainDot = (c: string, size = 18) => {
    const brand = CHAIN_BRAND[c];
    if (!brand) return null;
    return (
      <View style={[styles.chainDot, { backgroundColor: brand.bg, width: size, height: size, borderRadius: size / 2 }]}>
        <Text style={[styles.chainDotText, { color: brand.fg, fontSize: size < 20 ? 7 : 8 }]}>{chainChip(c)}</Text>
      </View>
    );
  };

  const searching = searchDebounced.length > 0;

  return (
    <View style={[styles.screen, { paddingTop: insets.top + 8 }]}>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
        <Text style={styles.title}>Boodschappen</Text>

        {/* week-strip: 7 dagen, puntjes = dagen met een lijst */}
        <View style={styles.weekCard}>
          <View style={styles.weekHeader}>
            <Pressable onPress={() => shiftWeek(-1)} hitSlop={10} accessibilityLabel="Vorige week">
              <ChevronLeft size={18} color={colors.primary} strokeWidth={2.2} />
            </Pressable>
            <Pressable onPress={jumpToToday} hitSlop={6} accessibilityLabel="Naar vandaag">
              <Text style={styles.weekLabel}>{weekRangeLabel(weekStart)}</Text>
            </Pressable>
            <Pressable onPress={() => shiftWeek(1)} hitSlop={10} accessibilityLabel="Volgende week">
              <ChevronRight size={18} color={colors.primary} strokeWidth={2.2} />
            </Pressable>
          </View>
          <View style={styles.weekRow}>
            {weekDays.map((date, i) => {
              const selected = date === selectedDate;
              const isToday = date === todayIso();
              return (
                <Pressable key={date} style={styles.weekCell} onPress={() => setSelectedDate(date)}>
                  <Text style={[styles.weekdayLabel, selected && { color: colors.primary }]}>{DAYS_NL[i]}</Text>
                  <View style={[styles.weekDay, isToday && styles.weekToday, selected && styles.weekSelected]}>
                    <Text style={[styles.weekDayText, selected && { color: colors.onPrimary, fontFamily: fonts.bodyBold }]}>
                      {Number(date.slice(8))}
                    </Text>
                  </View>
                  <View style={[styles.weekDot, { opacity: dotDates.has(date) ? 1 : 0 }]} />
                </Pressable>
              );
            })}
          </View>
        </View>

        <View style={styles.dayHeader}>
          <Text style={styles.dayTitle}>{dutchDate(selectedDate)}</Text>
          {list ? (
            <Pressable onPress={() => removeList(list)} hitSlop={10} accessibilityLabel="Lijst verwijderen">
              <Trash2 size={16} color={colors.danger} strokeWidth={2} />
            </Pressable>
          ) : null}
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

        {/* zoek-eerst: één balk voor ál je supers — werkt ook zonder lijst */}
        <View style={styles.searchBar}>
          <Search size={15} color="#97A08F" strokeWidth={2.2} />
          <TextInput
            style={styles.searchInput}
            placeholder="Zoek en vergelijk: melk, roomboter, hagelslag…"
            placeholderTextColor="#97A08F"
            value={search}
            onChangeText={setSearch}
            onSubmitEditing={() => addFromSearch()}
            returnKeyType="done"
            autoCapitalize="none"
          />
          {search ? (
            <Pressable onPress={() => { setSearch(''); setSearchDebounced(''); }} hitSlop={8}>
              <X size={15} color="#97A08F" />
            </Pressable>
          ) : null}
        </View>

        {searching ? (
          <View style={styles.resultsCard}>
            {/* zonder keuze kan altijd — kies later, of laat 'm gewoon staan */}
            <Pressable style={styles.plainAddRow} onPress={() => addFromSearch()}>
              <View style={styles.plainAddIcon}>
                <Plus size={14} color={colors.primary} strokeWidth={2.6} />
              </View>
              <Text style={styles.plainAddText}>
                Zet “{searchDebounced}” op de lijst <Text style={{ color: '#97A08F' }}>— product later kiezen</Text>
              </Text>
            </Pressable>
            {searchOptions === null ? (
              <Text style={[type.meta, { paddingVertical: 10 }]}>Prijzen vergelijken…</Text>
            ) : searchOptions.length === 0 ? (
              <Text style={[type.meta, { paddingVertical: 10 }]}>
                Geen producten gevonden bij {myChains.map(chainName).join(', ')}.
              </Text>
            ) : (
              searchOptions.slice(0, 8).map((o) => (
                <CrossChainRow key={`${o.chain}:${o.sku_id}`} option={o} onPick={(opt) => addFromSearch(opt)} />
              ))
            )}
          </View>
        ) : null}

        {list ? (
          <>
            <Text style={styles.metaLine}>
              {items.length} items · {checkedCount} afgevinkt
              {lastAdded ? ` · laatst: ${lastAdded.who} — ${lastAdded.what}` : ''}
            </Text>

            {groups.length === 0 ? (
              <Text style={[type.meta, { textAlign: 'center', marginTop: 30 }]}>
                Nog niets op de lijst. Zoek hierboven, of voeg toe vanuit een recept of het weekmenu.
              </Text>
            ) : (
              groups.map(({ group, items: groupItems }) => (
                <View key={group.id}>
                  <Text style={styles.groupTitle}>{group.nameNl}</Text>
                  <View style={styles.groupCard}>
                    {groupItems.map((item, idx) => {
                      const chain = chosenChainOf(item, myChains);
                      const line = lineFor(item, chain);
                      const pinned = !!chain;
                      const promoActive = pinned && !!line?.promo && (line?.promo_savings_cents ?? 0) > 0;
                      const recipes = (item.provenance ?? []).map((p) => p.recipe_title ?? p.title).filter(Boolean);
                      return (
                        <View key={item.id} style={[styles.itemRow, idx < groupItems.length - 1 && styles.itemBorder]}>
                          <Pressable onPress={() => toggle(item)} hitSlop={6}>
                            <View style={[styles.checkbox, item.checked && styles.checkboxOn]}>
                              {item.checked ? <Check size={12} color={colors.onPrimary} strokeWidth={3} /> : null}
                            </View>
                          </Pressable>
                          <Pressable style={{ flex: 1, minWidth: 0 }} onPress={() => setDetailItem(item)}>
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
                                  {line.product_name} · {chainName(chain!)}{line.packs && line.packs > 1 ? ` · ${line.packs}×` : ''}
                                </Text>
                              ) : recipes.length ? (
                                <Text style={styles.subline} numberOfLines={1}>uit: {recipes.join(' + ')}</Text>
                              ) : null
                            ) : null}
                          </Pressable>
                          {/* de user bepaalt: zonder keuze geen productprijs, wel een duidelijke knop */}
                          <Pressable onPress={() => setDetailItem(item)} hitSlop={8} style={styles.priceCol}>
                            {pinned && line?.matched && line.line_price_cents !== undefined ? (
                              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                                {chainDot(chain!, 16)}
                                <View style={{ alignItems: 'flex-end', gap: 1 }}>
                                  {promoActive ? (
                                    <Text style={styles.oldPrice}>
                                      {formatEuroCents(line.line_price_cents + (line.promo_savings_cents ?? 0))}
                                    </Text>
                                  ) : null}
                                  <Text style={[styles.price, item.checked && { color: '#B9C0B2' }]}>
                                    {formatEuroCents(line.line_price_cents)}
                                  </Text>
                                </View>
                              </View>
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

            {/* Waar ga je halen? — de dualiteit: 1 winkel vs slim verdelen */}
            {storeAdvice ? (
              <View style={{ marginTop: 6 }}>
                <Text style={styles.groupTitle}>WAAR GA JE HALEN?</Text>
                <View style={styles.groupCard}>
                  {storeAdvice.singles.map((s, idx) => (
                    <View key={s.chain_id} style={[styles.adviceRow, (idx < storeAdvice.singles.length - 1 || storeAdvice.split) && styles.itemBorder]}>
                      {chainDot(s.chain_id, 22)}
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <Text style={styles.adviceName}>
                          Alles bij {chainName(s.chain_id)}
                          {s.chain_id === storeAdvice.best.chain_id ? <Text style={styles.adviceBest}>  · voordeligste</Text> : null}
                        </Text>
                        {s.unmatched.length > 0 ? (
                          <Text style={styles.subline}>{s.unmatched.length} item{s.unmatched.length === 1 ? '' : 's'} niet gevonden</Text>
                        ) : null}
                      </View>
                      <Text style={styles.advicePrice}>± {formatEuroCents(s.total_cents)}</Text>
                    </View>
                  ))}
                  {storeAdvice.split ? (
                    <View style={styles.adviceRow}>
                      <View style={styles.splitIcon}>
                        <Text style={styles.splitIconText}>{storeAdvice.split.counts.size}×</Text>
                      </View>
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <Text style={styles.adviceName}>
                          Slim verdelen
                          {storeAdvice.savings > 0 ? (
                            <Text style={styles.adviceSave}>  · bespaar {formatEuroCents(storeAdvice.savings)}</Text>
                          ) : null}
                        </Text>
                        <Text style={styles.subline} numberOfLines={1}>
                          {storeAdvice.savings > 0
                            ? [...storeAdvice.split.counts.entries()].map(([c, n]) => `${chainName(c)} ${n}`).join(' · ')
                            : 'één winkel is hier al het voordeligst'}
                        </Text>
                      </View>
                      {storeAdvice.savings > 0 ? (
                        <Text style={[styles.advicePrice, { color: colors.primary }]}>± {formatEuroCents(storeAdvice.split.total)}</Text>
                      ) : null}
                    </View>
                  ) : null}
                </View>
                <Text style={styles.adviceFootnote}>
                  ± schatting op beste match per item — jouw eigen keuzes tellen exact mee.
                </Text>
              </View>
            ) : null}
          </>
        ) : (
          <Text style={[type.meta, { textAlign: 'center', marginTop: 20 }]}>
            Nog geen boodschappen op {dutchDate(selectedDate)}. Zoek hierboven je eerste item — de lijst maakt zichzelf.
          </Text>
        )}
      </ScrollView>

      {/* totaal: alleen wat de user zelf koos */}
      {list && items.length > 0 ? (
        <View style={[styles.footerWrap, { paddingBottom: insets.bottom + 96 }]}>
          <View style={styles.footerCard}>
            <View style={{ gap: 2, flex: 1 }}>
              <Text style={styles.footerLabel}>Jouw keuzes ({chosenTotal.chosen} van {items.length})</Text>
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

      {/* item-sheet: hoeveelheid, verwijderen, en DE productkeuze over ál je supers */}
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

          <Text style={styles.sheetSection}>KIES JOUW PRODUCT — GOEDKOOPSTE EERST</Text>
          <ScrollView style={{ maxHeight: 320 }} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
            <CrossChainOptions
              term={detailItem.item_normalised ?? detailItem.name}
              chains={myChains}
              currentSku={(() => {
                const c = chosenChainOf(detailItem, myChains);
                return c ? detailItem.matches?.[c]?.sku_id ?? null : null;
              })()}
              onPick={(o) => pinProduct(detailItem, o)}
            />
          </ScrollView>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { paddingHorizontal: 20, paddingBottom: 220, gap: 10 },
  title: { fontFamily: fonts.display, fontSize: 29, lineHeight: 32, color: colors.text },
  weekCard: {
    backgroundColor: colors.surface, borderRadius: 18, padding: 12, gap: 8,
    borderWidth: 1, borderColor: 'rgba(34,48,30,.08)',
  },
  weekHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 2 },
  weekLabel: { fontFamily: fonts.bodySemiBold, fontSize: 13.5, color: colors.text },
  weekRow: { flexDirection: 'row' },
  weekCell: { flex: 1, alignItems: 'center', gap: 3 },
  weekdayLabel: { fontSize: 10, fontFamily: fonts.bodyBold, color: colors.textMuted },
  weekDay: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  weekToday: { borderWidth: 1.5, borderColor: colors.primary },
  weekSelected: { backgroundColor: colors.primary },
  weekDayText: { fontSize: 13, color: colors.text },
  weekDot: { width: 5, height: 5, borderRadius: 3, backgroundColor: colors.primary },
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
  searchBar: {
    flexDirection: 'row', alignItems: 'center', gap: 9, backgroundColor: colors.surface,
    borderRadius: 13, paddingHorizontal: 13, paddingVertical: 11,
    borderWidth: 1, borderColor: 'rgba(34,48,30,.12)',
  },
  searchInput: { flex: 1, fontSize: 13.5, color: colors.text, padding: 0 },
  resultsCard: {
    backgroundColor: colors.surface, borderWidth: 1, borderColor: 'rgba(34,48,30,.08)',
    borderRadius: 16, paddingHorizontal: 10, paddingVertical: 6,
  },
  plainAddRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 9, paddingHorizontal: 4,
    borderBottomWidth: 1, borderBottomColor: 'rgba(34,48,30,.06)',
  },
  plainAddIcon: {
    width: 28, height: 28, borderRadius: 14, backgroundColor: colors.badgeBg,
    alignItems: 'center', justifyContent: 'center',
  },
  plainAddText: { flex: 1, fontSize: 12.5, color: colors.text, fontFamily: fonts.bodySemiBold },
  metaLine: { fontSize: 12, color: colors.textMuted },
  chainDot: { alignItems: 'center', justifyContent: 'center' },
  chainDotText: { fontFamily: fonts.bodyBold },
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
  adviceRow: { flexDirection: 'row', alignItems: 'center', gap: 11, paddingHorizontal: 14, paddingVertical: 11 },
  adviceName: { fontSize: 13.5, color: colors.text, fontFamily: fonts.bodySemiBold },
  adviceBest: { fontSize: 10.5, color: colors.primary, fontFamily: fonts.bodyBold },
  adviceSave: { fontSize: 10.5, color: colors.primary, fontFamily: fonts.bodyBold },
  advicePrice: { fontSize: 13.5, fontFamily: fonts.bodyBold, color: colors.text },
  adviceFootnote: { fontSize: 10, color: colors.textMuted, marginTop: 6, paddingHorizontal: 2 },
  splitIcon: {
    width: 22, height: 22, borderRadius: 11, backgroundColor: colors.badgeBg,
    alignItems: 'center', justifyContent: 'center',
  },
  splitIconText: { fontSize: 8.5, fontFamily: fonts.bodyBold, color: colors.primary },
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
});
