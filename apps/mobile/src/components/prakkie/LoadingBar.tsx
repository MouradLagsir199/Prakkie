import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, StyleSheet, Text, View } from 'react-native';
import { colors, fonts, radius } from '../../theme/tokens';

/**
 * Slanke, onbepaalde voortgangsbalk (owner 2026-07-21): tijdens de eerste
 * inlaadslag — prijzen opwarmen, ontdek-data ophalen — schuift er een groen
 * segment heen en weer, zodat het niet lijkt alsof de app vastloopt. Bewust
 * "indeterminate": de matcher levert zijn projecties in één keer op, dus een
 * echt percentage zou van 0 → 100 springen. Deze animatie is eerlijk en rustig.
 */

const SEGMENT_FRACTION = 0.4;

export function LoadingBar({ label }: { label?: string }) {
  const progress = useRef(new Animated.Value(0)).current;
  const [trackWidth, setTrackWidth] = useState(0);

  useEffect(() => {
    const animation = Animated.loop(
      Animated.timing(progress, {
        toValue: 1,
        duration: 1150,
        easing: Easing.inOut(Easing.ease),
        useNativeDriver: true,
      })
    );
    animation.start();
    return () => animation.stop();
  }, [progress]);

  const segmentWidth = Math.max(48, trackWidth * SEGMENT_FRACTION);
  const translateX = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [-segmentWidth, trackWidth],
  });

  return (
    <View style={styles.wrap} accessibilityRole="progressbar" accessibilityLabel={label ?? 'Bezig met laden'}>
      <View style={styles.track} onLayout={(e) => setTrackWidth(e.nativeEvent.layout.width)}>
        {trackWidth > 0 ? (
          <Animated.View
            style={[styles.segment, { width: segmentWidth, transform: [{ translateX }] }]}
          />
        ) : null}
      </View>
      {label ? <Text style={styles.label}>{label}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 8 },
  track: {
    height: 4,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceMuted,
    overflow: 'hidden',
  },
  segment: {
    height: 4,
    borderRadius: radius.pill,
    backgroundColor: colors.primary,
  },
  label: { fontSize: 12, fontFamily: fonts.bodyMedium, color: colors.textMuted, textAlign: 'center' },
});
