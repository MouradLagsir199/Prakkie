import type { PoolClient } from 'pg';
import { query } from './db';

/**
 * E3 matcher (plan/05 WS2): ingredient → SKU per chain, cascade
 *   user correction (E5) → lexicon hint → pg_trgm fuzzy over catalog.products
 * with confidence + shortlist fallback. pgvector semantic sits behind the same
 * seam once embeddings exist (owner input #6); absent embeddings it degrades
 * to the fuzzy tier. One round-trip matches one item across all chains.
 */

export interface MatchCandidate {
  chain_id: string;
  sku_id: string;
  name: string;
  brand: string | null;
  price_cents: number;
  promo_price_cents: number | null;
  promo: unknown;
  unit_price_cents_per_std: number | null;
  std_unit: string | null;
  pack_size_value: number | null;
  pack_size_unit: string | null;
  image_url: string | null;
  product_url: string | null;
  aisle_group_id: number | null;
  confidence: number;
  source: 'correction' | 'lexicon' | 'trgm' | 'image';
}

export interface ChainMatch {
  best: MatchCandidate | null;
  /** shown when best.confidence < SHORTLIST_THRESHOLD (match-fix UX, E5) */
  shortlist: MatchCandidate[];
}

export const SHORTLIST_THRESHOLD = 0.72;
// owner UX 2026-07-06/07: the user always picks the product — every item gets a
// full dropdown, so the shortlist is broad (roombotercroissant must show up
// under "roomboter") and always returned, not only when the matcher doubts.
// 24 per chain: liever te veel opties met lagere confidence dan te weinig.
const SHORTLIST_SIZE = 24;

type Queryable = Pick<PoolClient, 'query'>;

/**
 * Resolve an ingredient term through the lexicon (aliases → canonical item),
 * returning the search term + default aisle for list placement.
 */
export async function resolveLexicon(
  item: string,
  client?: Queryable
): Promise<{ term: string; aisleGroupId: number | null; aliases: string[] }> {
  const q = client ?? { query };
  const r = await q.query(
    `SELECT item_normalised, aisle_group_id, aliases FROM catalog.ingredient_lexicon
     WHERE item_normalised = $1 OR $1 = ANY(aliases) LIMIT 1`,
    [item]
  );
  if (r.rows[0]) {
    const term = String(r.rows[0].item_normalised);
    const aliases = [...new Set([item, term, ...((r.rows[0].aliases as string[]) ?? [])])];
    return { term, aisleGroupId: r.rows[0].aisle_group_id ?? null, aliases };
  }
  return { term: item, aisleGroupId: null, aliases: [item] };
}

// composite/processed product words: penalised when absent from the query itself
const PROCESSED_RX = '\\m(saus|soep|salade|mix|kruidenmix|poeder|drink|snack|chips|koek|koekje|koekjes|biscuit|biscuits|croissant|croissants|sprits|spritsen|smaak|geur|shampoo|spray|kattenvoer|hondenvoer|schotel|dagschotel|maaltijd)\\M';

// form words (conserven/bewerkingen): who "sperziebonen" zoekt wil vrijwel nooit
// "in blik gebroken". Alleen toegepast op vers-producten (aisle-groep 1) — bij
// kikkererwten/doperwten is blik/pot juist dé normale vorm. Bewust NIET in de
// lijst: diepvries, gesneden, gewassen, geraspt, gekookt (gekookte bietjes is
// de normale vorm), gezouten. Query "sperziebonen blik" krijgt géén penalty.
const FORM_RX = '\\m(blik|blikje|blikjes|pot|potje|gebroken|gedroogd|gedroogde|ingelegd|ingelegde|zoetzuur|zoetzure|tafelzuur)\\M';

