import type { MatchCandidate } from './match';

export const MATCHER_VERSION = 'policy-v2-ean';

export const MATCH_POLICIES = ['precise', 'practical', 'value'] as const;
export type MatchPolicy = (typeof MATCH_POLICIES)[number];
export type MatchDecision = 'accepted' | 'review' | 'unavailable';

export interface MatchAnchor {
  chain_id: string;
  sku_id: string;
  /** Display name is optional because older callers only hydrate identity data. */
  name?: string | null;
  ean: string | null;
  brand: string | null;
  pack_size_value: number | null;
  pack_size_unit: string | null;
  /** Prijsvelden zijn optioneel gehydrateerd: zonder expliciete pack-size wordt
   * de inhoud afgeleid uit prijs ÷ eenheidsprijs (exact — zo is die berekend). */
  price_cents?: number | string | null;
  unit_price_cents_per_std?: number | string | null;
  std_unit?: string | null;
  canonical_name: string | null;
  canonical_key: string | null;
  head_term: string | null;
  intent_form: string | null;
  intent_aisle: number | null;
  is_base?: boolean | null;
  is_organic: boolean | null;
}

export interface CalibrationRule {
  policy: MatchPolicy;
  source: MatchCandidate['source'];
  min_score: number;
  measured_precision: number | null;
  sample_size: number;
}

export interface CandidateAssessment {
  decision: Exclude<MatchDecision, 'unavailable'>;
  reliability: number;
  reasons: string[];
  hard_compatible: boolean;
}

// Drempels gelden alléén voor ingrediënt→product-suggesties (geen anker);
// product→product is EAN-of-niets en heeft geen drempel nodig.
const FALLBACK_THRESHOLDS: Record<MatchPolicy, Record<CalibrationRule['source'], number>> = {
  precise: { correction: 0.98, lexicon: 0.92, trgm: 0.88, semantic: 0.90, ean: 0.98 },
  practical: { correction: 0.95, lexicon: 0.84, trgm: 0.78, semantic: 0.82, ean: 0.98 },
  value: { correction: 0.95, lexicon: 0.78, trgm: 0.70, semantic: 0.76, ean: 0.98 },
};

function thresholdFor(
  policy: MatchPolicy,
  source: CalibrationRule['source'],
  rules: CalibrationRule[]
): number {
  return rules.find((rule) => rule.policy === policy && rule.source === source)?.min_score
    ?? FALLBACK_THRESHOLDS[policy][source];
}

const normaliseGtin = (value: string | null | undefined) => value?.trim().replace(/^0+/, '') || null;

/**
 * Decide whether a retrieved candidate is safe to apply automatically.
 *
 * EAN-only (owner 2026-07-14): zodra er een anker-product is — de user heeft
 * ergens een concreet artikel gekozen — bestaat "hetzelfde product bij een
 * andere keten" alléén als exact dezelfde EAN/GTIN. Naam-, foto- en
 * AI-intent-gelijkenis mogen nooit meer automatisch vervangen; alles zonder
 * EAN-match is een handmatige keuze in de picker. Zónder anker is er geen
 * productidentiteit om aan te houden en beslist de kalibratie-drempel over de
 * ingrediënt-suggestie per bron.
 */
export function assessCandidate(
  candidate: MatchCandidate,
  anchor: MatchAnchor | null,
  policy: MatchPolicy,
  calibration: CalibrationRule[] = []
): CandidateAssessment {
  if (candidate.source === 'correction') {
    return { decision: 'accepted', reliability: 0.995, reasons: ['eerder door jou gekozen'], hard_compatible: true };
  }

  const candidateEan = normaliseGtin(candidate.ean);
  const anchorEan = normaliseGtin(anchor?.ean);
  if (candidateEan && anchorEan && candidateEan === anchorEan) {
    return { decision: 'accepted', reliability: 0.999, reasons: ['exact dezelfde EAN/GTIN'], hard_compatible: true };
  }

  if (anchor) {
    // Verschillende GTIN's zijn normaal voor huismerken: gelijkheid bewijst
    // hetzelfde artikel, ongelijkheid bewijst niet dat het onbruikbaar is —
    // maar automatisch vervangen doen we dan dus niet.
    const reasons = candidateEan && anchorEan
      ? ['ander merkartikel (andere EAN)']
      : anchorEan
        ? ['geen EAN bekend voor dit product']
        : ['gekozen product heeft geen EAN'];
    return {
      decision: 'review',
      reliability: Math.min(Number(candidate.confidence) || 0, 0.49),
      reasons,
      hard_compatible: false,
    };
  }

  if (candidate.is_primary === false) {
    return {
      decision: 'review',
      reliability: Math.min(Number(candidate.confidence) || 0, 0.49),
      reasons: ['samengesteld product'],
      hard_compatible: false,
    };
  }

  const reliability = Math.min(0.995, Number(candidate.confidence) || 0);
  const accepted = reliability >= thresholdFor(policy, candidate.source, calibration);
  return {
    decision: accepted ? 'accepted' : 'review',
    reliability,
    reasons: ['tekstuele overeenkomst'],
    hard_compatible: true,
  };
}

export function policyLabel(policy: MatchPolicy): string {
  return policy === 'precise' ? 'Nauwkeurig' : policy === 'practical' ? 'Praktisch' : 'Voordelig';
}
