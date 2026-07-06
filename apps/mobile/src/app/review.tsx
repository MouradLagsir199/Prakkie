import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import { Check, ChevronDown, ChevronUp } from 'lucide-react-native';
import { useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { newId, syncNow, upsertRow } from '../data';
import { takePendingReview } from '../data/import-flow';
import type { RecipeRowData } from '../data/recipes';
import { colors, fonts, radius, type } from '../theme/tokens';

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
  const [stepsOpen, setStepsOpen] = useState(false);
  const [editIdx, setEditIdx] = useState<number | null>(null);
  const steps = outcome?.recipe.steps ?? [];

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
  const platformLabel =
    r.source_platform === 'instagram' ? 'Reel' : r.source_platform === 'tiktok' ? 'TikTok' :
    r.source_platform === 'blog' ? 'Website' : (r.source_platform ?? 'Import');
  const uncertain = (i: { confidence?: number | null }) => (i.confidence ?? 1) < 0.7;
  const allRecognised = !ingredients.some(uncertain) && (r.missing_fields ?? []).length === 0;

  async function save() {
    if (!title.trim()) {
      Alert.alert('Titel ontbreekt', 'Geef het recept een naam.');
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
        time_prep_min: r.time_prep_min ?? null,
        time_cook_min: r.time_cook_min ?? null,
        ingredients,
        steps,
        tags: r.tags ?? [],
        cuisine: r.cuisine ?? null,
        diet_flags: (r as { diet_flags?: string[] }).diet_flags ?? [],
        missing_fields: r.missing_fields ?? [],
      },
      id
    );
    syncNow(['recipes']).catch(() => {});
    router.dismissAll();
    router.replace('/');
  }

  const heroUrl = (r.images ?? [])[0];
  const qtyLabel = (i: (typeof ingredients)[number]) =>
    i.quantity != null
      ? `${String(i.quantity).replace('.', ',')}${i.unit ? ` ${i.unit}` : ' st'}`
      : i.raw_text && i.item_normalised && i.raw_text !== i.item_normalised
        ? ''
        : 'naar smaak';

  return (
    <View style={[styles.screen, { paddingTop: insets.top + 6 }]}>
      <View style={styles.topBar}>
        <Pressable onPress={() => router.back()} hitSlop={10}>
          <Text style={styles.cancel}>Annuleer</Text>
        </Pressable>
        <Text style={styles.topTitle}>Controleer recept</Text>
        <Text style={[styles.cancel, { opacity: 0 }]}>Annuleer</Text>
      </View>

      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 120, paddingTop: 14 }} showsVerticalScrollIndicator={false}>
        <View style={styles.successStrip}>
          <Check size={15} color={colors.primary} strokeWidth={2.2} />
          <Text style={styles.successText}>
            {outcome.warnings.length
              ? `Geïmporteerd met ${outcome.warnings.length} aandachtspunt(en) — kijk de gemarkeerde regels na`
              : 'Geïmporteerd — caption, beeld en structuur gecombineerd'}
          </Text>
        </View>

        <View style={styles.headRow}>
          {typeof heroUrl === 'string' && heroUrl ? (
            <Image source={{ uri: heroUrl }} style={styles.thumb} contentFit="cover" />
          ) : (
            <View style={[styles.thumb, { backgroundColor: '#E7EEDD' }]} />
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
          <Pressable style={styles.metaChip} onPress={() => setServings(Math.max(1, servings - 1))} onLongPress={() => setServings(servings + 1)}>
            <Text style={styles.metaChipText}>{servings} personen</Text>
          </Pressable>
          <Pressable style={[styles.metaChip, { paddingHorizontal: 8 }]} onPress={() => setServings(servings + 1)}>
            <Text style={styles.metaChipText}>+</Text>
          </Pressable>
          {r.time_prep_min ? (
            <View style={styles.metaChip}>
              <Text style={styles.metaChipText}>{r.time_prep_min} min voorbereiden</Text>
            </View>
          ) : null}
          {r.time_cook_min ? (
            <View style={styles.metaChip}>
              <Text style={styles.metaChipText}>{r.time_cook_min} min koken</Text>
            </View>
          ) : null}
        </View>

        {(r.missing_fields ?? []).length > 0 ? (
          <View style={styles.warnStrip}>
            <Text style={styles.warnReason}>
              Niet gevonden in de bron: {r.missing_fields!.join(', ')} — we verzinnen niets, vul aan waar nodig.
            </Text>
          </View>
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
                  <TextInput
                    style={styles.ingEdit}
                    value={ing.raw_text ?? ''}
                    autoFocus
                    onChangeText={(t) => setIngredients(ingredients.map((x, j) => (j === i ? { ...x, raw_text: t } : x)))}
                    onBlur={() => setEditIdx(null)}
                  />
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
                    {warn && ing.note ? <Text style={styles.warnReason}>{ing.note}</Text> : null}
                  </>
                )}
              </Pressable>
            );
          })}
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
              <View key={s.order} style={[styles.stepItem, i < steps.length - 1 && styles.rowBorder]}>
                <Text style={styles.stepNum}>{s.order}</Text>
                <Text style={[type.body, { flex: 1, fontSize: 13.5 }]}>{s.text}</Text>
              </View>
            ))}
          </View>
        ) : null}
      </ScrollView>

      <View style={[styles.ctaWrap, { paddingBottom: insets.bottom + 26 }]}>
        <Pressable style={styles.cta} onPress={save}>
          <Text style={styles.ctaText}>Bewaar in Mijn recepten</Text>
        </Pressable>
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
    borderRadius: 13, paddingHorizontal: 13, paddingVertical: 10,
  },
  successText: { flex: 1, fontSize: 12, color: '#3D5138' },
  headRow: { marginTop: 14, flexDirection: 'row', gap: 12, alignItems: 'center' },
  thumb: { width: 58, height: 58, borderRadius: 14 },
  titleInput: { fontFamily: fonts.display, fontSize: 20, lineHeight: 23, color: colors.text, padding: 0 },
  sourceLine: { fontSize: 11.5, color: colors.textMuted },
  chipsRow: { marginTop: 12, flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  metaChip: {
    paddingHorizontal: 12, paddingVertical: 7, borderRadius: 10, backgroundColor: colors.surface,
    borderWidth: 1, borderColor: 'rgba(34,48,30,.12)',
  },
  metaChipText: { fontSize: 12.5, color: colors.textSoft },
  warnStrip: { marginTop: 12, backgroundColor: '#FBF0DC', borderRadius: 12, padding: 11 },
  sectionLabel: {
    marginTop: 16, fontSize: 12, fontFamily: fonts.bodyBold, letterSpacing: 0.5, color: colors.textMuted,
  },
  card: {
    marginTop: 8, backgroundColor: colors.surface, borderWidth: 1, borderColor: 'rgba(34,48,30,.08)',
    borderRadius: 16, overflow: 'hidden',
  },
  rowBorder: { borderBottomWidth: 1, borderBottomColor: 'rgba(34,48,30,.06)' },
  ingRow: { paddingHorizontal: 14, paddingVertical: 11, gap: 4 },
  ingWarn: { backgroundColor: '#FBF0DC' },
  ingTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 10 },
  ingName: { fontSize: 13.5, color: colors.text, flexShrink: 1 },
  ingQty: { fontSize: 13.5, color: colors.textMuted },
  ingQtyWarn: { color: '#8A6116', fontFamily: fonts.bodySemiBold },
  checkPill: {
    paddingHorizontal: 8, paddingVertical: 3, borderRadius: radius.pill, overflow: 'hidden',
    backgroundColor: '#F1D9A8', color: '#6E4D10', fontSize: 10, fontFamily: fonts.bodyBold,
  },
  warnReason: { fontSize: 11, color: '#8A6116' },
  ingEdit: {
    fontSize: 13.5, color: colors.text, backgroundColor: colors.bg, borderRadius: 8,
    paddingHorizontal: 10, paddingVertical: 7,
  },
  stepsRow: {
    marginTop: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: colors.surface, borderWidth: 1, borderColor: 'rgba(34,48,30,.08)',
    borderRadius: 14, paddingHorizontal: 14, paddingVertical: 12,
  },
  stepsTitle: { fontSize: 13.5, fontFamily: fonts.bodySemiBold, color: colors.text },
  recognised: { fontSize: 12.5, color: colors.primary, fontFamily: fonts.bodySemiBold },
  stepItem: { flexDirection: 'row', gap: 10, paddingHorizontal: 14, paddingVertical: 10 },
  stepNum: { width: 18, fontSize: 13.5, fontFamily: fonts.bodySemiBold, color: colors.primary },
  ctaWrap: { position: 'absolute', left: 20, right: 20, bottom: 0 },
  cta: {
    backgroundColor: colors.primary, borderRadius: 16, paddingVertical: 16, alignItems: 'center',
    shadowColor: colors.primary, shadowOpacity: 0.35, shadowRadius: 24, shadowOffset: { width: 0, height: 10 }, elevation: 8,
  },
  ctaText: { fontSize: 16, fontFamily: fonts.bodySemiBold, color: colors.onPrimary },
});
