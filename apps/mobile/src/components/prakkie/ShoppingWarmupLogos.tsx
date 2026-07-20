import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, Easing, StyleSheet, Text, View } from 'react-native';
import { colors, fonts, radius } from '../../theme/tokens';
import { ChainLogo } from './ChainLogo';

function PulsingLogo({ chain, index, reduceMotion }: { chain: string; index: number; reduceMotion: boolean }) {
  const opacity = useRef(new Animated.Value(0.32)).current;

  useEffect(() => {
    if (reduceMotion) {
      opacity.setValue(1);
      return;
    }
    const animation = Animated.loop(
      Animated.sequence([
        Animated.delay(index * 85),
        Animated.timing(opacity, {
          toValue: 1,
          duration: 260,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
          isInteraction: false,
        }),
        Animated.timing(opacity, {
          toValue: 0.32,
          duration: 260,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
          isInteraction: false,
        }),
      ])
    );
    animation.start();
    return () => animation.stop();
  }, [index, opacity, reduceMotion]);

  return (
    <Animated.View style={{ opacity, marginLeft: index === 0 ? 0 : -5 }}>
      <ChainLogo id={chain} size={25} />
    </Animated.View>
  );
}

/** Visible only during the once-per-session store/list warm-up. */
export function ShoppingWarmupLogos({
  chains,
  withList,
  title,
  body,
}: {
  chains: readonly string[];
  withList: boolean;
  title?: string;
  body?: string;
}) {
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    let live = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((enabled) => { if (live) setReduceMotion(enabled); })
      .catch(() => {});
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
    return () => {
      live = false;
      subscription.remove();
    };
  }, []);

  return (
    <View
      style={styles.banner}
      accessibilityRole="progressbar"
      accessibilityLabel="Prijzen en alternatieven van je supermarkten laden"
    >
      <View style={styles.logos} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        {chains.map((chain, index) => (
          <PulsingLogo key={chain} chain={chain} index={index} reduceMotion={reduceMotion} />
        ))}
      </View>
      <View style={styles.copy}>
        <Text style={styles.title}>
          {title ?? (withList ? 'Je lijstje slim voorbereiden…' : 'Je supermarkten voorbereiden…')}
        </Text>
        <Text style={styles.body}>
          {body ?? (withList
            ? 'Prijzen en alternatieven worden één keer geladen.'
            : 'Producten en aanbiedingen worden één keer geladen.')}
        </Text>
      </View>
    </View>
  );
}

/** One calm, app-level warm-up state. Used once at startup while the catalog
 * snapshot and first list prices are pulled into memory. */
export function ShoppingWarmupOverlay({ chains }: { chains: readonly string[] }) {
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    let live = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((enabled) => { if (live) setReduceMotion(enabled); })
      .catch(() => {});
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
    return () => {
      live = false;
      subscription.remove();
    };
  }, []);

  return (
    <View
      style={styles.overlay}
      accessibilityRole="progressbar"
      accessibilityLabel="Laatste prijzen ophalen"
    >
      <View style={styles.overlayInner}>
        <View style={styles.overlayLogos} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          {chains.map((chain, index) => (
            <PulsingLogo key={chain} chain={chain} index={index} reduceMotion={reduceMotion} />
          ))}
        </View>
        <Text style={styles.overlayTitle}>Laatste prijzen ophalen</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFill,
    zIndex: 50,
    elevation: 50,
    backgroundColor: colors.bg,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 28,
  },
  overlayInner: { alignItems: 'center', gap: 13 },
  overlayLogos: { flexDirection: 'row', alignItems: 'center' },
  overlayTitle: { fontSize: 15, fontFamily: fonts.bodySemiBold, color: colors.text },
  banner: {
    minHeight: 60,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 13,
    paddingVertical: 10,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radius.lg,
  },
  logos: { flexDirection: 'row', alignItems: 'center' },
  copy: { flex: 1, minWidth: 0, gap: 1 },
  title: { fontSize: 12.5, fontFamily: fonts.bodySemiBold, color: colors.text },
  body: { fontSize: 10.5, lineHeight: 14, fontFamily: fonts.body, color: colors.textMuted2 },
});
