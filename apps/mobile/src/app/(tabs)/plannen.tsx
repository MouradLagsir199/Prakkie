import { DAY_ABBREV_NL, formatEuroCents, formatPricePerPortion } from '@prakkie/shared';
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import { ChevronLeft, ChevronRight, ListChecks, Plus } from 'lucide-react-native';
import { useMemo, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { deleteRow, newId, syncNow, upsertRow, useEntityRows } from '../../data';
import { authedRequest } from '../../data/api';
import { addDays, isoWeekNumber, mondayOf, weekRangeLabel } from '../../data/chains';
import { recipeImage, type RecipeRowData } from '../../data/recipes';
import { colors, fonts, radius, type } from '../../theme/tokens';

/** Plannen — mockup 05 1:1: week switcher, day-chip rows, dashed empty slots,
 *  "Zonder datum" strip, green CTA → week-tied list via list-generate (H5/G4). */

interface PlanRow { id: string; week_start: string }
interface EntryRow {
  id: string; plan_id: string; recipe_id: string; entry_date: string | null; meal_slot: string; servings: number;
}

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
  const plan = planRows
    .map((r) => ({ ...(r.row as unknown as PlanRow), id: r.id }))
    .find((p) => String(p.week_start).slice(0, 10) === weekStart);
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
    dayNum: Number(addDays(weekStart, i).slice(8)),
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
      const listId = newId();
      await upsertRow('lists', { name: 'Weekboodschappen', week_start: weekStart }, listId);
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

  const entryCard = (entry: EntryRow) => {
    const recipe = recipeById.get(entry.recipe_id);
    const pp = recipe?.price_cache?.per_portion_cents;
    return (
      <Pressable
        key={entry.id}
        style={styles.entryCard}
        onPress={() => setMoveEntry(entry)}
        onLongPress={() =>
          Alert.alert('Van het menu halen?', recipe?.title ?? '', [
            { text: 'Annuleren', style: 'cancel' },
            {
              text: 'Verwijderen', style: 'destructive',
              onPress: async () => {
                await deleteRow('plan_entries', entry.id);
                syncNow(['plan_entries']).catch(() => {});
              },
            },
          ])
        }
      >
        <Image source={{ uri: recipe ? recipeImage(recipe) : undefined }} style={styles.entryThumb} contentFit="cover" />
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <Text style={styles.entryTitle} numberOfLines={1}>{recipe?.title ?? 'Recept'}</Text>
          <Text style={styles.entryMeta}>
            {entry.servings} pers.{pp ? ` · ${formatPricePerPortion(pp)}` : ''}
          </Text>
        </View>
        <Pressable onPress={() => setServings(entry, -1)} hitSlop={8} style={styles.srvBtn}>
          <Text style={styles.srvText}>−</Text>
        </Pressable>
        <Pressable onPress={() => setServings(entry, 1)} hitSlop={8} style={styles.srvBtn}>
          <Text style={styles.srvText}>+</Text>
        </Pressable>
      </Pressable>
    );
  };

  return (
    <View style={[styles.screen, { paddingTop: insets.top + 8 }]}>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.headerRow}>
          <Text style={styles.title}>Weekplanner</Text>
          <View style={styles.weekSwitch}>
            <Pressable onPress={() => setWeekOffset(weekOffset - 1)} hitSlop={10}>
              <ChevronLeft size={12} color={colors.primary} strokeWidth={2.2} />
            </Pressable>
            <Text style={styles.weekSwitchText}>Week {isoWeekNumber(weekStart)}</Text>
            <Pressable onPress={() => setWeekOffset(weekOffset + 1)} hitSlop={10}>
              <ChevronRight size={12} color={colors.primary} strokeWidth={2.2} />
            </Pressable>
          </View>
        </View>
        <Text style={styles.subtitle}>
          {weekRangeLabel(weekStart)} · {entries.length} {entries.length === 1 ? 'gerecht' : 'gerechten'} gepland
        </Text>

        <View style={{ gap: 8, marginTop: 14 }}>
          {days.map((day) => {
            const dayEntries = entries.filter((e) => e.entry_date === day.date);
            const filled = dayEntries.length > 0;
            return (
              <View key={day.date} style={styles.dayRow}>
                <View style={[styles.dayChip, { backgroundColor: filled ? colors.badgeBg : '#F3F0E7' }]}>
                  <Text style={[styles.dayChipLabel, { color: filled ? colors.primary : '#97A08F' }]}>{day.label}</Text>
                  <Text style={[styles.dayChipNum, { color: filled ? '#3D5138' : '#97A08F' }]}>{day.dayNum}</Text>
                </View>
                <View style={{ flex: 1, gap: 8 }}>
                  {filled ? (
                    dayEntries.map(entryCard)
                  ) : (
                    <Pressable style={styles.emptySlot} onPress={() => router.push('/')}>
                      <Plus size={14} color="#97A08F" strokeWidth={2.2} />
                      <Text style={styles.emptyText}>Kies een recept voor deze dag</Text>
                    </Pressable>
                  )}
                </View>
              </View>
            );
          })}
        </View>

        <View style={styles.undatedStrip}>
          <Text style={styles.undatedText}>
            <Text style={{ fontFamily: fonts.bodyBold }}>Zonder datum</Text> · deze week nog inplannen
          </Text>
          <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap', flexShrink: 1, justifyContent: 'flex-end' }}>
            {undated.length === 0 ? (
              <Text style={type.meta}>leeg</Text>
            ) : (
              undated.map((e) => (
                <Pressable key={e.id} style={styles.undatedPill} onPress={() => setMoveEntry(e)}>
                  <Text style={styles.undatedPillText} numberOfLines={1}>
                    {recipeById.get(e.recipe_id)?.title ?? 'Recept'}
                  </Text>
                </Pressable>
              ))
            )}
          </View>
        </View>
      </ScrollView>

      {entries.length > 0 ? (
        <View style={[styles.ctaWrap, { paddingBottom: insets.bottom + 96 }]}>
          <Pressable style={styles.cta} onPress={makeList} disabled={generating}>
            <ListChecks size={17} color={colors.onPrimary} strokeWidth={2} />
            <Text style={styles.ctaText}>
              {generating ? 'Lijst maken…' : `Boodschappenlijst maken · ${entries.length} ${entries.length === 1 ? 'gerecht' : 'gerechten'}`}
            </Text>
          </Pressable>
        </View>
      ) : null}

      {moveEntry ? (
        <View style={[styles.sheet, { paddingBottom: insets.bottom + 100 }]}>
          <Text style={type.h3}>Verplaats naar…</Text>
          <View style={styles.moveDays}>
            {days.map((d) => (
              <Pressable key={d.date} style={styles.moveDay} onPress={() => moveTo(d.date)}>
                <Text style={type.chip}>{d.label} {d.dayNum}</Text>
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
  content: { paddingHorizontal: 20, paddingBottom: 220 },
  headerRow: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between' },
  title: { fontFamily: fonts.display, fontSize: 29, lineHeight: 32, color: colors.text },
  weekSwitch: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingBottom: 4 },
  weekSwitchText: { fontSize: 12.5, fontFamily: fonts.bodySemiBold, color: colors.primary },
  subtitle: { marginTop: 2, fontSize: 12.5, color: colors.textMuted },
  dayRow: { flexDirection: 'row', gap: 10, alignItems: 'stretch' },
  dayChip: { width: 38, borderRadius: 12, alignItems: 'center', justifyContent: 'center', paddingVertical: 6 },
  dayChipLabel: { fontSize: 10.5, fontFamily: fonts.bodyBold },
  dayChipNum: { fontSize: 12 },
  entryCard: {
    flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: colors.surface,
    borderWidth: 1, borderColor: 'rgba(34,48,30,.08)', borderRadius: 14, padding: 8, paddingRight: 10,
  },
  entryThumb: { width: 42, height: 42, borderRadius: 10, backgroundColor: '#EDE7D8' },
  entryTitle: { fontSize: 13.5, fontFamily: fonts.bodySemiBold, color: colors.text },
  entryMeta: { fontSize: 11, color: colors.textMuted },
  srvBtn: {
    width: 24, height: 24, borderRadius: 12, backgroundColor: colors.bg, alignItems: 'center',
    justifyContent: 'center', borderWidth: 1, borderColor: 'rgba(34,48,30,.12)',
  },
  srvText: { fontSize: 14, color: colors.text, lineHeight: 16 },
  emptySlot: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7,
    borderWidth: 1.5, borderStyle: 'dashed', borderColor: 'rgba(34,48,30,.18)', borderRadius: 14, paddingVertical: 15,
  },
  emptyText: { fontSize: 12.5, color: '#97A08F' },
  undatedStrip: {
    marginTop: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10,
    backgroundColor: '#F3F0E7', borderRadius: 14, paddingHorizontal: 14, paddingVertical: 11,
  },
  undatedText: { fontSize: 12.5, color: colors.textSoft, flexShrink: 0 },
  undatedPill: {
    paddingHorizontal: 11, paddingVertical: 6, borderRadius: radius.pill, backgroundColor: colors.surface,
    borderWidth: 1, borderColor: 'rgba(34,48,30,.12)',
  },
  undatedPillText: { fontSize: 12, fontFamily: fonts.bodySemiBold, color: colors.primary },
  ctaWrap: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 20 },
  cta: {
    flexDirection: 'row', gap: 9, alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.primary, borderRadius: 16, padding: 15,
    shadowColor: colors.primary, shadowOpacity: 0.35, shadowRadius: 24, shadowOffset: { width: 0, height: 10 }, elevation: 8,
  },
  ctaText: { fontSize: 15.5, fontFamily: fonts.bodySemiBold, color: colors.onPrimary },
  sheet: {
    position: 'absolute', left: 0, right: 0, bottom: 0, backgroundColor: colors.surface,
    borderTopLeftRadius: 22, borderTopRightRadius: 22, padding: 20, gap: 14,
    shadowColor: '#000', shadowOpacity: 0.12, shadowRadius: 16, shadowOffset: { width: 0, height: -6 }, elevation: 10,
  },
  moveDays: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  moveDay: {
    paddingHorizontal: 14, paddingVertical: 10, borderRadius: radius.pill, backgroundColor: colors.bg,
    borderWidth: 1, borderColor: 'rgba(34,48,30,.12)',
  },
});
