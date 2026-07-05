import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import { AlertCircle, X } from 'lucide-react-native';
import { useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { newId, syncNow, upsertRow } from '../data';
import { takePendingReview } from '../data/import-flow';
import type { RecipeRowData } from '../data/recipes';
import { colors, radius, type } from '../theme/tokens';

/**
 * Import review — mockup 04: edit-before-save, confidence chips on uncertain
 * ingredients, provenance hint, "Bewaar in Mijn recepten".
 */
export default function ReviewScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const [outcome] = useState(takePendingReview);
  const [title, setTitle] = useState(outcome?.recipe.title ?? '');
  const [ingredients, setIngredients] = useState(outcome?.recipe.ingredients ?? []);
  const [steps] = useState(outcome?.recipe.steps ?? []);

  if (!outcome) {
    return (
      <View style={[styles.screen, { paddingTop: insets.top + 16, alignItems: 'center' }]}>
        <Text style={type.body}>Geen import om te controleren.</Text>
        <Pressable onPress={() => router.back()}><Text style={[type.body, { color: colors.primary }]}>Terug</Text></Pressable>
      </View>
    );
  }
  const r = outcome.recipe;

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
        origin: r.source_url ? 'import' : 'manual',
        source_url: r.source_url ?? null,
        source_platform: r.source_platform ?? null,
        source_author: r.source_author ?? null,
        images: r.images ?? [],
        servings_base: r.servings_base ?? 2,
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
  return (
    <View style={[styles.screen, { paddingTop: insets.top + 12 }]}>
      <View style={styles.headerRow}>
        <Text style={type.screenTitle}>Controleer</Text>
        <Pressable onPress={() => router.back()} style={styles.close}>
          <X size={20} color={colors.textSoft} />
        </Pressable>
      </View>
      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 110, gap: 12 }} showsVerticalScrollIndicator={false}>
        {typeof heroUrl === 'string' && heroUrl ? (
          <Image source={{ uri: heroUrl }} style={styles.hero} contentFit="cover" />
        ) : null}
        {r.source_author || r.source_platform ? (
          <Text style={type.meta}>
            Bron: {r.source_author ?? ''} {r.source_platform ? `· ${r.source_platform}` : ''} — bron blijft bewaard
          </Text>
        ) : null}
        {(r.missing_fields ?? []).length > 0 ? (
          <View style={styles.warnBox}>
            <AlertCircle size={16} color={colors.bonusText} />
            <Text style={[type.meta, { color: colors.bonusText, flex: 1 }]}>
              Niet gevonden in de bron: {r.missing_fields!.join(', ')}. Vul aan waar nodig — we verzinnen niets.
            </Text>
          </View>
        ) : null}

        <TextInput style={styles.titleInput} value={title} onChangeText={setTitle} placeholder="Titel" />

        <Text style={type.h2}>Ingrediënten · {ingredients.length}</Text>
        {ingredients.map((ing, i) => {
          const uncertain = (ing.confidence ?? 1) < 0.7;
          return (
            <View key={i} style={styles.ingRow}>
              <TextInput
                style={[styles.ingInput, uncertain && styles.ingUncertain]}
                value={ing.raw_text ?? ''}
                onChangeText={(t) =>
                  setIngredients(ingredients.map((x, j) => (j === i ? { ...x, raw_text: t } : x)))
                }
              />
              {uncertain ? <Text style={styles.checkChip}>controleer</Text> : null}
            </View>
          );
        })}

        <Text style={[type.h2, { marginTop: 8 }]}>Stappen · {steps.length}</Text>
        {steps.map((s) => (
          <Text key={s.order} style={type.body}>
            {s.order}. {s.text}
          </Text>
        ))}
      </ScrollView>

      <Pressable style={[styles.saveBtn, { bottom: insets.bottom + 20 }]} onPress={save}>
        <Text style={styles.saveText}>Bewaar in Mijn recepten</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg, paddingHorizontal: 20 },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  close: {
    width: 34, height: 34, borderRadius: 17, backgroundColor: colors.surface,
    alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.borderSubtle,
  },
  hero: { width: '100%', height: 170, borderRadius: radius.card },
  warnBox: {
    flexDirection: 'row', gap: 8, alignItems: 'center', backgroundColor: '#FDF3D8',
    borderRadius: radius.md, padding: 10,
  },
  titleInput: {
    ...type.h1, backgroundColor: colors.surface, borderRadius: radius.control,
    padding: 12, borderWidth: 1, borderColor: colors.borderSubtle,
  },
  ingRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  ingInput: {
    flex: 1, ...type.body, backgroundColor: colors.surface, borderRadius: radius.control,
    paddingHorizontal: 12, paddingVertical: 9, borderWidth: 1, borderColor: colors.borderSubtle,
  },
  ingUncertain: { borderColor: colors.bonus },
  checkChip: {
    ...type.badge, color: colors.bonusText, backgroundColor: colors.bonus,
    borderRadius: radius.pill, paddingHorizontal: 8, paddingVertical: 4, overflow: 'hidden',
  },
  saveBtn: {
    position: 'absolute', left: 20, right: 20, backgroundColor: colors.primary,
    borderRadius: radius.pill, paddingVertical: 16, alignItems: 'center',
  },
  saveText: { ...type.h3, color: colors.onPrimary },
});
