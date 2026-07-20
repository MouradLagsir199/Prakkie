import { useSyncExternalStore } from 'react';
import type { ProductOption } from '../components/prakkie/ProductOptions';
import { authedRequest, onIdentityChange } from './api';
import { prefetchImages, resetImagePrefetch } from './image-prefetch';
import { syncNow } from './index';

/**
 * Process-memory cache for the expensive shopping-list projections.
 *
 * Nothing in this module is written to kv/SQLite: a cold app process performs
 * one warm-up, while every summary/policy interaction afterwards reads the
 * same objects synchronously. A changed list revision deliberately creates a
 * new scope so newly added products cannot inherit stale prices.
 */

export const SHOPPING_MATCH_POLICIES = ['precise', 'practical', 'value'] as const;
export type ShoppingMatchPolicy = (typeof SHOPPING_MATCH_POLICIES)[number];
export type ShoppingMatchDecision = 'accepted' | 'review' | 'unavailable';

export interface ShoppingPricedLine {
  item_id: string;
  /** Original list-line name. The API includes this even though most mobile
   * call sites render `product_name`; it lets a delta merge rebuild the
   * `unmatched` summary without another request. */
  name?: string;
  matched: boolean;
  sku_id?: string;
  product_name?: string;
  packs?: number;
  line_price_cents?: number;
  fractional_cents?: number;
  promo?: unknown;
  promo_savings_cents?: number;
  /** Restricts manual catalog search to the original product category/aisle. */
  category_aisle_id?: number | null;
  confidence?: number;
  reliability?: number;
  decision?: ShoppingMatchDecision;
  reasons?: string[];
  matcher_version?: string;
  alternatives?: ProductOption[];
}

export interface ShoppingChainPricing {
  chain_id: string;
  total_cents: number;
  fractional_total_cents?: number;
  promo_savings_cents?: number;
  matched: number;
  review?: number;
  unmatched: string[];
  full_assortment?: boolean;
  staleness?: unknown;
  accepted?: number;
  unavailable?: number;
  accepted_total_cents?: number;
  lines: ShoppingPricedLine[];
}

export interface ShoppingSubstitutionPreview {
  list_id: string;
  chain_id: string;
  policy: ShoppingMatchPolicy;
  matcher_version: string | null;
  accepted: number;
  review: number;
  unavailable: number;
  accepted_total_cents: number;
  lines: ShoppingPricedLine[];
}

export interface ShoppingSessionResponse {
  list_id: string;
  matcher_version: string | null;
  policies: Record<ShoppingMatchPolicy, ShoppingChainPricing[]>;
}

export type ShoppingSessionCacheStatus = 'idle' | 'warming' | 'updating' | 'ready' | 'error';

export interface ShoppingSessionCacheSnapshot {
  status: ShoppingSessionCacheStatus;
  listId: string | null;
  chainIds: readonly string[];
  /** Number of network projections made available in this warm phase. */
  loaded: number;
  total: number;
  error: string | null;
}

export interface WarmShoppingSessionOptions {
  listId: string;
  chains: readonly string[];
  /** Stable local-list identity; changes only when list content changes. */
  revision?: string;
  /**
   * Identity of every active local list line. `fingerprint` must change when
   * anything that affects matching or price changes (name, quantity, unit,
   * checked state or a pinned match). With this present, a warmed list sends
   * only new/changed IDs to the API and merges those lines into memory.
   */
  items?: readonly ShoppingSessionItemIdentity[];
  force?: boolean;
}

export interface ShoppingSessionItemIdentity {
  id: string;
  fingerprint: string;
}

const EMPTY_SNAPSHOT: ShoppingSessionCacheSnapshot = Object.freeze({
  status: 'idle',
  listId: null,
  chainIds: Object.freeze([]) as readonly string[],
  loaded: 0,
  total: 0,
  error: null,
});

