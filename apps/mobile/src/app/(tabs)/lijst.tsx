import { StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ScreenHeader } from '../../components/prakkie/ScreenHeader';
import { colors, type } from '../../theme/tokens';

/** Lijst — boodschappen. Contract: tab_designs_ui/html/06_Lijst_boodschappen.html — built in WS5. */
export default function LijstScreen() {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.screen, { paddingTop: insets.top + 8 }]}>
      <ScreenHeader title="Boodschappen" contextLine="AH-indeling · live gekoppeld aan weekplan" />
      <View style={styles.placeholder}>
        <Text style={type.meta}>Slimme lijst met prijzen — komt in WS5.</Text>
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
