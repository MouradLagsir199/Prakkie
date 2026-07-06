import { useKeepAwake } from 'expo-keep-awake';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { ChevronLeft, ChevronRight, TimerReset, X } from 'lucide-react-native';
import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, Vibration, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { getData, syncNow, upsertRow } from '../../data';
import type { RecipeRowData } from '../../data/recipes';
import { colors, radius, type } from '../../theme/tokens';

/**
 * Cook mode (D3): screen never sleeps, one large-text step at a time,
 * auto-detected tappable timers ("20 min sudderen" → 20:00 countdown).
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
        <Text style={[type.h3, { flex: 1 }]} numberOfLines={1}>
          {recipe?.title ?? ''}
        </Text>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <X size={26} color={colors.text} />
        </Pressable>
      </View>

      <View style={styles.stepArea}>
        <Text style={styles.stepCounter}>
          Stap {stepIdx + 1} van {steps.length}
        </Text>
        <Text style={styles.stepText}>{step?.text ?? 'Geen stappen in dit recept.'}</Text>
        {detected ? (
          <Pressable style={styles.timerBtn} onPress={() => (remaining === null ? startTimer(detected) : stopTimer())}>
            <TimerReset size={20} color={colors.onPrimary} />
            <Text style={styles.timerText}>
              {remaining === null ? `Start timer · ${mmss(detected)}` : remaining === 0 ? 'Klaar!' : mmss(remaining)}
            </Text>
          </Pressable>
        ) : null}
      </View>

      <View style={styles.navRow}>
        <Pressable
          style={[styles.navBtn, stepIdx === 0 && styles.navDisabled]}
          disabled={stepIdx === 0}
          onPress={() => {
            stopTimer();
            setStepIdx(stepIdx - 1);
          }}
        >
          <ChevronLeft size={28} color={stepIdx === 0 ? colors.textInactive : colors.text} />
          <Text style={type.body}>Vorige</Text>
        </Pressable>
        {stepIdx < steps.length - 1 ? (
          <Pressable
            style={[styles.navBtn, styles.navPrimary]}
            onPress={() => {
              stopTimer();
              setStepIdx(stepIdx + 1);
            }}
          >
            <Text style={[type.body, { color: colors.onPrimary }]}>Volgende</Text>
            <ChevronRight size={28} color={colors.onPrimary} />
          </Pressable>
        ) : (
          <Pressable
            style={[styles.navBtn, styles.navPrimary]}
            onPress={async () => {
              // R3 — voedt de sorteeroptie "laatst gekookt"
              if (recipe) {
                await upsertRow('recipes', { title: recipe.title, last_cooked_at: new Date().toISOString() }, String(id));
                syncNow(['recipes']).catch(() => {});
              }
              router.back();
            }}
          >
            <Text style={[type.body, { color: colors.onPrimary }]}>Klaar · Eet smakelijk!</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg, paddingHorizontal: 20 },
  topRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  stepArea: { flex: 1, justifyContent: 'center', gap: 18 },
  stepCounter: { ...type.meta, fontSize: 14 },
  stepText: { fontFamily: type.h1.fontFamily, fontSize: 30, lineHeight: 40, color: colors.text },
  timerBtn: {
    flexDirection: 'row', gap: 10, alignItems: 'center', alignSelf: 'flex-start',
    backgroundColor: colors.primary, borderRadius: radius.pill, paddingHorizontal: 18, paddingVertical: 12,
  },
  timerText: { ...type.h3, color: colors.onPrimary },
  navRow: { flexDirection: 'row', justifyContent: 'space-between', gap: 12 },
  navBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 14, paddingHorizontal: 18,
    borderRadius: radius.lg, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border,
  },
  navPrimary: { backgroundColor: colors.primary, borderColor: colors.primary, flex: 1, justifyContent: 'center' },
  navDisabled: { opacity: 0.5 },
});
