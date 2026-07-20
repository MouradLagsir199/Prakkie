import { CHAINS, type ChainId } from '@prakkie/shared';

/** Chain branding for avatars/chips (mockup 07) + week date helpers. */

export const CHAIN_BRAND: Record<string, { bg: string; fg: string }> = {
  ah: { bg: '#00A0E2', fg: '#FFFFFF' },
  jumbo: { bg: '#F5C400', fg: '#3A2E10' },
  plus: { bg: '#79B93C', fg: '#FFFFFF' },
  dirk: { bg: '#E30613', fg: '#FFFFFF' },
  dekamarkt: { bg: '#F39200', fg: '#FFFFFF' },
  aldi: { bg: '#00005F', fg: '#FFFFFF' },
  vomar: { bg: '#E2001A', fg: '#FFFFFF' },
  hoogvliet: { bg: '#003DA5', fg: '#FFFFFF' },
  spar: { bg: '#006633', fg: '#FFFFFF' },
  picnic: { bg: '#E01A22', fg: '#FFFFFF' },
  ekoplaza: { bg: '#4C8B2B', fg: '#FFFFFF' },
};

export const chainChip = (id: string) => (CHAINS as Record<string, { chip?: string }>)[id]?.chip ?? id.slice(0, 2).toUpperCase();
export const chainName = (id: string) =>
  (CHAINS as Record<string, { displayName?: string }>)[id as ChainId]?.displayName ?? id.toUpperCase();

/** Monday (ISO) of the week `offset` weeks from now, as yyyy-mm-dd. */
export function mondayOf(offsetWeeks: number): string {
  const d = new Date();
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7) + offsetWeeks * 7);
  return d.toISOString().slice(0, 10);
}

/** Monday (ISO) of the week that contains `iso`, as yyyy-mm-dd. */
export function mondayOfDate(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

/** Hele weken tussen twee maandagen (b − a), voor week-offset navigatie. */
export function weeksBetween(mondayA: string, mondayB: string): number {
  return Math.round((new Date(`${mondayB}T12:00:00Z`).getTime() - new Date(`${mondayA}T12:00:00Z`).getTime()) / (7 * 864e5));
}

export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function isoWeekNumber(iso: string): number {
  const d = new Date(`${iso}T12:00:00Z`);
  const jan4 = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week1Monday = new Date(jan4);
  week1Monday.setUTCDate(jan4.getUTCDate() - ((jan4.getUTCDay() + 6) % 7));
  return Math.round((d.getTime() - week1Monday.getTime()) / (7 * 864e5)) + 1;
}

const MONTHS_NL = ['januari','februari','maart','april','mei','juni','juli','augustus','september','oktober','november','december'];

/** "6 – 12 juli" for a week starting at `monday` (mockup 05 subtitle). */
export function weekRangeLabel(monday: string): string {
  const start = new Date(`${monday}T12:00:00Z`);
  const end = new Date(start);
  end.setUTCDate(start.getUTCDate() + 6);
  const sM = MONTHS_NL[start.getUTCMonth()]!;
  const eM = MONTHS_NL[end.getUTCMonth()]!;
  return sM === eM
    ? `${start.getUTCDate()} – ${end.getUTCDate()} ${eM}`
    : `${start.getUTCDate()} ${sM} – ${end.getUTCDate()} ${eM}`;
}
