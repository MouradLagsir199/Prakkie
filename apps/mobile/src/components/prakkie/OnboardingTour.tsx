import { CHAINS, LIVE_CHAIN_IDS, type ChainId } from '@prakkie/shared';
import { useRouter } from 'expo-router';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Animated,
  Easing,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import Svg, { Line, Polygon, Rect } from 'react-native-svg';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { authedRequest, ensureSession } from '../../data/api';
import { kv } from '../../data/kv';
import { setMyChainsForSession } from '../../data/lijst-flow';
import { resetShoppingSessionCache } from '../../data/shopping-session-cache';
import { resetStoreSessionCache } from '../../store/api';
import { colors, fonts, radius, shadows, type } from '../../theme/tokens';
import { ChainLogo } from './ChainLogo';
import { CTAButton } from './CTAButton';

interface TargetRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface TargetRegistry {
  version: number;
  registerTarget: (id: string, node: View | null) => void;
  signalLayout: () => void;
  measureTarget: (id: string) => Promise<TargetRect | null>;
}

const TourTargetContext = createContext<TargetRegistry | null>(null);

export function OnboardingTourProvider({ children }: { children: ReactNode }) {
  const targets = useRef(new Map<string, View>());
  const [version, setVersion] = useState(0);

  const registerTarget = useCallback((id: string, node: View | null) => {
    const current = targets.current.get(id);
    if (node) {
      if (current === node) return;
      targets.current.set(id, node);
    } else {
      if (!current) return;
      targets.current.delete(id);
    }
    setVersion((value) => value + 1);
  }, []);

  const signalLayout = useCallback(() => setVersion((value) => value + 1), []);

  const measureTarget = useCallback((id: string) => new Promise<TargetRect | null>((resolve) => {
    const node = targets.current.get(id);
    if (!node) {
      resolve(null);
      return;
    }
    node.measureInWindow((x, y, width, height) => {
      resolve(width > 0 && height > 0 ? { x, y, width, height } : null);
    });
  }), []);

  const value = useMemo(
    () => ({ version, registerTarget, signalLayout, measureTarget }),
    [measureTarget, registerTarget, signalLayout, version],
  );

  return <TourTargetContext.Provider value={value}>{children}</TourTargetContext.Provider>;
}

