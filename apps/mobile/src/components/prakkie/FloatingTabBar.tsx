import { Tabs, useRouter } from 'expo-router';
import type { ComponentProps } from 'react';
import { LinearGradient } from 'expo-linear-gradient';
import { BookOpen, Calendar, Plus, ShoppingCart, UserRound } from 'lucide-react-native';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, fonts, gradients, icons, radius, shadows } from '../../theme/tokens';
import { TourTarget } from './OnboardingTour';

/**
 * Statische tabbar. Iedere bestemming houdt exact dezelfde afmetingen tijdens
 * navigeren; alleen kleur en achtergrond geven de actieve tab aan.
 */

const TAB_META: Record<string, { label: string; Icon: typeof BookOpen }> = {
  index: { label: 'Recepten', Icon: BookOpen },
  plannen: { label: 'Plannen', Icon: Calendar },
  boodschappen: { label: 'Boodschappen', Icon: ShoppingCart },
  profiel: { label: 'Profiel', Icon: UserRound },
};

const LEFT_TABS = ['index', 'plannen'];
const RIGHT_TABS = ['boodschappen', 'profiel'];

/** Derive the tabBar render-prop type from expo-router itself — its vendored
 *  react-navigation types are not interchangeable with the standalone package. */
type TabBarProps = Parameters<NonNullable<ComponentProps<typeof Tabs>['tabBar']>>[0];

function StaticTab({
  label,
  Icon,
  focused,
  onPress,
  targetId,
}: {
  label: string;
  Icon: typeof BookOpen;
  focused: boolean;
  onPress: () => void;
  targetId: string;
}) {
  return (
    <TourTarget targetId={targetId} style={styles.tabTarget}>
      <Pressable
        accessibilityRole="tab"
        accessibilityState={{ selected: focused }}
        accessibilityLabel={label}
        onPress={onPress}
        style={[styles.tab, focused && styles.tabActive]}
      >
        <Icon
          size={icons.tabSize}
          strokeWidth={focused ? icons.strokeWidthActive : icons.strokeWidth}
          color={focused ? colors.primary : colors.textInactive}
        />
        <Text numberOfLines={1} style={[styles.label, !focused && styles.labelInactive]}>
          {label}
        </Text>
      </Pressable>
    </TourTarget>
  );
}

export function FloatingTabBar({ state, navigation }: TabBarProps) {
  const insets = useSafeAreaInsets();
  const router = useRouter();

  const renderTab = (routeName: string) => {
    const meta = TAB_META[routeName];
    if (!meta) return null;
    const routeIndex = state.routes.findIndex((r) => r.name === routeName);
    const route = state.routes[routeIndex];
    if (!route) return null;
    const focused = state.index === routeIndex;
    return (
      <StaticTab
        key={routeName}
        label={meta.label}
        Icon={meta.Icon}
        focused={focused}
        targetId={`tab-${routeName}`}
        onPress={() => {
          const event = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
          if (!focused && !event.defaultPrevented) navigation.navigate(route.name);
        }}
      />
    );
  };

  return (
    <View style={[styles.wrap, { paddingBottom: insets.bottom }]}>
      <View style={styles.bar}>
        {LEFT_TABS.map(renderTab)}
        <TourTarget targetId="tab-import" style={styles.fabTarget}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Recept importeren"
            onPress={() => router.push('/import')}
            style={({ pressed }) => [styles.fabWrap, pressed && { transform: [{ scale: 0.94 }] }]}
          >
            <LinearGradient
              colors={gradients.primary}
              start={{ x: 0.15, y: 0 }}
              end={{ x: 0.6, y: 1 }}
              style={styles.fab}
            >
              <View style={styles.fabHighlight} pointerEvents="none" />
              <Plus size={24} strokeWidth={2.4} color={colors.onPrimary} />
            </LinearGradient>
          </Pressable>
        </TourTarget>
        {RIGHT_TABS.map(renderTab)}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderSubtle,
  },
  bar: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
    backgroundColor: colors.surface,
    paddingHorizontal: 5,
    paddingTop: 7,
    paddingBottom: 6,
  },
  tabTarget: { flex: 1, minWidth: 0 },
  fabTarget: { width: 62, flexShrink: 0, alignItems: 'center' },
  tab: {
    width: '100%',
    minWidth: 0,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
    height: 48,
    borderRadius: radius.md,
  },
  tabActive: { backgroundColor: colors.badgeBg },
  label: {
    fontFamily: fonts.bodySemiBold,
    fontSize: 9.5,
    color: colors.primary,
  },
  labelInactive: { color: colors.textInactive },
  fabWrap: {
    marginTop: -23,
    marginHorizontal: 4,
    borderRadius: 27,
    ...shadows.fab,
  },
  fab: {
    width: 54,
    height: 54,
    borderRadius: 27,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  fabHighlight: {
    position: 'absolute',
    top: 0,
    left: 8,
    right: 8,
    height: 1.5,
    borderRadius: 1,
    backgroundColor: 'rgba(255,255,255,0.3)',
  },
});