let snapshot: ShoppingSessionCacheSnapshot = EMPTY_SNAPSHOT;
const listeners = new Set<() => void>();
const warmedScopes = new Set<string>();
const attemptedScopes = new Set<string>();
const warmFlights = new Map<string, Promise<ShoppingSessionResponse | null>>();
const warmFlightMeta = new Map<string, { listId: string; chains: readonly string[] }>();
const pricingByList = new Map<string, Map<string, ShoppingChainPricing>>();
const previewByKey = new Map<string, ShoppingSubstitutionPreview>();
const previewFlights = new Map<string, Promise<ShoppingSubstitutionPreview | null>>();
const latestScopeByList = new Map<string, string>();
const listGenerations = new Map<string, number>();
interface CachedSessionBundle {
  chains: readonly string[];
  items: ReadonlyMap<string, string> | null;
  response: ShoppingSessionResponse;
}
const sessionByList = new Map<string, CachedSessionBundle>();
interface ColdWarmCoordinator {
  leaderKey: string;
  epoch: number;
  generation: number;
  /** Newest requested state while the first complete projection is running. */
  queued: WarmShoppingSessionOptions | null;
  /** Every revision alias points at this one completion Promise. */
  aliases: Set<string>;
  completion: Promise<ShoppingSessionResponse | null>;
}
/**
 * Before a list has a complete base projection, changing its revision must not
 * fan out into several full matcher requests. Keep one leader per list/chain
 * set, commit that response as the merge base, then catch up exactly once to
 * the newest queued revision.
 */
const coldWarmByListChains = new Map<string, ColdWarmCoordinator>();
/** Must stay aligned with the API's guarded shopping-session query limit. */
const MAX_INCREMENTAL_ITEM_IDS = 100;
let cacheEpoch = 0;
let activeScopeKey: string | null = null;

function canonicalChains(chains: readonly string[]): string[] {
  return [...new Set(chains.map((chain) => chain.trim().toLowerCase()).filter(Boolean))].sort();
}

function scopeKey(listId: string, chains: readonly string[], revision?: string): string {
  return `${listId}|${canonicalChains(chains).join(',')}|${revision ?? ''}`;
}

function listChainsKey(listId: string, chains: readonly string[]): string {
  return `${listId}|${canonicalChains(chains).join(',')}`;
}

function normalizeItems(
  items: readonly ShoppingSessionItemIdentity[] | undefined
): ShoppingSessionItemIdentity[] | null {
  if (!items) return null;
  const byId = new Map<string, string>();
  for (const item of items) {
    const id = item.id.trim();
    if (id) byId.set(id, item.fingerprint);
  }
  return [...byId].map(([id, fingerprint]) => ({ id, fingerprint }));
}

function itemRevision(items: readonly ShoppingSessionItemIdentity[] | null): string | undefined {
  if (!items) return undefined;
  return [...items]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((item) => `${item.id}:${item.fingerprint}`)
    .join('|');
}

function sameChains(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((chain, index) => chain === right[index]);
}

function previewKey(listId: string, chain: string, policy: ShoppingMatchPolicy): string {
  return `${listId}|${chain.trim().toLowerCase()}|${policy}`;
}

function updateSnapshot(next: ShoppingSessionCacheSnapshot): void {
  snapshot = Object.freeze({ ...next, chainIds: Object.freeze([...next.chainIds]) });
  listeners.forEach((listener) => listener());
}

function putPricing(listId: string, chain: ShoppingChainPricing): void {
  let byChain = pricingByList.get(listId);
  if (!byChain) {
    byChain = new Map();
    pricingByList.set(listId, byChain);
  }
  byChain.set(chain.chain_id.trim().toLowerCase(), chain);
}

function clearListData(listId: string): void {
  pricingByList.delete(listId);
  for (const key of [...previewByKey.keys()]) {
    if (key.startsWith(`${listId}|`)) previewByKey.delete(key);
  }
}

function clearListSession(listId: string): void {
  clearListData(listId);
  sessionByList.delete(listId);
}

function asPreview(
  listId: string,
  policy: ShoppingMatchPolicy,
  matcherVersion: string | null,
  chain: ShoppingChainPricing
): ShoppingSubstitutionPreview {
  const accepted = chain.accepted ?? chain.lines.filter((line) => line.decision === 'accepted').length;
  const review = chain.review ?? chain.lines.filter((line) => line.decision === 'review').length;
  const unavailable = chain.unavailable ?? chain.lines.filter((line) => line.decision === 'unavailable').length;
  return {
    list_id: listId,
    chain_id: chain.chain_id,
    policy,
    matcher_version:
      matcherVersion ?? chain.lines.find((line) => line.matcher_version)?.matcher_version ?? null,
    accepted,
    review,
    unavailable,
    accepted_total_cents: chain.accepted_total_cents ?? chain.total_cents,
    lines: chain.lines,
  };
}

