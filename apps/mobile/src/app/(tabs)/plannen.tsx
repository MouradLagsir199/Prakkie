import { DAY_ABBREV_NL, formatEuroCents } from '@prakkie/shared';
import { useRouter } from 'expo-router';
import { ChevronLeft, ChevronRight, Minus, Plus, ShoppingCart } from 'lucide-react-native';
import { useMemo, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ScreenHeader } from '../../components/prakkie/ScreenHeader';
import { newId, syncNow, upsertRow, useEntityRows, deleteRow } from '../../data';
import { authedRequest } from '../../data/api';
import type { RecipeRowData } from '../../data/recipes';
import { colors, radius, type } from '../../theme/tokens';

/**
 * Plannen — mockup 05: week switcher, MA–ZO rows, per-dish servings, "Zonder
 * datum" strip (H3), CTA → list-generate (H5). Moving a dish = tap the day
 * chips (long-press-free, a11y-first; gesture drag-and-drop is a later polish).
 */

interface PlanRow { id: string; week_start: string }
interface EntryRow {
  id: string; plan_id: string; recipe_id: string; entry_date: string | null;
  meal_slot: string; servings: number;
}

const mondayOf = (offsetWeeks: number): string => {
  const d = new Date();
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7) + offsetWeeks * 7);
  return d.toISOString().slice(0, 10);
};
const addDays = (iso: string, days: number): string => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

