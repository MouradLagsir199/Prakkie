import { Image } from 'expo-image';
import { Clock } from 'lucide-react-native';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { FixtureRecipe } from '../../fixtures/recipes';
import { colors, radius, shadows, type } from '../../theme/tokens';
import { BonusBadge, PricePill } from './Badges';

/**
 * Recipe card for the 2-column grid — mockup 01. Prop-driven so the Ontdek
 * feed (WS7) reuses it one-for-one with an extra source-attribution line.
 */
export function RecipeCard({
  recipe,
  sourceAttribution,
  onPress,
}: {
  recipe: FixtureRecipe;
  /** "via Leukerecepten" — only for Ontdek cards (docs/04 §4). */
  sourceAttribution?: string;
  onPress?: () => void;
}) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={styles.card}>
      <View style={styles.photoWrap}>
        <Image source={{ uri: recipe.imageUrl }} style={styles.photo} contentFit="cover" transition={150} />
        {recipe.bonusTip ? (
          <View style={styles.badgeOverlay}>
            <BonusBadge />
          </View>
        ) : null}
      </View>
      <View style={styles.body}>
        <Text style={type.cardTitle} numberOfLines={2}>
          {recipe.title}
        </Text>
        <View style={styles.metaRow}>
          <Clock size={12} strokeWidth={1.9} color={colors.textMuted} />
          <Text style={type.meta}>{recipe.timeTotalMin} min</Text>
        </View>
        <PricePill cents={recipe.pricePerPortionCents} />
        {sourceAttribution ? <Text style={styles.attribution}>{sourceAttribution}</Text> : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    flex: 1,
    backgroundColor: colors.surface,
    borderRadius: radius.card,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    overflow: 'hidden',
    ...shadows.card,
  },
  photoWrap: {
    height: 118,
  },
  photo: {
    flex: 1,
    backgroundColor: colors.badgeBg,
  },
  badgeOverlay: {
    position: 'absolute',
    top: 8,
    left: 8,
  },
  body: {
    padding: 10,
    gap: 6,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  attribution: {
    fontFamily: 'InstrumentSans_400Regular',
    fontSize: 11,
    color: colors.textMuted2,
  },
});
