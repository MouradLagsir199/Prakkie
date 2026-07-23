import { useEffect, useState } from 'react';
import { authedRequest } from './api';

/**
 * Matching v2 (docs/09 Fase 5): het directe cross-supermarkt totaal van de
 * server (`/v1/lists/{id}/basket-plan`). Read-only; naast de bestaande
 * handmatige samenstelling. Vult zich naarmate de facet/graph-backfill vordert.
 */

export type LineDecision = 'exact' | 'equivalent' | 'compromise' | 'no_match';

export interface BasketPlanLine {
  item_id: string;
  name: string;
  decision_by_chain: Record<string, LineDecision>;
  price_by_chain: Record<string, number | null>;
  reason_by_chain: Record<string, string>;
}
export interface ChainTotal {
  chain_id: string;
  total_cents: number;
  matched: number;
  missing: number;
  complete: boolean;
}
export interface BasketOptimizer {
  cheapest_single: { chain_id: string; total_cents: number; missing: number } | null;
  split: { total_cents: number; by_chain: Record<string, number>; assignments: Record<string, string>; missing: number } | null;
  savings_vs_single_cents: number;
}
export interface BasketPlan {
  list_id: string;
  chains: string[];
  lines: BasketPlanLine[];
  chain_totals: ChainTotal[];
  optimizer: BasketOptimizer;
  matcher_version: string;
}

/** Heeft dit plan iets zinnigs om te tonen (minstens één gematchte regel)? */
export function planHasMatches(plan: BasketPlan | null): boolean {
  return !!plan && plan.chain_totals.some((c) => c.matched > 0);
}

export function useBasketPlan(listId: string | null, chains: readonly string[]): {
  plan: BasketPlan | null; loading: boolean; error: boolean;
} {
  const [plan, setPlan] = useState<BasketPlan | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const chainKey = [...chains].sort().join(',');

  useEffect(() => {
    if (!listId || chains.length === 0) { setPlan(null); return; }
    let live = true;
    setLoading(true);
    setError(false);
    authedRequest(`/v1/lists/${listId}/basket-plan?chains=${encodeURIComponent(chainKey)}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`basket-plan ${res.status}`);
        return (await res.json()) as BasketPlan;
      })
      .then((p) => { if (live) setPlan(p); })
      .catch(() => { if (live) { setError(true); setPlan(null); } })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [listId, chainKey]);

  return { plan, loading, error };
}
