import { LIVE_CHAIN_IDS } from '@prakkie/shared';
import { authedRequest, onIdentityChange } from './api';
import { kv } from './kv';

/**
 * Boodschappen (owner 2026-07-13): lijst samenstellen = winkelen in de
 * Boodschappen-tab; de summary (/lijst/resultaat) toont en prijst. Het oude
 * zoeklijstje + "Vind mijn prakkie" (AI-resolve) zijn gesloopt — wat hier
 * rest is de gedeelde ketens-helper.
 */

// Eén bron van waarheid met Profiel/onboarding. Nieuwe live catalogi mogen
// niet wel in de ketenkiezer staan maar hier stil uit de opgeslagen keuze
// worden gefilterd.
export const ALL_CHAINS: string[] = [...LIVE_CHAIN_IDS];

type ChainsListener = (chains: string[] | null) => void;
const chainListeners = new Set<ChainsListener>();
let sessionChains: string[] | null = null;
let chainsFlight: Promise<string[]> | null = null;
let chainsEpoch = 0;

function validChains(value: readonly string[]): string[] {
  return [...new Set(value.map((chain) => chain.trim().toLowerCase()))]
    .filter((chain) => ALL_CHAINS.includes(chain));
}

function commitMyChains(value: readonly string[]): string[] {
  const chains = validChains(value);
  sessionChains = chains.length ? chains : ['ah'];
  chainListeners.forEach((listener) => listener(sessionChains));
  return sessionChains;
}

/** Update the current process immediately after a deliberate Profile change. */
export function setMyChainsForSession(value: readonly string[]): string[] {
  chainsEpoch += 1;
  chainsFlight = null;
  return commitMyChains(value);
}

export function resetMyChainsForSession(): void {
  chainsEpoch += 1;
  sessionChains = null;
  chainsFlight = null;
  chainListeners.forEach((listener) => listener(null));
}

export function subscribeMyChains(listener: ChainsListener): () => void {
  chainListeners.add(listener);
  return () => chainListeners.delete(listener);
}

/** jouw supers: kv-cache direct, /v1/me als waarheid (best effort) */
export async function loadMyChains(): Promise<string[]> {
  if (sessionChains) return sessionChains;
  if (chainsFlight) return chainsFlight;
  const capturedEpoch = chainsEpoch;
  let flight!: Promise<string[]>;
  flight = (async () => {
    let chains: string[] = ['ah'];
    try {
      const cached = await kv.getItem('prakkie.mychains');
      if (cached) {
        const arr = validChains(JSON.parse(cached) as string[]);
        if (arr.length) chains = arr;
      }
    } catch { /* cache is optioneel */ }
    try {
      const res = await authedRequest('/v1/me');
      if (res.ok) {
        const me = (await res.json()) as { home_chain_ids?: string[] };
        const arr = validChains(me.home_chain_ids ?? []);
        if (arr.length) {
          chains = arr;
          kv.setItem('prakkie.mychains', JSON.stringify(arr)).catch(() => {});
        }
      }
    } catch { /* offline: cache/fallback */ }
    // A profile/identity change while /v1/me was in flight owns the newer
    // value; the late response must never put the previous account back.
    if (capturedEpoch !== chainsEpoch) return loadMyChains();
    return commitMyChains(chains);
  })().finally(() => {
    if (chainsFlight === flight) chainsFlight = null;
  });
  chainsFlight = flight;
  return flight;
}

onIdentityChange(() => resetMyChainsForSession());
