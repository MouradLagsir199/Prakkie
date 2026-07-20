import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { ChevronLeft, ChevronRight, Plus, ShoppingBasket, ShoppingCart, X } from 'lucide-react-native';
import { useEffect, useMemo, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { CTAButton } from '../../components/prakkie/CTAButton';
import { TourTarget } from '../../components/prakkie/OnboardingTour';
import { CrossChainOptions, type CrossChainOption } from '../../components/prakkie/ProductOptions';
import { deleteRow, newId, syncNow, upsertRow, useEntityRows } from '../../data';
import { addDays, isoWeekNumber, mondayOf } from '../../data/chains';
import { kv } from '../../data/kv';
import { recipeImage, type RecipeRowData } from '../../data/recipes';
import { confirmDialog, notice } from '../../lib/dialogs';
import { useBoodschappenLijst } from '../../store/lijst';
import { colors, fonts, radius, shadows, type } from '../../theme/tokens';

/** Plannen v5 (owner 2026-07-13): een plan-entry is een RECEPT of een LOS
 *  CATALOOG-PRODUCT (met hoeveelheid). Elk maaltijdmoment heeft een foto-
 *  kopheader ("gewoon om het mooi te maken"), de +'jes eronder. De CTA onderin
 *  zet de week direct op je boodschappenlijst — de AI-resolve is gesloopt;
 *  productkeuzes maak je per regel op de summary of door te winkelen. */

/** kopheader-foto per maaltijdmoment (Pexels, vrije licentie; sharp 900×300) */
const SLOT_ART: Record<SlotKey, number> = {
  breakfast: require('../../../assets/images/meals/breakfast.jpg'),
  lunch: require('../../../assets/images/meals/lunch.jpg'),
  snack: require('../../../assets/images/meals/snack.jpg'),
  dinner: require('../../../assets/images/meals/dinner.jpg'),
};

interface PlanRow { id: string; week_start: string }
interface EntryRow {
  id: string; plan_id: string; recipe_id: string | null; title?: string | null;
  entry_date: string | null; meal_slot: string; servings: number;
  quantity?: number | null; unit?: string | null;
  image_url?: string | null;
}

const SLOTS = [
  { key: 'breakfast', label: 'Ontbijt' },
  { key: 'lunch', label: 'Lunch' },
  { key: 'snack', label: 'Tussendoor' },
  { key: 'dinner', label: 'Avondeten' },
] as const;
type SlotKey = (typeof SLOTS)[number]['key'];

const MONTHS_NL = ['januari', 'februari', 'maart', 'april', 'mei', 'juni', 'juli', 'augustus', 'september', 'oktober', 'november', 'december'];
const MONTHS_KORT = ['jan', 'feb', 'mrt', 'apr', 'mei', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];
const DAYS_NL = ['ma', 'di', 'wo', 'do', 'vr', 'za', 'zo'];
const DAYS_VOL = ['maandag', 'dinsdag', 'woensdag', 'donderdag', 'vrijdag', 'zaterdag', 'zondag'];

const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const dutchDate = (isoDate: string) => {
  const d = new Date(`${isoDate}T12:00:00`);
  return `${d.getDate()} ${MONTHS_NL[d.getMonth()]}`;
};

export default function PlannenScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const [weekOffset, setWeekOffset] = useState(0);
  const [selectedDate, setSelectedDate] = useState<string>(todayIso());
  const { rows: planRows } = useEntityRows('plans');
  const { rows: entryRows } = useEntityRows('plan_entries');
  const { rows: recipeRows } = useEntityRows('recipes');
  const [editEntry, setEditEntry] = useState<EntryRow | null>(null);
  // P1 — in-place kiezer: welk slot van de gekozen dag krijgt een gerecht/product?
  const [pickSlot, setPickSlot] = useState<SlotKey | null>(null);
  const [pickFilter, setPickFilter] = useState('');
  // los product uit de catalogus: zoekterm → keuze → hoeveelheid (owner 2026-07-10)
  const [productQuery, setProductQuery] = useState('');
  const [productTerm, setProductTerm] = useState<string | null>(null);
  const [pickedProduct, setPickedProduct] = useState<CrossChainOption | null>(null);
  const [productQty, setProductQty] = useState('');
  const [myChains, setMyChains] = useState<string[]>(['ah']);
  const { addNames } = useBoodschappenLijst();
  useEffect(() => {
    kv.getItem('prakkie.mychains')
      .then((v) => {
        if (!v) return;
        const arr = JSON.parse(v) as string[];
        if (Array.isArray(arr) && arr.length) setMyChains(arr);
      })
      .catch(() => {});
  }, []);
  useEffect(() => {
    const t = setTimeout(() => setProductTerm(productQuery.trim() || null), 350);
    return () => clearTimeout(t);
  }, [productQuery]);

  const weekStart = mondayOf(weekOffset);
  const weekDays = useMemo(() => [0, 1, 2, 3, 4, 5, 6].map((i) => addDays(weekStart, i)), [weekStart]);
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

  // stipjes: dagen van deze week waar al iets gepland staat
  const plannedDates = useMemo(
    () => new Set(entries.map((e) => e.entry_date).filter(Boolean) as string[]),
    [entries]
  );
  const dayEntries = useMemo(
    () => entries.filter((e) => e.entry_date === selectedDate),
    [entries, selectedDate]
  );
  const dayIndex = weekDays.indexOf(selectedDate);

  function shiftWeek(delta: number) {
    const idx = weekDays.indexOf(selectedDate);
    const next = mondayOf(weekOffset + delta);
    setWeekOffset(weekOffset + delta);
    setSelectedDate(addDays(next, idx >= 0 ? idx : 0));
    setEditEntry(null);
    setPickSlot(null);
  }
  function jumpToToday() {
    setWeekOffset(0);
    setSelectedDate(todayIso());
  }

  async function setServings(entry: EntryRow, delta: number) {
    const next = Math.max(1, entry.servings + delta);
    await upsertRow('plan_entries', { plan_id: entry.plan_id, servings: next }, entry.id);
    setEditEntry((e) => (e && e.id === entry.id ? { ...e, servings: next } : e));
    syncNow(['plan_entries']).catch(() => {});
  }

  async function moveTo(entry: EntryRow, date: string) {
    await upsertRow('plan_entries', { plan_id: entry.plan_id, entry_date: date }, entry.id);
    setEditEntry(null);
    syncNow(['plan_entries']).catch(() => {});
  }

  async function setSlot(entry: EntryRow, slot: SlotKey) {
    await upsertRow('plan_entries', { plan_id: entry.plan_id, meal_slot: slot }, entry.id);
    setEditEntry((e) => (e && e.id === entry.id ? { ...e, meal_slot: slot } : e));
    syncNow(['plan_entries']).catch(() => {});
  }

  /** de geplande week → regels op dé boodschappenlijst (zonder AI): recepten
   *  worden ingrediënten geschaald naar de geplande porties; losse producten
   *  nemen hun hoeveelheid mee. Kiezen/prijzen gebeurt op de summary. */
  async function importWeekToList() {
    const rows: { name: string; quantity?: number | null; unit?: string | null }[] = [];
    for (const e of entries) {
      if (e.recipe_id) {
        const recipe = recipeById.get(e.recipe_id);
        if (!recipe) continue;
        const factor = e.servings / Math.max(1, recipe.servings_base ?? 2);
        for (const ing of recipe.ingredients ?? []) {
          const name = (ing.item_normalised || ing.raw_text || '').trim();
          if (!name) continue;
          rows.push({
            name,
            quantity: ing.quantity != null ? Math.round(ing.quantity * factor * 100) / 100 : null,
            unit: ing.unit ?? null,
          });
        }
      } else if (e.title) {
        rows.push({ name: e.title, quantity: e.quantity ?? null, unit: e.unit ?? null });
      }
    }
    if (!rows.length) {
      notice('Niets te importeren', 'De geplande recepten hebben nog geen ingrediënten.');
      return;
    }
    await addNames(rows);
    router.push('/lijst/resultaat');
  }

  async function removeEntry(entry: EntryRow) {
    const label = (entry.recipe_id ? recipeById.get(entry.recipe_id)?.title : entry.title) ?? 'Recept';
    setEditEntry(null);
    if (!(await confirmDialog({ title: 'Van het menu halen?', message: label, confirmLabel: 'Verwijderen', destructive: true }))) return;
    await deleteRow('plan_entries', entry.id);
    syncNow(['plan_entries']).catch(() => {});
  }

  /** P1/P3 — plan a recipe or free-text note straight onto the selected day+slot. */
  async function ensurePlanId(): Promise<string> {
    if (plan) return plan.id;
    const id = newId();
    await upsertRow('plans', { week_start: weekStart }, id);
    return id;
  }

  async function planRecipe(recipe: RecipeRowData & { id: string }) {
    if (!pickSlot) return;
    const planId = await ensurePlanId();
    await upsertRow('plan_entries', {
      plan_id: planId, recipe_id: recipe.id, entry_date: selectedDate,
      meal_slot: pickSlot, servings: recipe.servings_base ?? 2,
    });
    setPickSlot(null);
    setPickFilter('');
    syncNow(['plans', 'plan_entries']).catch(() => {});
  }

  /** los cataloog-product inplannen mét hoeveelheid (owner 2026-07-10) */
  async function planProduct() {
    if (!pickedProduct || !pickSlot) return;
    // "500 g" / "2" / "1,5 l" → numeriek + eenheid; leeg = 1 stuks
    const m = productQty.trim().match(/^([\d.,]+)\s*(.*)$/);
    const quantity = m ? Number(m[1]!.replace(',', '.')) || 1 : 1;
    const unit = m && m[2] ? m[2].trim() : null;
    const planId = await ensurePlanId();
    await upsertRow('plan_entries', {
      plan_id: planId, recipe_id: null, title: pickedProduct.name, entry_date: selectedDate,
      meal_slot: pickSlot, servings: 1, quantity, unit, image_url: pickedProduct.image_url ?? null,
    });
    setPickedProduct(null);
    setProductQty('');
    setProductQuery('');
    setProductTerm(null);
    setPickSlot(null);
    syncNow(['plans', 'plan_entries']).catch(() => {});
  }

  const recipeEntries = entries.filter((e) => e.recipe_id);

  const entryCard = (entry: EntryRow) => {
    const recipe = entry.recipe_id ? recipeById.get(entry.recipe_id) : undefined;
    const isProduct = !entry.recipe_id;
    const label = recipe?.title ?? entry.title ?? 'Recept';
    // owner 2026-07-10: bij het plannen bewust GEEN prijzen — die zie je op
    // de boodschappen-summary zodra de week op je lijst staat
    const qtyLabel = entry.quantity != null ? `${String(entry.quantity).replace('.', ',')}${entry.unit ? ` ${entry.unit}` : '×'}` : '1×';
    return (
      <Pressable
        key={entry.id}
        style={styles.entryCard}
        onPress={() => setEditEntry(entry)}
        onLongPress={() => removeEntry(entry)}
      >
        {isProduct ? (
          entry.image_url ? (
            <Image source={{ uri: entry.image_url }} style={styles.entryThumb} contentFit="contain" />
          ) : (
            <View style={[styles.entryThumb, styles.noteThumb]}>
              <ShoppingBasket size={15} color={colors.primary} strokeWidth={1.9} />
            </View>
          )
        ) : (
          <Image source={{ uri: recipe ? recipeImage(recipe) : undefined }} style={styles.entryThumb} contentFit="cover" />
        )}
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <Text style={styles.entryTitle} numberOfLines={1}>{label}</Text>
          <Text style={styles.entryMeta}>
            {isProduct ? `product · ${qtyLabel}` : `${entry.servings} pers.`}
          </Text>
        </View>
        {isProduct ? null : (
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
    <View style={[styles.screen, { paddingTop: insets.top + 24 }]}>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.headerRow}>
          <Text style={styles.title}>Weekplanner</Text>
          <Text style={styles.weekBadge}>Week {isoWeekNumber(weekStart)}</Text>
        </View>

        {/* week-strip — zelfde patroon als Boodschappen: pijltjes naast de dagen,
            stipje onder het getal = die dag heeft al een menu */}
        <TourTarget targetId="plan-week">
        <View style={styles.weekCard}>
          <View style={styles.weekRow}>
            <Pressable onPress={() => shiftWeek(-1)} hitSlop={10} accessibilityLabel="Vorige week" style={styles.weekArrow}>
              <ChevronLeft size={16} color={colors.primary} strokeWidth={2.2} />
            </Pressable>
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
                  <View style={[styles.weekDot, { opacity: plannedDates.has(date) ? 1 : 0 }]} />
                </Pressable>
              );
            })}
            <Pressable onPress={() => shiftWeek(1)} hitSlop={10} accessibilityLabel="Volgende week" style={styles.weekArrow}>
              <ChevronRight size={16} color={colors.primary} strokeWidth={2.2} />
            </Pressable>
          </View>
        </View>
        </TourTarget>

        <View style={styles.dayHeader}>
          <Pressable onPress={jumpToToday} hitSlop={6} accessibilityLabel="Naar vandaag">
            <Text style={styles.dayTitle}>
              {dayIndex >= 0 ? `${DAYS_VOL[dayIndex]} ${dutchDate(selectedDate)}` : dutchDate(selectedDate)}
            </Text>
          </Pressable>
          <Text style={type.meta}>
            {dayEntries.length ? `${dayEntries.length} ${dayEntries.length === 1 ? 'gerecht' : 'gerechten'}` : ''}
          </Text>
        </View>

        {/* de dag in vier maaltijd-secties, elk met een foto-kopheader
            (owner 2026-07-13: "meer imagery, gewoon om het mooi te maken") */}
        <View style={{ gap: 18 }}>
          {SLOTS.map(({ key, label }) => {
            const slotEntries = dayEntries.filter((e) => (e.meal_slot ?? 'dinner') === key);
            return (
              <View key={key} style={{ gap: 8 }}>
                <TourTarget targetId={key === 'breakfast' ? 'plan-slot' : `plan-slot-${key}`}>
                <Pressable
                  style={styles.slotHero}
                  onPress={() => setPickSlot(key)}
                  accessibilityRole="button"
                  accessibilityLabel={`Plan ${label.toLowerCase()}`}
                >
                  <Image source={SLOT_ART[key]} style={styles.slotHeroImg} contentFit="cover" transition={150} />
                  <LinearGradient
                    colors={['rgba(20,28,17,0)', 'rgba(20,28,17,0.62)']}
                    style={styles.slotHeroScrim}
                  />
                  <Text style={styles.slotHeroLabel}>{label}</Text>
                  {slotEntries.length ? (
                    <View style={styles.slotHeroCount}>
                      <Text style={styles.slotHeroCountText}>{slotEntries.length}</Text>
                    </View>
                  ) : null}
                </Pressable>
                </TourTarget>
                {slotEntries.map(entryCard)}
                <Pressable style={styles.emptySlot} onPress={() => setPickSlot(key)}>
                  <Plus size={13} color={colors.textMuted2} strokeWidth={2.2} />
                  <Text style={styles.emptyText}>
                    {slotEntries.length ? 'nog een gerecht' : `Plan ${label.toLowerCase()}`}
                  </Text>
                </Pressable>
              </View>
            );
          })}
        </View>
      </ScrollView>

      {entries.length > 0 ? (
        /* owner 2026-07-13: geen AI-resolve meer — de week gaat als regels
           direct op dé lijst (recepten → geschaalde ingrediënten, producten →
           naam + hoeveelheid); productkeuzes maak je op de summary */
        <CTAButton
          label={`Zet week op je lijst (${entries.length})`}
          icon={<ShoppingCart size={16} color={colors.onPrimary} strokeWidth={2} />}
          onPress={importWeekToList}
          style={[styles.ctaWrap, { bottom: insets.bottom + 96 }]}
        />
      ) : null}

      {/* P1/P3 — kiezer: recept uit je bibliotheek óf een vrije notitie, voor het
          getikte slot. KeyboardAvoidingView: het telefoon-toetsenbord schoof
          anders óver de typvelden heen (owner-bug 2026-07-08) */}
      {pickSlot ? (
        <KeyboardAvoidingView
          pointerEvents="box-none"
          behavior={Platform.OS === 'web' ? undefined : 'padding'}
          style={styles.sheetWrap}
        >
        <View style={[styles.sheet, styles.sheetInWrap, { paddingBottom: insets.bottom + 100 }]}>
          <View style={styles.sheetHeader}>
            <Text style={type.h3}>
              {SLOTS.find((s) => s.key === pickSlot)?.label} · {dayIndex >= 0 ? DAYS_NL[dayIndex] : ''} {Number(selectedDate.slice(8))} {MONTHS_KORT[Number(selectedDate.slice(5, 7)) - 1]}
            </Text>
            <Pressable onPress={() => setPickSlot(null)} hitSlop={10}>
              <X size={20} color={colors.textSoft} />
            </Pressable>
          </View>

          {recipeRows.length > 6 ? (
            <TextInput
              style={styles.pickInput}
              placeholder="Zoek in je recepten…"
              placeholderTextColor={colors.textMuted2}
              value={pickFilter}
              onChangeText={setPickFilter}
            />
          ) : null}

          <ScrollView style={{ maxHeight: 250 }} showsVerticalScrollIndicator={false}>
            {recipeRows.length === 0 ? (
              <Pressable style={styles.pickEmpty} onPress={() => { setPickSlot(null); router.push('/import'); }}>
                <Text style={[type.body, { color: colors.primary }]}>
                  Nog geen recepten — like iets in Ontdek of importeer via +
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

          {/* los product uit de catalogus (owner 2026-07-10): zoeken → kiezen →
              hoeveelheid. Geen vrije tekst; prijzen zie je op de summary. */}
          {pickedProduct ? (
            <View style={{ gap: 8 }}>
              <Text style={type.h3} numberOfLines={1}>{pickedProduct.name}</Text>
              <View style={styles.noteRow}>
                <TextInput
                  style={[styles.pickInput, { flex: 1, marginTop: 0 }]}
                  placeholder="hoeveelheid — bijv. 2, 500 g, 1,5 l"
                  placeholderTextColor={colors.textMuted2}
                  value={productQty}
                  onChangeText={setProductQty}
                  autoFocus
                  onSubmitEditing={planProduct}
                />
                <Pressable style={styles.noteBtn} onPress={planProduct} accessibilityLabel="Zet in planning">
                  <Plus size={16} color={colors.onPrimary} strokeWidth={2.2} />
                </Pressable>
              </View>
              <Pressable onPress={() => setPickedProduct(null)}>
                <Text style={[type.meta, { color: colors.textMuted }]}>← ander product kiezen</Text>
              </Pressable>
            </View>
          ) : (
            <>
              <TextInput
                style={styles.pickInput}
                placeholder="of plan een los product: zoek in de catalogus…"
                placeholderTextColor={colors.textMuted2}
                value={productQuery}
                onChangeText={setProductQuery}
                autoCapitalize="none"
              />
              {productTerm ? (
                <ScrollView style={{ maxHeight: 220 }} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
                  <CrossChainOptions
                    term={productTerm}
                    chains={myChains}
                    maxRows={10}
                    onPick={(o) => setPickedProduct(o)}
                  />
                </ScrollView>
              ) : null}
            </>
          )}
        </View>
        </KeyboardAvoidingView>
      ) : null}

      {/* bewerk-sheet: slot wisselen, dag verplaatsen, porties, verwijderen */}
      {editEntry ? (
        <View style={[styles.sheet, { paddingBottom: insets.bottom + 100 }]}>
          <View style={styles.sheetHeader}>
            <Text style={type.h3} numberOfLines={1}>
              {(editEntry.recipe_id ? recipeById.get(editEntry.recipe_id)?.title : editEntry.title) ?? 'Recept'}
            </Text>
            <Pressable onPress={() => setEditEntry(null)} hitSlop={10}>
              <X size={20} color={colors.textSoft} />
            </Pressable>
          </View>

          <Text style={styles.sheetSection}>MAALTIJD</Text>
          <View style={styles.slotRow}>
            {SLOTS.map(({ key, label }) => {
              const on = (editEntry.meal_slot ?? 'dinner') === key;
              return (
                <Pressable key={key} onPress={() => setSlot(editEntry, key)} style={[styles.slotChip, on && styles.slotChipOn]}>
                  <Text style={[styles.slotChipText, on && { color: colors.onPrimary }]}>{label}</Text>
                </Pressable>
              );
            })}
          </View>

          {editEntry.recipe_id ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
              <Text style={styles.sheetSection}>PORTIES</Text>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <Pressable onPress={() => setServings(editEntry, -1)} hitSlop={8} style={styles.srvBtn}>
                  <Text style={styles.srvText}>−</Text>
                </Pressable>
                <Text style={[type.h3, { minWidth: 22, textAlign: 'center' }]}>{editEntry.servings}</Text>
                <Pressable onPress={() => setServings(editEntry, 1)} hitSlop={8} style={styles.srvBtn}>
                  <Text style={styles.srvText}>+</Text>
                </Pressable>
              </View>
            </View>
          ) : null}

          <Text style={styles.sheetSection}>VERPLAATS NAAR…</Text>
          <View style={styles.moveDays}>
            {weekDays.map((d, i) => (
              <Pressable key={d} style={styles.moveDay} onPress={() => moveTo(editEntry, d)}>
                <Text style={type.chip}>{DAYS_NL[i]} {Number(d.slice(8))}</Text>
              </Pressable>
            ))}
          </View>

          <Pressable onPress={() => removeEntry(editEntry)}>
            <Text style={[type.body, { color: colors.danger, textAlign: 'center' }]}>Van het menu halen</Text>
          </Pressable>
          <Pressable onPress={() => setEditEntry(null)}>
            <Text style={[type.body, { color: colors.textMuted, textAlign: 'center' }]}>Annuleren</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { paddingHorizontal: 20, paddingBottom: 220, gap: 16 },
  headerRow: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between' },
  title: { ...type.screenTitle },
  weekBadge: {
    fontSize: 12, fontFamily: fonts.bodyBold, color: colors.primary,
    backgroundColor: colors.badgeBg, borderRadius: radius.pill, paddingVertical: 5, paddingHorizontal: 11,
    overflow: 'hidden',
  },
  weekCard: {
    backgroundColor: colors.surface, borderRadius: 18, paddingVertical: 14, paddingHorizontal: 10,
    borderWidth: 1, borderColor: colors.borderSubtle, ...shadows.card,
  },
  weekRow: { flexDirection: 'row', alignItems: 'center' },
  weekArrow: { paddingHorizontal: 2, paddingVertical: 8 },
  weekCell: { flex: 1, alignItems: 'center', gap: 4 },
  weekdayLabel: { fontSize: 10, fontFamily: fonts.bodyBold, color: colors.textMuted2 },
  weekDay: { width: 31, height: 31, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  weekToday: { borderWidth: 1.5, borderColor: colors.primary },
  weekSelected: {
    backgroundColor: colors.primary, borderWidth: 0,
    shadowColor: colors.primary, shadowOpacity: 0.35, shadowRadius: 14, shadowOffset: { width: 0, height: 6 }, elevation: 5,
  },
  weekDayText: { fontSize: 13, fontFamily: fonts.body, color: colors.text },
  weekDot: { width: 5, height: 5, borderRadius: 3, backgroundColor: colors.primary },
  dayHeader: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between' },
  dayTitle: { fontFamily: fonts.display, fontSize: 20, lineHeight: 24, color: colors.text },
  slotLabel: { ...type.sectionLabel },
  slotHero: {
    height: 82, borderRadius: radius.lg, overflow: 'hidden',
    backgroundColor: colors.surface, ...shadows.card,
  },
  slotHeroImg: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  slotHeroScrim: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 56 },
  slotHeroLabel: {
    position: 'absolute', left: 13, bottom: 9,
    fontFamily: fonts.display, fontSize: 18, color: colors.cream,
  },
  slotHeroCount: {
    position: 'absolute', right: 10, bottom: 10, minWidth: 22, height: 22, borderRadius: 11,
    backgroundColor: 'rgba(253,251,246,0.92)', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 6,
  },
  slotHeroCountText: { fontSize: 11.5, fontFamily: fonts.bodyBold, color: colors.primary },
  entryCard: {
    flexDirection: 'row', alignItems: 'center', gap: 11, backgroundColor: colors.surface,
    borderWidth: 1, borderColor: colors.borderSubtle, borderRadius: radius.control,
    paddingVertical: 9, paddingLeft: 9, paddingRight: 12, ...shadows.card,
  },
  entryThumb: { width: 44, height: 44, borderRadius: 11, backgroundColor: '#EDE7D8' },
  entryTitle: { fontSize: 13.5, fontFamily: fonts.bodySemiBold, color: colors.text },
  entryMeta: { fontSize: 11, fontFamily: fonts.body, color: colors.textMuted },
  srvBtn: {
    width: 26, height: 26, borderRadius: 13, backgroundColor: colors.surfaceMuted, alignItems: 'center',
    justifyContent: 'center', borderWidth: 1, borderColor: colors.borderControl,
  },
  srvText: { fontSize: 15, color: colors.textSoft, lineHeight: 18 },
  emptySlot: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    borderWidth: 1.5, borderStyle: 'dashed', borderColor: 'rgba(34,48,30,0.16)', borderRadius: 13, padding: 12,
  },
  emptyText: { fontSize: 12, fontFamily: fonts.body, color: colors.textMuted2 },
  ctaWrap: { position: 'absolute', left: 20, right: 20 },
  sheet: {
    position: 'absolute', left: 0, right: 0, bottom: 0, backgroundColor: colors.bg,
    borderTopLeftRadius: radius.sheet, borderTopRightRadius: radius.sheet, padding: 20, gap: 12,
    shadowColor: '#000', shadowOpacity: 0.12, shadowRadius: 16, shadowOffset: { width: 0, height: -6 }, elevation: 10,
  },
  // typ-sheets zitten in een KeyboardAvoidingView: absolute → relative, anders
  // negeert de absolute positionering de keyboard-padding
  sheetWrap: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, justifyContent: 'flex-end' },
  sheetInWrap: { position: 'relative' },
  sheetHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  sheetSection: { ...type.sectionLabel },
  slotRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 },
  slotChip: {
    paddingHorizontal: 13, paddingVertical: 8, borderRadius: radius.pill, backgroundColor: colors.surfaceMuted,
    borderWidth: 1, borderColor: colors.borderControl,
  },
  slotChipOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  slotChipText: { fontSize: 12.5, fontFamily: fonts.bodySemiBold, color: colors.textSoft },
  noteThumb: { alignItems: 'center', justifyContent: 'center', backgroundColor: colors.badgeBg },
  pickInput: {
    marginTop: 4, backgroundColor: colors.surfaceMuted, borderRadius: 12, paddingHorizontal: 13, paddingVertical: 10,
    borderWidth: 1, borderColor: colors.borderControl, fontSize: 13.5, fontFamily: fonts.body, color: colors.text,
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
    paddingHorizontal: 14, paddingVertical: 10, borderRadius: radius.pill, backgroundColor: colors.surfaceMuted,
    borderWidth: 1, borderColor: colors.borderControl,
  },
  calHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 4 },
  calMonthLabel: { fontSize: 14, fontFamily: fonts.bodySemiBold, color: colors.text },
  calWeekRow: { flexDirection: 'row', gap: 4 },
  calWeekday: { flex: 1, textAlign: 'center', fontSize: 10.5, fontFamily: fonts.bodyBold, color: colors.textMuted2 },
  calDay: { flex: 1, alignItems: 'center', paddingVertical: 7, borderRadius: 10, gap: 2 },
  calToday: { backgroundColor: colors.badgeBg },
  calDayText: { fontSize: 13.5, color: colors.text },
  calDot: { width: 4, height: 4, borderRadius: 2, backgroundColor: colors.primary },
});
