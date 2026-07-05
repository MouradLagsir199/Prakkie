import { StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ScreenHeader } from '../../components/prakkie/ScreenHeader';
import { colors, type } from '../../theme/tokens';

/** Plannen — weekplanner. Contract: tab_designs_ui/html/05_Plannen_weekplanner.html — built in WS6. */
export default function PlannenScreen() {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.screen, { paddingTop: insets.top + 8 }]}>
      <ScreenHeader title="Weekplanner" contextLine="Week 28 · 6 – 12 juli" />
      <View style={styles.placeholder}>
        <Text style={type.meta}>Sleep een recept hierheen — komt in WS6.</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg, paddingHorizontal: 16, gap: 16 },
  placeholder: {
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: colors.borderSubtle,
    borderRadius: 18,
    padding: 24,
    alignItems: 'center',
  },
});