function storeSessionResponse(response: ShoppingSessionResponse): number {
  let loaded = 0;
  for (const policy of SHOPPING_MATCH_POLICIES) {
    for (const chain of response.policies[policy] ?? []) {
      previewByKey.set(
        previewKey(response.list_id, chain.chain_id, policy),
        asPreview(response.list_id, policy, response.matcher_version, chain)
      );
      if (policy === 'precise') putPricing(response.list_id, chain);
      loaded += 1;
    }
  }
  // Warm de schijf-cache met precies de foto's die het overzicht straks toont:
  // de gematchte sku per regel. De Boodschappen-tab warmt de sessie al bij het
  // openen, dus tegen de tijd dat de user naar het lijst-overzicht gaat staan
  // de thumbnails al klaar (owner 2026-07-21: "traag ladende thumbnails").
  prefetchImages(collectPricedLineImages(response.policies.precise ?? []));
  return loaded;
}

/** De foto van de gematchte sku per regel — dat is wat de lijstregel toont. */
function collectPricedLineImages(chains: readonly ShoppingChainPricing[]): string[] {
  const urls: string[] = [];
  for (const chain of chains) {
    for (const line of chain.lines) {
      const chosen =
        line.alternatives?.find((alt) => alt.sku_id === line.sku_id) ?? line.alternatives?.[0];
      if (chosen?.image_url) urls.push(chosen.image_url);
    }
  }
  return urls;
}

function replaceStoredSessionResponse(response: ShoppingSessionResponse): number {
  clearListData(response.list_id);
  return storeSessionResponse(response);
}

function isAcceptedLine(line: ShoppingPricedLine): boolean {
  return line.decision === 'accepted' || (line.decision == null && line.matched);
}

/** Rebuild every aggregate carried by a chain after line-level delta merging. */
function withRecomputedTotals(
  source: ShoppingChainPricing,
  lines: ShoppingPricedLine[]
): ShoppingChainPricing {
  const acceptedLines = lines.filter(isAcceptedLine);
  const review = lines.filter((line) => line.decision === 'review').length;
  const unavailable = lines.filter(
    (line) => line.decision === 'unavailable' || (line.decision == null && !line.matched)
  ).length;
  const totalCents = acceptedLines.reduce((sum, line) => sum + (line.line_price_cents ?? 0), 0);
  const fractionalTotalCents = acceptedLines.reduce(
    (sum, line) => sum + (line.fractional_cents ?? line.line_price_cents ?? 0),
    0
  );
  const promoSavingsCents = acceptedLines.reduce(
    (sum, line) => sum + (line.promo_savings_cents ?? 0),
    0
  );
  return {
    ...source,
    total_cents: totalCents,
    fractional_total_cents: fractionalTotalCents,
    promo_savings_cents: promoSavingsCents,
    matched: acceptedLines.length,
    accepted: acceptedLines.length,
    review,
    unavailable,
    accepted_total_cents: totalCents,
    unmatched: lines
      .filter((line) => !isAcceptedLine(line))
      .map((line) => line.name ?? line.product_name ?? line.item_id),
    lines,
  };
}

/**
 * Apply a response containing only `replaceItemIds` to the prior complete
 * bundle. Lines absent from the current local identity list are deletions;
 * changed lines are removed before their replacement is inserted.
 */
function mergeSessionDelta(
  base: ShoppingSessionResponse,
  delta: ShoppingSessionResponse,
  chains: readonly string[],
  items: readonly ShoppingSessionItemIdentity[],
  replaceItemIds: ReadonlySet<string>
): ShoppingSessionResponse {
  const currentIds = new Set(items.map((item) => item.id));
  const policies = {} as ShoppingSessionResponse['policies'];

  for (const policy of SHOPPING_MATCH_POLICIES) {
    const baseByChain = new Map(
      (base.policies[policy] ?? []).map((chain) => [chain.chain_id.trim().toLowerCase(), chain])
    );
    const deltaByChain = new Map(
      (delta.policies[policy] ?? []).map((chain) => [chain.chain_id.trim().toLowerCase(), chain])
    );
    policies[policy] = chains.map((chainId) => {
      const oldChain = baseByChain.get(chainId);
      const deltaChain = deltaByChain.get(chainId);
      // A same-chain delta always has both. The defensive fallback keeps a
      // rolling backend deploy from destroying an already usable projection.
      const source = deltaChain ?? oldChain ?? {
        chain_id: chainId,
        total_cents: 0,
        matched: 0,
        unmatched: [],
        lines: [],
      };
      const oldLines = new Map(
        (oldChain?.lines ?? [])
          .filter((line) => currentIds.has(line.item_id) && !replaceItemIds.has(line.item_id))
          .map((line) => [line.item_id, line])
      );
      const newLines = new Map(
        (deltaChain?.lines ?? [])
          .filter((line) => currentIds.has(line.item_id))
          .map((line) => [line.item_id, line])
      );
      const lines = items
        .map((item) => newLines.get(item.id) ?? oldLines.get(item.id))
        .filter(Boolean) as ShoppingPricedLine[];
      return withRecomputedTotals(source, lines);
    });
  }

  return {
    list_id: base.list_id,
    matcher_version: delta.matcher_version ?? base.matcher_version,
    policies,
  };
}

