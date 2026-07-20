export type BasePackUnit = 'g' | 'ml' | 'st';

export interface PackQuantity {
  value: number;
  unit: BasePackUnit;
}

export interface ParsedPackQuery {
  /** Search text with one recognised package amount removed. */
  text: string;
  quantity: PackQuantity | null;
}

const PACK_TOKEN = /(^|[^\p{L}\p{N}])(?:(\d+)\s*[x×]\s*)?(\d+(?:[.,]\d+)?)\s*(kg|kilogram|kilo|g|gr|gram|ml|milliliter|cl|dl|l|liter|litre|stuks?|st)(?=$|[^\p{L}\p{N}])/giu;

function toBasePack(multiplier: number, amount: number, rawUnit: string): PackQuantity | null {
  if (!Number.isFinite(multiplier) || !Number.isFinite(amount) || multiplier <= 0 || amount <= 0) return null;
  const unit = rawUnit.toLocaleLowerCase('nl-NL');
  if (['kg', 'kilogram', 'kilo'].includes(unit)) return { value: multiplier * amount * 1000, unit: 'g' };
  if (['g', 'gr', 'gram'].includes(unit)) return { value: multiplier * amount, unit: 'g' };
  if (unit === 'l' || unit === 'liter' || unit === 'litre') return { value: multiplier * amount * 1000, unit: 'ml' };
  if (unit === 'dl') return { value: multiplier * amount * 100, unit: 'ml' };
  if (unit === 'cl') return { value: multiplier * amount * 10, unit: 'ml' };
  if (unit === 'ml' || unit === 'milliliter') return { value: multiplier * amount, unit: 'ml' };
  if (['st', 'stuk', 'stuks'].includes(unit)) return { value: multiplier * amount, unit: 'st' };
  return null;
}

/**
 * Understands compact and spaced Dutch package queries: `500g`, `300 gr`,
 * `1L`, `1,5 kg`, `6 x 200 ml`. Only a token carrying a unit is interpreted,
 * so product names/numbers such as `7UP` or `1010` remain normal text.
 */
export function parsePackQuantityQuery(raw: string | null | undefined): ParsedPackQuery {
  const source = raw?.trim() ?? '';
  if (!source) return { text: '', quantity: null };
  const matches = [...source.matchAll(PACK_TOKEN)];
  const match = matches.at(-1);
  if (!match || match.index == null) return { text: source, quantity: null };
  const multiplier = match[2] ? Number(match[2]) : 1;
  const amount = Number(match[3]!.replace(',', '.'));
  const quantity = toBasePack(multiplier, amount, match[4]!);
  if (!quantity) return { text: source, quantity: null };

  // Group 1 is the preceding separator/boundary. Keep it, remove only the
  // amount token, then clean dangling punctuation/whitespace for text search.
  const tokenStart = match.index + (match[1]?.length ?? 0);
  const tokenEnd = match.index + match[0].length;
  const text = `${source.slice(0, tokenStart)} ${source.slice(tokenEnd)}`
    .replace(/^[\s,;:·-]+|[\s,;:·-]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return { text, quantity };
}

export function normaliseProductPack(
  value: number | string | null | undefined,
  unit: string | null | undefined
): PackQuantity | null {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0 || !unit) return null;
  return toBasePack(1, amount, unit);
}

/** Product-title amount wins because retailer titles often correct sparse metadata. */
export function productPackQuantity(product: {
  name?: string | null;
  pack_size_value?: number | string | null;
  pack_size_unit?: string | null;
}): PackQuantity | null {
  const named = parsePackQuantityQuery(product.name).quantity;
  return named ?? normaliseProductPack(product.pack_size_value, product.pack_size_unit);
}

export function matchesPackQuantity(
  product: {
    name?: string | null;
    pack_size_value?: number | string | null;
    pack_size_unit?: string | null;
  },
  wanted: PackQuantity | null | undefined
): boolean {
  if (!wanted) return true;
  const actual = productPackQuantity(product);
  return !!actual && actual.unit === wanted.unit && Math.abs(actual.value - wanted.value) < 0.001;
}
