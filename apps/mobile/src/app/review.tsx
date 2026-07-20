import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import { Check, ChevronDown, ChevronUp, Minus, Plus, Sparkles, Trash2 } from 'lucide-react-native';
import { useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { CTAButton } from '../components/prakkie/CTAButton';
import { newId, syncNow, upsertRow } from '../data';
import { authedRequest } from '../data/api';
import { takePendingReview } from '../data/import-flow';
import type { RecipeRowData } from '../data/recipes';
import { notice } from '../lib/dialogs';
import { colors, fonts, radius, shadows, type } from '../theme/tokens';

/**
 * Import review — mockup 04 1:1: top bar, green success strip, source line
 * ("bron blijft bewaard"), meta chips, ingredient rows with amber
 * "controleer" pattern on low-confidence lines, collapsed steps row,
 * "Bewaar in Mijn recepten" CTA.
 */
export default function ReviewScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const [outcome] = useState(takePendingReview);
  const [title, setTitle] = useState(outcome?.recipe.title ?? '');
  const [ingredients, setIngredients] = useState(outcome?.recipe.ingredients ?? []);
  const [servings, setServings] = useState(outcome?.recipe.servings_base ?? 2);
  const [steps, setSteps] = useState(outcome?.recipe.steps ?? []);
  // manual entry (I1): open the steps editor right away when there's nothing yet
  const [stepsOpen, setStepsOpen] = useState((outcome?.recipe.steps ?? []).length === 0);
  const [editIdx, setEditIdx] = useState<number | null>(null);
  const [stepEditIdx, setStepEditIdx] = useState<number | null>(null);
  // tijden + missing_fields als state: "Vul het recept aan" mag ze bijwerken
  const [meta, setMeta] = useState({
    time_prep_min: outcome?.recipe.time_prep_min ?? null,
    time_cook_min: outcome?.recipe.time_cook_min ?? null,
    missing_fields: (outcome?.recipe.missing_fields ?? []) as string[],
  });
  const [enriching, setEnriching] = useState(false);

  if (!outcome) {
    return (
      <View style={[styles.screen, { paddingTop: insets.top + 16, alignItems: 'center', gap: 10 }]}>
        <Text style={type.body}>Geen import om te controleren.</Text>
        <Pressable onPress={() => router.back()}>
          <Text style={[type.body, { color: colors.primary }]}>Terug</Text>
        </Pressable>
      </View>
    );
  }
  const r = outcome.recipe;
  // porties-schaling (owner 2026-07-08): −/+ schaalt de getoonde hoeveelheden
  // live mee; bij opslaan worden de GESCHAALDE hoeveelheden + gekozen porties
  // weggeschreven — wat je ziet is wat je bewaart
  const baseServings = r.servings_base ?? 2;
  const factor = servings / baseServings;
  const isManual = !r.source_url && outcome.importId === '';
  const isEditing = outcome.importId === 'edit';
  const platformLabel =
    r.source_platform === 'instagram' ? 'Reel' : r.source_platform === 'tiktok' ? 'TikTok' :
    r.source_platform === 'blog' ? 'Website' : (r.source_platform ?? 'Import');
  const uncertain = (i: { confidence?: number | null }) => (i.confidence ?? 1) < 0.7;
  const allRecognised = !ingredients.some(uncertain) && meta.missing_fields.length === 0;
  // "Vul het recept aan" (owner 2026-07-10): derde AI-actie — tonen zolang het
  // recept aantoonbaar gaten heeft (parser-signaal, hoeveelheden of dun stappenplan)
  const needsEnrich =
    !isManual &&
    (meta.missing_fields.length > 0 || steps.length < 3 || ingredients.some((i) => i.quantity == null));

  async function enrich() {
    if (enriching) return;
    setEnriching(true);
    try {
      const payload = {
        recipe: {
          title: title.trim() || r.title || 'Recept',
          servings_base: baseServings,
          time_prep_min: meta.time_prep_min,
          time_cook_min: meta.time_cook_min,
          ingredients: ingredients.filter((i) => (i.raw_text ?? i.item_normalised ?? '').trim()),
          steps: steps.filter((s) => s.text.trim()),
          missing_fields: meta.missing_fields,
          source_capture: r.source_capture,
        },
      };
      const res = await authedRequest('/v1/recipes/enrich', { method: 'POST', body: JSON.stringify(payload) });
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (res.status === 402) {
        notice('Aanvul-tegoed op', String(body.message ?? 'Je aanvul-tegoed voor deze maand is op.'));
        return;
      }
      if (!res.ok) throw new Error(String(res.status));
      const e = body.recipe as RecipeRowData;
      setIngredients((e.ingredients ?? ingredients).map((ingredient) => ({
        ...ingredient,
        note: ingredient.note && /^AI-suggestie\b/i.test(ingredient.note.trim()) ? null : ingredient.note,
      })));
      setSteps(e.steps ?? steps);
      setMeta({
        time_prep_min: e.time_prep_min ?? meta.time_prep_min,
        time_cook_min: e.time_cook_min ?? meta.time_cook_min,
        missing_fields: (e.missing_fields ?? []) as string[],
      });
      setStepsOpen(true); // laat meteen zien wat er is aangevuld
    } catch {
      notice('Even geen verbinding', 'Aanvullen vereist internet — probeer het zo nog eens.');
    } finally {
      setEnriching(false);
    }
  }

  type Ing = (typeof ingredients)[number];
  function addIngredient() {
    const blank = { raw_text: '', quantity: null, unit: null, item_normalised: null, note: null, confidence: 1 } as Ing;
    setIngredients([...ingredients, blank]);
    setEditIdx(ingredients.length);
  }
  function removeIngredient(i: number) {
    setEditIdx(null);
    setIngredients(ingredients.filter((_, j) => j !== i));
  }
  function addStep() {
    setSteps([...steps, { order: steps.length + 1, text: '' }]);
    setStepsOpen(true);
    setStepEditIdx(steps.length);
  }
  function removeStep(i: number) {
    setStepEditIdx(null);
    setSteps(steps.filter((_, j) => j !== i).map((s, j) => ({ ...s, order: j + 1 })));
  }

  async function save() {
    if (!title.trim()) {
      notice('Titel ontbreekt', 'Geef het recept een naam.');
      return;
    }
    // drop rows the user left empty; a recipe needs at least one real ingredient.
    // Hoeveelheden geschaald naar de gekozen porties — het scherm toonde ze zo.
    const cleanIngredients = ingredients
      .filter((i) => (i.raw_text ?? i.item_normalised ?? '').trim())
      .map((i) => ({
        ...i,
        ...(i.quantity != null ? { quantity: Math.round(i.quantity * factor * 100) / 100 } : {}),
        // Tijdens review is de herkomstmarkering nuttig. In het uiteindelijke
        // recept is het gewoon een ingrediënt en hoort die technische tekst er niet bij.
        note: i.note && !/^AI-suggestie\b/i.test(i.note.trim()) ? i.note : null,
      }));
    const cleanSteps = steps.filter((s) => s.text.trim()).map((s, j) => ({ ...s, order: j + 1 }));
    if (cleanIngredients.length === 0) {
      notice('Nog geen ingrediënten', 'Voeg minstens één ingrediënt toe.');
      return;
    }
    const id = r.id && r.id.length === 36 ? r.id : newId();
    await upsertRow(
      'recipes',
      {
        title: title.trim(),
        origin: (r as { origin?: string }).origin ?? (r.source_url ? 'import' : 'manual'),
        source_url: r.source_url ?? null,
        source_platform: r.source_platform ?? null,
        source_author: r.source_author ?? null,
        images: r.images ?? [],
        servings_base: servings,
        time_prep_min: meta.time_prep_min ?? null,
        time_cook_min: meta.time_cook_min ?? null,
        ingredients: cleanIngredients,
        steps: cleanSteps,
        tags: r.tags ?? [],
        cuisine: r.cuisine ?? null,
        diet_flags: (r as { diet_flags?: string[] }).diet_flags ?? [],
        missing_fields: meta.missing_fields,
      },
      id
    );
    syncNow(['recipes']).catch(() => {});
    if (isEditing) {
      router.replace(`/recipe/${id}`);
    } else {
      router.dismissAll();
      router.replace('/');
    }
  }

  const heroUrl = (r.images ?? [])[0];
  const scaleQty = (q: number) => Math.round(q * factor * 100) / 100;
  const qtyLabel = (i: (typeof ingredients)[number]) =>
    i.quantity != null
      ? `${String(scaleQty(i.quantity)).replace('.', ',')}${i.unit ? ` ${i.unit}` : ' st'}`
      : i.raw_text && i.item_normalised && i.raw_text !== i.item_normalised
        ? ''
        : 'naar smaak';

  return (
    <View style={[styles.screen, { paddingTop: insets.top + 16 }]}>
      <View style={styles.topBar}>
        <Pressable onPress={() => router.back()} hitSlop={10}>
          <Text style={styles.cancel}>Annuleer</Text>
        </Pressable>
        <Text style={styles.topTitle}>{isEditing ? 'Bewerk recept' : 'Controleer recept'}</Text>
        <Text style={[styles.cancel, { opacity: 0 }]}>Annuleer</Text>
      </View>

      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 120, paddingTop: 14 }} showsVerticalScrollIndicator={false}>
        <View style={styles.successStrip}>
          <Check size={15} color={colors.primary} strokeWidth={2.2} />
          <Text style={styles.successText}>
            {isEditing
              ? 'Pas je recept aan en bewaar de wijzigingen'
              : isManual
              ? 'Nieuw recept — vul titel, ingrediënten en stappen in'
              : outcome.warnings.length
                ? `Geïmporteerd met ${outcome.warnings.length} aandachtspunt(en) — kijk de gemarkeerde regels na`
                : 'Recept geïmporteerd — controleer het resultaat'}
          </Text>
        </View>

        <View style={styles.headRow}>
          {typeof heroUrl === 'string' && heroUrl ? (
            <Image source={{ uri: heroUrl }} style={styles.thumb} contentFit="cover" />
          ) : (
            <View style={[styles.thumb, { backgroundColor: colors.badgeBg }]} />
          )}
          <View style={{ flex: 1, gap: 4, minWidth: 0 }}>
            <TextInput style={styles.titleInput} value={title} onChangeText={setTitle} placeholder="Titel" multiline />
            {r.source_author || r.source_platform ? (
              <Text style={styles.sourceLine} numberOfLines={1}>
                {platformLabel}
                {r.source_author ? ` · ${r.source_author}` : ''} · bron blijft bewaard
              </Text>
            ) : null}
          </View>
        </View>

        <View style={styles.chipsRow}>
          <View style={styles.servingsStepper}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Minder personen"
              onPress={() => setServings(Math.max(1, servings - 1))}
              style={styles.stepBtn}
              hitSlop={6}
            >
              <Minus size={14} color={colors.textSoft} strokeWidth={2.2} />
            </Pressable>
            <Text style={styles.metaChipText}>{servings} personen</Text>
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
          {meta.time_prep_min ? (
            <View style={styles.metaChip}>
              <Text style={styles.metaChipText}>{meta.time_prep_min} min voorbereiden</Text>
            </View>
          ) : null}
          {meta.time_cook_min ? (
            <View style={styles.metaChip}>
              <Text style={styles.metaChipText}>{meta.time_cook_min} min koken</Text>
            </View>
          ) : null}
        </View>

        {meta.missing_fields.length > 0 && !isManual ? (
          <View style={styles.warnStrip}>
            <Text style={styles.warnReason}>
              Nog aan te vullen: {meta.missing_fields.join(', ')}
            </Text>
          </View>
        ) : null}

        {needsEnrich ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Vul aan met AI"
            onPress={enrich}
            disabled={enriching}
            style={[styles.enrichBtn, enriching && { opacity: 0.7 }]}
          >
            {enriching ? (
              <ActivityIndicator size="small" color={colors.quota} />
            ) : (
              <Sparkles size={16} color={colors.quota} strokeWidth={2.2} />
            )}
            <Text style={styles.enrichTitle}>{enriching ? 'Aanvullen…' : 'Vul aan met AI'}</Text>
          </Pressable>
        ) : null}

        <Text style={styles.sectionLabel}>INGREDIËNTEN · {ingredients.length}</Text>
        <View style={styles.card}>
          {ingredients.map((ing, i) => {
            const warn = uncertain(ing);
            const isLast = i === ingredients.length - 1;
            const name = ing.item_normalised ?? ing.raw_text ?? '';
            return (
              <Pressable
                key={i}
                style={[styles.ingRow, warn && styles.ingWarn, !isLast && styles.rowBorder]}
                onPress={() => setEditIdx(editIdx === i ? null : i)}
              >
                {editIdx === i ? (
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <TextInput
                      style={[styles.ingEdit, { flex: 1 }]}
                      value={ing.raw_text ?? ''}
                      autoFocus
                      placeholder="bijv. 200 g penne"
                      placeholderTextColor={colors.textMuted}
                      // user text wins: stale normalisation weg, server herleidt bij lijst/prijs (I3)
                      onChangeText={(t) =>
                        setIngredients(
                          ingredients.map((x, j) =>
                            j === i ? { ...x, raw_text: t, item_normalised: null, confidence: 1, note: null } : x
                          )
                        )
                      }
                      onBlur={() => setEditIdx(null)}
                      onSubmitEditing={() => setEditIdx(null)}
                    />
                    <Pressable hitSlop={8} onPress={() => removeIngredient(i)}>
                      <Trash2 size={16} color={colors.textMuted} />
                    </Pressable>
                  </View>
                ) : (
                  <>
                    <View style={styles.ingTop}>
                      <Text style={[styles.ingName, warn && { fontFamily: fonts.bodySemiBold }]} numberOfLines={1}>
                        {name}
                      </Text>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                        <Text style={[styles.ingQty, warn && styles.ingQtyWarn]}>
                          {qtyLabel(ing)}
                          {warn ? '?' : ''}
                        </Text>
                        {warn ? <Text style={styles.checkPill}>controleer</Text> : null}
                      </View>
                    </View>
                    {/* I4: bron-tekst niet verliezen als de hoeveelheid niet parste */}
                    {ing.quantity == null && ing.raw_text && ing.raw_text !== name ? (
                      <Text style={styles.rawSubline} numberOfLines={1}>{ing.raw_text}</Text>
                    ) : null}
                    {warn && ing.note ? <Text style={styles.warnReason}>{ing.note}</Text> : null}
                  </>
                )}
              </Pressable>
            );
          })}
          {/* I1 — handmatig én import: altijd een regel kunnen toevoegen */}
          <Pressable style={[styles.addRow, ingredients.length > 0 && styles.rowBorderTop]} onPress={addIngredient}>
            <Plus size={15} color={colors.primary} strokeWidth={2.4} />
            <Text style={styles.addRowText}>Ingrediënt toevoegen</Text>
          </Pressable>
        </View>

        <Pressable style={styles.stepsRow} onPress={() => setStepsOpen(!stepsOpen)}>
          <Text style={styles.stepsTitle}>Bereiding · {steps.length} stappen</Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            {allRecognised ? (
              <>
                <Text style={styles.recognised}>Alles herkend</Text>
                <Check size={13} color={colors.primary} strokeWidth={2.4} />
              </>
            ) : null}
            {stepsOpen ? <ChevronUp size={15} color={colors.textSoft} /> : <ChevronDown size={15} color={colors.textSoft} />}
          </View>
        </Pressable>
        {stepsOpen ? (
          <View style={[styles.card, { marginTop: 8 }]}>
            {steps.map((s, i) => (
              <Pressable
                key={i}
                style={[styles.stepItem, i < steps.length - 1 && styles.rowBorder]}
                onPress={() => setStepEditIdx(stepEditIdx === i ? null : i)}
              >
                <Text style={styles.stepNum}>{s.order}</Text>
                {stepEditIdx === i ? (
                  <View style={{ flex: 1, flexDirection: 'row', alignItems: 'flex-start', gap: 8 }}>
                    <TextInput
                      style={[styles.ingEdit, { flex: 1 }]}
                      value={s.text}
                      autoFocus
                      multiline
                      placeholder="Beschrijf deze stap…"
                      placeholderTextColor={colors.textMuted}
                      onChangeText={(t) => setSteps(steps.map((x, j) => (j === i ? { ...x, text: t } : x)))}
                      onBlur={() => setStepEditIdx(null)}
                    />
                    <Pressable hitSlop={8} onPress={() => removeStep(i)}>
                      <Trash2 size={16} color={colors.textMuted} />
                    </Pressable>
                  </View>
                ) : (
                  <Text style={[type.body, { flex: 1, fontSize: 13.5 }]}>{s.text || 'tik om te schrijven…'}</Text>
                )}
              </Pressable>
            ))}
            <Pressable style={[styles.addRow, steps.length > 0 && styles.rowBorderTop]} onPress={addStep}>
              <Plus size={15} color={colors.primary} strokeWidth={2.4} />
              <Text style={styles.addRowText}>Stap toevoegen</Text>
            </Pressable>
          </View>
        ) : null}
      </ScrollView>

      <View style={[styles.ctaWrap, { paddingBottom: insets.bottom + 26 }]}>
        <CTAButton label={isEditing ? 'Bewaar wijzigingen' : 'Bewaar in Mijn recepten'} onPress={save} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg, paddingHorizontal: 20 },
  topBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: 4 },
  cancel: { fontSize: 14, color: colors.textMuted },
  topTitle: { fontSize: 16, fontFamily: fonts.bodyBold, color: colors.text },
  successStrip: {
    flexDirection: 'row', alignItems: 'center', gap: 9, backgroundColor: colors.badgeBg,
    borderRadius: 14, paddingHorizontal: 13, paddingVertical: 10,
  },
  successText: { flex: 1, fontSize: 12, color: colors.textSoft },
  headRow: { marginTop: 14, flexDirection: 'row', gap: 12, alignItems: 'center' },
  thumb: { width: 58, height: 58, borderRadius: 14 },
  titleInput: { fontFamily: fonts.display, fontSize: 20, lineHeight: 23, color: colors.text, padding: 0 },
  sourceLine: { fontSize: 11.5, color: colors.textMuted },
  chipsRow: { marginTop: 12, flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  metaChip: {
    paddingHorizontal: 13, paddingVertical: 8, borderRadius: radius.pill, backgroundColor: colors.surface,
    borderWidth: 1, borderColor: colors.borderControl,
  },
  metaChipText: { fontSize: 12.5, fontFamily: fonts.bodySemiBold, color: colors.textSoft },
  servingsStepper: {
    flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 5, paddingHorizontal: 7,
    borderRadius: radius.pill, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.borderControl,
  },
  stepBtn: {
    width: 24, height: 24, borderRadius: 12, backgroundColor: colors.surfaceMuted,
    alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.borderControl,
  },
  warnStrip: { marginTop: 12, backgroundColor: colors.plusBgFrom, borderRadius: 14, padding: 11 },
  enrichBtn: {
    marginTop: 12, alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: colors.quotaBg, borderWidth: 1, borderColor: colors.quotaBorder,
    borderRadius: radius.pill, paddingHorizontal: 13, paddingVertical: 9,
  },
  enrichTitle: { fontSize: 13.5, fontFamily: fonts.bodySemiBold, color: colors.quota },
  sectionLabel: { ...type.sectionLabel, marginTop: 16 },
  card: {
    marginTop: 8, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.borderSubtle,
    borderRadius: radius.listCard, overflow: 'hidden',
    ...shadows.card,
  },
  rowBorder: { borderBottomWidth: 1, borderBottomColor: 'rgba(34,48,30,.06)' },
  rowBorderTop: { borderTopWidth: 1, borderTopColor: 'rgba(34,48,30,.06)' },
  addRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, paddingVertical: 12 },
  addRowText: { fontSize: 13, fontFamily: fonts.bodySemiBold, color: colors.primary },
  rawSubline: { fontSize: 11, color: colors.textMuted2 },
  ingRow: { paddingHorizontal: 14, paddingVertical: 11, gap: 4 },
  ingWarn: { backgroundColor: colors.plusBgFrom },
  ingTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 10 },
  ingName: { fontSize: 13.5, color: colors.text, flexShrink: 1 },
  ingQty: { fontSize: 13.5, color: colors.textMuted },
  ingQtyWarn: { color: colors.plusText, fontFamily: fonts.bodySemiBold },
  checkPill: {
    paddingHorizontal: 8, paddingVertical: 3, borderRadius: radius.pill, overflow: 'hidden',
    backgroundColor: colors.bonus, color: colors.bonusText, fontSize: 10.5, fontFamily: fonts.bodyBold,
  },
  warnReason: { fontSize: 11, color: colors.plusText },
  ingEdit: {
    fontSize: 13.5, color: colors.text, backgroundColor: colors.surfaceMuted, borderRadius: radius.md,
    borderWidth: 1, borderColor: colors.borderControl,
    paddingHorizontal: 10, paddingVertical: 7,
  },
  stepsRow: {
    marginTop: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.borderSubtle,
    borderRadius: radius.listCard, paddingHorizontal: 14, paddingVertical: 12,
  },
  stepsTitle: { fontSize: 13.5, fontFamily: fonts.bodySemiBold, color: colors.text },
  recognised: { fontSize: 12.5, color: colors.primary, fontFamily: fonts.bodySemiBold },
  stepItem: { flexDirection: 'row', gap: 10, paddingHorizontal: 14, paddingVertical: 10 },
  stepNum: { width: 18, fontSize: 13.5, fontFamily: fonts.bodySemiBold, color: colors.primary },
  ctaWrap: { position: 'absolute', left: 20, right: 20, bottom: 0 },
});