function isShoppingSessionResponse(value: unknown): value is ShoppingSessionResponse {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<ShoppingSessionResponse>;
  return (
    typeof candidate.list_id === 'string' &&
    !!candidate.policies &&
    SHOPPING_MATCH_POLICIES.every((policy) => Array.isArray(candidate.policies?.[policy]))
  );
}

class CombinedSessionEndpointUnavailable extends Error {}

async function requestCombinedSession(
  listId: string,
  chains: readonly string[],
  itemIds?: readonly string[]
): Promise<ShoppingSessionResponse> {
  const params = new URLSearchParams({ chains: chains.join(',') });
  if (itemIds?.length) params.set('items', itemIds.join(','));
  const res = await authedRequest(
    `/v1/lists/${listId}/shopping-session?${params.toString()}`
  );
  if (!res.ok) {
    if (res.status === 404 || res.status === 405) {
      throw new CombinedSessionEndpointUnavailable(`shopping-session ${res.status}`);
    }
    throw new Error(`shopping-session ${res.status}`);
  }
  const body: unknown = await res.json();
  if (!isShoppingSessionResponse(body)) throw new Error('shopping-session response is ongeldig');
  if (body.list_id !== listId) throw new Error('shopping-session hoort bij een ander lijstje');
  return body;
}

async function requestLegacyPreview(
  listId: string,
  chain: string,
  policy: ShoppingMatchPolicy
): Promise<ShoppingSubstitutionPreview> {
  const res = await authedRequest(`/v1/lists/${listId}/substitution-preview`, {
    method: 'POST',
    body: JSON.stringify({ chain_id: chain, policy }),
  });
  if (!res.ok) throw new Error(`substitution-preview ${res.status}`);
  return (await res.json()) as ShoppingSubstitutionPreview;
}

/** Temporary compatibility path while older API deployments are still live. */
async function requestLegacySession(listId: string, chains: readonly string[]): Promise<ShoppingSessionResponse> {
  const priceRequest = authedRequest(
    `/v1/lists/${listId}/price?chains=${encodeURIComponent(chains.join(','))}&policy=precise`
  ).then(async (res) => {
    if (!res.ok) throw new Error(`price ${res.status}`);
    return ((await res.json()) as { chains: ShoppingChainPricing[] }).chains;
  });
  const previewRequests = SHOPPING_MATCH_POLICIES.flatMap((policy) =>
    chains.map(async (chain) => ({ policy, preview: await requestLegacyPreview(listId, chain, policy) }))
  );
  const [precisePricing, previewResults] = await Promise.all([priceRequest, Promise.all(previewRequests)]);
  const policies: ShoppingSessionResponse['policies'] = { precise: [], practical: [], value: [] };
  for (const result of previewResults) {
    const { preview, policy } = result;
    policies[policy].push({
      chain_id: preview.chain_id,
      total_cents: preview.accepted_total_cents,
      accepted_total_cents: preview.accepted_total_cents,
      matched: preview.accepted,
      accepted: preview.accepted,
      review: preview.review,
      unavailable: preview.unavailable,
      unmatched: [],
      lines: preview.lines,
    });
  }
  // The price response remains the summary source; preview precise carries the
  // richer alternatives and is already stored separately by the projection.
  const preciseByChain = new Map(policies.precise.map((chain) => [chain.chain_id, chain]));
  policies.precise = precisePricing.map((chain) => ({
    ...chain,
    lines: preciseByChain.get(chain.chain_id)?.lines ?? chain.lines,
  }));
  return {
    list_id: listId,
    matcher_version:
      policies.precise.flatMap((chain) => chain.lines).find((line) => line.matcher_version)?.matcher_version ?? null,
    policies,
  };
}

