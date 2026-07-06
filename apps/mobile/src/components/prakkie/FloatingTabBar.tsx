import { Tabs, useRouter } from 'expo-router';
import type { ComponentProps } from 'react';
import { BookOpen, Calendar, Plus, ShoppingCart, UserRound } from 'lucide-react-native';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, icons, radius, shadows, type } from '../../theme/tokens';

/**
 * The floating pill tab bar + centre FAB — docs/04 §2, owner rework 2026-07-06:
 * Recepten · Plannen · [+] · Boodschappen · Profiel. The FAB opens the import sheet.
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
    const color = focused ? colors.primary : colors.textInactive;
    const { Icon } = meta;
    return (
      <Pressable
        key={routeName}
        accessibilityRole="tab"
        accessibilityState={{ selected: focused }}
        accessibilityLabel={meta.label}
        onPress={() => {
          const event = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
          if (!focused && !event.defaultPrevented) navigation.navigate(route.name);
        }}
        style={styles.tab}
      >
        <Icon size={icons.tabSize} strokeWidth={icons.strokeWidth} color={color} />
        <Text
          numberOfLines={1}
          style={[
            focused ? type.tabLabelActive : type.tabLabelInactive,
            styles.tabLabel,
            meta.label.length > 9 && styles.tabLabelLong, // "Boodschappen" past dan net
          ]}
        >
          {meta.label}
        </Text>
      </Pressable>
    );
  };

  return (
    <View pointerEvents="box-none" style={[styles.wrap, { paddingBottom: Math.max(insets.bottom, 12) }]}>
      <View style={styles.bar}>
        {LEFT_TABS.map(renderTab)}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Recept importeren"
          onPress={() => router.push('/import')}
          style={styles.fab}
        >
          <Plus size={26} strokeWidth={2.4} color={colors.onPrimary} />
        </Pressable>
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
  },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.94)',
    borderRadius: radius.tabBar,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    paddingHorizontal: 18,
    paddingVertical: 10,
    gap: 6,
    ...shadows.float,
  },
  tab: {
    alignItems: 'center',
    justifyContent: 'center',
    width: 64,
    gap: 3,
  },
  tabLabel: {
    textAlign: 'center',
  },
  tabLabelLong: {
    fontSize: 8.5,
    letterSpacing: -0.2,
  },
  fab: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    marginHorizontal: 4,
    marginTop: -26,
    ...shadows.fab,
  },
});