const CANDIDATE_SQL = `
WITH terms AS (SELECT DISTINCT unnest($1::text[]) AS q),
corrections AS (
  SELECT mc.chain_id, mc.chosen_sku_id
  FROM app.match_corrections mc
  WHERE mc.user_id = $4 AND mc.item_normalised = ANY($1 || $5)
),
hints AS (
  SELECT lp.chain_id, lp.sku_id, lp.rank
  FROM catalog.lexicon_products lp
  WHERE lp.item_normalised = ANY($1)
),
fuzzy AS (
  -- score shape per (query term, product): trgm similarity + whole-word boost
  -- + COVERAGE (how much of the product name the query explains — "uien" is
  -- all about "ui", "gehakt met ui" is not) + canonical-name equality against
  -- the full alias set ($6) + processed-product penalty. Cheap-first price is
  -- the final tiebreak so raw produce beats processed products at equal score.
  SELECT chain_id, sku_id, MAX(score) AS score, MIN(price_cents) AS price_cents FROM (
    SELECT p.chain_id, p.sku_id, p.price_cents,
           GREATEST(word_similarity(t.q, p.name), similarity(p.name, t.q))
           + CASE WHEN public.fold_text(p.name) ~ ('\\m' || t.q || '\\M') THEN 0.18 ELSE 0 END
           + CASE WHEN public.fold_text(p.name) = t.q THEN 0.35
                  WHEN public.fold_text(p.name) LIKE t.q || '%' THEN 0.12
                  ELSE 0 END
           + 0.45 * length(t.q)::float / GREATEST(length(p.name), length(t.q))
           + CASE WHEN public.fold_text(nc.display_name) = ANY($6) THEN 0.60
                  WHEN nc.display_name IS NOT NULL
                       AND public.fold_text(nc.display_name) ~ ('\\m' || t.q || '\\M') THEN 0.15
                  ELSE 0 END
           - CASE WHEN public.fold_text(p.name) ~ '${PROCESSED_RX}'
                       AND NOT t.q ~ '${PROCESSED_RX}' THEN 0.22 ELSE 0 END
           - CASE WHEN $7::boolean AND public.fold_text(p.name) ~ '${FORM_RX}'
                       AND NOT t.q ~ '${FORM_RX}' THEN 0.22 ELSE 0 END AS score
    FROM catalog.products p
    CROSS JOIN terms t
    LEFT JOIN catalog.name_canonical nc
      ON nc.name_search = public.fold_text(p.name)
    WHERE p.chain_id = ANY($2) AND p.available
      AND (t.q <% p.name OR p.name % t.q)
  ) s GROUP BY chain_id, sku_id
),
ranked AS (
  SELECT chain_id, sku_id, score, source, rn FROM (
    SELECT c.chain_id, c.chosen_sku_id AS sku_id, 1.0::float AS score, 'correction' AS source,
           1 AS rn
    FROM corrections c
    UNION ALL
    SELECT h.chain_id, h.sku_id, 0.95 - (h.rank - 1) * 0.02, 'lexicon',
           row_number() OVER (PARTITION BY h.chain_id ORDER BY h.rank)
    FROM hints h
    UNION ALL
    SELECT f.chain_id, f.sku_id, f.score, 'trgm',
           row_number() OVER (PARTITION BY f.chain_id ORDER BY f.score DESC, f.price_cents ASC)
    FROM fuzzy f
  ) u
  WHERE rn <= $3
)
SELECT DISTINCT ON (p.chain_id, p.sku_id)
       p.chain_id, p.sku_id, p.name, p.brand, p.price_cents, p.promo_price_cents, p.promo,
       p.unit_price_cents_per_std, p.std_unit, p.pack_size_value, p.pack_size_unit,
       p.image_url, p.product_url, p.aisle_group_id,
       r.score AS confidence, r.source
FROM ranked r
JOIN catalog.products p ON p.chain_id = r.chain_id AND p.sku_id = r.sku_id
WHERE p.available
ORDER BY p.chain_id, p.sku_id,
         CASE r.source WHEN 'correction' THEN 0 WHEN 'lexicon' THEN 1 ELSE 2 END`;