/**
 * Loads the complete summary plus all policy tabs once for this in-memory list.
 * A later revision of the same list/chains requests only new or changed item
 * IDs and atomically merges them; concurrent callers share the same Promise.
 */
export function warmShoppingSession(
  options: WarmShoppingSessionOptions
): Promise<ShoppingSessionResponse | null> {
  const chains = canonicalChains(options.chains);
  if (!options.listId || chains.length === 0) return Promise.resolve(null);
  const items = normalizeItems(options.items);
  const revision = options.revision ?? itemRevision(items);
  const key = scopeKey(options.listId, chains, revision);
  const coldKey = listChainsKey(options.listId, chains);
  const normalizedOptions: WarmShoppingSessionOptions = {
    listId: options.listId,
    chains,
    ...(revision !== undefined ? { revision } : {}),
    ...(items !== null ? { items } : {}),
    ...(options.force ? { force: true } : {}),
  };

  // The most recently requested local revision is authoritative immediately,
  // not only after its request starts. Otherwise a slower request for a
  // previous revision could win while this call exits through a reuse path.
  const previousScope = latestScopeByList.get(options.listId);
  if (previousScope && previousScope !== key) {
    for (const oldKey of [...warmedScopes]) {
      if (oldKey.startsWith(`${options.listId}|`)) warmedScopes.delete(oldKey);
    }
    for (const oldKey of [...attemptedScopes]) {
      if (oldKey.startsWith(`${options.listId}|`)) attemptedScopes.delete(oldKey);
    }
  }
  latestScopeByList.set(options.listId, key);
  activeScopeKey = key;

  const coldCoordinator = coldWarmByListChains.get(coldKey);
  if (
    coldCoordinator &&
    coldCoordinator.epoch === cacheEpoch &&
    coldCoordinator.generation === (listGenerations.get(options.listId) ?? 0)
  ) {
    // A changed revision during the first warm supersedes any intermediate
    // revision. Alias it to the leader's completion instead of launching a
    // second full request. Reverting to the leader state clears the catch-up.
    coldCoordinator.queued = key === coldCoordinator.leaderKey ? null : normalizedOptions;
    coldCoordinator.aliases.add(key);
    warmFlights.set(key, coldCoordinator.completion);
    warmFlightMeta.set(key, { listId: options.listId, chains });
    const hasCachedProjection = getCachedPricing(options.listId, chains) !== null;
    const total = chains.length * SHOPPING_MATCH_POLICIES.length;
    updateSnapshot({
      status: hasCachedProjection ? 'updating' : 'warming',
      listId: options.listId,
      chainIds: chains,
      loaded: hasCachedProjection ? total : 0,
      total,
      error: null,
    });
    return coldCoordinator.completion;
  }

  const existing = warmFlights.get(key);
  if (existing) {
    const hasCachedProjection = getCachedPricing(options.listId, chains) !== null;
    const total = chains.length * SHOPPING_MATCH_POLICIES.length;
    updateSnapshot({
      status: hasCachedProjection ? 'updating' : 'warming',
      listId: options.listId,
      chainIds: chains,
      loaded: hasCachedProjection ? total : 0,
      total,
      error: null,
    });
    return existing;
  }

  const cachedBundle = sessionByList.get(options.listId);
  const startsColdFullProjection =
    !cachedBundle || !sameChains(cachedBundle.chains, chains);
  const canMergeDelta =
    !!cachedBundle &&
    !!cachedBundle.items &&
    !!items &&
    sameChains(cachedBundle.chains, chains);
  const priorItems = cachedBundle?.items;
  const currentItemIds = items ? new Set(items.map((item) => item.id)) : null;
  const changedItemIds = canMergeDelta
    ? items
        .filter((item) => priorItems!.get(item.id) !== item.fingerprint)
        .map((item) => item.id)
    : [];
  const removedItemCount = canMergeDelta
    ? [...priorItems!.keys()].filter((id) => !currentItemIds!.has(id)).length
    : 0;
  const hasDelta = canMergeDelta && (changedItemIds.length > 0 || removedItemCount > 0);

  const total = chains.length * SHOPPING_MATCH_POLICIES.length;

  // A caller may provide a differently formatted revision while the exact
  // fingerprints are unchanged. Reuse the complete object without touching
  // the network (unless this is an explicit forced refresh).
  if (canMergeDelta && !hasDelta && !options.force) {
    warmedScopes.add(key);
    latestScopeByList.set(options.listId, key);
    activeScopeKey = key;
    updateSnapshot({
      status: 'ready', listId: options.listId, chainIds: chains,
      loaded: total, total, error: null,
    });
    return Promise.resolve(cachedBundle.response);
  }

  // A direct deep-link can perform the first full warm without descriptors.
  // When Boodschappen later supplies them for that exact warmed scope, attach
  // the identities to the complete bundle so subsequent changes can be
  // incremental; the full projection itself does not need to be fetched again.
  if (
    !options.force &&
    cachedBundle &&
    sameChains(cachedBundle.chains, chains) &&
    warmedScopes.has(key) &&
    (!items || !cachedBundle.items)
  ) {
    if (items && !cachedBundle.items) {
      sessionByList.set(options.listId, {
        ...cachedBundle,
        items: new Map(items.map((item) => [item.id, item.fingerprint])),
      });
    }
    updateSnapshot({
      status: 'ready', listId: options.listId, chainIds: chains,
      loaded: total, total, error: null,
    });
    return Promise.resolve(cachedBundle.response);
  }

  // A failed scope is not hammered again merely because a tab remounted; an
  // explicit retry can still refresh it. This check deliberately comes after
  // the complete-bundle reuse paths above.
  if (!options.force && attemptedScopes.has(key)) return Promise.resolve(null);

  attemptedScopes.add(key);
  const capturedEpoch = cacheEpoch;
  const capturedGeneration = listGenerations.get(options.listId) ?? 0;
  // Only a cold process warm-up drives the logo banner. Incremental and other
  // refreshes retain the complete cached data and update quietly.
  const retainsCachedProjection = !!cachedBundle;
  updateSnapshot({
    status: retainsCachedProjection ? 'updating' : 'warming',
    listId: options.listId,
    chainIds: chains,
    loaded: retainsCachedProjection ? total : 0,
    total,
    error: null,
  });
  let flight!: Promise<ShoppingSessionResponse | null>;
  flight = (async () => {
    // Register the Promise before a deletion-only projection (which has no
    // network await) can reach finally; otherwise a resolved flight would be
    // inserted into warmFlights after its cleanup already ran.
    await Promise.resolve();
    try {
      let response: ShoppingSessionResponse;
      let responseIsDelta = false;

      if (hasDelta && changedItemIds.length === 0) {
        // Deletion-only edits can be reflected synchronously. The ordinary
        // local-first sync still runs, but no matcher request is necessary.
        void syncNow(['lists', 'list_items']).catch(() => {});
        response = {
          list_id: options.listId,
          matcher_version: cachedBundle.response.matcher_version,
          policies: { precise: [], practical: [], value: [] },
        };
        responseIsDelta = true;
      } else {
        // The matcher must observe the local additions/changes before the
        // filtered projection is requested.
        await syncNow(['lists', 'list_items']);
        // The API caps a filtered projection at 100 IDs to keep its URL below
        // common proxy limits. A larger edit is uncommon and safely becomes
        // one full projection instead of several racy partial replacements.
        const incrementalItemIds =
          hasDelta && changedItemIds.length <= MAX_INCREMENTAL_ITEM_IDS
            ? changedItemIds
            : undefined;
        try {
          response = await requestCombinedSession(
            options.listId,
            chains,
            incrementalItemIds
          );
          responseIsDelta = incrementalItemIds !== undefined;
        } catch (error) {
          if (!(error instanceof CombinedSessionEndpointUnavailable)) throw error;
          // The legacy endpoints cannot project a subset. Always treat their
          // result as a full replacement; merging it as a delta could retain
          // deleted lines or double-count aggregate values.
          response = await requestLegacySession(options.listId, chains);
          responseIsDelta = false;
        }
      }

      const isCurrent =
        cacheEpoch === capturedEpoch &&
        (listGenerations.get(options.listId) ?? 0) === capturedGeneration &&
        (
          latestScopeByList.get(options.listId) === key ||
          (
            startsColdFullProjection &&
            coldWarmByListChains.get(coldKey)?.leaderKey === key &&
            latestScopeByList.get(options.listId)?.startsWith(`${coldKey}|`) === true
          )
        );
      if (!isCurrent) return null;

      if (responseIsDelta && (!cachedBundle || !items)) {
        throw new Error('Een gedeeltelijke winkelsessie mist zijn basisgegevens');
      }
      const completeResponse = responseIsDelta
        ? mergeSessionDelta(
            cachedBundle!.response,
            response,
            chains,
            items!,
            new Set(changedItemIds)
          )
        : response;
      const loaded = replaceStoredSessionResponse(completeResponse);
      sessionByList.set(options.listId, {
        chains,
        items: items ? new Map(items.map((item) => [item.id, item.fingerprint])) : null,
        response: completeResponse,
      });
      warmedScopes.add(key);
      if (activeScopeKey === key) {
        updateSnapshot({
          status: 'ready', listId: options.listId, chainIds: chains,
          loaded, total, error: null,
        });
      }
      return completeResponse;
    } catch (error) {
      const isCurrent =
        cacheEpoch === capturedEpoch &&
        (listGenerations.get(options.listId) ?? 0) === capturedGeneration &&
        latestScopeByList.get(options.listId) === key;
      if (isCurrent && activeScopeKey === key) {
        updateSnapshot({
          status: 'error', listId: options.listId, chainIds: chains,
          loaded: cachedBundle ? total : 0,
          total,
          error: error instanceof Error ? error.message : 'Laden mislukt',
        });
      }
      return null;
    } finally {
      if (warmFlights.get(key) === flight) {
        warmFlights.delete(key);
        warmFlightMeta.delete(key);
      }
    }
  })();
  if (startsColdFullProjection) {
    const coordinator: ColdWarmCoordinator = {
      leaderKey: key,
      epoch: capturedEpoch,
      generation: capturedGeneration,
      queued: null,
      aliases: new Set([key]),
      // Replaced synchronously below, before the leader passes its initial
      // microtask yield and can inspect this coordinator.
      completion: Promise.resolve(null),
    };
    coordinator.completion = flight.then(async (response) => {
      const stillActive = coldWarmByListChains.get(coldKey) === coordinator;
      const generationIsCurrent =
        cacheEpoch === coordinator.epoch &&
        (listGenerations.get(options.listId) ?? 0) === coordinator.generation;
      if (!stillActive || !generationIsCurrent) return null;

      const queued = coordinator.queued;
      coldWarmByListChains.delete(coldKey);
      for (const alias of coordinator.aliases) {
        if (warmFlights.get(alias) === coordinator.completion) warmFlights.delete(alias);
        if (warmFlightMeta.get(alias)?.listId === options.listId) warmFlightMeta.delete(alias);
      }

      // The leader response has just become the complete base bundle. One
      // ordinary warm against the newest descriptors now becomes a filtered
      // delta (or a no-op if the list returned to the leader revision).
      if (queued) return warmShoppingSession(queued);
      return response;
    });
    coldWarmByListChains.set(coldKey, coordinator);
    warmFlights.set(key, coordinator.completion);
    warmFlightMeta.set(key, { listId: options.listId, chains });
    return coordinator.completion;
  }

  warmFlights.set(key, flight);
  warmFlightMeta.set(key, { listId: options.listId, chains });
  return flight;
}

