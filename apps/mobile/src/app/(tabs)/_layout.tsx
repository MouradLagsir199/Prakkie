import { Tabs } from 'expo-router';
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { FloatingTabBar } from '../../components/prakkie/FloatingTabBar';
import { OnboardingTour, OnboardingTourProvider } from '../../components/prakkie/OnboardingTour';
import { ShoppingWarmupOverlay } from '../../components/prakkie/ShoppingWarmupLogos';
import { useShoppingSessionCache, warmShoppingSession } from '../../data/shopping-session-cache';
import { getStoreCatalogStatus, preloadStoreCatalog } from '../../data/store-catalog-cache';
import { useStoreDiscover } from '../../store/api';
import { useBoodschappenLijst } from '../../store/lijst';
import { colors } from '../../theme/tokens';

let hasShownStoreWarmupOverlay = false;

/** Warm de actuele lijst al bij het openen van de app. Daardoor hoeft een
 * recept dat later aan de lijst wordt toegevoegd niet eerst te wachten tot de
 * gebruiker het tabblad Boodschappen heeft bezocht. */
function ShoppingSessionBootstrap() {
  // Dit warmt tegelijk de categorie-/bonusdata van Boodschappen; het tabblad
  // kan daardoor later direct uit het process-geheugen tekenen.
  const { chains, loading: storeLoading } = useStoreDiscover();
  const { currentListId, itemDescriptors, revision } = useBoodschappenLijst();
  const shoppingCache = useShoppingSessionCache();
  const [catalogWarming, setCatalogWarming] = useState(false);
  const [overlayDone, setOverlayDone] = useState(hasShownStoreWarmupOverlay);
  const chainKey = chains?.join(',') ?? '';

  useEffect(() => {
    if (!chains?.length) return;
    let live = true;
    if (!hasShownStoreWarmupOverlay && getStoreCatalogStatus(chains) !== 'ready') {
      setCatalogWarming(true);
    }
    void preloadStoreCatalog(chains)
      .finally(() => {
        if (live) setCatalogWarming(false);
      });
    return () => { live = false; };
  }, [chainKey]);

  useEffect(() => {
    if (!currentListId || !chains?.length || itemDescriptors.length === 0) return;
    void warmShoppingSession({
      listId: currentListId,
      chains,
      revision,
      items: itemDescriptors,
    });
  }, [currentListId, revision, chains, itemDescriptors]);

  const coldListWarming =
    shoppingCache.status === 'warming' &&
    (!currentListId || shoppingCache.listId === currentListId);
  const shouldShowOverlay =
    !overlayDone &&
    !hasShownStoreWarmupOverlay &&
    !!chains?.length &&
    (storeLoading || catalogWarming || coldListWarming);

  useEffect(() => {
    if (shouldShowOverlay) return;
    if (overlayDone || hasShownStoreWarmupOverlay || !chains?.length) return;
    hasShownStoreWarmupOverlay = true;
    setOverlayDone(true);
  }, [shouldShowOverlay, overlayDone, chainKey]);

  return shouldShowOverlay ? <ShoppingWarmupOverlay chains={chains!} /> : null;
}

export default function TabsLayout() {
  return (
    <OnboardingTourProvider>
      <View style={{ flex: 1 }}>
        <ShoppingSessionBootstrap />
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
        {/* rondleiding na eerste registratie — tekent over de tabs heen */}
        <OnboardingTour />
      </View>
    </OnboardingTourProvider>
  );
}
