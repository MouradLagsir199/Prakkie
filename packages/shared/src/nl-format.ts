/**
 * Dutch number/money formatting — comma decimals throughout (docs/04 §1):
 * "€ 47,80", "€ 1,85 p.p.", "€ 2,49 → € 1,87".
 */

export function formatEuroCents(cents: number): string {
  const negative = cents < 0;
  const abs = Math.abs(Math.round(cents));
  const euros = Math.floor(abs / 100);
  const rest = abs % 100;
  const eurosStr = euros.toLocaleString('nl-NL'); // 1.234 thousands separator
  return `${negative ? '-' : ''}€ ${eurosStr},${String(rest).padStart(2, '0')}`;
}

/** "€ 1,85 p.p." — the price-per-portion pill (mockups 01/02/05). */
export function formatPricePerPortion(cents: number): string {
  return `${formatEuroCents(cents)} p.p.`;
}

/** "25 min" / "1 u 10 min" — card + meta chips. */
export function formatMinutes(totalMin: number): string {
  if (totalMin < 60) return `${totalMin} min`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m === 0 ? `${h} u` : `${h} u ${m} min`;
}

/** Dutch day abbreviations for the planner (mockup 05). */
export const DAY_ABBREV_NL = ['MA', 'DI', 'WO', 'DO', 'VR', 'ZA', 'ZO'] as const;

/** Parse a Dutch decimal string ("1,5", "2.5", "½") to a number; null when not numeric. */
export function parseNlDecimal(input: string): number | null {
  const s = input.trim();
  const vulgar: Record<string, number> = { '½': 0.5, '¼': 0.25, '¾': 0.75, '⅓': 1 / 3, '⅔': 2 / 3 };
  if (s in vulgar) return vulgar[s] ?? null;
  const m = s.match(/^(\d+)\s*(½|¼|¾)$/);
  if (m && m[1] && m[2]) return Number(m[1]) + (vulgar[m[2]] ?? 0);
  const normalised = s.replace(',', '.');
  const n = Number(normalised);
  return Number.isFinite(n) ? n : null;
}

/** Format a quantity for display: 1.5 → "1,5"; 2 → "2". */
export function formatQuantity(q: number): string {
  const rounded = Math.round(q * 100) / 100;
  return rounded.toLocaleString('nl-NL', { maximumFractionDigits: 2 });
}
