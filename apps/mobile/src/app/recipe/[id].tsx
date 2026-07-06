import { DAY_ABBREV_NL, formatEuroCents } from '@prakkie/shared';
import { Image } from 'expo-image';
import { useLocalSearchParams, useRouter } from 'expo-router';
import {
  CalendarPlus, ChefHat, ChevronLeft, ChevronRight, Clock, Minus, Plus, ShoppingCart, Trash2, X,
} from 'lucide-react-native';
import { useEffect, useMemo, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { deleteRow, getData, newId, syncNow, upsertRow } from '../../data';
import { addDays, isoWeekNumber, mondayOf, weekRangeLabel } from '../../data/chains';
import { recipeImage, type RecipeRowData } from '../../data/recipes';
import { colors, fonts, radius, type } from '../../theme/tokens';

/**
 * Recipe detail (tokens-only screen) — serving scaler, cook mode entry, and the
 * owner-UX pickers (2026-07-06): "Op de lijst" always asks WHICH week-list
 * (or a new one); "Inplannen" always asks WHICH week + day.
 */

interface ListRow { id: string; name: string; week_start?: string | null }

export default function RecipeDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const [recipe, setRecipe] = useState<RecipeRowData | null>(null);
  const [servings, setServings] = useState(2);
  const [sheet, setSheet] = useState<'none' | 'list' | 'plan'>('none');
  const [weekOffset, setWeekOffset] = useState(0);
  const [weekLists, setWeekLists] = useState<ListRow[]>([]);
  const [planDay, setPlanDay] = useState(0);

  useEffect(() => {
    getData().then(async ({ store }) => {
      const row = await store.getRow('recipes', String(id));
      if (row) {
        const r = row.row as unknown as RecipeRowData;
        setRecipe(r);
        setServings(r.servings_base ?? 2);
      }
    });
  }, [id]);

  const weekStart = mondayOf(weekOffset);
  useEffect(() => {
    if (sheet !== 'list') return;
    getData().then(async ({ store }) => {
      const lists = (await store.listRows('lists'))
        .filter((l) => !l.deleted)
        .map((l) => ({ ...(l.row as unknown as ListRow), id: l.id }))
        .filter((l) => (l.week_start ?? '').slice(0, 10) === weekStart);
      setWeekLists(lists);
    });
  }, [sheet, weekStart]);

  const factor = recipe ? servings / (recipe.servings_base ?? 2) : 1;
  const scaled = useMemo(
    () =>
      (recipe?.ingredients ?? []).map((ing) => ({
        ...ing,
        display:
          ing.quantity != null
            ? `${formatQty(ing.quantity * factor)}${ing.unit ? ` ${ing.unit}` : ''} ${ing.item_normalised ?? ing.raw_text ?? ''}`
            : (ing.raw_text ?? ing.item_normalised ?? ''),
      })),
    [recipe, factor]
  );

  if (!recipe) {
    return (
      <View style={[styles.screen, { paddingTop: insets.top + 16 }]}>
        <Text style={type.meta}>Laden…</Text>
      </View>
    );
  }

  async function addToList(listId: string | 'new') {
    let target = listId;
    if (target === 'new') {
      target = newId();
      await upsertRow('lists', { name: `Week ${isoWeekNumber(weekStart)}`, week_start: weekStart }, target);
    }
    for (const ing of scaled) {
      await upsertRow('list_items', {
        list_id: target,
        name: ing.item_normalised ?? ing.raw_text ?? 'item',
        quantity: ing.quantity != null ? ing.quantity * factor : null,
        unit: ing.unit ?? null,
        item_normalised: ing.item_normalised ?? null,
        is_manual: false,
        provenance: [{ recipe_id: recipe!.id, recipe_title: recipe!.title, quantity: null, unit: null }],
      });
    }
    setSheet('none');
    syncNow(['lists', 'list_items']).catch(() => {});
    Alert.alert('Toegevoegd', `${scaled.length} ingrediënten op je lijst voor week ${isoWeekNumber(weekStart)}.`);
  }

  async function planIt() {
    const { store } = await getData();
    const plans = (await store.listRows('plans')).filter(
      (p) => !p.deleted && String((p.row as { week_start?: string }).week_start).slice(0, 10) === weekStart
    );
    let planId = plans[0]?.id;
    if (!planId) {
      planId = newId();
      await upsertRow('plans', { week_start: weekStart }, planId);
    }
    await upsertRow('plan_entries', {
      plan_id: planId,
      recipe_id: recipe!.id,
      entry_date: addDays(weekStart, planDay),
      meal_slot: 'dinner',
      servings,
    });
    setSheet('none');
    syncNow(['plans', 'plan_entries']).catch(() => {});
    Alert.alert('Ingepland', `${DAY_ABBREV_NL[planDay]} in week ${isoWeekNumber(weekStart)}.`);
  }

  function removeRecipe() {
    Alert.alert('Recept verwijderen?', recipe!.title, [
      { text: 'Annuleren', style: 'cancel' },
      {
        text: 'Verwijderen',
        style: 'destructive',
        onPress: async () => {
          await deleteRow('recipes', recipe!.id);
          syncNow(['recipes']).catch(() => {});
          router.back();
        },
      },
    ]);
  }

  const total = (recipe.time_prep_min ?? 0) + (recipe.time_cook_min ?? 0);

  const weekPicker = (
    <View style={styles.weekRow}>
      <Pressable onPress={() => setWeekOffset(Math.max(0, weekOffset - 1))} hitSlop={10}>
        <ChevronLeft size={18} color={colors.primary} strokeWidth={2.2} />
      </Pressable>
      <Text style={styles.weekLabel}>
        Week {isoWeekNumber(weekStart)} <Text style={type.meta}>· {weekRangeLabel(weekStart)}</Text>
      </Text>
      <Pressable onPress={() => setWeekOffset(weekOffset + 1)} hitSlop={10}>
        <ChevronRight size={18} color={colors.primary} strokeWidth={2.2} />
      </Pressable>
    </View>
  );

  return (
    <View style={styles.screen}>
      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 40 }}>
        <Image source={{ uri: recipeImage(recipe) }} style={styles.hero} contentFit="cover" />
        <View style={styles.body}>
          <Text style={type.h1}>{recipe.title}</Text>
          <View style={styles.metaRow}>
            {total > 0 ? (
              <View style={styles.metaItem}>
                <Clock size={15} color={colors.textSoft} />
                <Text style={type.meta}>{total} min</Text>
              </View>
            ) : null}
            {recipe.source_author ? <Text style={type.meta}>via {recipe.source_author}</Text> : null}
            {recipe.price_cache?.per_portion_cents ? (
              <Text style={type.meta}>{formatEuroCents(recipe.price_cache.per_portion_cents)} p.p.</Text>
            ) : null}
          </View>

          {(recipe.missing_fields ?? []).length > 0 ? (
            <View style={styles.warnBox}>
              <Text style={[type.meta, { color: colors.text }]}>
                Onvolledig geïmporteerd: {recipe.missing_fields!.join(', ')} — controleer en vul aan.
              </Text>
            </View>
          ) : null}

          <View style={styles.servingsRow}>
            <Text style={type.h2}>Ingrediënten</Text>
            <View style={styles.stepper}>
              <Pressable onPress={() => setServings(Math.max(1, servings - 1))} style={styles.stepBtn}>
                <Minus size={16} color={colors.text} />
              </Pressable>
              <Text style={[type.body, styles.stepValue]}>{servings} pers.</Text>
              <Pressable onPress={() => setServings(servings + 1)} style={styles.stepBtn}>
                <Plus size={16} color={colors.text} />
              </Pressable>
            </View>
          </View>
          {scaled.map((ing, i) => (
            <View key={i} style={styles.ingRow}>
              <Text style={type.body}>{ing.display}</Text>
              {ing.note ? <Text style={type.meta}> ({ing.note})</Text> : null}
            </View>
          ))}

          <Text style={[type.h2, { marginTop: 20 }]}>Bereiding</Text>
          {(recipe.steps ?? []).map((s) => (
            <View key={s.order} style={styles.stepRow}>
              <Text style={[type.h3, styles.stepNum]}>{s.order}</Text>
              <Text style={[type.body, { flex: 1 }]}>{s.text}</Text>
            </View>
          ))}

          <View style={styles.actions}>
            <Pressable style={[styles.action, styles.primary]} onPress={() => router.push(`/cook/${recipe.id}`)}>
              <ChefHat size={18} color={colors.onPrimary} />
              <Text style={styles.primaryText}>Kookmodus</Text>
            </Pressable>
            <Pressable style={styles.action} onPress={() => { setWeekOffset(0); setSheet('list'); }}>
              <ShoppingCart size={18} color={colors.text} />
              <Text style={type.body}>Op de lijst</Text>
            </Pressable>
            <Pressable style={styles.action} onPress={() => { setWeekOffset(0); setPlanDay(new Date().getDay() === 0 ? 6 : new Date().getDay() - 1); setSheet('plan'); }}>
              <CalendarPlus size={18} color={colors.text} />
              <Text style={type.body}>Inplannen</Text>
            </Pressable>
            <Pressable style={styles.action} onPress={removeRecipe}>
              <Trash2 size={18} color={colors.danger} />
              <Text style={[type.body, { color: colors.danger }]}>Verwijderen</Text>
            </Pressable>
          </View>
        </View>
      </ScrollView>

      {sheet !== 'none' ? (
        <View style={[styles.sheet, { paddingBottom: insets.bottom + 24 }]}>
          <View style={styles.sheetHeader}>
            <Text style={type.h3}>{sheet === 'list' ? 'Op welke lijst?' : 'Wanneer eten?'}</Text>
            <Pressable onPress={() => setSheet('none')} hitSlop={10}>
              <X size={20} color={colors.textSoft} />
            </Pressable>
          </View>
          {weekPicker}
          {sheet === 'list' ? (
            <>
              {weekLists.map((l) => (
                <Pressable key={l.id} style={styles.sheetRow} onPress={() => addToList(l.id)}>
                  <Text style={type.body}>{l.name}</Text>
                  <Text style={type.meta}>week {isoWeekNumber(weekStart)}</Text>
                </Pressable>
              ))}
              <Pressable style={[styles.sheetRow, styles.sheetNew]} onPress={() => addToList('new')}>
                <Text style={[type.body, { color: colors.primary }]}>+ Nieuwe lijst voor week {isoWeekNumber(weekStart)}</Text>
              </Pressable>
            </>
          ) : (
            <>
              <View style={styles.dayRow}>
                {DAY_ABBREV_NL.map((d, i) => (
                  <Pressable key={d} onPress={() => setPlanDay(i)} style={[styles.dayChip, planDay === i && styles.dayChipActive]}>
                    <Text style={[styles.dayChipText, planDay === i && { color: colors.onPrimary }]}>{d}</Text>
                    <Text style={[styles.dayChipNum, planDay === i && { color: colors.onPrimary }]}>
                      {Number(addDays(weekStart, i).slice(8))}
                    </Text>
                  </Pressable>
                ))}
              </View>
              <Pressable style={styles.confirmBtn} onPress={planIt}>
                <Text style={[type.h3, { color: colors.onPrimary }]}>
                  Inplannen · {DAY_ABBREV_NL[planDay]} {Number(addDays(weekStart, planDay).slice(8))} · {servings} pers.
                </Text>
              </Pressable>
            </>
          )}
        </View>
      ) : null}
    </View>
  );
}