function activeWarmFor(listId: string, chains: readonly string[]): Promise<ShoppingSessionResponse | null> | null {
  const needed = new Set(canonicalChains(chains));
  const latestKey = latestScopeByList.get(listId);
  const latestMeta = latestKey ? warmFlightMeta.get(latestKey) : null;
  if (latestKey && latestMeta && [...needed].every((chain) => latestMeta.chains.includes(chain))) {
    return warmFlights.get(latestKey) ?? null;
  }
  // When there is a latest scope but its request has completed, older flights
  // are stale by definition and must not delay a cache-first reader.
  if (latestKey) return null;
  for (const [key, meta] of warmFlightMeta) {
    if (meta.listId === listId && [...needed].every((chain) => meta.chains.includes(chain))) {
      return warmFlights.get(key) ?? null;
    }
  }
  return null;
}

/** Returns cached precise-policy pricing in the caller's chain order. */
export function getCachedPricing(
  listId: string,
  chains: readonly string[]
): ShoppingChainPricing[] | null {
  const byChain = pricingByList.get(listId);
  if (!byChain) return null;
  const ordered = chains
    .map((chain) => byChain.get(chain.trim().toLowerCase()))
    .filter(Boolean) as ShoppingChainPricing[];
  return ordered.length === chains.length ? ordered : null;
}

