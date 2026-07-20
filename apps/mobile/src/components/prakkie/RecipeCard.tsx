import { Image } from 'expo-image';
import { Heart } from 'lucide-react-native';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { FixtureRecipe } from '../../fixtures/recipes';
import { colors, radius, shadows, type } from '../../theme/tokens';
import { BonusBadge, PricePill } from './Badges';

/**
 * Recipe card for the 2-column grid — REDESIGN 1a: price pill frosted on the
 * photo (bottom-left), bonus badge top-left, heart top-right, and one meta
 * line "25 min · via Leukerecepten" under the title. Prop-driven so the
 * Ontdek feed reuses it one-for-one.
 */
export function RecipeCard({
  recipe,
  sourceAttribution,
  onPress,
  liked,
  onToggleLike,
}: {
  recipe: FixtureRecipe;
  /** "via Leukerecepten" — only for Ontdek cards (docs/04 §4). */
  sourceAttribution?: string;
  onPress?: () => void;
  /** undefined = geen hartje tonen (eigen bibliotheek); boolean = Ontdek-kaart. */
  liked?: boolean;
  onToggleLike?: () => void;
}) {
  const metaLine = [
    recipe.timeTotalMin ? `${recipe.timeTotalMin} min` : null,
    sourceAttribution ?? null,
  ]
    .filter(Boolean)
    .join(' · ');

  // het hartje is een SIBLING van de kaart-knop, geen kind — geneste Pressables
  // worden op react-native-web <button> in <button> en dat is invalide DOM
  return (
    <View style={styles.card}>
      <Pressable accessibilityRole="button" onPress={onPress}>
        <View style={styles.photoWrap}>
          <Image source={{ uri: recipe.imageUrl }} style={styles.photo} contentFit="cover" transition={150} />
          {recipe.bonusTip ? (
            <View style={styles.badgeTopLeft}>
              <BonusBadge />
            </View>
          ) : null}
          {recipe.pricePerPortionCents ? (
            <View style={styles.priceOverlay}>
              <PricePill cents={recipe.pricePerPortionCents} onPhoto />
            </View>
          ) : null}
        </View>
        <View style={styles.body}>
          <Text style={type.cardTitle} numberOfLines={2}>
            {recipe.title}
          </Text>
          {metaLine ? <Text style={type.meta}>{metaLine}</Text> : null}
        </View>
      </Pressable>
      {onToggleLike ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={liked ? 'Verwijder uit Mijn recepten' : 'Bewaar in Mijn recepten'}
          onPress={onToggleLike}
          hitSlop={8}
          style={styles.heartBtn}
        >
          <Heart
            size={14}
            strokeWidth={2.1}
            color={liked ? colors.heart : colors.textSoft}
            fill={liked ? colors.heart : 'transparent'}
          />
        </Pressable>
      ) : null}
    </View>
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
    height: 122,
  },
  photo: {
    flex: 1,
    backgroundColor: colors.badgeBg,
  },
  badgeTopLeft: {
    position: 'absolute',
    top: 8,
    left: 8,
  },
  priceOverlay: {
    position: 'absolute',
    left: 8,
    bottom: 8,
  },
  heartBtn: {
    position: 'absolute',
    top: 8,
    right: 8,
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: 'rgba(253,251,246,0.88)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  body: {
    padding: 12,
    gap: 5,
  },
});
