import { AISLE_GROUPS, formatEuroCents, OVERIG_GROUP_ID } from '@prakkie/shared';
import { Check, RefreshCw } from 'lucide-react-native';
import { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ScreenHeader } from '../../components/prakkie/ScreenHeader';
import { newId, syncNow, upsertRow, useEntityRows } from '../../data';
import { authedRequest } from '../../data/api';
import { colors, radius, type } from '../../theme/tokens';

interface ListItemRow {
  id: string;
  list_id: string;
  name: string;
  quantity: number | string | null;
  unit: string | null;
  aisle_group_id: number | null;
  checked: boolean;
  is_manual: boolean;
  provenance?: { title?: string }[];
}

/** Lijst — mockup 06: aisle-grouped items, check-off (G8), price footer + cheaper-elsewhere teaser. */
export default function LijstScreen() {
  const insets = useSafeAreaInsets();
  const { rows: lists } = useEntityRows('lists');
  const { rows: itemRows } = useEntityRows('list_items');
  const [activeList, setActiveList] = useState<string | null>(null);
  const [pricing, setPricing] = useState<{ chain_id: string; total_cents: number; unmatched: string[] }[] | null>(null);

  const list = lists.find((l) => l.id === activeList) ?? lists[0] ?? null;
  const items = useMemo(
    () => itemRows.map((r) => r.row as unknown as ListItemRow).filter((i) => list && i.list_id === list.id),
    [itemRows, list]
  );
  const checkedCount = items.filter((i) => i.checked).length;

  useEffect(() => {
    if (!list || items.length === 0) {
      setPricing(null);
      return;
    }
    const timer = setTimeout(async () => {
      try {
        await syncNow(['lists', 'list_items']); // push local edits so pricing sees them
        const res = await authedRequest(`/v1/lists/${list.id}/price`);
        if (res.ok) {
          const body = (await res.json()) as { chains: { chain_id: string; total_cents: number; unmatched: string[] }[] };
          setPricing(body.chains);
        }
      } catch {
        /* offline: the list itself keeps working; pricing arrives on reconnect */
      }
    }, 400);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list?.id, items.length, checkedCount]);

  const groups = useMemo(() => {
    const byAisle = new Map<number, ListItemRow[]>();
    for (const item of items) {
      const key = item.aisle_group_id ?? OVERIG_GROUP_ID;
      (byAisle.get(key) ?? byAisle.set(key, []).get(key)!).push(item);
    }
    return AISLE_GROUPS.filter((g) => byAisle.has(g.id)).map((g) => ({ group: g, items: byAisle.get(g.id)! }));
  }, [items]);

  const cheapest = pricing?.length ? [...pricing].sort((a, b) => a.total_cents - b.total_cents)[0] : null;
  const primary = pricing?.[0] ?? null;

  async function toggle(item: ListItemRow) {
    await upsertRow('list_items', { list_id: item.list_id, name: item.name, checked: !item.checked }, item.id);
    syncNow(['list_items']).catch(() => {});
  }

  async function newList() {
    const id = newId();
    await upsertRow('lists', { name: `Lijst ${lists.length + 1}` }, id);
    setActiveList(id);
    syncNow(['lists']).catch(() => {});
  }

  return (
    <View style={[styles.screen, { paddingTop: insets.top + 8 }]}>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <ScreenHeader title="Boodschappen" contextLine="AH-indeling · live gekoppeld aan weekplan" />

        <View style={styles.tabs}>
          {lists.map((l) => (
            <Pressable key={l.id} onPress={() => setActiveList(l.id)} style={[styles.tab, list?.id === l.id && styles.tabActive]}>
              <Text style={[type.chip, list?.id === l.id && { color: colors.onPrimary }]}>
                {(l.row as { name?: string }).name ?? 'Lijst'}
              </Text>
            </Pressable>
          ))}
          <Pressable onPress={newList} style={styles.tab}>
            <Text style={type.chip}>+ Nieuw</Text>
          </Pressable>
        </View>

        {groups.length === 0 ? (
          <Text style={[type.meta, { textAlign: 'center', marginTop: 40 }]}>
            Nog niets op de lijst. Voeg toe vanuit een recept of het weekmenu.
          </Text>
        ) : (
          groups.map(({ group, items: groupItems }) => (
            <View key={group.id} style={styles.group}>
              <Text style={styles.groupTitle}>{group.nameNl}</Text>
              {groupItems.map((item) => (
                <Pressable key={item.id} style={styles.itemRow} onPress={() => toggle(item)}>
                  <View style={[styles.checkbox, item.checked && styles.checkboxOn]}>
                    {item.checked ? <Check size={14} color={colors.onPrimary} strokeWidth={3} /> : null}
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={[type.body, item.checked && styles.checkedText]}>
                      {item.quantity ? `${String(item.quantity).replace('.', ',')}${item.unit ? ` ${item.unit}` : ''} ` : ''}
                      {item.name}
                    </Text>
                    {item.provenance?.length ? (
                      <Text style={type.meta} numberOfLines={1}>
                        {item.provenance.length > 1
                          ? `samengevoegd: ${item.provenance.map((p) => p.title).filter(Boolean).join(' + ')}`
                          : item.provenance[0]?.title}
                      </Text>
                    ) : null}
                  </View>
                </Pressable>
              ))}
            </View>
          ))
        )}
      </ScrollView>

      {primary ? (
        <View style={[styles.footer, { paddingBottom: insets.bottom + 96 }]}>
          <View style={{ flex: 1 }}>
            <Text style={type.h3}>
              {formatEuroCents(primary.total_cents)} <Text style={type.meta}>bij {primary.chain_id.toUpperCase()}</Text>
            </Text>
            {cheapest && cheapest.chain_id !== primary.chain_id && primary.total_cents > cheapest.total_cents ? (
              <Text style={[type.meta, { color: colors.primary }]}>
                {formatEuroCents(primary.total_cents - cheapest.total_cents)} goedkoper bij {cheapest.chain_id.toUpperCase()}
              </Text>
            ) : null}
            {primary.unmatched.length ? (
              <Text style={type.meta}>{primary.unmatched.length} item(s) niet gevonden — geen neptotalen</Text>
            ) : null}
          </View>
          <RefreshCw size={16} color={colors.textMuted} />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { paddingHorizontal: 16, paddingBottom: 200, gap: 12 },
  tabs: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  tab: {
    paddingHorizontal: 14, paddingVertical: 8, borderRadius: radius.pill,
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.borderSubtle,
  },
  tabActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  group: { gap: 2 },
  groupTitle: { ...type.badge, color: colors.textMuted2, letterSpacing: 1, marginTop: 10, marginBottom: 4 },
  itemRow: {
    flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: colors.surface,
    borderRadius: radius.control, padding: 12, marginBottom: 6,
  },
  checkbox: {
    width: 22, height: 22, borderRadius: 7, borderWidth: 2, borderColor: colors.borderSubtle,
    alignItems: 'center', justifyContent: 'center',
  },
  checkboxOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  checkedText: { textDecorationLine: 'line-through', color: colors.textMuted },
  footer: {
    position: 'absolute', left: 0, right: 0, bottom: 0, flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 20, paddingTop: 14, backgroundColor: colors.surface,
    borderTopLeftRadius: radius.card, borderTopRightRadius: radius.card,
    shadowColor: '#000', shadowOpacity: 0.08, shadowRadius: 12, shadowOffset: { width: 0, height: -4 }, elevation: 8,
  },
});
