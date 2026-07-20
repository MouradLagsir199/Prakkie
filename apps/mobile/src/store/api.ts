import { useCallback, useEffect, useState } from 'react';
import type { DiscoverCategory, DiscoverProduct, StorePanel, StorePanelSort } from '@prakkie/shared';
import { authedRequest, onIdentityChange } from '../data/api';
import { getStoreCatalogStatus, preloadStoreCatalog, searchStoreCatalogCache } from '../data/store-catalog-cache';
import { kv } from '../data/kv';
import { loadMyChains, subscribeMyChains } from '../data/lijst-flow';

/**
 * Data-laag van Boodschappen-ontdek (owner-redesign 2026-07-12: praktisch,
 * geen 3D/strip). Cache-first: de home tekent direct uit kv, verse data komt
 * op de achtergrond binnen — nooit een blanco laadscherm. Ketens komen uit
 * Profiel (prakkie.mychains, /v1/me blijft waarheid).
 */

export interface StoreDiscover {
  categories: DiscoverCategory[];
  aanbevolen: DiscoverProduct[];
  refreshed_at: string | null;
}

export interface DepartmentDetail {
  department: { id: number; slug: string; name_nl: string; theme: string; sort: number };
  panels: StorePanel[];
  refreshed_at: string | null;
}

// v2 invalidates older category payloads in which valid thumbnails (notably
// Vis and Glutenvrij) were cached as null for the whole app session.
const DISCOVER_KEY = 'prakkie.store.discover.v2';
const sessionStoreData = new Map<string, unknown>();
const sessionStoreFlights = new Map<string, Promise<unknown | null>>();
const directStoreData = new Map<string, unknown>();
const directStoreFlights = new Map<string, Promise<unknown | null>>();
const attemptedStoreKeys = new Set<string>();
let storeCacheEpoch = 0;

function storeSessionKey(cacheKey: string, path: string): string {
  return `${cacheKey}|${path}`;
}

export function resetStoreSessionCache(): void {
  storeCacheEpoch += 1;
  sessionStoreData.clear();
  sessionStoreFlights.clear();
  directStoreData.clear();
  directStoreFlights.clear();
  attemptedStoreKeys.clear();
}

async function fetchJson<T>(path: string): Promise<T | null> {
  try {
    const res = await authedRequest(path);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/** Single-flight voor imperatieve categoriecalls. Alleen succesvolle
 * responses worden onthouden, zodat een tijdelijke netwerkfout wél opnieuw
 * geprobeerd kan worden wanneer de gebruiker terugkomt. */
function fetchDirectOnce<T>(path: string): Promise<T | null> {
  if (directStoreData.has(path)) return Promise.resolve(directStoreData.get(path) as T);
  const active = directStoreFlights.get(path);
  if (active) return active as Promise<T | null>;
  let flight!: Promise<T | null>;
  flight = fetchJson<T>(path)
    .then((fresh) => {
      if (fresh) directStoreData.set(path, fresh);
      return fresh;
    })
    .finally(() => {
      if (directStoreFlights.get(path) === flight) directStoreFlights.delete(path);
    });
  directStoreFlights.set(path, flight);
  return flight;
}

function fetchStoreOnce<T>(cacheKey: string, path: string): Promise<T | null> {
  const key = storeSessionKey(cacheKey, path);
  if (sessionStoreData.has(key)) return Promise.resolve(sessionStoreData.get(key) as T);
  const active = sessionStoreFlights.get(key);
  if (active) return active as Promise<T | null>;
  if (attemptedStoreKeys.has(key)) return Promise.resolve(null);
  attemptedStoreKeys.add(key);
  const capturedEpoch = storeCacheEpoch;
  let flight!: Promise<T | null>;
  flight = fetchJson<T>(path)
    .then((fresh) => {
      if (capturedEpoch !== storeCacheEpoch) return null;
      if (fresh) {
        sessionStoreData.set(key, fresh);
        kv.setItem(key, JSON.stringify(fresh)).catch(() => {});
      }
      return fresh;
    })
    .finally(() => {
      if (sessionStoreFlights.get(key) === flight) sessionStoreFlights.delete(key);
    });
  sessionStoreFlights.set(key, flight);
  return flight;
}

/** Cold app: kv → direct tekenen, netwerk één keer verversen. Daarna blijft de
 *  route voor de hele processessie volledig in geheugen. */
function useCachedStore<T>(cacheKey: string, path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [fromCache, setFromCache] = useState(false);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!path) return;
    const fresh = await fetchStoreOnce<T>(cacheKey, path);
    if (fresh) {
      setData(fresh);
      setFromCache(false);
    }
  }, [cacheKey, path]);

  useEffect(() => {
    let live = true;
    if (!path) {
      setData(null);
      setFromCache(false);
      setLoading(false);
      return () => { live = false; };
    }
    const key = storeSessionKey(cacheKey, path);
    const inMemory = sessionStoreData.get(key) as T | undefined;
    if (inMemory) {
      setData(inMemory);
      setFromCache(false);
      setLoading(false);
      return () => { live = false; };
    }
    setLoading(true);
    (async () => {
      let diskCached: T | null = null;
      try {
        // Path-specific key prevents one supermarket selection flashing data
        // from another. The legacy key is only a first-run migration fallback.
        const raw = await kv.getItem(key) ?? await kv.getItem(cacheKey);
        if (raw) {
          const cached = JSON.parse(raw) as T;
          diskCached = cached;
          if (live) {
            setData(cached);
            setFromCache(true);
          }
        }
      } catch { /* cache is optioneel */ }
      const fresh = await fetchStoreOnce<T>(cacheKey, path);
      if (live && fresh) {
        setData(fresh);
        setFromCache(false);
      }
      // Offline cold start still graduates the disk fallback to process memory,
      // so later route visits never reread storage during this app session.
      if (!fresh && diskCached && !sessionStoreData.has(key)) {
        sessionStoreData.set(key, diskCached);
      }
      if (live) setLoading(false);
    })();
    return () => {
      live = false;
    };
  }, [cacheKey, path]);

  return { data, fromCache, loading, refresh };
}