/** Joins an in-progress Boodschappen warm-up instead of issuing a second price request. */
export async function loadCachedPricing(
  listId: string,
  chains: readonly string[]
): Promise<ShoppingChainPricing[] | null> {
  const cached = getCachedPricing(listId, chains);
  if (cached) return cached;
  await activeWarmFor(listId, chains);
  return getCachedPricing(listId, chains);
}

export function getCachedPreview(
  listId: string,
  chain: string,
  policy: ShoppingMatchPolicy
): ShoppingSubstitutionPreview | null {
  return previewByKey.get(previewKey(listId, chain, policy)) ?? null;
}

/** Cache-first fallback for a preview requested before the warm phase finished. */
export function loadCachedPreview(
  listId: string,
  chain: string,
  policy: ShoppingMatchPolicy
): Promise<ShoppingSubstitutionPreview | null> {
  const normalizedChain = chain.trim().toLowerCase();
  const cached = getCachedPreview(listId, normalizedChain, policy);
  if (cached) return Promise.resolve(cached);
  const key = previewKey(listId, normalizedChain, policy);
  const existing = previewFlights.get(key);
  if (existing) return existing;
  const capturedEpoch = cacheEpoch;
  const capturedGeneration = listGenerations.get(listId) ?? 0;
  let flight!: Promise<ShoppingSubstitutionPreview | null>;
  flight = (async () => {
    // If the one combined request is still running, wait for it first. This is
    // the common path when the user opens Mijn lijstje immediately.
    await activeWarmFor(listId, [normalizedChain]);
    if (
      cacheEpoch !== capturedEpoch ||
      (listGenerations.get(listId) ?? 0) !== capturedGeneration
    ) return null;
    const afterWarm = getCachedPreview(listId, normalizedChain, policy);
    if (afterWarm) return afterWarm;
    return requestLegacyPreview(listId, normalizedChain, policy);
  })()
    .then((preview) => {
      const isCurrent =
        preview &&
        cacheEpoch === capturedEpoch &&
        (listGenerations.get(listId) ?? 0) === capturedGeneration;
      if (isCurrent) {
        previewByKey.set(key, preview);
        return preview;
      }
      return null;
    })
    .catch(() => null)
    .finally(() => {
      // invalidate/reset can remove this flight and start a new one with the
      // same key while the old HTTP call is still settling.
      if (previewFlights.get(key) === flight) previewFlights.delete(key);
    });
  previewFlights.set(key, flight);
  return flight;
}

