import { Tabs } from 'expo-router';
import { FloatingTabBar } from '../../components/prakkie/FloatingTabBar';
import { colors } from '../../theme/tokens';

export default function TabsLayout() {
  return (
    <Tabs
      tabBar={(props) => <FloatingTabBar {...props} />}
      screenOptions={{
        headerShown: false,
        sceneStyle: { backgroundColor: colors.bg },
      }}
    >
      <Tabs.Screen name="index" options={{ title: 'Recepten' }} />
      <Tabs.Screen name="plannen" options={{ title: 'Plannen' }} />
      <Tabs.Screen name="boodschappen" options={{ title: 'Boodschappen' }} />
      <Tabs.Screen name="profiel" options={{ title: 'Profiel' }} />
    </Tabs>
  );
}