export default function PlannenScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const [weekOffset, setWeekOffset] = useState(0);
  const { rows: planRows } = useEntityRows('plans');
  const { rows: entryRows } = useEntityRows('plan_entries');
  const { rows: recipeRows } = useEntityRows('recipes');
  const [moveEntry, setMoveEntry] = useState<EntryRow | null>(null);
  const [generating, setGenerating] = useState(false);

  const weekStart = mondayOf(weekOffset);
  const plan = planRows.map((r) => r.row as unknown as PlanRow).find((p) => p.week_start?.slice(0, 10) === weekStart);
  const entries = useMemo(
    () => entryRows.map((r) => r.row as unknown as EntryRow).filter((e) => plan && e.plan_id === plan.id),
    [entryRows, plan]
  );
  const recipeById = useMemo(() => {
    const m = new Map<string, RecipeRowData>();
    for (const r of recipeRows) m.set(r.id, r.row as unknown as RecipeRowData);
    return m;
  }, [recipeRows]);

  const days = [0, 1, 2, 3, 4, 5, 6].map((i) => ({
    label: DAY_ABBREV_NL[i]!,
    date: addDays(weekStart, i),
  }));
  const undated = entries.filter((e) => !e.entry_date);

  async function setServings(entry: EntryRow, delta: number) {
    const next = Math.max(1, entry.servings + delta);
    await upsertRow('plan_entries', { plan_id: entry.plan_id, recipe_id: entry.recipe_id, servings: next }, entry.id);
    syncNow(['plan_entries']).catch(() => {});
  }

  async function moveTo(date: string | null) {
    if (!moveEntry) return;
    await upsertRow(
      'plan_entries',
      { plan_id: moveEntry.plan_id, recipe_id: moveEntry.recipe_id, servings: moveEntry.servings, entry_date: date },
      moveEntry.id
    );
    setMoveEntry(null);
    syncNow(['plan_entries']).catch(() => {});
  }

  async function makeList() {
    if (entries.length === 0) return;
    setGenerating(true);
    try {
      await syncNow(['plans', 'plan_entries']);
      // one list per week, plan-owned lines re-derived (G4)
      const listId = newId();
      await upsertRow('lists', { name: `Week ${weekStart.slice(5)}` }, listId);
      await syncNow(['lists']);
      const res = await authedRequest(`/v1/lists/${listId}/generate`, {
        method: 'POST',
        body: JSON.stringify({
          recipes: entries.map((e) => ({ recipe_id: e.recipe_id, servings: e.servings })),
          replace_generated: true,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await syncNow(['lists', 'list_items']);
      router.push('/lijst');
    } catch {
      Alert.alert('Lijst maken mislukt', 'Controleer je verbinding en probeer opnieuw.');
    } finally {
      setGenerating(false);
    }
  }

  const renderEntry = (entry: EntryRow) => {
    const recipe = recipeById.get(entry.recipe_id);
    const perPortion = recipe?.price_cache?.per_portion_cents;
    return (
      <Pressable key={entry.id} style={styles.entry} onPress={() => setMoveEntry(entry)} onLongPress={() => {
        Alert.alert('Verwijderen uit weekplan?', recipe?.title ?? '', [
          { text: 'Annuleren', style: 'cancel' },
          { text: 'Verwijderen', style: 'destructive', onPress: async () => { await deleteRow('plan_entries', entry.id); syncNow(['plan_entries']).catch(() => {}); } },
        ]);
      }}>
        <View style={{ flex: 1 }}>
          <Text style={type.body} numberOfLines={1}>{recipe?.title ?? 'Recept'}</Text>
          <Text style={type.meta}>
            {entry.servings} pers.{perPortion ? ` · ${formatEuroCents(perPortion)} p.p.` : ''}
          </Text>
        </View>
        <Pressable onPress={() => setServings(entry, -1)} hitSlop={8} style={styles.srvBtn}>
          <Minus size={14} color={colors.text} />
        </Pressable>
        <Pressable onPress={() => setServings(entry, 1)} hitSlop={8} style={styles.srvBtn}>
          <Plus size={14} color={colors.text} />
        </Pressable>
      </Pressable>
    );
  };

  return (
    <View style={[styles.screen, { paddingTop: insets.top + 8 }]}>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <ScreenHeader title="Weekmenu" contextLine="tik een gerecht om te verplaatsen" />

        <View style={styles.weekRow}>
          <Pressable onPress={() => setWeekOffset(weekOffset - 1)} hitSlop={10}>
            <ChevronLeft size={22} color={colors.text} />
          </Pressable>
          <Text style={type.h3}>
            {weekOffset === 0 ? 'Deze week' : weekOffset === 1 ? 'Volgende week' : `Week van ${weekStart.slice(8)}-${weekStart.slice(5, 7)}`}
          </Text>
          <Pressable onPress={() => setWeekOffset(weekOffset + 1)} hitSlop={10}>
            <ChevronRight size={22} color={colors.text} />
          </Pressable>
        </View>

        {days.map((day) => {
          const dayEntries = entries.filter((e) => e.entry_date === day.date);
          return (
            <View key={day.date} style={styles.dayRow}>
              <Text style={styles.dayLabel}>{day.label}</Text>
              <View style={{ flex: 1, gap: 6 }}>
                {dayEntries.length === 0 ? (
                  <Pressable style={styles.emptySlot} onPress={() => router.push('/')}>
                    <Text style={type.meta}>+ kies een recept</Text>
                  </Pressable>
                ) : (
                  dayEntries.map(renderEntry)
                )}
              </View>
            </View>
          );
        })}

        <Text style={[type.badge, { color: colors.textMuted2, letterSpacing: 1, marginTop: 6 }]}>ZONDER DATUM</Text>
        {undated.length === 0 ? (
          <Text style={type.meta}>Sleep hier gerechten voor “ooit deze week”.</Text>
        ) : (
          undated.map(renderEntry)
        )}

        {entries.length > 0 ? (
          <Pressable style={styles.cta} onPress={makeList} disabled={generating}>
            <ShoppingCart size={18} color={colors.onPrimary} />
            <Text style={[type.h3, { color: colors.onPrimary }]}>
              {generating ? 'Lijst maken…' : `Boodschappenlijst maken · ${entries.length} ${entries.length === 1 ? 'gerecht' : 'gerechten'}`}
            </Text>
          </Pressable>
        ) : null}
      </ScrollView>

      {moveEntry ? (
        <View style={[styles.movePicker, { paddingBottom: insets.bottom + 100 }]}>
          <Text style={type.h3}>Verplaats naar…</Text>
          <View style={styles.moveDays}>
            {days.map((d) => (
              <Pressable key={d.date} style={styles.moveDay} onPress={() => moveTo(d.date)}>
                <Text style={type.chip}>{d.label}</Text>
              </Pressable>
            ))}
            <Pressable style={styles.moveDay} onPress={() => moveTo(null)}>
              <Text style={type.chip}>Zonder datum</Text>
            </Pressable>
          </View>
          <Pressable onPress={() => setMoveEntry(null)}>
            <Text style={[type.body, { color: colors.textMuted, textAlign: 'center' }]}>Annuleren</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { paddingHorizontal: 16, paddingBottom: 160, gap: 10 },
  weekRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 4 },
  dayRow: { flexDirection: 'row', gap: 12, alignItems: 'flex-start' },
  dayLabel: { ...type.badge, color: colors.textMuted, width: 30, marginTop: 14 },
  emptySlot: {
    borderWidth: 1, borderStyle: 'dashed', borderColor: colors.borderSubtle,
    borderRadius: radius.control, padding: 12, alignItems: 'center',
  },
  entry: {
    flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: colors.surface,
    borderRadius: radius.control, padding: 12, borderWidth: 1, borderColor: colors.borderSubtle,
  },
  srvBtn: {
    width: 26, height: 26, borderRadius: 13, backgroundColor: colors.bg,
    alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.borderSubtle,
  },
  cta: {
    flexDirection: 'row', gap: 10, alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.primary, borderRadius: radius.pill, padding: 16, marginTop: 12,
  },
  movePicker: {
    position: 'absolute', left: 0, right: 0, bottom: 0, backgroundColor: colors.surface,
    borderTopLeftRadius: radius.card, borderTopRightRadius: radius.card, padding: 20, gap: 14,
    shadowColor: '#000', shadowOpacity: 0.12, shadowRadius: 16, shadowOffset: { width: 0, height: -6 }, elevation: 10,
  },
  moveDays: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  moveDay: {
    paddingHorizontal: 14, paddingVertical: 10, borderRadius: radius.pill,
    backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.borderSubtle,
  },
});
