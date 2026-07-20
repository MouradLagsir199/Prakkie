import {
  matchesPackQuantity,
  parsePackQuantityQuery,
  type StorePanelSort,
} from '@prakkie/shared';
import type { CrossChainOption } from '../components/prakkie/ProductOptions';
import { authedRequest, onIdentityChange } from './api';

export interface StoreCatalogProduct extends CrossChainOption {
  rank: number;
  head_term?: string | null;
  is_base?: boolean;
  category_slug?: string | null;
  department_name?: string | null;
  department_slug?: string | null;
}

export interface StoreCatalogSearchResult {
  products: StoreCatalogProduct[];
  total: number;
  offset: number;
  has_more: boolean;
  search_coverage: 'none' | 'partial' | 'exact' | 'fuzzy';
}

type CatalogStatus = 'idle' | 'warming' | 'ready' | 'error';

let catalogStatus: CatalogStatus = 'idle';
let catalogChainsKey = '';
let catalogProducts: StoreCatalogProduct[] = [];
let catalogFlight: Promise<StoreCatalogProduct[] | null> | null = null;

const fold = (value: string | null | undefined) =>
  (value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

function canonicalChains(chains: readonly string[]): string[] {
  return [...new Set(chains.map((chain) => chain.trim().toLowerCase()).filter(Boolean))].sort();
}

function chainsKey(chains: readonly string[]): string {
  return canonicalChains(chains).join(',');
}

export function resetStoreCatalogCache(): void {
  catalogStatus = 'idle';
  catalogChainsKey = '';
  catalogProducts = [];
  catalogFlight = null;
}

onIdentityChange(() => resetStoreCatalogCache());

export function getStoreCatalogStatus(chains: readonly string[]): CatalogStatus {
  return catalogChainsKey === chainsKey(chains) ? catalogStatus : 'idle';
}

export function preloadStoreCatalog(chains: readonly string[], force = false): Promise<StoreCatalogProduct[] | null> {
  const key = chainsKey(chains);
  if (!key) return Promise.resolve(null);
  if (!force && catalogStatus === 'ready' && catalogChainsKey === key) return Promise.resolve(catalogProducts);
  if (!force && catalogFlight && catalogChainsKey === key) return catalogFlight;

  catalogStatus = 'warming';
  catalogChainsKey = key;
  const path = `/v1/store/catalog-snapshot?chains=${encodeURIComponent(key)}`;
  catalogFlight = authedRequest(path)
    .then(async (res) => {
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as {
        compact?: boolean;
        products?: StoreCatalogProduct[] | unknown[][];
      };
      const rawProducts = body.products ?? [];
      const products = rawProducts.map((product, index) => {
        if (Array.isArray(product)) {
          return {
            chain: String(product[0] ?? ''),
            sku_id: String(product[1] ?? ''),
            name: String(product[2] ?? ''),
            brand: product[3] == null ? null : String(product[3]),
            price_cents: Number(product[4] ?? 0),
            promo_price_cents: product[5] == null ? null : Number(product[5]),
            pack_size_value: product[6] == null ? null : Number(product[6]),
            pack_size_unit: product[7] == null ? null : String(product[7]),
            unit_price_cents_per_std: product[8] == null ? null : Number(product[8]),
            std_unit: product[9] == null ? null : String(product[9]),
            image_url: product[10] == null ? null : String(product[10]),
            promo: product[11] as StoreCatalogProduct['promo'],
            head_term: product[12] == null ? null : String(product[12]),
            is_base: Boolean(product[13]),
            category_name: product[14] == null ? null : String(product[14]),
            department_slug: product[15] == null ? null : String(product[15]),
            rank: index,
          } satisfies StoreCatalogProduct;
        }
        return { ...(product as StoreCatalogProduct), rank: index };
      });
      if (catalogChainsKey === key) {
        catalogProducts = products;
        catalogStatus = 'ready';
      }
      return products;
    })
    .catch(() => {
      if (catalogChainsKey === key) catalogStatus = 'error';
      return null;
    })
    .finally(() => {
      if (catalogChainsKey === key) catalogFlight = null;
    });
  return catalogFlight;
}

function documentOf(product: StoreCatalogProduct): string {
  return [
    product.name,
    product.brand,
    product.head_term,
    product.category_name,
    product.department_name,
  ].map(fold).filter(Boolean).join(' ');
}

function sortProducts(products: StoreCatalogProduct[], sort: StorePanelSort | undefined): StoreCatalogProduct[] {
  const price = (p: StoreCatalogProduct) => p.promo_price_cents ?? p.price_cents;
  if (sort === 'prijs') return [...products].sort((a, b) => price(a) - price(b) || a.rank - b.rank);
  if (sort === 'eenheidsprijs') {
    return [...products].sort((a, b) =>
      (a.unit_price_cents_per_std ?? Number.MAX_SAFE_INTEGER) -
        (b.unit_price_cents_per_std ?? Number.MAX_SAFE_INTEGER) ||
      price(a) - price(b) ||
      a.rank - b.rank
    );
  }
  if (sort === 'bonus') {
    return [...products].sort((a, b) =>
      Number((b.promo_price_cents ?? b.price_cents) < b.price_cents) -
        Number((a.promo_price_cents ?? a.price_cents) < a.price_cents) ||
      price(a) - price(b) ||
      a.rank - b.rank
    );
  }
  return [...products].sort((a, b) =>
    Number(b.is_base) - Number(a.is_base) ||
    price(a) - price(b) ||
    a.rank - b.rank
  );
}

export function searchStoreCatalogCache(
  q: string,
  chains: readonly string[],
  opts: { offset?: number; limit?: number; sort?: StorePanelSort } = {}
): StoreCatalogSearchResult | null {
  if (getStoreCatalogStatus(chains) !== 'ready') return null;
  const parsed = parsePackQuantityQuery(q);
  const query = fold(parsed.text);
  const tokens = query.split(/\s+/).filter(Boolean);
  const offset = Math.max(0, opts.offset ?? 0);
  const limit = Math.max(1, opts.limit ?? 60);
  if (!tokens.length && !parsed.quantity) {
    return { products: [], total: 0, offset, has_more: false, search_coverage: 'none' };
  }

  const rows = catalogProducts
    .filter((product) => matchesPackQuantity(product, parsed.quantity))
    .map((product) => {
      const doc = documentOf(product);
      const name = fold(product.name);
      const head = fold(product.head_term);
      const category = fold(product.category_name);
      const matched = tokens.filter((token) =>
        doc.split(/\s+/).some((word) => word.startsWith(token))
      ).length;
      const all = tokens.length === 0 || matched === tokens.length;
      const compactQuery = tokens.join('');
      const compactName = name.replace(/\s+/g, '');
      const compactHead = head.replace(/\s+/g, '');
      const compact = !!compactQuery && (compactName.includes(compactQuery) || compactHead.includes(compactQuery));
      if (!all && !compact) return null;
      const nameWords = name.split(/\s+/).filter(Boolean);
      const startsName = tokens.some((token) => nameWords.some((word) => word.startsWith(token)));
      const score =
        (head === query ? 60 : 0) +
        (category === query ? 55 : 0) +
        (head.startsWith(query) ? 35 : 0) +
        (category.startsWith(query) ? 30 : 0) +
        (tokens[0] && nameWords[0]?.startsWith(tokens[0]) ? 20 : 0) +
        (product.is_base ? 8 : 0) +
        matched;
      return { product, matched, all, startsName, score };
    })
    .filter(Boolean) as Array<{
      product: StoreCatalogProduct;
      matched: number;
      all: boolean;
      startsName: boolean;
      score: number;
    }>;

  if (!rows.length) {
    return { products: [], total: 0, offset, has_more: false, search_coverage: 'none' };
  }
  const bestMatched = Math.max(...rows.map((row) => row.matched));
  const filtered = rows.filter((row) => row.matched === bestMatched || row.all);
  const scoreByKey = new Map(filtered.map((row) => [`${row.product.chain}:${row.product.sku_id}`, row]));
  const sorted = sortProducts(filtered.map((row) => row.product), opts.sort)
    .sort((a, b) => {
      const ra = scoreByKey.get(`${a.chain}:${a.sku_id}`)!;
      const rb = scoreByKey.get(`${b.chain}:${b.sku_id}`)!;
      return Number(rb.all) - Number(ra.all) ||
        rb.score - ra.score ||
        Number(rb.startsName) - Number(ra.startsName);
    });
  const page = sorted.slice(offset, offset + limit);
  return {
    products: page,
    total: sorted.length,
    offset,
    has_more: offset + page.length < sorted.length,
    search_coverage: bestMatched >= tokens.length ? 'exact' : 'partial',
  };
}
