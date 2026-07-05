import { StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ScreenHeader } from '../../components/prakkie/ScreenHeader';
import { colors, type } from '../../theme/tokens';

/** Prijzen — vergelijking. Contract: tab_designs_ui/html/07_Prijzen_vergelijking.html — built in WS5. */
export default function PrijzenScreen() {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.screen, { paddingTop: insets.top + 8 }]}>
      <ScreenHeader title="Prijzen & Bonus" contextLine="Weekboodschappen · prijzen van vandaag" />
      <View style={styles.placeholder}>
        <Text style={type.meta}>Jouw mandje per supermarkt — komt in WS5.</Text>
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
