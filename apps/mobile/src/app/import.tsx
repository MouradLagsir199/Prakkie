import { useRouter } from 'expo-router';
import { Camera, ClipboardPaste, Link2, PencilLine, X } from 'lucide-react-native';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, radius, type } from '../theme/tokens';

/**
 * Import sheet — opens from the FAB.
 * Contract: tab_designs_ui/html/03_Import_sheet.html. Clipboard detection and
 * the live import flow land in WS3/WS4; this is the visual contract skeleton.
 */

const OPTIONS = [
  { key: 'link', label: 'Plak een link', Icon: Link2 },
  { key: 'photo', label: 'Foto of scan', Icon: Camera },
  { key: 'text', label: 'Tekst plakken', Icon: ClipboardPaste },
  { key: 'manual', label: 'Handmatig', Icon: PencilLine },
];

export default function ImportSheet() {
  const insets = useSafeAreaInsets();
  const router = useRouter();

  return (
    <View style={[styles.screen, { paddingTop: insets.top + 12, paddingBottom: insets.bottom + 16 }]}>
      <View style={styles.headerRow}>
        <Text style={type.screenTitle}>Recept importeren</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Sluiten" onPress={() => router.back()} style={styles.close}>
          <X size={20} strokeWidth={1.9} color={colors.textSoft} />
        </Pressable>
      </View>

      <View style={styles.divider}>
        <View style={styles.dividerLine} />
        <Text style={type.meta}>of kies zelf</Text>
        <View style={styles.dividerLine} />
      </View>

      <View style={styles.options}>
        {OPTIONS.map(({ key, label, Icon }) => (
          <Pressable key={key} accessibilityRole="button" style={styles.option}>
            <Icon size={20} strokeWidth={1.9} color={colors.primary} />
            <Text style={styles.optionLabel}>{label}</Text>
          </Pressable>
        ))}
      </View>

      <Text style={[type.meta, styles.footer]}>
        Sneller: deel rechtstreeks vanuit Instagram of TikTok via <Text style={styles.footerBold}>Deel → Prakkie</Text>.
        Eén tik, klaar.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.bg,
    paddingHorizontal: 20,
    gap: 20,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  close: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    alignItems: 'center',
    justifyContent: 'center',
  },
  divider: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  dividerLine: {
    flex: 1,
    height: 1,
    backgroundColor: colors.borderSubtle,
  },
  options: {
    gap: 10,
  },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: colors.surface,
    borderRadius: radius.control,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    paddingHorizontal: 16,
    paddingVertical: 16,
  },
  optionLabel: {
    fontFamily: 'InstrumentSans_600SemiBold',
    fontSize: 15,
    color: colors.text,
  },
  footer: {
    textAlign: 'center',
    marginTop: 'auto',
  },
  footerBold: {
    fontFamily: 'InstrumentSans_700Bold',
    color: colors.textSoft,
  },
});
