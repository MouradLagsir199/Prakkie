import { Image } from 'expo-image';

/**
 * Warmt de expo-image schijf-cache vóórdat een scherm de thumbnails nodig heeft.
 * De productfoto's op het boodschappen-overzicht staan al in de opgeslagen
 * `matches`-JSON van elk item — die kunnen we dus meteen bij het starten van de
 * app inladen, zonder netwerk. Eenmaal geprefetcht serveert expo-image ze
 * instant (memory-disk), ook na een herstart.
 */

const requested = new Set<string>();

/** URL's die al zijn aangevraagd worden nooit een tweede keer geprefetcht. */
export function prefetchImages(urls: readonly (string | null | undefined)[]): void {
  const fresh: string[] = [];
  for (const url of urls) {
    if (!url || typeof url !== 'string') continue;
    if (requested.has(url)) continue;
    requested.add(url);
    fresh.push(url);
  }
  if (fresh.length === 0) return;
  // Fire-and-forget: een mislukte prefetch mag het scherm nooit blokkeren; de
  // gewone <Image>-render haalt hem later alsnog op.
  Image.prefetch(fresh, 'memory-disk').catch(() => {});
}

/** Reset (bij identiteitswissel): de nieuwe gebruiker mag opnieuw prefetchen. */
export function resetImagePrefetch(): void {
  requested.clear();
}
