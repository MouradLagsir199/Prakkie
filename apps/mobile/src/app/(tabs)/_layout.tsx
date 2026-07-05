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
      <Tabs.Screen name="lijst" options={{ title: 'Lijst' }} />
      <Tabs.Screen name="prijzen" options={{ title: 'Prijzen' }} />
    </Tabs>
  );
}
