import { useKeepAwake } from 'expo-keep-awake';
import { LinearGradient } from 'expo-linear-gradient';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { ChevronLeft, ChevronRight, TimerReset, X } from 'lucide-react-native';
import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, Vibration, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { getData, syncNow, upsertRow } from '../../data';
import type { RecipeRowData } from '../../data/recipes';
import { colors, fonts, gradients, radius, shadows } from '../../theme/tokens';

/**
 * Cook mode (D3): screen never sleeps, one large-text step at a time,
 * auto-detected tappable timers ("20 min sudderen" → 20:00 countdown).
 * REDESIGN 1c: gesegmenteerde voortgangsbalk, Young Serif-stap gecentreerd,
 * gradient timer-pil en Vorige/Volgende-navigatie onderin.
 */
export default function CookMode() {
  useKeepAwake();
  const { id } = useLocalSearchParams<{ id: string }>();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const [recipe, setRecipe] = useState<RecipeRowData | null>(null);
  const [stepIdx, setStepIdx] = useState(0);
  const [remaining, setRemaining] = useState<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    getData().then(async ({ store }) => {
      const row = await store.getRow('recipes', String(id));
      if (row) setRecipe(row.row as unknown as RecipeRowData);
    });
    return () => stopTimer();
  }, [id]);

  function stopTimer() {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
    setRemaining(null);
  }

  function startTimer(seconds: number) {
    stopTimer();
    setRemaining(seconds);
    timerRef.current = setInterval(() => {
      setRemaining((r) => {
        if (r === null) return null;
        if (r <= 1) {
          stopTimer();
          Vibration.vibrate([0, 500, 250, 500]);
          return 0;
        }
        return r - 1;
      });
    }, 1000);
  }

  const steps = recipe?.steps ?? [];
  const step = steps[stepIdx];
  // auto-detect a timer in the step text when the import didn't already tag one
  const detected =
    step?.timer_seconds ??
    (() => {
      const m = step?.text.match(/(\d+)\s*(?:tot\s*\d+\s*)?(min(?:uten|\.)?|uur)/i);
      if (!m) return undefined;
      return m[2]!.toLowerCase().startsWith('uur') ? Number(m[1]) * 3600 : Number(m[1]) * 60;
    })();

  const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

  return (
    <View style={[styles.screen, { paddingTop: insets.top + 10, paddingBottom: insets.bottom + 16 }]}>
      <View style={styles.topRow}>
        <Text style={styles.title} numberOfLines={1}>
          {recipe?.title ?? ''}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Sluiten"
          onPress={() => router.back()}
          style={styles.closeBtn}
          hitSlop={12}
        >
          <X size={15} color={colors.textSoft} strokeWidth={2.2} />
        </Pressable>
      </View>

      {/* gesegmenteerde voortgang — één segment per stap */}
      {steps.length > 0 ? (
        <View style={styles.progressRow}>
          {steps.map((_, i) => (
            <View key={i} style={[styles.progressSeg, i <= stepIdx && styles.progressSegDone]} />
          ))}
        </View>
      ) : null}

      <View style={styles.stepArea}>
        <Text style={styles.stepCounter}>
          Stap {stepIdx + 1} van {steps.length}
        </Text>
        <Text style={styles.stepText}>{step?.text ?? 'Geen stappen in dit recept.'}</Text>
        {detected ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={remaining === null ? `Start timer ${mmss(detected)}` : 'Stop timer'}
            style={({ pressed }) => [styles.timerWrap, pressed && { opacity: 0.88 }]}
            onPress={() => (remaining === null ? startTimer(detected) : stopTimer())}
          >
            <LinearGradient colors={gradients.primary} start={{ x: 0.2, y: 0 }} end={{ x: 0.5, y: 1 }} style={styles.timerBtn}>
              <View style={styles.gradHighlight} pointerEvents="none" />
              <TimerReset size={18} color={colors.onPrimary} strokeWidth={2} />
              <Text style={styles.timerText}>
                {remaining === null ? `Start timer · ${mmss(detected)}` : remaining === 0 ? 'Klaar!' : mmss(remaining)}
              </Text>
            </LinearGradient>
          </Pressable>
        ) : null}
      </View>

      <View style={styles.navRow}>
        <Pressable
          style={[styles.prevBtn, stepIdx === 0 && styles.navDisabled]}
          disabled={stepIdx === 0}
          onPress={() => {
            stopTimer();
            setStepIdx(stepIdx - 1);
          }}
        >
          <ChevronLeft size={18} color={stepIdx === 0 ? colors.textInactive : colors.textSoft} strokeWidth={2.2} />
          <Text style={[styles.prevText, stepIdx === 0 && { color: colors.textInactive }]}>Vorige</Text>
        </Pressable>
        {stepIdx < steps.length - 1 ? (
          <Pressable
            style={({ pressed }) => [styles.nextWrap, pressed && { opacity: 0.88 }]}
            onPress={() => {
              stopTimer();
              setStepIdx(stepIdx + 1);
            }}
          >
            <LinearGradient colors={gradients.primary} start={{ x: 0.2, y: 0 }} end={{ x: 0.5, y: 1 }} style={styles.nextBtn}>
              <View style={styles.gradHighlight} pointerEvents="none" />
              <Text style={styles.nextText}>Volgende</Text>
              <ChevronRight size={18} color={colors.onPrimary} strokeWidth={2.2} />
            </LinearGradient>
          </Pressable>
        ) : (
          <Pressable
            style={({ pressed }) => [styles.nextWrap, pressed && { opacity: 0.88 }]}
            onPress={async () => {
              // R3 — voedt de sorteeroptie "laatst gekookt"
              if (recipe) {
                await upsertRow('recipes', { title: recipe.title, last_cooked_at: new Date().toISOString() }, String(id));
                syncNow(['recipes']).catch(() => {});
              }
              router.back();
            }}
          >
            <LinearGradient colors={gradients.primary} start={{ x: 0.2, y: 0 }} end={{ x: 0.5, y: 1 }} style={styles.nextBtn}>
              <View style={styles.gradHighlight} pointerEvents="none" />
              <Text style={styles.nextText}>Klaar · Eet smakelijk!</Text>
            </LinearGradient>
          </Pressable>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg, paddingHorizontal: 24 },
  topRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  title: { flex: 1, fontFamily: fonts.bodySemiBold, fontSize: 14, color: colors.textSoft },
  closeBtn: {
    width: 36, height: 36, borderRadius: 18, backgroundColor: 'rgba(255,255,255,0.9)',
    borderWidth: 1, borderColor: colors.border, alignItems: 'center', justifyContent: 'center',
  },
  progressRow: { flexDirection: 'row', gap: 5, marginTop: 22 },
  progressSeg: { flex: 1, height: 4, borderRadius: 2, backgroundColor: 'rgba(34,48,30,0.12)' },
  progressSegDone: { backgroundColor: colors.primary },
  stepArea: { flex: 1, justifyContent: 'center', gap: 22 },
  stepCounter: {
    fontFamily: fonts.bodyBold, fontSize: 12, letterSpacing: 1.2,
    color: colors.textMuted2, textTransform: 'uppercase',
  },
  stepText: { fontFamily: fonts.display, fontSize: 31, lineHeight: 42, color: colors.text },
  timerWrap: { alignSelf: 'flex-start', borderRadius: radius.pill, ...shadows.cta },
  timerBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 10, borderRadius: radius.pill,
    paddingHorizontal: 20, paddingVertical: 13, overflow: 'hidden',
  },
  timerText: { fontFamily: fonts.bodySemiBold, fontSize: 15, color: colors.onPrimary },
  gradHighlight: {
    position: 'absolute', top: 0, left: 0, right: 0, height: 1.5,
    backgroundColor: 'rgba(255,255,255,0.22)',
  },
  navRow: { flexDirection: 'row', gap: 12 },
  prevBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 15, paddingHorizontal: 20,
    borderRadius: radius.lg, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border,
  },
  prevText: { fontFamily: fonts.body, fontSize: 14.5, color: colors.textSoft },
  nextWrap: { flex: 1, borderRadius: radius.lg, ...shadows.cta },
  nextBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    paddingVertical: 15, paddingHorizontal: 20, borderRadius: radius.lg, overflow: 'hidden',
  },
  nextText: { fontFamily: fonts.bodySemiBold, fontSize: 14.5, color: colors.cream },
  navDisabled: { opacity: 0.5 },
});
