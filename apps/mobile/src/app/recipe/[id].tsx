import { Image } from 'expo-image';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { CalendarPlus, ChefHat, Clock, Minus, Plus, ShoppingCart, Trash2 } from 'lucide-react-native';
import { useEffect, useMemo, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { deleteRow, getData, newId, syncNow, upsertRow } from '../../data';
import { formatEuroCents } from '@prakkie/shared';
import { recipeImage, type RecipeRowData } from '../../data/recipes';
import { colors, radius, type } from '../../theme/tokens';

/** Recipe detail — serving scaler + add-to-list/plan (D1/D2/D4), cook-mode entry (D3). */
export default function RecipeDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const [recipe, setRecipe] = useState<RecipeRowData | null>(null);
  const [servings, setServings] = useState(2);

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

  const factor = recipe ? servings / (recipe.servings_base ?? 2) : 1;
  const scaled = useMemo(
    () =>
      (recipe?.ingredients ?? []).map((ing) => ({
        ...ing,
        display:
          ing.quantity != null
            ? `${formatQty(ing.quantity * factor)}${ing.unit ? ` ${ing.unit}` : ''} ${ing.item_normalised ?? ing.raw_text ?? ''}`
            : ing.raw_text ?? ing.item_normalised ?? '',
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

  async function addToList() {
    // default list = first list, created on the fly when none exists
    const { store } = await getData();
    const lists = (await store.listRows('lists')).filter((l) => !l.deleted);
    let listId = lists[0]?.id;
    if (!listId) {
      listId = newId();
      await upsertRow('lists', { name: 'Boodschappen' }, listId);
    }
    for (const ing of scaled) {
      await upsertRow('list_items', {
        list_id: listId,
        name: ing.item_normalised ?? ing.raw_text ?? 'item',
        quantity: ing.quantity != null ? ing.quantity * factor : null,
        unit: ing.unit ?? null,
        item_normalised: ing.item_normalised ?? null,
        is_manual: false,
        provenance: [{ recipe_id: recipe!.id, title: recipe!.title, servings }],
      });
    }
    syncNow(['lists', 'list_items']).catch(() => {});
    Alert.alert('Toegevoegd', `${scaled.length} ingrediënten op je lijst.`);
  }

  async function addToPlan() {
    // vandaag in het weekplan (H-basics; volledige planner in tab Plannen)
    const monday = new Date();
    monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
    const weekStart = monday.toISOString().slice(0, 10);
    const { store } = await getData();
    const plans = (await store.listRows('plans')).filter(
      (p) => !p.deleted && (p.row as { week_start?: string }).week_start === weekStart
    );
    let planId = plans[0]?.id;
    if (!planId) {
      planId = newId();
      await upsertRow('plans', { week_start: weekStart }, planId);
    }
    await upsertRow('plan_entries', {
      plan_id: planId,
      recipe_id: recipe!.id,
      entry_date: new Date().toISOString().slice(0, 10),
      meal_slot: 'dinner',
      servings,
    });
    syncNow(['plans', 'plan_entries']).catch(() => {});
    Alert.alert('Ingepland', 'Vanavond op het menu.');
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

  return (
    <ScrollView style={styles.screen} contentContainerStyle={{ paddingBottom: insets.bottom + 40 }}>
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
            <ChefHat size={18} color="#fff" />
            <Text style={styles.primaryText}>Kookmodus</Text>
          </Pressable>
          <Pressable style={styles.action} onPress={addToList}>
            <ShoppingCart size={18} color={colors.text} />
            <Text style={type.body}>Op de lijst</Text>
          </Pressable>
          <Pressable style={styles.action} onPress={addToPlan}>
            <CalendarPlus size={18} color={colors.text} />
            <Text style={type.body}>Inplannen</Text>
          </Pressable>
          <Pressable style={styles.action} onPress={removeRecipe}>
            <Trash2 size={18} color={colors.danger ?? '#b3261e'} />
            <Text style={[type.body, { color: colors.danger ?? '#b3261e' }]}>Verwijderen</Text>
          </Pressable>
        </View>
      </View>
    </ScrollView>
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
  primaryText: { ...type.body, color: '#fff', fontFamily: type.h3.fontFamily },
});
