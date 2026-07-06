import * as Clipboard from 'expo-clipboard';
import { useRouter } from 'expo-router';
import { Camera, ClipboardPaste, Link2, PencilLine, X } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ImportError, importUrl, setPendingReview } from '../data/import-flow';
import { notice } from '../lib/dialogs';
import { colors, fonts, radius, type } from '../theme/tokens';

/** Import sheet — mockup 03 1:1: clipboard card + green CTA, "of kies zelf",
 *  option cards, share-tip footer. Live flow → /v1/import → review. */

const OPTIONS = [
  { key: 'link', label: 'Plak een link', Icon: Link2 },
  { key: 'photo', label: 'Foto of scan', Icon: Camera, soon: true },
  { key: 'text', label: 'Tekst plakken', Icon: ClipboardPaste, soon: true },
  { key: 'manual', label: 'Handmatig', Icon: PencilLine },
];

const looksLikeUrl = (s: string) => /^https?:\/\/\S+$/i.test(s.trim());
const hostOf = (u: string) => {
  try {
    return new URL(u).hostname.replace('www.', '') + new URL(u).pathname.slice(0, 18) + '…';
  } catch {
    return u.slice(0, 40);
  }
};

export default function ImportSheet() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const [url, setUrl] = useState('');
  const [showInput, setShowInput] = useState(false);
  const [clipboardUrl, setClipboardUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');

  useEffect(() => {
    Clipboard.getStringAsync()
      .then((s) => {
        if (looksLikeUrl(s)) setClipboardUrl(s.trim());
      })
      .catch(() => {});
  }, []);

  async function run(target: string) {
    if (!looksLikeUrl(target)) {
      notice('Geen geldige link', 'Plak een volledige link (https://…).');
      return;
    }
    setBusy(true);
    try {
      const outcome = await importUrl(target.trim(), setStatus);
      setPendingReview(outcome);
      router.replace('/review');
    } catch (err) {
      const msg = err instanceof ImportError ? err.message : 'Import mislukt. Probeer het opnieuw.';
      notice('Import mislukt', msg);
    } finally {
      setBusy(false);
      setStatus('');
    }
  }

  return (
    <View style={[styles.screen, { paddingTop: insets.top + 10 }]}>
      <View style={styles.grabber} />
      <View style={styles.headerRow}>
        <Text style={styles.title}>Recept importeren</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Sluiten" onPress={() => router.back()} style={styles.close}>
          <X size={18} strokeWidth={1.9} color={colors.textSoft} />
        </Pressable>
      </View>

      {busy ? (
        <View style={styles.busyBox}>
          <ActivityIndicator color={colors.primary} size="large" />
          <Text style={type.body}>{status || 'Bezig met importeren…'}</Text>
          <Text style={type.meta}>Video's kunnen tot een minuut duren</Text>
        </View>
      ) : (
        <ScrollView contentContainerStyle={{ gap: 14, paddingBottom: insets.bottom + 24 }} showsVerticalScrollIndicator={false}>
          {clipboardUrl ? (
            <View style={styles.clipCard}>
              <View style={styles.clipRow}>
                <View style={styles.clipThumb}>
                  <Link2 size={18} strokeWidth={1.9} color={colors.primary} />
                </View>
                <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                  <Text style={styles.clipTitle}>Link op je klembord gevonden</Text>
                  <Text style={styles.clipSub} numberOfLines={1}>{hostOf(clipboardUrl)}</Text>
                </View>
              </View>
              <Pressable style={styles.clipCta} onPress={() => run(clipboardUrl)}>
                <Text style={styles.clipCtaText}>Importeer deze link</Text>
              </Pressable>
              <Text style={styles.clipHint}>
                Video-import: gesproken én in beeld getoonde ingrediënten worden herkend
              </Text>
            </View>
          ) : null}

          {showInput ? (
            <View style={styles.inputRow}>
              <TextInput
                style={styles.input}
                placeholder="https://…"
                placeholderTextColor={colors.textMuted2}
                autoCapitalize="none"
                autoCorrect={false}
                autoFocus
                value={url}
                onChangeText={setUrl}
                onSubmitEditing={() => run(url)}
              />
              <Pressable style={styles.goBtn} onPress={() => run(url)}>
                <Text style={{ fontSize: 13, fontFamily: fonts.bodySemiBold, color: colors.onPrimary }}>Import</Text>
              </Pressable>
            </View>
          ) : null}

          <View style={styles.divider}>
            <View style={styles.dividerLine} />
            <Text style={styles.dividerText}>of kies zelf</Text>
            <View style={styles.dividerLine} />
          </View>

          <View style={{ gap: 10 }}>
            {OPTIONS.map(({ key, label, Icon, soon }) => (
              <Pressable
                key={key}
                accessibilityRole="button"
                style={[styles.option, soon && { opacity: 0.55 }]}
                onPress={() => {
                  if (key === 'link') setShowInput(true);
                  else if (key === 'manual') {
                    setPendingReview({
                      recipe: { id: '', title: '', ingredients: [], steps: [], servings_base: 2 },
                      warnings: [],
                      importId: '',
                    });
                    router.replace('/review');
                  } else notice('Binnenkort', 'Foto/OCR en tekst plakken komen in een volgende update.');
                }}
              >
                <Icon size={19} strokeWidth={1.9} color={colors.primary} />
                <Text style={styles.optionLabel}>{label}{soon ? '  ·  binnenkort' : ''}</Text>
              </Pressable>
            ))}
          </View>

          {/* C4 — eerlijke tip: klembord-detectie is wat er nu écht werkt */}
          <View style={styles.tip}>
            <Text style={styles.tipText}>
              Sneller: <Text style={{ fontFamily: fonts.bodyBold }}>kopieer de link</Text> in Instagram of TikTok
              en open Prakkie — we zien &apos;m meteen op je klembord.
            </Text>
          </View>
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg, paddingHorizontal: 20 },
  grabber: { alignSelf: 'center', width: 44, height: 5, borderRadius: 99, backgroundColor: 'rgba(34,48,30,.15)', marginBottom: 10 },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 },
  title: { fontFamily: fonts.display, fontSize: 23, lineHeight: 26, color: colors.text },
  close: {
    width: 32, height: 32, borderRadius: 16, backgroundColor: colors.surface, alignItems: 'center',
    justifyContent: 'center', borderWidth: 1, borderColor: 'rgba(34,48,30,.1)',
  },
  busyBox: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 14 },
  clipCard: {
    backgroundColor: colors.surface, borderRadius: 18, padding: 14, gap: 12,
    borderWidth: 1, borderColor: 'rgba(34,48,30,.08)',
    shadowColor: '#22301E', shadowOpacity: 0.05, shadowRadius: 8, shadowOffset: { width: 0, height: 2 }, elevation: 2,
  },
  clipRow: { flexDirection: 'row', alignItems: 'center', gap: 11 },
  clipThumb: {
    width: 46, height: 46, borderRadius: 12, backgroundColor: colors.badgeBg,
    alignItems: 'center', justifyContent: 'center',
  },
  clipTitle: { fontSize: 13.5, fontFamily: fonts.bodySemiBold, color: colors.text },
  clipSub: { fontSize: 12, color: colors.textMuted },
  clipCta: { backgroundColor: colors.primary, borderRadius: 13, paddingVertical: 13, alignItems: 'center' },
  clipCtaText: { fontSize: 15, fontFamily: fonts.bodySemiBold, color: colors.onPrimary },
  clipHint: { fontSize: 11.5, color: colors.textMuted, textAlign: 'center' },
  inputRow: { flexDirection: 'row', gap: 10 },
  input: {
    flex: 1, backgroundColor: colors.surface, borderRadius: radius.control, paddingHorizontal: 14,
    paddingVertical: 12, borderWidth: 1, borderColor: 'rgba(34,48,30,.12)', fontSize: 14, color: colors.text,
  },
  goBtn: { backgroundColor: colors.primary, borderRadius: radius.control, paddingHorizontal: 16, alignItems: 'center', justifyContent: 'center' },
  divider: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  dividerLine: { flex: 1, height: 1, backgroundColor: 'rgba(34,48,30,.1)' },
  dividerText: { fontSize: 11.5, color: colors.textMuted },
  option: {
    flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: colors.surface,
    borderRadius: 15, paddingHorizontal: 15, paddingVertical: 14, borderWidth: 1, borderColor: 'rgba(34,48,30,.08)',
  },
  optionLabel: { fontSize: 13, fontFamily: fonts.bodySemiBold, color: colors.text },
  tip: { backgroundColor: colors.badgeBg, borderRadius: 14, padding: 12 },
  tipText: { fontSize: 12, color: '#3D5138', textAlign: 'center' },
});