onIdentityChange(() => resetStoreSessionCache());

/** de hele Boodschappen-home in één call: categorieën + aanbevolen bonussen */
export function useStoreDiscover() {
  const chains = useMyChains();
  const path = chains ? `/v1/store/discover?chains=${chains.join(',')}` : null;
  return { ...useCachedStore<StoreDiscover>(DISCOVER_KEY, path), chains };
}

/** subcategorieën (panelen) van één categorie — cache-first per categorie */
export function useDepartment(slug: string | null) {
  const chains = useMyChains();
  const path = slug && chains ? `/v1/store/department/${slug}?chains=${chains.join(',')}` : null;
  return { ...useCachedStore<DepartmentDetail>(`prakkie.store.dept.${slug ?? ''}`, path), chains };
}

export function useMyChains(): string[] | null {
  const [chains, setChains] = useState<string[] | null>(null);
  useEffect(() => {
    let live = true;
    const load = () => loadMyChains()
      .then((next) => { if (live) setChains(next); })
      .catch(() => { if (live) setChains(['ah']); });
    const unsubscribe = subscribeMyChains((next) => {
      if (!live) return;
      if (next) setChains(next);
      else {
        setChains(null);
        void load();
      }
    });
    void load();
    return () => {
      live = false;
      unsubscribe();
    };
  }, []);
  return chains;
}

/** subcategorie-inhoud — CrossChainOption-vormig, direct voedbaar aan CrossChainList */
export async function fetchPanelProducts(
  categoryId: number,
  chains: string[],
  opts: {
    sort?: StorePanelSort;
    q?: string;
    offset?: number;
    limit?: number;
    scope?: 'category' | 'department';
  } = {}
): Promise<{
  products: unknown[];
  total: number;
  offset?: number;
  has_more?: boolean;
  search_coverage?: 'none' | 'partial' | 'exact';
  search_scope?: 'category' | 'department';
} | null> {
  const q = opts.q?.trim() ? `&q=${encodeURIComponent(opts.q.trim())}` : '';
  const sort = opts.sort ? `&sort=${opts.sort}` : '';
  const scope = opts.scope ? `&scope=${opts.scope}` : '';
  const offset = `&offset=${Math.max(0, opts.offset ?? 0)}`;
  const limit = `&limit=${Math.max(1, opts.limit ?? 60)}`;
  const path = `/v1/store/category/${categoryId}/products?chains=${chains.join(',')}${sort}${q}${scope}${offset}${limit}`;
  return fetchDirectOnce(path);
}

export interface ResolvedStoreCategory {
  id: number;
  slug: string;
  name_nl: string;
  department_id: number;
}

/** Categorie voor de handmatige alternatiefkiezer. De server gebruikt exacte
 * catalogus-membership of de veilige aisle-taxonomie, nooit losse substrings. */
export async function resolveStoreCategory(opts: {
  term: string;
  aisle?: number | null;
  sourceChain?: string | null;
  sourceSku?: string | null;
}): Promise<ResolvedStoreCategory | null> {
  const params = new URLSearchParams({ term: opts.term.trim() });
  if (opts.aisle != null) params.set('aisle', String(opts.aisle));
  if (opts.sourceChain) params.set('source_chain', opts.sourceChain);
  if (opts.sourceSku) params.set('source_sku', opts.sourceSku);
  const path = `/v1/store/resolve-category?${params.toString()}`;
  const result = await fetchDirectOnce<{ category: ResolvedStoreCategory }>(path);
  return result?.category ?? null;
}

/** Vrije cataloguszoeker voor de hoofdzoekbalk onder Boodschappen. Anders dan
 * /v1/match behoudt deze samengestelde productnamen en vangt hij kleine typo's
 * op zonder "sinaasappeljam" semantisch naar sinaasappelsap om te buigen. */
export async function searchStoreProducts(
  q: string,
  chains: string[],
  opts: { offset?: number; limit?: number; sort?: StorePanelSort } = {}
): Promise<{
  products: unknown[];
  total: number;
  offset?: number;
  has_more?: boolean;
  search_coverage?: 'none' | 'partial' | 'exact' | 'fuzzy';
} | null> {
  const cached = searchStoreCatalogCache(q, chains, opts);
  if (cached) return cached;
  const status = getStoreCatalogStatus(chains);
  if (status === 'idle' || status === 'warming') {
    await preloadStoreCatalog(chains);
    const warmed = searchStoreCatalogCache(q, chains, opts);
    if (warmed) return warmed;
  }
  const params = new URLSearchParams({
    q: q.trim(),
    chains: chains.join(','),
    offset: String(Math.max(0, opts.offset ?? 0)),
    limit: String(Math.max(1, opts.limit ?? 60)),
  });
  if (opts.sort) params.set('sort', opts.sort);
  return fetchJson(`/v1/store/search?${params.toString()}`);
}
