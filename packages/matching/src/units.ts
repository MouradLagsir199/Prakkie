/**
 * E1 unit normalisation — Dutch kitchen units to canonical base units.
 * "2 el olijfolie" → { qty: 2, unit: 'el' } → ~30 ml (spec §E1).
 */

export type BaseUnit = 'g' | 'ml' | 'st';

export interface CanonicalQuantity {
  value: number;
  unit: BaseUnit;
  /** True when the conversion is approximate (spoon/cup measures). */
  approximate: boolean;
}

interface UnitDef {
  aliases: string[];
  base: BaseUnit;
  factor: number;
  approximate?: boolean;
}

const UNIT_DEFS: UnitDef[] = [
  { aliases: ['g', 'gr', 'gram'], base: 'g', factor: 1 },
  { aliases: ['kg', 'kilo', 'kilogram'], base: 'g', factor: 1000 },
  { aliases: ['ml', 'milliliter'], base: 'ml', factor: 1 },
  { aliases: ['cl'], base: 'ml', factor: 10 },
  { aliases: ['dl'], base: 'ml', factor: 100 },
  { aliases: ['l', 'liter'], base: 'ml', factor: 1000 },
  { aliases: ['el', 'eetlepel', 'eetlepels', 'tbsp'], base: 'ml', factor: 15, approximate: true },
  { aliases: ['tl', 'theelepel', 'theelepels', 'tsp'], base: 'ml', factor: 5, approximate: true },
  { aliases: ['kop', 'kopje', 'cup'], base: 'ml', factor: 250, approximate: true },
  { aliases: ['snufje', 'snuf', 'mespunt', 'mespuntje'], base: 'g', factor: 0.5, approximate: true },
  { aliases: ['st', 'stuk', 'stuks', 'stukjes', 'teen', 'tenen', 'teentje', 'teentjes', 'blaadje', 'blaadjes', 'takje', 'takjes', 'bosje', 'bos', 'blik', 'blikje', 'pot', 'potje', 'zakje', 'plak', 'plakjes'], base: 'st', factor: 1 },
];

const ALIAS_MAP: Map<string, UnitDef> = new Map();
for (const def of UNIT_DEFS) for (const a of def.aliases) ALIAS_MAP.set(a, def);

/** Normalise a raw unit token; null when unknown. */
export function normaliseUnit(rawUnit: string, quantity: number): CanonicalQuantity | null {
  const def = ALIAS_MAP.get(rawUnit.trim().toLowerCase());
  if (!def) return null;
  return { value: quantity * def.factor, unit: def.base, approximate: def.approximate ?? false };
}

export function isKnownUnit(rawUnit: string): boolean {
  return ALIAS_MAP.has(rawUnit.trim().toLowerCase());
}
