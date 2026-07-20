import * as Clipboard from 'expo-clipboard';
import { useRouter } from 'expo-router';
import { Link2, PencilLine, Sparkles, X } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { CTAButton } from '../components/prakkie/CTAButton';
import { authedRequest } from '../data/api';
import { ImportError, importUrl, setPendingReview } from '../data/import-flow';
import { notice } from '../lib/dialogs';
import { colors, fonts, radius, shadows, type } from '../theme/tokens';

/** Import sheet: clipboard card + link/manual choices. Live flow → /v1/import → review. */

const OPTIONS = [
  { key: 'link', label: 'Plak een link', Icon: Link2 },
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
  const [progress, setProgress] = useState(0);
  // import-tegoed vooraf zichtbaar, in de vaste quota-accentkleur (owner 2026-07-10)
  const [importQuota, setImportQuota] = useState<{ used: number; limit: number } | null>(null);

  useEffect(() => {
    Clipboard.getStringAsync()
      .then((s) => {
        if (looksLikeUrl(s)) setClipboardUrl(s.trim());
      })
      .catch(() => {});
    authedRequest('/v1/me/quota')
      .then(async (r) => {
        if (!r.ok) return;
        const q = (await r.json()) as { import?: { used: number; limit: number } };
        if (q.import) setImportQuota(q.import);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => {
      setProgress((current) => {
        const ceiling = status === 'Recept samenstellen…' ? 96 : 72;
        if (current >= ceiling) return current;
        return Math.min(ceiling, current + Math.max(0.25, (ceiling - current) * 0.018));
      });
    }, 700);
    return () => clearInterval(timer);
  }, [busy, status]);

  async function run(target: string) {
    if (!looksLikeUrl(target)) {
      notice('Geen geldige link', 'Plak een volledige link (https://…).');
      return;
    }
    setBusy(true);
    setProgress(3);
    try {
      const outcome = await importUrl(target.trim(), (nextStatus, nextProgress) => {
        setStatus(nextStatus);
        setProgress((current) => Math.max(current, nextProgress));
      });
      setPendingReview(outcome);
      router.replace('/review');
    } catch (err) {
      const quotaHit = err instanceof ImportError && (err.code === 'quota_exceeded' || err.code === 'trial_expired');
      const msg = err instanceof ImportError ? err.message : 'Import mislukt. Probeer het opnieuw.';
      notice(quotaHit ? 'Import-tegoed op' : 'Import mislukt', msg);
    } finally {
      setBusy(false);
      setStatus('');
    }
  }

  return (
    <View style={[styles.screen, { paddingTop: insets.top + 18 }]}>
      <View style={styles.grabber} />
      <View style={styles.headerRow}>
        <Text style={styles.title}>Recept importeren</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Sluiten" onPress={() => router.back()} style={styles.close}>
          <X size={18} strokeWidth={1.9} color={colors.textSoft} />
        </Pressable>
      </View>

      {/* import-tegoed in de vaste quota-accentkleur — zelfde badge als bij
          "Vind mijn prakkie" (owner 2026-07-10) */}
      <View style={styles.quotaBadge}>
        <Sparkles size={13} color={colors.quota} strokeWidth={2.2} />
        <Text style={styles.quotaBadgeText}>
          {importQuota
            ? `nog ${Math.max(0, importQuota.limit - importQuota.used)} van ${importQuota.limit} imports deze maand`
            : 'AI-tegoed laden…'}
        </Text>
      </View>

      {busy ? (
        <View style={styles.busyBox}>
          <Text style={styles.progressValue}>{Math.round(progress)}%</Text>
          <View style={styles.progressTrack} accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: 100, now: Math.round(progress) }}>
            <View style={[styles.progressFill, { width: `${Math.min(100, progress)}%` }]} />
          </View>
          <Text style={type.body}>{status || 'Bezig met importeren…'}</Text>
          <Text style={type.meta}>Je kunt dit scherm open laten; we verwerken alle beschikbare broninformatie.</Text>
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
              <CTAButton label="Importeer deze link" onPress={() => run(clipboardUrl)} />
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
              <CTAButton label="Import" onPress={() => run(url)} />
            </View>
          ) : null}

          <View style={styles.divider}>
            <View style={styles.dividerLine} />
            <Text style={styles.dividerText}>of kies zelf</Text>
            <View style={styles.dividerLine} />
          </View>

          <View style={{ gap: 10 }}>
            {OPTIONS.map(({ key, label, Icon }) => (
              <Pressable
                key={key}
                accessibilityRole="button"
                style={styles.option}
                onPress={() => {
                  if (key === 'link') setShowInput(true);
                  else {
                    setPendingReview({
                      recipe: { id: '', title: '', ingredients: [], steps: [], servings_base: 2 },
                      warnings: [],
                      importId: '',
                    });
                    router.replace('/review');
                  }
                }}
              >
                <Icon size={19} strokeWidth={1.9} color={colors.primary} />
                <Text style={styles.optionLabel}>{label}</Text>
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
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
  quotaBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', marginBottom: 14,
    backgroundColor: colors.quotaBg, borderWidth: 1, borderColor: colors.quotaBorder,
    borderRadius: radius.pill, paddingHorizontal: 12, paddingVertical: 6,
  },
  quotaBadgeText: { fontSize: 12, fontFamily: fonts.bodySemiBold, color: colors.quota },
  title: { fontFamily: fonts.display, fontSize: 23, lineHeight: 26, color: colors.text },
  close: {
    width: 32, height: 32, borderRadius: 16, backgroundColor: colors.surface, alignItems: 'center',
    justifyContent: 'center', borderWidth: 1, borderColor: colors.border,
  },
  busyBox: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 14 },
  progressValue: { fontFamily: fonts.display, fontSize: 30, color: colors.primary },
  progressTrack: { width: '82%', height: 9, borderRadius: 99, overflow: 'hidden', backgroundColor: colors.surfaceMuted },
  progressFill: { height: '100%', borderRadius: 99, backgroundColor: colors.primary },
  clipCard: {
    backgroundColor: colors.surface, borderRadius: radius.listCard, padding: 14, gap: 12,
    borderWidth: 1, borderColor: colors.borderSubtle,
    ...shadows.card,
  },
  clipRow: { flexDirection: 'row', alignItems: 'center', gap: 11 },
  clipThumb: {
    width: 46, height: 46, borderRadius: 12, backgroundColor: colors.badgeBg,
    alignItems: 'center', justifyContent: 'center',
  },
  clipTitle: { fontSize: 13.5, fontFamily: fonts.bodySemiBold, color: colors.text },
  clipSub: { fontSize: 12, color: colors.textMuted },
  clipHint: { fontSize: 11.5, color: colors.textMuted, textAlign: 'center' },
  inputRow: { flexDirection: 'row', gap: 10 },
  input: {
    flex: 1, backgroundColor: colors.surface, borderRadius: radius.control, paddingHorizontal: 14,
    paddingVertical: 12, borderWidth: 1, borderColor: colors.borderControl, fontSize: 13.5, color: colors.text,
  },
  divider: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  dividerLine: { flex: 1, height: 1, backgroundColor: colors.border },
  dividerText: { fontSize: 11.5, color: colors.textMuted },
  option: {
    flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: colors.surface,
    borderRadius: radius.listCard, paddingHorizontal: 15, paddingVertical: 14, borderWidth: 1, borderColor: colors.borderSubtle,
  },
  optionLabel: { fontSize: 13, fontFamily: fonts.bodySemiBold, color: colors.text },
  tip: { backgroundColor: colors.badgeBg, borderRadius: radius.lg, padding: 12 },
  tipText: { fontSize: 12, color: colors.textSoft, textAlign: 'center' },
});