export function invalidateShoppingSessionList(listId: string): void {
  listGenerations.set(listId, (listGenerations.get(listId) ?? 0) + 1);
  latestScopeByList.delete(listId);
  clearListSession(listId);
  // Promises cannot be cancelled, but removing their registrations lets a
  // fresh generation start immediately. Epoch/generation checks prevent the
  // detached responses from ever being stored.
  for (const [key, meta] of [...warmFlightMeta]) {
    if (meta.listId !== listId) continue;
    warmFlightMeta.delete(key);
    warmFlights.delete(key);
  }
  for (const key of [...previewFlights.keys()]) {
    if (key.startsWith(`${listId}|`)) previewFlights.delete(key);
  }
  for (const key of [...coldWarmByListChains.keys()]) {
    if (key.startsWith(`${listId}|`)) coldWarmByListChains.delete(key);
  }
  for (const key of [...warmedScopes]) if (key.startsWith(`${listId}|`)) warmedScopes.delete(key);
  for (const key of [...attemptedScopes]) if (key.startsWith(`${listId}|`)) attemptedScopes.delete(key);
  if (snapshot.listId === listId) {
    activeScopeKey = null;
    updateSnapshot(EMPTY_SNAPSHOT);
  }
}

export function resetShoppingSessionCache(): void {
  cacheEpoch += 1;
  activeScopeKey = null;
  warmedScopes.clear();
  attemptedScopes.clear();
  warmFlights.clear();
  warmFlightMeta.clear();
  pricingByList.clear();
  previewByKey.clear();
  previewFlights.clear();
  coldWarmByListChains.clear();
  latestScopeByList.clear();
  listGenerations.clear();
  sessionByList.clear();
  updateSnapshot(EMPTY_SNAPSHOT);
}

export function subscribeShoppingSessionCache(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getShoppingSessionCacheSnapshot(): ShoppingSessionCacheSnapshot {
  return snapshot;
}

export function useShoppingSessionCache(): ShoppingSessionCacheSnapshot {
  return useSyncExternalStore(
    subscribeShoppingSessionCache,
    getShoppingSessionCacheSnapshot,
    getShoppingSessionCacheSnapshot
  );
}

// A different signed-in identity must never observe the prior user's memory.
onIdentityChange(() => {
  resetShoppingSessionCache();
  resetImagePrefetch();
});
