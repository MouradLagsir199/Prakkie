import { DAY_ABBREV_NL, formatEuroCents, formatPricePerPortion } from '@prakkie/shared';
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import { ChevronLeft, ChevronRight, ListChecks, Plus, StickyNote, X } from 'lucide-react-native';
import { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { deleteRow, newId, syncNow, upsertRow, useEntityRows } from '../../data';
import { authedRequest } from '../../data/api';
import { addDays, isoWeekNumber, mondayOf, weekRangeLabel } from '../../data/chains';
import { activeHouseholdId } from '../../data/households';
import { recipeImage, type RecipeRowData } from '../../data/recipes';
import { confirmDialog, notice } from '../../lib/dialogs';
import { colors, fonts, radius, type } from '../../theme/tokens';

/** Plannen — mockup 05 1:1: week switcher, day-chip rows, dashed empty slots,
 *  "Zonder datum" strip, green CTA → week-tied list via list-generate (H5/G4). */

interface PlanRow { id: string; week_start: string }
interface EntryRow {
  id: string; plan_id: string; recipe_id: string | null; title?: string | null;
  entry_date: string | null; meal_slot: string; servings: number;
}

export default function PlannenScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const [weekOffset, setWeekOffset] = useState(0);
  const { rows: planRows } = useEntityRows('plans');
  const { rows: entryRows } = useEntityRows('plan_entries');
  const { rows: recipeRows } = useEntityRows('recipes');
  const { rows: listRows } = useEntityRows('lists');
  const [moveEntry, setMoveEntry] = useState<EntryRow | null>(null);
  const [generating, setGenerating] = useState(false);
  // P1 — in-place kiezer: welke dag krijgt een gerecht/notitie?
  const [pickDate, setPickDate] = useState<string | null>(null);
  const [pickFilter, setPickFilter] = useState('');
  const [noteText, setNoteText] = useState('');

  const weekStart = mondayOf(weekOffset);
  const plan = planRows
    .map((r) => ({ ...(r.row as unknown as PlanRow), id: r.id }))
    .find((p) => String(p.week_start).slice(0, 10) === weekStart);
  const entries = useMemo(
    () =>
      entryRows
        .map((r) => r.row as unknown as EntryRow)
        .filter((e) => plan && e.plan_id === plan.id)
        // server round-trips dates as ISO datetimes — normalise or entries
        // vanish from their day after the first sync (owner bug 2026-07-06)
        .map((e) => ({ ...e, entry_date: e.entry_date ? String(e.entry_date).slice(0, 10) : null })),
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
      {
        plan_id: moveEntry.plan_id, recipe_id: moveEntry.recipe_id, title: moveEntry.title ?? null,
        servings: moveEntry.servings, entry_date: date,
      },
      moveEntry.id
    );
    setMoveEntry(null);
    syncNow(['plan_entries']).catch(() => {});
  }

  /** P1/P3 — plan a recipe or free-text note straight onto a day. */
  async function ensurePlanId(): Promise<string> {
    if (plan) return plan.id;
    const id = newId();
    await upsertRow('plans', { week_start: weekStart }, id);
    return id;
  }

  async function planRecipe(recipe: RecipeRowData & { id: string }) {
    const planId = await ensurePlanId();
    await upsertRow('plan_entries', {
      plan_id: planId, recipe_id: recipe.id, entry_date: pickDate === 'undated' ? null : pickDate,
      meal_slot: 'dinner', servings: recipe.servings_base ?? 2,
    });
    setPickDate(null);
    setPickFilter('');
    syncNow(['plans', 'plan_entries']).catch(() => {});
  }

  async function planNote() {
    const text = noteText.trim();
    if (!text) return;
    const planId = await ensurePlanId();
    await upsertRow('plan_entries', {
      plan_id: planId, recipe_id: null, title: text, entry_date: pickDate === 'undated' ? null : pickDate,
      meal_slot: 'dinner', servings: 1,
    });
    setNoteText('');
    setPickDate(null);
    syncNow(['plans', 'plan_entries']).catch(() => {});
  }

  const recipeEntries = entries.filter((e) => e.recipe_id);

  async function makeList() {
    if (recipeEntries.length === 0) return;
    setGenerating(true);
    try {
      await syncNow(['lists', 'plans', 'plan_entries']);
      // P2 — reuse this week's list: generated lines replace, manual items survive
      const existing = listRows
        .map((r) => ({ id: r.id, ...(r.row as { week_start?: string | null }) }))
        .find((l) => (l.week_start ?? '').slice(0, 10) === weekStart);
      let listId = existing?.id;
      if (!listId) {
        listId = newId();
        await upsertRow(
          'lists',
          { name: 'Weekboodschappen', week_start: weekStart, household_id: await activeHouseholdId() },
          listId
        );
        await syncNow(['lists']);
      }
      const res = await authedRequest(`/v1/lists/${listId}/generate`, {
        method: 'POST',
        body: JSON.stringify({
          recipes: recipeEntries.map((e) => ({ recipe_id: e.recipe_id, servings: e.servings })),
          replace_generated: true,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await syncNow(['lists', 'list_items']);
      router.push('/boodschappen');
    } catch {
      notice('Lijst maken mislukt', 'Controleer je verbinding en probeer opnieuw.');
    } finally {
      setGenerating(false);
    }
  }

  const entryCard = (entry: EntryRow) => {
    const recipe = entry.recipe_id ? recipeById.get(entry.recipe_id) : undefined;
    const isNote = !entry.recipe_id;
    const label = recipe?.title ?? entry.title ?? 'Recept';
    const pp = recipe?.price_cache?.per_portion_cents;
    return (
      <Pressable
        key={entry.id}
        style={styles.entryCard}
        onPress={() => setMoveEntry(entry)}
        onLongPress={async () => {
          if (!(await confirmDialog({ title: 'Van het menu halen?', message: label, confirmLabel: 'Verwijderen', destructive: true }))) return;
          await deleteRow('plan_entries', entry.id);
          syncNow(['plan_entries']).catch(() => {});
        }}
      >
        {isNote ? (
          <View style={[styles.entryThumb, styles.noteThumb]}>
            <StickyNote size={17} color={colors.primary} strokeWidth={1.9} />
          </View>
        ) : (
          <Image source={{ uri: recipe ? recipeImage(recipe) : undefined }} style={styles.entryThumb} contentFit="cover" />
        )}
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <Text style={styles.entryTitle} numberOfLines={1}>{label}</Text>
          <Text style={styles.entryMeta}>
            {isNote ? 'eigen notitie' : `${entry.servings} pers.${pp ? ` · ${formatPricePerPortion(pp)}` : ''}`}
          </Text>
        </View>
        {isNote ? null : (
          <>
            <Pressable onPress={() => setServings(entry, -1)} hitSlop={8} style={styles.srvBtn}>
              <Text style={styles.srvText}>−</Text>
            </Pressable>
            <Pressable onPress={() => setServings(entry, 1)} hitSlop={8} style={styles.srvBtn}>
              <Text style={styles.srvText}>+</Text>
            </Pressable>
          </>
        )}
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
                    <Pressable style={styles.emptySlot} onPress={() => setPickDate(day.date)}>
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
            {undated.map((e) => (
              <Pressable key={e.id} style={styles.undatedPill} onPress={() => setMoveEntry(e)}>
                <Text style={styles.undatedPillText} numberOfLines={1}>
                  {(e.recipe_id ? recipeById.get(e.recipe_id)?.title : e.title) ?? 'Recept'}
                </Text>
              </Pressable>
            ))}
            <Pressable style={styles.undatedPill} onPress={() => setPickDate('undated')}>
              <Text style={styles.undatedPillText}>+ toevoegen</Text>
            </Pressable>
          </View>
        </View>
      </ScrollView>

      {recipeEntries.length > 0 ? (
        <View style={[styles.ctaWrap, { paddingBottom: insets.bottom + 96 }]}>
          <Pressable style={styles.cta} onPress={makeList} disabled={generating}>
            <ListChecks size={17} color={colors.onPrimary} strokeWidth={2} />
            <Text style={styles.ctaText}>
              {generating ? 'Lijst maken…' : `Boodschappenlijst maken · ${recipeEntries.length} ${recipeEntries.length === 1 ? 'gerecht' : 'gerechten'}`}
            </Text>
          </Pressable>
        </View>
      ) : null}

      {/* P1/P3 — in-place kiezer: recept uit je bibliotheek óf een vrije notitie */}
      {pickDate ? (
        <View style={[styles.sheet, { paddingBottom: insets.bottom + 100 }]}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <Text style={type.h3}>
              Wat eet je {pickDate === 'undated'
                ? 'deze week'
                : `${days.find((d) => d.date === pickDate)?.label ?? ''} ${days.find((d) => d.date === pickDate)?.dayNum ?? ''}`}?
            </Text>
            <Pressable onPress={() => setPickDate(null)} hitSlop={10}>
              <X size={20} color={colors.textSoft} />
            </Pressable>
          </View>

          {recipeRows.length > 6 ? (
            <TextInput
              style={styles.pickInput}
              placeholder="Zoek in je recepten…"
              placeholderTextColor="#97A08F"
              value={pickFilter}
              onChangeText={setPickFilter}
            />
          ) : null}

          <ScrollView style={{ maxHeight: 260 }} showsVerticalScrollIndicator={false}>
            {recipeRows.length === 0 ? (
              <Pressable style={styles.pickEmpty} onPress={() => { setPickDate(null); router.push('/import'); }}>
                <Text style={[type.body, { color: colors.primary }]}>
                  Nog geen recepten — importeer je eerste via +
                </Text>
              </Pressable>
            ) : (
              recipeRows
                .map((row) => ({ ...(row.row as unknown as RecipeRowData), id: row.id }))
                .filter((r) => !pickFilter.trim() || r.title.toLowerCase().includes(pickFilter.trim().toLowerCase()))
                .slice(0, 20)
                .map((r) => (
                  <Pressable key={r.id} style={styles.pickRow} onPress={() => planRecipe(r)}>
                    <Image source={{ uri: recipeImage(r) }} style={styles.pickThumb} contentFit="cover" />
                    <Text style={[type.body, { flex: 1, fontSize: 13.5 }]} numberOfLines={1}>{r.title}</Text>
                    <Text style={type.meta}>{r.servings_base ?? 2} pers.</Text>
                  </Pressable>
                ))
            )}
          </ScrollView>

          <View style={styles.noteRow}>
            <TextInput
              style={[styles.pickInput, { flex: 1, marginTop: 0 }]}
              placeholder="of typ zelf: uit eten, restjes…"
              placeholderTextColor="#97A08F"
              value={noteText}
              onChangeText={setNoteText}
              onSubmitEditing={planNote}
            />
            <Pressable style={styles.noteBtn} onPress={planNote}>
              <StickyNote size={16} color={colors.onPrimary} strokeWidth={2} />
            </Pressable>
          </View>
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
          {/* long-press is op web onvindbaar — verwijderen hoort ook via de gewone tap-sheet te kunnen */}
          <Pressable
            onPress={async () => {
              const target = moveEntry;
              setMoveEntry(null);
              const label = (target.recipe_id ? recipeById.get(target.recipe_id)?.title : target.title) ?? 'Recept';
              if (!(await confirmDialog({ title: 'Van het menu halen?', message: label, confirmLabel: 'Verwijderen', destructive: true }))) return;
              await deleteRow('plan_entries', target.id);
              syncNow(['plan_entries']).catch(() => {});
            }}
          >
            <Text style={[type.body, { color: colors.danger, textAlign: 'center' }]}>Van het menu halen</Text>
          </Pressable>
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
  noteThumb: { alignItems: 'center', justifyContent: 'center', backgroundColor: colors.badgeBg },
  pickInput: {
    marginTop: 4, backgroundColor: colors.bg, borderRadius: 12, paddingHorizontal: 13, paddingVertical: 10,
    borderWidth: 1, borderColor: 'rgba(34,48,30,.12)', fontSize: 13.5, color: colors.text,
  },
  pickRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8 },
  pickThumb: { width: 36, height: 36, borderRadius: 9, backgroundColor: '#EDE7D8' },
  pickEmpty: { paddingVertical: 14, alignItems: 'center' },
  noteRow: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  noteBtn: {
    width: 42, height: 42, borderRadius: 12, backgroundColor: colors.primary,
    alignItems: 'center', justifyContent: 'center',
  },
  moveDays: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  moveDay: {
    paddingHorizontal: 14, paddingVertical: 10, borderRadius: radius.pill, backgroundColor: colors.bg,
    borderWidth: 1, borderColor: 'rgba(34,48,30,.12)',
  },
});
