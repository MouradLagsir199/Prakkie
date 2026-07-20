import { InstrumentSans_400Regular, InstrumentSans_500Medium, InstrumentSans_600SemiBold, InstrumentSans_700Bold } from '@expo-google-fonts/instrument-sans';
import { YoungSerif_400Regular } from '@expo-google-fonts/young-serif';
import { useFonts } from 'expo-font';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { router } from 'expo-router';
import { useEffect } from 'react';
import { AppState, Platform } from 'react-native';
import { listRows, syncNow } from '../data';
import { prefetchImages } from '../data/image-prefetch';
import { kv } from '../data/kv';
import { colors } from '../theme/tokens';

SplashScreen.preventAutoHideAsync();

/** Productfoto's van de opgeslagen lijst-items — deze staan al lokaal in de
 *  `matches`-JSON, dus we kunnen ze bij het starten van de app meteen in de
 *  cache warmen zonder netwerk (owner 2026-07-21: thumbnails instant). */
async function warmListItemThumbnails(): Promise<void> {
  try {
    const rows = await listRows('list_items');
    const urls: (string | null | undefined)[] = [];
    for (const { row } of rows) {
      const matches = (row as { matches?: Record<string, { image_url?: string | null }> }).matches;
      if (!matches) continue;
      for (const entry of Object.values(matches)) urls.push(entry?.image_url);
    }
    prefetchImages(urls);
  } catch {
    /* prefetch is best-effort; nooit de start blokkeren */
  }
}

export default function RootLayout() {
  const [fontsLoaded] = useFonts({
    YoungSerif_400Regular,
    InstrumentSans_400Regular,
    InstrumentSans_500Medium,
    InstrumentSans_600SemiBold,
    InstrumentSans_700Bold,
  });

  useEffect(() => {
    if (fontsLoaded) SplashScreen.hideAsync();
  }, [fontsLoaded]);

  // offline-first sync: on launch and every return to foreground (WS1)
  useEffect(() => {
    // warm de thumbnails direct uit de lokale opslag, en opnieuw zodra de sync
    // verse items kan hebben binnengehaald (owner 2026-07-21)
    const kick = () =>
      syncNow()
        .catch(() => {}) // offline is a normal state, queue survives
        .finally(() => void warmListItemThumbnails());
    void warmListItemThumbnails();
    kick();
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') kick();
    });
    return () => sub.remove();
  }, []);

  // eerste start of na uitloggen → inlogscherm (owner 2026-07-07); wie is
  // ingelogd blijft ingelogd, ook na het sluiten van de app (SecureStore)
  useEffect(() => {
    if (Platform.OS === 'web') return; // web companion is a viewer, no login wall
    (async () => {
      const authed = await kv.getItem('prakkie.authed').catch(() => null);
      const legacy = await kv.getItem('prakkie.onboarded').catch(() => null); // bestaande installs niet eruit gooien
      if (!authed && !legacy) router.replace('/login');
    })();
  }, []);

  if (!fontsLoaded) return null;

  return (
    <>
      <StatusBar style="dark" />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="import" options={{ presentation: 'modal' }} />
      </Stack>
    </>
  );
}
