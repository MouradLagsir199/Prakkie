/**
 * ChainConnector (plan/05 WS2) — one interface, eleven chains.
 *
 * Fetching is done by the owner's proven Python scrapers (scrapers/*.py): they
 * reverse-engineer each chain's API/anti-bot and emit a shared bronze envelope
 * per product to JSONL. A connector's job here is the silver step: parse one
 * bronze envelope into the normalised product row for catalog.products.
 * The shared pipeline (lib/ingest.ts) owns hashing, delta upserts,
 * price history, availability sweep and staleness bookkeeping — written once.
 */

export interface BronzeEnvelope {
  store: string;
  scraped_at: string;
  external_id: string;
  raw: Record<string, unknown>;
}

export interface PromoInfo {
  type: string; // 'bonus' | 'discount' | chain-specific mechanic id
  price_cents?: number;
  mechanic?: string; // "2 voor € 3,50", "25% korting", "2e halve prijs"
  valid_from?: string;
  valid_to?: string;
}

export interface NormalizedProduct {
  skuId: string;
  ean?: string | null;
  name: string;
  brand?: string | null;
  packSizeValue?: number | null;
  packSizeUnit?: string | null; // g | kg | ml | l | stuks
  priceCents: number;
  unitPriceCentsPerStd?: number | null;
  stdUnit?: string | null; // kg | l | stuks
  promo?: PromoInfo | null;
  categoryPath: string[];
  imageUrl?: string | null;
  productUrl?: string | null;
  available: boolean;
}

export interface ChainCapabilities {
  promos: boolean;
  eans: boolean;
  deepLinks: boolean; // cart handoff / product_url
  fullAssortment: boolean;
}

export interface ChainConnector {
  /** primary chain id (catalog.chains.id); detailresult serves dirk + dekamarkt */
  chainId: string;
  capabilities: ChainCapabilities;
  /** silver parse of one bronze envelope; null = skip row (unparseable/not a product) */
  parse(envelope: BronzeEnvelope): NormalizedProduct | null;
}

/** "1,5 kg" | "500 g" | "6 x 250 ml" | "per stuk" → value + unit in g/kg/ml/l/stuks */
export function parsePackSize(text: string | null | undefined): {
  value: number | null;
  unit: string | null;
} {
  if (!text) return { value: null, unit: null };
  const t = text.toLowerCase().replace(',', '.').trim();
  // multipacks: "6 x 250 ml" → 1500 ml
  const multi = t.match(/(\d+(?:\.\d+)?)\s*x\s*(\d+(?:\.\d+)?)\s*(kg|g|gr|gram|ml|cl|l|liter|stuks?|st)\b/);
  if (multi) {
    const value = parseFloat(multi[1]!) * parseFloat(multi[2]!);
    return normaliseUnit(value, multi[3]!);
  }
  const single = t.match(/(\d+(?:\.\d+)?)\s*(kg|g|gr|gram|ml|cl|l|liter|stuks?|st)\b/);
  if (single) return normaliseUnit(parseFloat(single[1]!), single[2]!);
  if (/\bper\s+stuk\b|\bstuk\b/.test(t)) return { value: 1, unit: 'stuks' };
  return { value: null, unit: null };
}

function normaliseUnit(value: number, unit: string): { value: number; unit: string } {
  switch (unit) {
    case 'gr':
    case 'gram':
      return { value, unit: 'g' };
    case 'cl':
      return { value: value * 10, unit: 'ml' };
    case 'liter':
      return { value, unit: 'l' };
    case 'st':
    case 'stuk':
    case 'stuks':
      return { value, unit: 'stuks' };
    default:
      return { value, unit };
  }
}

export function euroToCents(euro: number | string | null | undefined): number | null {
  if (euro === null || euro === undefined || euro === '') return null;
  const n = typeof euro === 'string' ? parseFloat(euro.replace(',', '.')) : euro;
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

/** Calculate the comparable price per kg/l/item from an already parsed pack. */
export function unitPriceFromPack(
  priceCents: number,
  value: number | null,
  unit: string | null
): { cents: number | null; unit: string | null } {
  if (!value || value <= 0 || !unit || priceCents <= 0) return { cents: null, unit: null };
  if (unit === 'g') return { cents: Math.round((priceCents * 1000) / value), unit: 'kg' };
  if (unit === 'kg') return { cents: Math.round(priceCents / value), unit: 'kg' };
  if (unit === 'ml') return { cents: Math.round((priceCents * 1000) / value), unit: 'l' };
  if (unit === 'l') return { cents: Math.round(priceCents / value), unit: 'l' };
  if (unit === 'stuks') return { cents: Math.round(priceCents / value), unit: 'stuks' };
  return { cents: null, unit: null };
}