// ---- beeld-tier (0015): zelfde product, andere winkelnaam ("Duo Penotti" bij
// AH = "Duopasta" bij Aldi) — de fóto's lijken wél. Ná trgm: heeft een keten
// geen overtuigende kandidaat maar een andere keten wél, dan zoeken we met de
// foto-embedding van die sterke match (het "anker") de meest gelijkende
// producten bij de zwakke keten. Puur additief; faalt stil.
// IJkpunten (gemeten): zelfde-product-kloon 0.785; ongerelateerd ~0.57-0.63.
// gekalibreerd op de dev-catalogus (penotti-casus): exacte naam-match op een
// lange query haalt maar ~0.68 (coverage-term), dus anker vanaf 0.65; en bij
// sim 0.72 zit al ruis ("Vanille roomijs"), Duopasta-kloon zit op 0.785 → 0.74
const IMAGE_ANCHOR_MIN_CONF = 0.65; // alleen overtuigende matches zijn anker
const IMAGE_WEAK_MAX_CONF = 0.6; // onder dit niveau mag beeld bijspringen
const IMAGE_MIN_SIM = 0.74; // cosine-drempel: daaronder is het ruis
const IMAGE_MAX_ANCHORS = 2;
const IMAGE_LIMIT = 8;

const IMAGE_ANN_SQL = `
SELECT p.chain_id, p.sku_id, p.name, p.brand, p.price_cents, p.promo_price_cents, p.promo,
       p.unit_price_cents_per_std, p.std_unit, p.pack_size_value, p.pack_size_unit,
       p.image_url, p.product_url, p.aisle_group_id,
       1 - (e.embedding <=> (SELECT embedding FROM catalog.product_image_embeddings WHERE chain_id = $1 AND sku_id = $2)) AS sim
FROM catalog.product_image_embeddings e
JOIN catalog.products p ON p.chain_id = e.chain_id AND p.sku_id = e.sku_id
WHERE e.chain_id = $3 AND p.available
ORDER BY e.embedding <=> (SELECT embedding FROM catalog.product_image_embeddings WHERE chain_id = $1 AND sku_id = $2)
LIMIT $4`;

/** cosine [0.74..0.95] → confidence [0.55..0.85]: sterk beeld verslaat zwakke
 *  trgm-ruis, maar nooit correcties/hints en zelden een echte naam-match */
const imageConfidence = (sim: number) => Math.min(0.85, 0.55 + ((sim - IMAGE_MIN_SIM) / 0.21) * 0.3);

async function imageTier(
  client: Queryable | undefined,
  result: Record<string, ChainMatch>,
  chainIds: string[]
): Promise<void> {
  const q = client ?? { query };
  const anchors = chainIds
    .map((c) => result[c]?.best)
    .filter((b): b is MatchCandidate => !!b && b.confidence >= IMAGE_ANCHOR_MIN_CONF)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, IMAGE_MAX_ANCHORS);
  const weak = chainIds.filter((c) => {
    const b = result[c]?.best;
    return !b || b.confidence < IMAGE_WEAK_MAX_CONF;
  });
  if (!anchors.length || !weak.length) return;

  // alleen ankers waarvan de foto al geëmbed is (backfill is incrementeel)
  const withEmbedding = await q.query(
    `SELECT chain_id, sku_id FROM catalog.product_image_embeddings
     WHERE (chain_id, sku_id) IN (${anchors.map((_, i) => `($${2 * i + 1}, $${2 * i + 2})`).join(',')})`,
    anchors.flatMap((a) => [a.chain_id, a.sku_id])
  );
  const embedded = new Set(
    (withEmbedding.rows as { chain_id: string; sku_id: string }[]).map((r) => `${r.chain_id}:${r.sku_id}`)
  );
  const usable = anchors.filter((a) => embedded.has(`${a.chain_id}:${a.sku_id}`));
  if (!usable.length) return;

  for (const chain of weak) {
    const bySku = new Map<string, MatchCandidate & { sim: number }>();
    for (const anchor of usable) {
      const r = await q.query(IMAGE_ANN_SQL, [anchor.chain_id, anchor.sku_id, chain, IMAGE_LIMIT]);
      for (const row of r.rows as (MatchCandidate & { sim: number | string })[]) {
        const sim = Number(row.sim);
        if (!(sim >= IMAGE_MIN_SIM)) continue;
        const existing = bySku.get(row.sku_id);
        if (!existing || sim > existing.sim) bySku.set(row.sku_id, { ...row, sim });
      }
    }
    if (!bySku.size) continue;
    const shortlistSkus = new Set(result[chain]?.shortlist.map((c) => c.sku_id) ?? []);
    const candidates = [...bySku.values()]
      .filter((c) => !shortlistSkus.has(c.sku_id))
      .map(({ sim, ...c }) => ({ ...c, confidence: imageConfidence(sim), source: 'image' as const }))
      .sort((a, b) => b.confidence - a.confidence);
    if (!candidates.length) continue;
    const merged = [...(result[chain]?.shortlist ?? []), ...candidates].sort(
      (a, b) => sourceRank[a.source] - sourceRank[b.source] || b.confidence - a.confidence
    );
    result[chain] = { best: merged[0] ?? null, shortlist: merged.slice(0, SHORTLIST_SIZE) };
  }
}

