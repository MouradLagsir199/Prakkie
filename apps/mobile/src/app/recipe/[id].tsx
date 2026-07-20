import { DAY_ABBREV_NL, formatEuroCents } from '@prakkie/shared';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { useLocalSearchParams, useRouter } from 'expo-router';
import {
  CalendarPlus, Check, ChefHat, ChevronLeft, ChevronRight, Clock, Minus, Pencil, Plus, ShoppingBasket, Trash2, Users, X,
} from 'lucide-react-native';
import { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { CTAButton } from '../../components/prakkie/CTAButton';
import { CrossChainOptions, type CrossChainOption } from '../../components/prakkie/ProductOptions';
import { deleteRow, getData, newId, syncNow, upsertRow } from '../../data';
import { addDays, isoWeekNumber, mondayOf, weekRangeLabel } from '../../data/chains';
import { activeHouseholdId } from '../../data/households';
import { recipeImage, type RecipeRowData } from '../../data/recipes';
import { setPendingReview } from '../../data/import-flow';
import { useMyChains } from '../../store/api';
import { useBoodschappenLijst } from '../../store/lijst';
import { confirmDialog, notice } from '../../lib/dialogs';
import { colors, fonts, radius, shadows, type } from '../../theme/tokens';

/**
 * Recipe detail (tokens-only screen) — serving scaler, cook mode entry, and the
 * owner-UX pickers (2026-07-06): "Op de lijst" always asks WHICH week-list
 * (or a new one); "Inplannen" always asks WHICH week + day.
 * REDESIGN 1b (foto voorop): full-bleed hero + scrim, overlappend content-sheet,
 * chips-rij met porties-stepper, ingrediëntenkaart en zwevende actiebalk.
 */

export default function RecipeDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const [recipe, setRecipe] = useState<RecipeRowData | null>(null);
  const [servings, setServings] = useState(2);
  // owner 2026-07-10: boodschappen is één vaste lijst — de dag/lijst/product-
  // kiezers zijn weg; "op de lijst" vult het zoeklijstje in Boodschappen
  const [sheet, setSheet] = useState<'none' | 'plan'>('none');
  const [weekOffset, setWeekOffset] = useState(0);
  const [planDay, setPlanDay] = useState(0);
  const chains = useMyChains() ?? [];
  const { add } = useBoodschappenLijst();
  const [activeIngredient, setActiveIngredient] = useState<number | null>(null);
  const [addedIngredients, setAddedIngredients] = useState<Set<number>>(() => new Set());
  const [pendingProduct, setPendingProduct] = useState<{
    index: number; term: string; option: CrossChainOption; quantity: number;
  } | null>(null);

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
      <View style={[styles.screen, { paddingTop: insets.top + 16, paddingHorizontal: 22 }]}>
        <Text style={type.meta}>Laden…</Text>
      </View>
    );
  }

  /** deel/on-deel met je huishouden — het recept verschijnt dan bij huisgenoten
   *  onder het "Gedeeld"-filter (owner 2026-07-07 avond). */
  async function toggleShareHousehold() {
    if (!recipe) return;
    const hh = await activeHouseholdId();
    if (!hh) {
      notice('Nog geen groep', 'Maak eerst een groep aan via je Profiel — dan kun je recepten delen.');
      return;
    }
    const next = recipe.household_id ? null : hh;
    await upsertRow('recipes', { household_id: next }, String(id));
    setRecipe({ ...recipe, household_id: next });
    syncNow(['recipes']).catch(() => {});
  }

  async function confirmIngredientProduct() {
    if (!pendingProduct) return;
    const { index, term, option, quantity } = pendingProduct;
    await add({
      chain: option.chain,
      sku_id: option.sku_id,
      name: option.name,
      term,
      unit_cents: option.promo_price_cents ?? option.price_cents,
      quantity,
    });
    setAddedIngredients((current) => new Set(current).add(index));
    setPendingProduct(null);
    setActiveIngredient(null);
  }

  function editRecipe() {
    if (!recipe) return;
    setPendingReview({ recipe, warnings: [], importId: 'edit' });
    router.push('/review');
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
    notice('Ingepland', `${DAY_ABBREV_NL[planDay]} in week ${isoWeekNumber(weekStart)}.`);
  }

  async function removeRecipe() {
    const ok = await confirmDialog({
      title: 'Recept verwijderen?',
      message: recipe!.title,
      confirmLabel: 'Verwijderen',
      destructive: true,
    });
    if (!ok) return;
    await deleteRow('recipes', recipe!.id);
    syncNow(['recipes']).catch(() => {});
    router.back();
  }

  const total = (recipe.time_prep_min ?? 0) + (recipe.time_cook_min ?? 0);
  const steps = recipe.steps ?? [];

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
      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 130 }} showsVerticalScrollIndicator={false}>
        {/* 1b — foto voorop: hero met scrim, bron + titel óver de foto */}
        <View style={styles.heroWrap}>
          <Image source={{ uri: recipeImage(recipe) }} style={styles.hero} contentFit="cover" />
          <LinearGradient
            colors={['rgba(20,28,17,0.25)', 'rgba(20,28,17,0)', 'rgba(20,28,17,0.55)']}
            locations={[0, 0.35, 1]}
            style={StyleSheet.absoluteFill}
            pointerEvents="none"
          />
          <View style={styles.heroText} pointerEvents="none">
            {recipe.source_author ? <Text style={styles.heroSource}>via {recipe.source_author}</Text> : null}
            <Text style={styles.heroTitle}>{recipe.title}</Text>
          </View>
        </View>

        {/* content-sheet dat de foto overlapt */}
        <View style={styles.body}>
          <View style={styles.chipsRow}>
            {total > 0 ? (
              <View style={styles.chip}>
                <Clock size={13} color={colors.textMuted} strokeWidth={2} />
                <Text style={styles.chipText}>{total} min</Text>
              </View>
            ) : null}
            {recipe.price_cache?.per_portion_cents ? (
              <View style={styles.priceChip}>
                <Text style={styles.priceChipText}>{formatEuroCents(recipe.price_cache.per_portion_cents)} p.p.</Text>
              </View>
            ) : null}
            <View style={{ flex: 1 }} />
            <View style={styles.stepper}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Minder personen"
                onPress={() => setServings(Math.max(1, servings - 1))}
                style={styles.stepBtn}
                hitSlop={6}
              >
                <Minus size={14} color={colors.textSoft} strokeWidth={2.2} />
              </Pressable>
              <Text style={styles.stepValue}>{servings} pers.</Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Meer personen"
                onPress={() => setServings(servings + 1)}
                style={styles.stepBtn}
                hitSlop={6}
              >
                <Plus size={14} color={colors.textSoft} strokeWidth={2.2} />
              </Pressable>
            </View>
          </View>

          {(recipe.missing_fields ?? []).length > 0 ? (
            <View style={styles.warnBox}>
              <Text style={[type.meta, { color: colors.text }]}>
                Onvolledig geïmporteerd: {recipe.missing_fields!.join(', ')} — controleer en vul aan.
              </Text>
            </View>
          ) : null}

          <View style={styles.section}>
            <Text style={type.sectionLabel}>Ingrediënten</Text>
            <View style={styles.ingCard}>
              {scaled.map((ing, i) => {
                const term = (ing.item_normalised ?? ing.raw_text ?? '').trim();
                const open = activeIngredient === i;
                const added = addedIngredients.has(i);
                return (
                <View key={i} style={[styles.ingBlock, i < scaled.length - 1 && styles.ingRowDivider]}>
                  <View style={styles.ingRow}>
                    <View style={styles.ingDot} />
                    <View style={styles.ingCopy}>
                      <Text style={styles.ingName}>{ing.display}</Text>
                      {ing.note && !/^AI-suggestie\b/i.test(ing.note.trim()) ? (
                        <Text style={styles.ingNote}>{ing.note}</Text>
                      ) : null}
                    </View>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={added ? `${term} opnieuw toevoegen` : `${term} toevoegen aan boodschappenlijst`}
                      onPress={() => setActiveIngredient(open ? null : i)}
                      disabled={!term || chains.length === 0}
                      style={[styles.addIngredientBtn, added && styles.addIngredientBtnDone]}
                    >
                      {added ? <Check size={14} color={colors.primary} strokeWidth={2.5} /> : <ShoppingBasket size={14} color={colors.primary} strokeWidth={2.2} />}
                      <Text style={styles.addIngredientText}>{added ? 'Toegevoegd' : 'Voeg toe'}</Text>
                    </Pressable>
                  </View>
                  {open ? (
                    <View style={styles.ingredientPicker}>
                      {pendingProduct?.index === i ? (
                        <View style={styles.quantityCard}>
                          <Text style={styles.pickerHint} numberOfLines={2}>{pendingProduct.option.name}</Text>
                          <View style={styles.quantityRow}>
                            <Pressable
                              accessibilityLabel="Eén minder"
                              onPress={() => setPendingProduct((current) => current ? { ...current, quantity: Math.max(1, current.quantity - 1) } : null)}
                              style={styles.quantityBtn}
                            >
                              <Minus size={16} color={colors.primary} strokeWidth={2.3} />
                            </Pressable>
                            <Text style={styles.quantityValue}>{pendingProduct.quantity}×</Text>
                            <Pressable
                              accessibilityLabel="Eén meer"
                              onPress={() => setPendingProduct((current) => current ? { ...current, quantity: Math.min(99, current.quantity + 1) } : null)}
                              style={styles.quantityBtn}
                            >
                              <Plus size={16} color={colors.primary} strokeWidth={2.3} />
                            </Pressable>
                            <Pressable onPress={() => void confirmIngredientProduct()} style={styles.confirmProductBtn}>
                              <Text style={styles.confirmProductText}>Voeg {pendingProduct.quantity}× toe</Text>
                            </Pressable>
                          </View>
                          <Pressable onPress={() => setPendingProduct(null)} hitSlop={6}>
                            <Text style={styles.chooseOther}>Ander product kiezen</Text>
                          </Pressable>
                        </View>
                      ) : (
                        <>
                          <Text style={styles.pickerHint}>Kies het product dat op je lijst komt</Text>
                          <CrossChainOptions
                            term={term}
                            chains={chains}
                            maxRows={20}
                            onPick={(option) => setPendingProduct({ index: i, term, option, quantity: 1 })}
                          />
                        </>
                      )}
                    </View>
                  ) : null}
                </View>
                );
              })}
            </View>
          </View>

          <View style={styles.section}>
            <View style={styles.sectionHead}>
              <Text style={type.sectionLabel}>Bereiding</Text>
              <Text style={styles.stepCount}>{steps.length} {steps.length === 1 ? 'stap' : 'stappen'}</Text>
            </View>
            {steps.map((s) => (
              <View key={s.order} style={styles.stepCard}>
                <View style={styles.stepBadge}>
                  <Text style={styles.stepBadgeText}>{s.order}</Text>
                </View>
                <Text style={styles.stepText}>{s.text}</Text>
              </View>
            ))}
          </View>

          {/* overige acties — inplannen, delen, verwijderen */}
          <View style={styles.actions}>
            <Pressable style={styles.action} onPress={editRecipe}>
              <Pencil size={18} color={colors.textSoft} strokeWidth={2} />
              <Text style={styles.actionText}>Recept bewerken</Text>
            </Pressable>
            <Pressable
              style={styles.action}
              onPress={() => { setWeekOffset(0); setPlanDay(new Date().getDay() === 0 ? 6 : new Date().getDay() - 1); setSheet('plan'); }}
            >
              <CalendarPlus size={18} color={colors.textSoft} strokeWidth={2} />
              <Text style={styles.actionText}>Inplannen</Text>
            </Pressable>
            <Pressable style={styles.action} onPress={toggleShareHousehold}>
              <Users size={18} color={recipe.household_id ? colors.primary : colors.textSoft} strokeWidth={2} />
              <Text style={[styles.actionText, recipe.household_id && { color: colors.primary, fontFamily: fonts.bodySemiBold }]}>
                {recipe.household_id ? 'Gedeeld met groep ✓' : 'Deel met groep'}
              </Text>
            </Pressable>
            <Pressable style={styles.action} onPress={removeRecipe}>
              <Trash2 size={18} color={colors.danger} strokeWidth={2} />
              <Text style={[styles.actionText, { color: colors.danger }]}>Verwijderen</Text>
            </Pressable>
          </View>
        </View>
      </ScrollView>

      {/* C1 — expliciete terugknop; zonder header is er anders geen weg terug op iOS */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Terug"
        onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))}
        style={[styles.floatBtn, { top: insets.top + 8, left: 16 }]}
      >
        <ChevronLeft size={20} color={colors.text} strokeWidth={2.4} />
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={recipe.household_id ? 'Gedeeld met groep' : 'Deel met groep'}
        onPress={toggleShareHousehold}
        style={[styles.floatBtn, { top: insets.top + 8, right: 16 }]}
      >
        <Users size={17} color={recipe.household_id ? colors.primary : colors.text} strokeWidth={2.2} />
      </Pressable>

      {/* zwevende actiebalk — ingrediënten worden bewust één voor één gekozen */}
      {sheet === 'none' ? (
        <View style={[styles.actionBar, { bottom: Math.max(insets.bottom + 10, 26) }]}>
          <CTAButton
            label="Start kookmodus"
            icon={<ChefHat size={17} color={colors.onPrimary} strokeWidth={2} />}
            onPress={() => router.push(`/cook/${recipe.id}`)}
            style={{ flex: 1 }}
          />
        </View>
      ) : null}

      {sheet === 'plan' ? (
        <View style={[styles.sheet, { paddingBottom: insets.bottom + 24 }]}>
          <View style={styles.sheetHeader}>
            <Text style={type.h3}>Wanneer eten?</Text>
            <Pressable onPress={() => setSheet('none')} hitSlop={10}>
              <X size={20} color={colors.textSoft} />
            </Pressable>
          </View>
          {weekPicker}
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
          <CTAButton
            label={`Inplannen · ${DAY_ABBREV_NL[planDay]} ${Number(addDays(weekStart, planDay).slice(8))} · ${servings} pers.`}
            onPress={planIt}
            style={{ marginTop: 4 }}
          />
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
  heroWrap: { width: '100%', height: 400 },
  hero: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  heroText: { position: 'absolute', left: 22, right: 22, bottom: 44, gap: 5 },
  heroSource: {
    fontFamily: fonts.bodySemiBold, fontSize: 11.5, letterSpacing: 0.4,
    color: 'rgba(253,251,246,0.75)',
  },
  heroTitle: {
    fontFamily: fonts.display, fontSize: 27, lineHeight: 31, color: colors.cream,
    textShadowColor: 'rgba(20,28,17,0.35)', textShadowOffset: { width: 0, height: 2 }, textShadowRadius: 12,
  },
  floatBtn: {
    position: 'absolute', width: 38, height: 38, borderRadius: 19,
    backgroundColor: 'rgba(253,251,246,0.82)', alignItems: 'center', justifyContent: 'center',
    shadowColor: '#141C11', shadowOpacity: 0.18, shadowRadius: 12, shadowOffset: { width: 0, height: 4 }, elevation: 5,
  },
  body: {
    marginTop: -22, backgroundColor: colors.bg,
    borderTopLeftRadius: 28, borderTopRightRadius: 28,
    padding: 22, gap: 18,
    shadowColor: '#141C11', shadowOpacity: 0.14, shadowRadius: 32, shadowOffset: { width: 0, height: -12 }, elevation: 10,
  },
  chipsRow: { flexDirection: 'row', alignItems: 'center', gap: 9 },
  chip: {
    flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 8, paddingHorizontal: 13,
    borderRadius: radius.pill, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border,
  },
  chipText: { fontFamily: fonts.bodySemiBold, fontSize: 12.5, color: colors.textSoft },
  priceChip: { paddingVertical: 8, paddingHorizontal: 13, borderRadius: radius.pill, backgroundColor: colors.badgeBg },
  priceChipText: { fontFamily: fonts.bodyBold, fontSize: 12.5, color: colors.primary },
  stepper: {
    flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 6, paddingHorizontal: 8,
    borderRadius: radius.pill, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border,
  },
  stepBtn: {
    width: 24, height: 24, borderRadius: 12, backgroundColor: colors.surfaceMuted,
    alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.borderControl,
  },
  stepValue: { fontFamily: fonts.bodySemiBold, fontSize: 13, color: colors.text },
  warnBox: { backgroundColor: '#FDF3D8', borderRadius: radius.md, padding: 10 },
  section: { gap: 8 },
  sectionHead: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between' },
  stepCount: { fontFamily: fonts.body, fontSize: 11.5, color: colors.textMuted },
  ingCard: {
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.borderSubtle,
    borderRadius: radius.listCard, overflow: 'hidden',
  },
  ingBlock: { paddingVertical: 2 },
  ingRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 9, paddingHorizontal: 14 },
  ingRowDivider: { borderBottomWidth: 1, borderBottomColor: 'rgba(34,48,30,0.06)' },
  ingDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.primary },
  ingCopy: { flex: 1, minWidth: 0, gap: 2 },
  ingName: { fontFamily: fonts.body, fontSize: 13.5, color: colors.text },
  ingNote: { fontFamily: fonts.body, fontSize: 12, color: colors.textMuted2 },
  addIngredientBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 5, paddingVertical: 7, paddingHorizontal: 9,
    borderRadius: radius.pill, backgroundColor: colors.badgeBg,
  },
  addIngredientBtnDone: { backgroundColor: colors.surfaceMuted },
  addIngredientText: { fontFamily: fonts.bodySemiBold, fontSize: 11.5, color: colors.primary },
  ingredientPicker: { paddingHorizontal: 12, paddingBottom: 12, gap: 7 },
  pickerHint: { fontFamily: fonts.bodySemiBold, fontSize: 11.5, color: colors.textSoft },
  quantityCard: { gap: 10, padding: 12, borderRadius: radius.md, backgroundColor: colors.surfaceMuted },
  quantityRow: { flexDirection: 'row', alignItems: 'center', gap: 9 },
  quantityBtn: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface },
  quantityValue: { minWidth: 32, textAlign: 'center', fontFamily: fonts.bodyBold, fontSize: 14, color: colors.text },
  confirmProductBtn: { flex: 1, minHeight: 38, borderRadius: radius.control, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primary },
  confirmProductText: { fontFamily: fonts.bodyBold, fontSize: 12.5, color: colors.onPrimary },
  chooseOther: { fontFamily: fonts.bodyMedium, fontSize: 11.5, color: colors.textMuted, textAlign: 'center' },
  stepCard: {
    flexDirection: 'row', gap: 12, backgroundColor: colors.surface, borderWidth: 1,
    borderColor: colors.borderSubtle, borderRadius: radius.listCard, padding: 14, marginTop: 2,
  },
  stepBadge: {
    width: 24, height: 24, borderRadius: 12, backgroundColor: colors.badgeBg,
    alignItems: 'center', justifyContent: 'center', flexShrink: 0,
  },
  stepBadgeText: { fontFamily: fonts.bodyBold, fontSize: 12, color: colors.primary },
  stepText: { flex: 1, fontFamily: fonts.body, fontSize: 13, lineHeight: 19.5, color: colors.textSoft },
  actions: { marginTop: 6, gap: 10 },
  action: {
    flexDirection: 'row', gap: 10, alignItems: 'center', padding: 14,
    borderRadius: radius.listCard, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.borderSubtle,
  },
  actionText: { fontFamily: fonts.body, fontSize: 14, lineHeight: 20, color: colors.textSoft },
  actionBar: { position: 'absolute', left: 20, right: 20, flexDirection: 'row', gap: 10 },
  sheet: {
    position: 'absolute', left: 0, right: 0, bottom: 0, backgroundColor: colors.bg,
    borderTopLeftRadius: radius.sheet, borderTopRightRadius: radius.sheet, padding: 20, gap: 10,
    ...shadows.float,
  },
  sheetHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  weekRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 4 },
  weekLabel: { fontFamily: fonts.bodySemiBold, fontSize: 13, color: colors.primary },
  sheetRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    backgroundColor: colors.surfaceMuted, borderRadius: radius.control, padding: 14,
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
  pickBlock: { borderBottomWidth: 1, borderBottomColor: 'rgba(34,48,30,.06)', paddingVertical: 4 },
  pickHead: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8 },
  pickChosen: { maxWidth: 170, fontSize: 12, color: colors.primary, fontFamily: fonts.bodySemiBold },
  pickNone: { fontSize: 12.5, color: colors.textMuted2, fontFamily: fonts.bodySemiBold },
});
