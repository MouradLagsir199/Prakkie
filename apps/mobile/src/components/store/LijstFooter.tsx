import { useRouter } from 'expo-router';
import { ArrowRight, ShoppingCart } from 'lucide-react-native';
import { Pressable, StyleSheet, Text } from 'react-native';
import Animated, { SlideInDown, useReducedMotion } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, fonts, radius } from '../../theme/tokens';

/**
 * De rode draad van het lijst-bouwen: zodra er iets op je lijst staat zweeft
 * deze groene balk onderin élk winkel-scherm — één tik en je bent bij de
 * summary (/lijst/resultaat, per supermarkt met prijzen).
 * `aboveTabBar` schuift 'm boven de zwevende tab-bar op de home.
 */
export function LijstFooter({ count, lastAdded, aboveTabBar }: { count: number; lastAdded?: string | null; aboveTabBar?: boolean }) {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const reduceMotion = useReducedMotion();
  if (count <= 0) return null;
  const bottom = aboveTabBar ? Math.max(insets.bottom, 26) + 92 : insets.bottom + 16;

  return (
    <Animated.View
      entering={reduceMotion ? undefined : SlideInDown.springify().damping(20).stiffness(200)}
      style={[styles.wrap, { bottom }]}
      pointerEvents="box-none"
    >
      <Pressable
        onPress={() => router.push('/lijst/resultaat')}
        accessibilityRole="button"
        accessibilityLabel={`Bekijk je lijstje, ${count} items`}
        style={styles.bar}
      >
        <ShoppingCart size={16} color={colors.onPrimary} strokeWidth={2.2} />
        <Text style={styles.text} numberOfLines={1}>
          {count} op je lijstje{lastAdded ? ` · ${lastAdded}` : ''}
        </Text>
        <Text style={styles.cta}>Bekijk</Text>
        <ArrowRight size={15} color={colors.onPrimary} strokeWidth={2.4} />
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', left: 20, right: 20 },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    backgroundColor: colors.primary,
    borderRadius: radius.pill,
    paddingHorizontal: 16,
    paddingVertical: 13,
    shadowColor: colors.primary,
    shadowOpacity: 0.4,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 7 },
    elevation: 8,
  },
  text: { flex: 1, fontSize: 13, fontFamily: fonts.bodySemiBold, color: colors.onPrimary },
  cta: { fontSize: 13, fontFamily: fonts.bodyBold, color: colors.onPrimary },
});