const sourceRank = { correction: 0, lexicon: 1, trgm: 2, image: 2 }; // beeld concurreert met trgm op confidence

/** Match one normalised item across chains. */
export async function matchItem(
  item: string,
  chainIds: string[],
  userId: string | null,
  client?: Queryable
): Promise<Record<string, ChainMatch>> {
  const q = client ?? { query };
  const { term, aliases, aisleGroupId } = await resolveLexicon(item, client);
  // Dutch morphological aliases (plural/diminutive: uien, aardappelen) join the
  // search — "aardappel" alone loses the whole-word boost against products named
  // "…aardappelen", letting dish names win. Translations ("onion") stay out:
  // they'd surface "AH Onion rings" for "ui". (UX-audit matching pass)
  const morphAliases = aliases.filter((a) => a.includes(term) || term.includes(a));
  const searchTerms = [...new Set([item, term, ...morphAliases])].slice(0, 6);
  const freshProduce = aisleGroupId === 1; // groente & fruit → FORM_RX-penalty aan
  const r = await q.query(CANDIDATE_SQL, [searchTerms, chainIds, SHORTLIST_SIZE, userId, [item], aliases, freshProduce]);

  const byChain: Record<string, MatchCandidate[]> = {};
  for (const row of r.rows as (MatchCandidate & { confidence: string | number })[]) {
    const raw = Number(row.confidence);
    // trgm raw scores are boost-stacked (0..~2); map to a 0..0.90 confidence
    const confidence = row.source === 'trgm' ? Math.min(0.9, raw * 0.5) : raw;
    const candidate = { ...row, confidence, rawScore: raw } as MatchCandidate & { rawScore: number };
    (byChain[candidate.chain_id] ??= []).push(candidate);
  }

  const result: Record<string, ChainMatch> = {};
  for (const chainId of chainIds) {
    const candidates = (byChain[chainId] ?? []).sort(
      (a, b) => sourceRank[a.source] - sourceRank[b.source] || b.confidence - a.confidence
    );
    const best = candidates[0] ?? null;
    result[chainId] = {
      best,
      shortlist: candidates.slice(0, SHORTLIST_SIZE),
    };
  }

  // beeld-brug: zwakke ketens aanvullen via foto-gelijkenis met sterke ketens.
  // Additief en fail-safe — een kapotte Vision/embedding-tabel breekt nooit de match.
  try {
    await imageTier(client, result, chainIds);
  } catch (err) {
    // beeld-tier is additief: nooit de match breken, wel zichtbaar in de logs
    console.error('image-tier overgeslagen:', err instanceof Error ? err.message : err);
  }
  return result;
}