export function TourTarget({
  targetId,
  children,
  style,
}: {
  targetId: string;
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const registry = useContext(TourTargetContext);
  const registerTarget = registry?.registerTarget;
  const signalLayout = registry?.signalLayout;
  const setNode = useCallback(
    (node: View | null) => registerTarget?.(targetId, node),
    [registerTarget, targetId],
  );

  return (
    <View
      ref={setNode}
      collapsable={false}
      onLayout={() => signalLayout?.()}
      style={style}
      testID={`tour-target-${targetId}`}
    >
      {children}
    </View>
  );
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function connector(card: TargetRect, target: TargetRect) {
  const tx = target.x + target.width / 2;
  const ty = target.y + target.height / 2;
  const right = card.x + card.width;
  const bottom = card.y + card.height;
  let sx = clamp(card.x + card.width * 0.32, card.x + 12, right - 12);
  let sy = ty < card.y ? card.y : bottom;

  if (ty >= card.y && ty <= bottom) {
    sx = tx < card.x ? card.x : right;
    sy = clamp(ty, card.y + 12, bottom - 12);
  }

  const dx = tx - sx;
  const dy = ty - sy;
  const distance = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
  const ux = dx / distance;
  const uy = dy / distance;
  const baseX = tx - ux * 12;
  const baseY = ty - uy * 12;
  const px = -uy * 6;
  const py = ux * 6;

  return {
    sx,
    sy,
    tx,
    ty,
    baseX,
    baseY,
    points: `${tx},${ty} ${baseX + px},${baseY + py} ${baseX - px},${baseY - py}`,
  };
}

function GroupCallout({
  overlayOrigin,
  onMeasure,
}: {
  overlayOrigin: { x: number; y: number };
  onMeasure: (rect: TargetRect) => void;
}) {
  const ref = useRef<View>(null);
  const measure = useCallback(() => {
    requestAnimationFrame(() => {
      ref.current?.measureInWindow((x, y, width, height) => {
        if (width > 0 && height > 0) {
          onMeasure({ x: x - overlayOrigin.x, y: y - overlayOrigin.y, width, height });
        }
      });
    });
  }, [onMeasure, overlayOrigin.x, overlayOrigin.y]);

  useEffect(() => {
    measure();
    const timer = setTimeout(measure, 320);
    return () => clearTimeout(timer);
  }, [measure]);

  return (
    <View
      ref={ref}
      collapsable={false}
      onLayout={measure}
      style={styles.callout}
      testID="tour-callout-profile-group"
    >
      <View style={styles.calloutNumber}>
        <Text style={styles.calloutNumberText}>2</Text>
      </View>
      <View style={styles.calloutCopy}>
        <Text style={styles.calloutTitle}>Maak een groep</Text>
        <Text style={styles.calloutText}>
          Tik op + om een groep te maken. Deel daarna recepten en boodschappenlijstjes met elkaar.
        </Text>
      </View>
    </View>
  );
}

export function OnboardingTour() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const registry = useContext(TourTargetContext);
  const overlayRef = useRef<View>(null);
  const reveal = useRef(new Animated.Value(0)).current;
  const [page, setPage] = useState<0 | 1 | null>(null);
  const [chains, setChains] = useState<ChainId[]>([]);
  const [transitioning, setTransitioning] = useState(false);
  const [overlayOrigin, setOverlayOrigin] = useState({ x: 0, y: 0 });
  const [targetRect, setTargetRect] = useState<TargetRect | null>(null);
  const [calloutRect, setCalloutRect] = useState<TargetRect | null>(null);

  useEffect(() => {
    (async () => {
      const [pending, done, storedChains, storedPage] = await Promise.all([
        kv.getItem('prakkie.tour_pending').catch(() => null),
        kv.getItem('prakkie.tour_done').catch(() => null),
        kv.getItem('prakkie.mychains').catch(() => null),
        kv.getItem('prakkie.tour_page').catch(() => null),
      ]);
      if (pending !== '1' || done === '1') return;

      let knownChains: ChainId[] = [];
      try {
        const parsed = JSON.parse(storedChains ?? '[]');
        if (Array.isArray(parsed)) {
          const live = new Set<string>(LIVE_CHAIN_IDS);
          knownChains = parsed.filter((id): id is ChainId => typeof id === 'string' && live.has(id));
        }
      } catch { /* first run */ }

      setChains(knownChains);
      const resumeGroup = storedPage === '1' && knownChains.length > 0;
      setPage(resumeGroup ? 1 : 0);
      router.navigate('/profiel' as never);
    })();
  }, [router]);

  const measureOverlay = useCallback(() => {
    overlayRef.current?.measureInWindow((x, y) => setOverlayOrigin({ x, y }));
  }, []);

  useEffect(() => {
    if (page !== 1 || !registry) return;
    let active = true;
    const measure = async () => {
      const rect = await registry.measureTarget('profile-group');
      if (!active || !rect) return;
      setTargetRect({
        x: rect.x - overlayOrigin.x,
        y: rect.y - overlayOrigin.y,
        width: rect.width,
        height: rect.height,
      });
    };
    const timers = [0, 120, 420, 700].map((delay) => setTimeout(() => void measure(), delay));
    return () => {
      active = false;
      timers.forEach(clearTimeout);
    };
  }, [height, overlayOrigin.x, overlayOrigin.y, page, registry, registry?.version, width]);

  useEffect(() => {
    if (page !== 1) return;
    setCalloutRect(null);
    setTargetRect(null);
    reveal.stopAnimation();
    reveal.setValue(0);
    const timer = setTimeout(() => {
      Animated.timing(reveal, {
        toValue: 1,
        duration: 260,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start();
    }, 70);
    return () => {
      clearTimeout(timer);
      reveal.stopAnimation();
    };
  }, [page, reveal]);

  if (page === null) return null;

  function toggleChain(id: ChainId) {
    const next = chains.includes(id) ? chains.filter((chain) => chain !== id) : [...chains, id];
    setChains(next);
  }

  function showGroupStep() {
    if (chains.length === 0) return;
    const selected = [...chains];
    setMyChainsForSession(selected);
    resetShoppingSessionCache();
    resetStoreSessionCache();
    void Promise.all([
      kv.setItem('prakkie.homechain', selected[0]),
      kv.setItem('prakkie.mychains', JSON.stringify(selected)),
    ]).catch(() => {});
    void (async () => {
      try {
        await ensureSession();
        await authedRequest('/v1/me', {
          method: 'PATCH',
          body: JSON.stringify({ home_chain_ids: selected }),
        });
      } catch { /* offline: the next sync retries */ }
    })();
    setPage(1);
    void kv.setItem('prakkie.tour_page', '1').catch(() => {});
    router.navigate('/profiel' as never);
  }

  async function finish() {
    setPage(null);
    await Promise.all([
      kv.setItem('prakkie.tour_done', '1').catch(() => {}),
      kv.removeItem('prakkie.tour_pending').catch(() => {}),
      kv.removeItem('prakkie.tour_page').catch(() => {}),
    ]);
    router.navigate('/boodschappen' as never);
  }

  function afterFade(change: () => void) {
    if (transitioning) return;
    setTransitioning(true);
    Animated.timing(reveal, {
      toValue: 0,
      duration: 160,
      easing: Easing.in(Easing.quad),
      useNativeDriver: true,
    }).start(() => {
      change();
      setTransitioning(false);
    });
  }

  function previous() {
    afterFade(() => {
      setPage(0);
      void kv.setItem('prakkie.tour_page', '0').catch(() => {});
    });
  }

  const tabClearance = Math.max(insets.bottom, 26) + 88;
  const groupCalloutTop = targetRect
    ? clamp(
        targetRect.y + targetRect.height + 18,
        insets.top + 72,
        height - tabClearance - 215,
      )
    : insets.top + 180;
  const line = targetRect && calloutRect ? connector(calloutRect, targetRect) : null;

  return (
    <View
      ref={overlayRef}
      onLayout={measureOverlay}
      pointerEvents="box-none"
      style={StyleSheet.absoluteFill}
      testID={page === 0 ? 'tour-page-setup' : 'tour-page-profiel'}
      accessibilityViewIsModal
    >
      <Pressable accessibilityLabel="Rondleiding actief" onPress={() => {}} style={styles.backdrop} />

      {page === 1 ? (
        <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { opacity: reveal }]}>
          <Svg pointerEvents="none" width={width} height={height} style={StyleSheet.absoluteFill}>
            {targetRect ? (
              <Rect
                x={targetRect.x - 5}
                y={targetRect.y - 5}
                width={targetRect.width + 10}
                height={targetRect.height + 10}
                rx={Math.min(14, (targetRect.height + 10) / 2)}
                fill="rgba(255,255,255,0.08)"
                stroke={colors.surface}
                strokeWidth={2}
              />
            ) : null}
            {line ? (
              <>
                <Line
                  x1={line.sx}
                  y1={line.sy}
                  x2={line.baseX}
                  y2={line.baseY}
                  stroke={colors.surface}
                  strokeWidth={2.5}
                  strokeLinecap="round"
                />
                <Polygon points={line.points} fill={colors.surface} />
              </>
            ) : null}
          </Svg>
          {targetRect ? (
            <View
              pointerEvents="none"
              testID="tour-arrow-tip-profile-group"
              style={[styles.arrowTipMarker, {
                left: targetRect.x + targetRect.width / 2 - 2,
                top: targetRect.y + targetRect.height / 2 - 2,
              }]}
            />
          ) : null}
        </Animated.View>
      ) : null}

      {page === 0 ? (
        <View style={[styles.setupCard, { bottom: tabClearance, maxHeight: height - tabClearance - insets.top - 18 }]}>
          <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.setupContent}>
            <View style={styles.progressTrack}>
              <View testID="tour-progress-setup" style={[styles.progressFill, { width: '50%' }]} />
            </View>
            <View style={styles.navHeading}>
              <Text style={styles.stepBadge}>Supermarkten</Text>
            </View>
            <Text style={styles.setupTitle}>Waar doe jij boodschappen?</Text>
            <Text style={styles.setupText}>
              Kies je supermarkten. Dan vergelijken we alleen winkels die voor jou handig zijn.
            </Text>
            <View style={styles.chainWrap}>
              {LIVE_CHAIN_IDS.map((id) => {
                const selected = chains.includes(id);
                return (
                  <Pressable
                    key={id}
                    onPress={() => toggleChain(id)}
                    accessibilityRole="button"
                    accessibilityState={{ selected }}
                    accessibilityLabel={`${CHAINS[id].displayName} ${selected ? 'geselecteerd' : 'selecteren'}`}
                    style={[styles.chainChip, selected && styles.chainChipOn]}
                  >
                    <ChainLogo id={id} size={22} />
                    <Text style={[styles.chainChipText, selected && styles.chainChipTextOn]}>
                      {CHAINS[id].displayName}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
            <CTAButton
              label={chains.length ? 'Verder' : 'Kies minstens één supermarkt'}
              onPress={showGroupStep}
              disabled={chains.length === 0}
            />
            <Text style={styles.setupHint}>Aanpassen kan later altijd op Profiel.</Text>
          </ScrollView>
        </View>
      ) : (
        <>
          <Animated.View
            style={[
              styles.floatingCallout,
              {
                top: groupCalloutTop,
                opacity: reveal,
                transform: [{
                  translateY: reveal.interpolate({ inputRange: [0, 1], outputRange: [8, 0] }),
                }],
              },
            ]}
          >
            <GroupCallout overlayOrigin={overlayOrigin} onMeasure={setCalloutRect} />
          </Animated.View>
          <View style={[styles.tourDock, { bottom: tabClearance }]}>
            <View style={styles.navCard}>
              <View style={styles.progressTrack}>
                <View testID="tour-progress-profile" style={[styles.progressFill, { width: '100%' }]} />
              </View>
              <View style={styles.navHeading}>
                <Text style={styles.stepBadge}>Groepen</Text>
              </View>
              <View style={styles.navRow}>
                <Pressable
                  onPress={previous}
                  disabled={transitioning}
                  accessibilityRole="button"
                  accessibilityLabel="Vorige uitleg"
                  style={styles.secondaryButton}
                >
                  <Text style={styles.secondaryButtonText}>Vorige</Text>
                </Pressable>
                <Pressable
                  onPress={() => afterFade(() => void finish())}
                  disabled={transitioning}
                  accessibilityRole="button"
                  accessibilityLabel="Rondleiding afronden"
                  style={styles.primaryButton}
                >
                  <Text style={styles.primaryButtonText}>Aan de slag</Text>
                </Pressable>
              </View>
            </View>
          </View>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: 'rgba(20,28,17,0.58)',
  },
  setupCard: {
    position: 'absolute',
    left: 18,
    right: 18,
    maxWidth: 390,
    alignSelf: 'center',
    backgroundColor: colors.surface,
    borderRadius: radius.card,
    ...shadows.float,
  },
  setupContent: { padding: 20, gap: 11 },
  stepBadge: { ...type.sectionLabel },
  setupTitle: { fontFamily: fonts.display, fontSize: 23, lineHeight: 27, color: colors.text },
  setupText: { fontSize: 13.5, lineHeight: 20, color: colors.textSoft },
  setupHint: { ...type.meta, textAlign: 'center', fontSize: 11 },
  chainWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginVertical: 2 },
  chainChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    paddingHorizontal: 11,
    paddingVertical: 8,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceMuted,
    borderWidth: 1,
    borderColor: colors.borderControl,
  },
  chainChipOn: { borderColor: colors.primary, backgroundColor: colors.badgeBg },
  chainChipText: { fontSize: 12.5, fontFamily: fonts.bodySemiBold, color: colors.textSoft },
  chainChipTextOn: { color: colors.primary, fontFamily: fonts.bodyBold },
  tourDock: {
    position: 'absolute',
    left: 14,
    right: 14,
    maxWidth: 400,
    alignSelf: 'center',
    gap: 9,
  },
  floatingCallout: {
    position: 'absolute',
    left: 14,
    right: 14,
    maxWidth: 400,
    alignSelf: 'center',
  },
  callout: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    paddingHorizontal: 13,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.7)',
    ...shadows.card,
  },
  calloutNumber: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.badgeBg,
  },
  calloutNumberText: { fontSize: 11, fontFamily: fonts.bodyBold, color: colors.primary },
  calloutCopy: { flex: 1, minWidth: 0, gap: 2 },
  calloutTitle: { fontSize: 13, lineHeight: 16, fontFamily: fonts.bodyBold, color: colors.text },
  calloutText: { fontSize: 12, lineHeight: 16, fontFamily: fonts.body, color: colors.textSoft },
  navCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.card,
    padding: 13,
    gap: 8,
    ...shadows.float,
  },
  progressTrack: {
    height: 4,
    borderRadius: 2,
    overflow: 'hidden',
    backgroundColor: colors.surfaceMuted,
  },
  progressFill: { height: 4, borderRadius: 2, backgroundColor: colors.primary },
  navHeading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  navRow: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  secondaryButton: {
    minHeight: 40,
    paddingHorizontal: 14,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.borderControl,
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondaryButtonText: { fontSize: 12.5, fontFamily: fonts.bodySemiBold, color: colors.textSoft },
  primaryButton: {
    flex: 1,
    minHeight: 40,
    paddingHorizontal: 14,
    borderRadius: radius.pill,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryButtonText: { fontSize: 12.5, fontFamily: fonts.bodyBold, color: colors.onPrimary },
  arrowTipMarker: { position: 'absolute', width: 4, height: 4, opacity: 0 },
});
