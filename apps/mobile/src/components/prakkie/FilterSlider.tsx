import { useRef, useState } from 'react';
import { PanResponder, StyleSheet, Text, View } from 'react-native';
import { colors, fonts } from '../../theme/tokens';

/**
 * Dependency-vrije schuifbalk voor de receptfilters (owner 2026-07-07):
 * prijs p.p. en bereidingstijd. Bewust geen @react-native-community/slider —
 * dat vergt een native rebuild; PanResponder werkt in Expo Go én op web.
 * Slepen of tikken op de balk; helemaal rechts = "geen limiet" (null).
 */
export function FilterSlider({
  label,
  value,
  min,
  max,
  step,
  format,
  onChange,
}: {
  label: string;
  /** null = geen limiet (schuif helemaal rechts) */
  value: number | null;
  min: number;
  max: number;
  step: number;
  format: (v: number | null) => string;
  onChange: (v: number | null) => void;
}) {
  const [width, setWidth] = useState(0);
  const widthRef = useRef(0);
  const startPct = useRef(0);

  const toValue = (pct: number): number | null => {
    const clamped = Math.max(0, Math.min(1, pct));
    if (clamped >= 0.999) return null; // rechteruitslag = geen limiet
    const raw = min + clamped * (max - min);
    return Math.max(min, Math.round(raw / step) * step);
  };
  const pctOf = (v: number | null) => (v === null ? 1 : (v - min) / (max - min));

  const responder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (evt) => {
        const pct = evt.nativeEvent.locationX / Math.max(1, widthRef.current);
        startPct.current = pct;
        onChangeRef.current(toValue(pct));
      },
      onPanResponderMove: (_evt, g) => {
        const pct = startPct.current + g.dx / Math.max(1, widthRef.current);
        onChangeRef.current(toValue(pct));
      },
    })
  ).current;
  // PanResponder wordt één keer gemaakt — de verse onChange moet via een ref mee
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const pct = pctOf(value);
  return (
    <View style={styles.wrap}>
      <View style={styles.labelRow}>
        <Text style={styles.label}>{label}</Text>
        <Text style={styles.value}>{format(value)}</Text>
      </View>
      <View
        style={styles.track}
        onLayout={(e) => {
          setWidth(e.nativeEvent.layout.width);
          widthRef.current = e.nativeEvent.layout.width;
        }}
        {...responder.panHandlers}
      >
        {/* pointerEvents none: locationX moet relatief aan de tráck blijven, ook bij een tik op de knop */}
        <View pointerEvents="none" style={[styles.fill, { width: Math.max(0, pct * width) }]} />
        <View pointerEvents="none" style={[styles.thumb, { left: Math.max(0, Math.min(width - 18, pct * width - 9)) }]} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 6 },
  labelRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  label: { fontSize: 12, fontFamily: fonts.bodySemiBold, color: colors.textSoft },
  value: { fontSize: 12, fontFamily: fonts.bodyBold, color: colors.primary },
  track: {
    height: 26,
    justifyContent: 'center',
    borderRadius: 13,
    backgroundColor: colors.borderControl,
    overflow: 'visible',
    paddingHorizontal: 0,
  },
  fill: {
    position: 'absolute',
    left: 0,
    top: 9,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.primary,
    opacity: 0.85,
  },
  thumb: {
    position: 'absolute',
    top: 4,
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: colors.surface,
    borderWidth: 2,
    borderColor: colors.primary,
  },
});