function formatQty(n: number): string {
  const rounded = Math.round(n * 100) / 100;
  return String(rounded).replace('.', ',');
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  hero: { width: '100%', height: 240 },
  body: { padding: 16, gap: 10 },
  metaRow: { flexDirection: 'row', gap: 14, alignItems: 'center' },
  metaItem: { flexDirection: 'row', gap: 4, alignItems: 'center' },
  warnBox: { backgroundColor: '#FDF3D8', borderRadius: radius.md, padding: 10 },
  servingsRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 12 },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  stepBtn: {
    width: 30, height: 30, borderRadius: 15, backgroundColor: colors.surface,
    alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.border,
  },
  stepValue: { minWidth: 60, textAlign: 'center' },
  ingRow: { flexDirection: 'row', alignItems: 'baseline', paddingVertical: 5, borderBottomWidth: 1, borderBottomColor: colors.border },
  stepRow: { flexDirection: 'row', gap: 12, marginTop: 10 },
  stepNum: { width: 22, color: colors.primary },
  actions: { marginTop: 24, gap: 10 },
  action: {
    flexDirection: 'row', gap: 10, alignItems: 'center', padding: 14,
    borderRadius: radius.lg, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border,
  },
  primary: { backgroundColor: colors.primary, borderColor: colors.primary },
  primaryText: { ...type.body, color: colors.onPrimary, fontFamily: fonts.bodySemiBold },
  sheet: {
    position: 'absolute', left: 0, right: 0, bottom: 0, backgroundColor: colors.surface,
    borderTopLeftRadius: 22, borderTopRightRadius: 22, padding: 20, gap: 10,
    shadowColor: '#000', shadowOpacity: 0.14, shadowRadius: 18, shadowOffset: { width: 0, height: -6 }, elevation: 12,
  },
  sheetHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  weekRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 4 },
  weekLabel: { fontFamily: fonts.bodySemiBold, fontSize: 13, color: colors.primary },
  sheetRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    backgroundColor: colors.bg, borderRadius: radius.control, padding: 14,
  },
  sheetNew: { backgroundColor: colors.badgeBg },
  dayRow: { flexDirection: 'row', gap: 6, justifyContent: 'space-between' },
  dayChip: {
    flex: 1, alignItems: 'center', paddingVertical: 8, borderRadius: 12,
    backgroundColor: '#F3F0E7', gap: 1,
  },
  dayChipActive: { backgroundColor: colors.primary },
  dayChipText: { fontSize: 10.5, fontFamily: fonts.bodyBold, color: colors.textSoft },
  dayChipNum: { fontSize: 12, color: '#3D5138' },
  confirmBtn: {
    backgroundColor: colors.primary, borderRadius: radius.lg, padding: 15, alignItems: 'center', marginTop: 4,
  },
});
