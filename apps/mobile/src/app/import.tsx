import * as Clipboard from 'expo-clipboard';
import { useRouter } from 'expo-router';
import { Camera, ClipboardPaste, Link2, PencilLine, X } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ImportError, importUrl, setPendingReview } from '../data/import-flow';
import { colors, radius, type } from '../theme/tokens';

/** Import sheet — mockup 03, now live: clipboard card + link input → /v1/import → review. */

const OPTIONS = [
  { key: 'photo', label: 'Foto of scan (binnenkort)', Icon: Camera },
  { key: 'text', label: 'Tekst plakken (binnenkort)', Icon: ClipboardPaste },
  { key: 'manual', label: 'Handmatig', Icon: PencilLine },
];

const looksLikeUrl = (s: string) => /^https?:\/\/\S+$/i.test(s.trim());

export default function ImportSheet() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const [url, setUrl] = useState('');
  const [clipboardUrl, setClipboardUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');

  useEffect(() => {
    Clipboard.getStringAsync().then((s) => {
      if (looksLikeUrl(s)) setClipboardUrl(s.trim());
    }).catch(() => {});
  }, []);

  async function run(target: string) {
    if (!looksLikeUrl(target)) {
      Alert.alert('Geen geldige link', 'Plak een volledige link (https://…).');
      return;
    }
    setBusy(true);
    try {
      const outcome = await importUrl(target.trim(), setStatus);
      setPendingReview(outcome);
      router.replace('/review');
    } catch (err) {
      const msg = err instanceof ImportError ? err.message : 'Import mislukt. Probeer het opnieuw.';
      Alert.alert('Import mislukt', msg);
    } finally {
      setBusy(false);
      setStatus('');
    }
  }

  return (
    <View style={[styles.screen, { paddingTop: insets.top + 12, paddingBottom: insets.bottom + 16 }]}>
      <View style={styles.headerRow}>
        <Text style={type.screenTitle}>Recept importeren</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Sluiten" onPress={() => router.back()} style={styles.close}>
          <X size={20} strokeWidth={1.9} color={colors.textSoft} />
        </Pressable>
      </View>

      {busy ? (
        <View style={styles.busyBox}>
          <ActivityIndicator color={colors.primary} size="large" />
          <Text style={type.body}>{status || 'Bezig met importeren…'}</Text>
        </View>
      ) : (
        <>
          {clipboardUrl ? (
            <Pressable style={styles.clipCard} onPress={() => run(clipboardUrl)}>
              <Link2 size={20} strokeWidth={1.9} color={colors.primary} />
              <View style={{ flex: 1 }}>
                <Text style={type.h3}>Link gevonden op je klembord</Text>
                <Text style={type.meta} numberOfLines={1}>{clipboardUrl}</Text>
              </View>
              <Text style={[type.chip, { color: colors.primary }]}>Importeer</Text>
            </Pressable>
          ) : null}

          <View style={styles.inputRow}>
            <TextInput
              style={styles.input}
              placeholder="Plak hier een link (Instagram, TikTok, blog…)"
              placeholderTextColor={colors.textMuted2}
              autoCapitalize="none"
              autoCorrect={false}
              value={url}
              onChangeText={setUrl}
              onSubmitEditing={() => run(url)}
            />
            <Pressable style={styles.goBtn} onPress={() => run(url)}>
              <Text style={{ ...type.chip, color: colors.onPrimary }}>Import</Text>
            </Pressable>
          </View>

          <View style={styles.divider}>
            <View style={styles.dividerLine} />
            <Text style={type.meta}>of kies zelf</Text>
            <View style={styles.dividerLine} />
          </View>

          <View style={styles.options}>
            {OPTIONS.map(({ key, label, Icon }) => (
              <Pressable
                key={key}
                accessibilityRole="button"
                style={styles.option}
                onPress={() => {
                  if (key === 'manual') {
                    setPendingReview({
                      recipe: { id: '', title: '', ingredients: [], steps: [], servings_base: 2 },
                      warnings: [],
                      importId: '',
                    });
                    router.replace('/review');
                  }
                }}
              >
                <Icon size={20} strokeWidth={1.9} color={colors.primary} />
                <Text style={styles.optionLabel}>{label}</Text>
              </Pressable>
            ))}
          </View>

          <Text style={[type.meta, styles.footer]}>
            Sneller: deel rechtstreeks vanuit Instagram of TikTok via <Text style={styles.footerBold}>Deel → Prakkie</Text>.
            Eén tik, klaar.
          </Text>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg, paddingHorizontal: 20, gap: 18 },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  close: {
    width: 34, height: 34, borderRadius: 17, backgroundColor: colors.surface,
    alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.borderSubtle,
  },
  busyBox: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16 },
  clipCard: {
    flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: colors.surface,
    borderRadius: radius.card, padding: 14, borderWidth: 1, borderColor: colors.primary,
  },
  inputRow: { flexDirection: 'row', gap: 10 },
  input: {
    flex: 1, backgroundColor: colors.surface, borderRadius: radius.control, paddingHorizontal: 14,
    paddingVertical: 12, borderWidth: 1, borderColor: colors.borderSubtle, ...type.body,
  },
  goBtn: {
    backgroundColor: colors.primary, borderRadius: radius.control, paddingHorizontal: 16,
    alignItems: 'center', justifyContent: 'center',
  },
  divider: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  dividerLine: { flex: 1, height: 1, backgroundColor: colors.borderSubtle },
  options: { gap: 10 },
  option: {
    flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: colors.surface,
    borderRadius: radius.card, padding: 16, borderWidth: 1, borderColor: colors.borderSubtle,
  },
  optionLabel: { ...type.h3 },
  footer: { textAlign: 'center', marginTop: 'auto' },
  footerBold: { fontFamily: type.h3.fontFamily, color: colors.textSoft },
});
