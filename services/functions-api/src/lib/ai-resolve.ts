import type { PoolClient } from 'pg';
import { query as dbQuery } from './db';
import { env } from './env';
import { resolveLexicon } from './match';

/**
 * AI product resolver (prakkie-search prototype) — the "vind mijn prakkie"
 * engine. Two stages, deliberately split so an LLM does the hard judgment the
 * hand-tuned regexes in match.ts approximate:
 *
 *   1. retrieveLoose — a WIDE recall net over catalog.products (low trigram
 *      floor + substring), NO composite/form/variant penalties. Goal: the right
 *      product is PRESENT in the candidate list, even buried. Precision is not
 *      this stage's job.
 *   2. aiSelectBest — OpenAI picks the single best sku per chain from those
 *      candidates (plain/base form, right variant, sensible pack), constrained
 *      by a strict json_schema and a hard guard that the returned sku actually
 *      exists in the candidate set (never invents a product).
 *
 * resolveItem glues them and hydrates the pick into a ChainMatch-like shape so
 * it is a drop-in for what /v1/match and the app already consume. The offline
 * eval (scripts/ai-match-eval.mjs) imports these same functions, so measuring
 * the eval measures the production code path.
 */

type Queryable = Pick<PoolClient, 'query'>;

/** Wide-net candidate: the subset of catalog fields the prompt + scoring need. */
export interface LooseCandidate {
  chain_id: string;
  sku_id: string;
  name: string;
  brand: string | null;
  price_cents: number;
  promo_price_cents: number | null;
  pack_size_value: number | null;
  pack_size_unit: string | null;
  unit_price_cents_per_std: number | null;
  std_unit: string | null;
  image_url: string | null;
  product_url: string | null;
  /** retrieval trigram similarity — for ordering/diagnostics only */
  sim: number;
}

/** What resolveItem returns per chain — structurally close to match.ts ChainMatch. */
export interface ResolvedMatch {
  best: (LooseCandidate & { source: 'ai'; confidence: number }) | null;
  shortlist: LooseCandidate[];
}

/** How many candidates the wide net keeps per chain (recall over precision). */
export const RETRIEVE_LIMIT = 40;

// One broad query across all chains. WHERE uses only trigram-INDEXED forms
// (<%, %, ILIKE — same index path as match.ts's CANDIDATE_SQL), never
// similarity() function calls: those force a full scan and dit pad is straks
// het productie-pad. Recall net = prod-operators PLUS substring. Geen
// penalties: een pot "gebroken sperziebonen" is net zo vindbaar als de verse
// zak — de LLM beslist wat de gebruiker bedoelt.
const RETRIEVE_SQL = `
WITH terms AS (SELECT DISTINCT public.fold_text(unnest($2::text[])) AS q)
SELECT p.chain_id, p.sku_id, p.name, p.brand, p.price_cents, p.promo_price_cents,
       p.pack_size_value, p.pack_size_unit, p.unit_price_cents_per_std, p.std_unit,
       p.image_url, p.product_url,
       MAX(GREATEST(word_similarity(t.q, p.name), similarity(p.name, t.q))) AS sim,
       MAX(CASE WHEN public.fold_text(p.name) ~ ('\\m' || t.q || '\\M') THEN 1 ELSE 0 END) AS whole_word
FROM catalog.products p
CROSS JOIN terms t
WHERE p.chain_id = ANY($1) AND p.available
  AND (t.q <% p.name OR p.name % t.q OR p.name ILIKE '%' || t.q || '%')
GROUP BY p.chain_id, p.sku_id, p.name, p.brand, p.price_cents, p.promo_price_cents,
         p.pack_size_value, p.pack_size_unit, p.unit_price_cents_per_std, p.std_unit,
         p.image_url, p.product_url
ORDER BY p.chain_id, whole_word DESC, length(p.name) ASC, sim DESC`;

/** Wide recall net per chain. Returns up to RETRIEVE_LIMIT candidates each. */
export async function retrieveLoose(
  term: string,
  chainIds: string[],
  client?: Queryable
): Promise<Record<string, LooseCandidate[]>> {
  const q = client ?? { query: dbQuery };
  const { term: canonical, aliases } = await resolveLexicon(term, client);
  // morfologische verwanten (uien, aardappelen, banaan→bananen) helpen recall;
  // vertalingen ("onion") zouden de 40 kandidaat-slots met ruis vullen ("AH
  // Onion rings"). Substring-check mist NL-meervouden met klinkerwissel
  // (banaan/bananen), dus ook: gedeelde voorvoegsel-stam van ≥3 tekens.
  const stem = (s: string) => s.slice(0, Math.min(3, canonical.length));
  const morphAliases = aliases.filter(
    (a) => a.includes(canonical) || canonical.includes(a) || stem(a) === stem(canonical)
  );
  const searchTerms = [...new Set([term, canonical, ...morphAliases])].slice(0, 6);

  const r = await q.query(RETRIEVE_SQL, [chainIds, searchTerms]);
  const byChain: Record<string, LooseCandidate[]> = {};
  for (const row of r.rows as (LooseCandidate & { sim: string | number })[]) {
    const list = (byChain[row.chain_id] ??= []);
    if (list.length < RETRIEVE_LIMIT) list.push({ ...row, sim: Number(row.sim) });
  }
  return byChain;
}

/** hoort bij de cache-sleutel: prompt-wijziging ⇒ oude keuzes automatisch ongeldig */
export const PROMPT_VERSION = 'v4';

const SYSTEM_PROMPT = `Je bent een boodschappen-assistent voor Nederlandse supermarkten.
De gebruiker typt een ingrediënt of product ("boter", "sperziebonen", "volle melk").
Voor ELKE supermarkt krijg je een lijst kandidaat-producten (met een id). Kies per
supermarkt het ID van HET product dat de gebruiker bedoelt, of null als niets past.

Kies het product dat het ingrediënt ZELF is, in de gewone/basale vorm:
- GEEN samengestelde of afgeleide producten (soep, saus, salade, mix, koek, gebak,
  kant-en-klare maaltijd, chips, drank, spread) tenzij de gebruiker daar zelf om vraagt.
- Respecteer de variant die gevraagd wordt: "volle melk" is niet "halfvolle melk";
  "rode ui" is niet "gewone ui". Vraagt de gebruiker geen variant, dan is elke gewone
  variant prima.
- Verse groente/fruit: kies vers, niet blik/pot/gedroogd/zoetzuur, TENZIJ de zoekterm
  dat expliciet noemt ("sperziebonen" → verse/hele bonen, niet "gebroken sperziebonen
  in blik"; maar "kikkererwten" → blik/pot is juist normaal).
- LET OP verraderlijke pot/blik-namen bij groente: "extra fijn", "zeer fijn", "op sap"
  en merkloze potmaten duiden vrijwel altijd op conserven — kies die NIET voor een
  verse vraag ("wortels" → verse wortelen, nooit "wortelen extra fijn").
- Staat er een gevraagde verpakking bij ("1 zak", "2 blikken"), respecteer die:
  "zak(je)" → verse zak; "blik(je)"/"pot(je)" → juist wél conserven.
- Staat er een GEVRAAGDE HOEVEELHEID als gewicht of volume bij ("500 g", "1 kg",
  "1 l"): dat gaat over het verse/basis-product zelf — kies dan NOOIT blik, pot of
  conserven (een gewicht maakt de verse variant strenger verplicht, niet losser).
  Kies de verpakking waarvan de inhoud het dichtst bij de gevraagde hoeveelheid
  ligt, liefst gelijk of iets groter; meerdere keren een kleiner pak is prima als
  dat beter past (de gebruiker kan het aantal verhogen).
- Bij twijfel tussen goede varianten: kies een normale, standaard verpakking (geen
  onnodige multipack/grootverpakking) en anders de goedkoopste zinnige optie.
- Kies ALLEEN uit de gegeven id's. Liever een goede gewone variant dan null —
  null alleen als er écht niets passends tussen staat.`;

/**
 * JSON schema (strict), gebouwd per aanvraag: één VERPLICHTE property per
 * supermarkt. Een vrije picks-array liet het model ketens weglaten (banaan
 * kreeg bij 5 van de 6 supers "null" omdat het antwoord simpelweg stopte);
 * required-per-keten dwingt een compleet antwoord af.
 */
function selectSchema(chains: string[]) {
  return {
    name: 'product_picks',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: Object.fromEntries(chains.map((c) => [c, { type: ['string', 'null'] }])),
      required: chains,
    },
  };
}

function packLabel(c: LooseCandidate): string {
  if (c.pack_size_value != null && c.pack_size_unit) return `${c.pack_size_value} ${c.pack_size_unit}`;
  // AH-data mist pack_size vaak, maar heeft wél de eenheidsprijs — de inhoud is
  // dan afleidbaar (prijs ÷ €/kg). Zonder dit heten vier verschillende zakken
  // allemaal "AH Wortelen" en kiest de LLM blind de goedkoopste: het 120g-pakje
  // op een 1kg-vraag (owner-bug 2026-07-09). "±" want de schapkaart rondt af.
  if (c.unit_price_cents_per_std && c.std_unit && c.price_cents) {
    const size = c.price_cents / c.unit_price_cents_per_std;
    if (c.std_unit === 'kg' || c.std_unit === 'l') {
      if (size < 0.9995) return `± ${Math.round(size * 200) * 5} ${c.std_unit === 'kg' ? 'g' : 'ml'}`;
      return `± ${Math.round(size * 20) / 20} ${c.std_unit}`;
    }
    return `± ${Math.round(size)} ${c.std_unit}`;
  }
  return '';
}

function candidateLines(candidates: LooseCandidate[]): string {
  return candidates
    .map((c) => {
      const price = ((c.promo_price_cents ?? c.price_cents) / 100).toFixed(2);
      const bits = [c.brand, packLabel(c)].filter(Boolean).join(' · ');
      return `  [${c.sku_id}] ${c.name}${bits ? ` (${bits})` : ''} — €${price}`;
    })
    .join('\n');
}

const OPENAI_TIMEOUT_MS = 60_000;

async function callOpenAIWithSchema(
  messages: { role: string; content: string }[],
  model: string,
  schema: object
): Promise<unknown> {
  // kiezen-uit-een-lijst heeft geen diep redeneren nodig — 'low' scheelt fors
  // in latency/kosten; alleen geldig op redeneer-modellen (gpt-5-/o-familie)
  const reasoning = /^(gpt-5|o\d)/.test(model) ? { reasoning_effort: 'low' } : {};
  // één retry op transient fouten (429/5xx/netwerk/timeout) — Apify-patroon
  for (let attempt = 1; ; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);
    try {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${env.openaiApiKey}` },
        body: JSON.stringify({
          model,
          messages,
          ...reasoning,
          response_format: { type: 'json_schema', json_schema: schema },
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const transient = res.status === 429 || res.status >= 500;
        const text = (await res.text()).slice(0, 300);
        if (transient && attempt === 1) {
          await new Promise((r) => setTimeout(r, 2000));
          continue;
        }
        throw new Error(`OpenAI HTTP ${res.status}: ${text}`);
      }
      const body = (await res.json()) as { choices: { message: { content: string } }[] };
      return JSON.parse(body.choices[0]!.message.content) as unknown;
    } catch (err) {
      if (attempt === 1 && (err instanceof Error && (err.name === 'AbortError' || err.name === 'TypeError'))) {
        continue; // timeout of netwerkfout: één keer opnieuw
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Ask the model to pick one sku per chain from the loose candidates. Returns a
 * chain → sku_id map; a returned id that is NOT in that chain's candidate set
 * (hallucination) is dropped to null. Chains with no candidates are skipped.
 */
export async function aiSelectBest(
  term: string,
  candidatesByChain: Record<string, LooseCandidate[]>,
  opts: { model?: string } = {}
): Promise<Record<string, string | null>> {
  const chains = Object.keys(candidatesByChain).filter((c) => candidatesByChain[c]!.length > 0);
  if (chains.length === 0) return {};

  const userBlocks = chains.map(
    (c) => `SUPERMARKT ${c}:\n${candidateLines(candidatesByChain[c]!)}`
  );
  const user = `Gezocht: "${term}"\n\n${userBlocks.join('\n\n')}`;
  const parsed = (await callOpenAIWithSchema(
    [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: user },
    ],
    opts.model ?? env.openaiModel,
    selectSchema(chains)
  )) as Record<string, string | null>;

  const out: Record<string, string | null> = {};
  for (const chain of chains) {
    const sku = parsed[chain] ?? null;
    // hallucinatie-guard: alleen id's die écht in de kandidatenlijst staan
    out[chain] = sku && candidatesByChain[chain]!.some((c) => c.sku_id === sku) ? sku : null;
  }
  return out;
}

/**
 * Batch-variant: één OpenAI-call voor een groepje items tegelijk (kosten +
 * latency — een weeklijst is ~20 items). Zelfde afdwinging als aiSelectBest:
 * per item per keten een VERPLICHT antwoord via het strict schema; items
 * krijgen neutrale sleutels (i0, i1, …) zodat rare tekens in namen het schema
 * niet breken.
 */
/** meet-eenheden waarvoor de hoeveelheid als harde promptregel meegaat */
const MEASURE_UNITS = new Set(['kg', 'g', 'mg', 'l', 'dl', 'cl', 'ml']);

export async function aiSelectBestBatch(
  items: {
    term: string;
    ask?: string;
    quantity?: number | null;
    unit?: string | null;
    candidatesByChain: Record<string, LooseCandidate[]>;
  }[],
  opts: { model?: string } = {}
): Promise<Record<string, string | null>[]> {
  const active = items
    .map((it, i) => ({
      ...it,
      key: `i${i}`,
      chains: Object.keys(it.candidatesByChain).filter((c) => it.candidatesByChain[c]!.length > 0),
    }))
    .filter((it) => it.chains.length > 0);
  if (active.length === 0) return items.map(() => ({}));

  const schema = {
    name: 'product_picks',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: Object.fromEntries(
        active.map((it) => [
          it.key,
          {
            type: 'object',
            additionalProperties: false,
            properties: Object.fromEntries(it.chains.map((c) => [c, { type: ['string', 'null'] }])),
            required: it.chains,
          },
        ])
      ),
      required: active.map((it) => it.key),
    },
  };

  // de rauwe vraag ("1 zak wortels") gaat mee: verpakkings-/hoeveelheid-context
  // stuurt de keuze (zak = vers; blik = conserven) — owner-bug 2026-07-08.
  // Een gewicht/volume ("1 kg") krijgt een eigen, expliciete regel: als bijzin
  // in de ask woog het te licht en won een blik alsnog (owner-bug 2026-07-09).
  const user = active
    .map((it) => {
      const qtyLine =
        it.quantity != null && it.unit && MEASURE_UNITS.has(it.unit)
          ? `\nGEVRAAGDE HOEVEELHEID: ${it.quantity} ${it.unit}`
          : '';
      return `### ${it.key} — gezocht: "${it.term}"${
        it.ask && it.ask.toLowerCase() !== it.term.toLowerCase() ? ` (gebruiker vroeg: "${it.ask}")` : ''
      }${qtyLine}\n${it.chains
        .map((c) => `SUPERMARKT ${c}:\n${candidateLines(it.candidatesByChain[c]!)}`)
        .join('\n\n')}`;
    })
    .join('\n\n');

  const parsed = await callOpenAIWithSchema(
    [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: user },
    ],
    opts.model ?? env.openaiModel,
    schema
  ) as Record<string, Record<string, string | null>>;

  return items.map((it, i) => {
    const picks = parsed[`i${i}`] ?? {};
    const out: Record<string, string | null> = {};
    for (const chain of Object.keys(it.candidatesByChain)) {
      const sku = picks[chain] ?? null;
      out[chain] = sku && it.candidatesByChain[chain]!.some((c) => c.sku_id === sku) ? sku : null;
    }
    return out;
  });
}

/** Hoeveel items per OpenAI-call — begrenst de kandidaten-muur per request. */
const BATCH_SIZE = 4;
/** Cache-versheid: na 7 dagen (of als de sku uit het assortiment is) opnieuw kiezen. */
const CACHE_TTL_DAYS = 7;

export interface PrakkieItemResult {
  /** de invoer zoals de gebruiker die typte */
  name: string;
  item_normalised: string;
  quantity: number | null;
  unit: string | null;
  /** list_items.matches-vorm: {chain: {sku_id, confidence, user_pinned, preferred?}} */
  matches: Record<string, { sku_id: string; confidence: number; user_pinned: true; preferred?: true }>;
  /** productdetails per keten voor weergave/prijs (alleen gekozen sku's) */
  products: Record<string, LooseCandidate>;
  /** goedkoopste keten voor dit item (promo-prijs telt) — de spreiding-view */
  cheapest_chain: string | null;
  from_cache: boolean;
}

const CACHE_GET_SQL = `
SELECT c.item_normalised, c.chain_id, c.sku_id
FROM catalog.ai_resolve_cache c
LEFT JOIN catalog.products p ON p.chain_id = c.chain_id AND p.sku_id = c.sku_id
WHERE c.item_normalised = ANY($1) AND c.chain_id = ANY($2) AND c.model = $3
  AND c.resolved_at > now() - ($4 || ' days')::interval
  AND (c.sku_id IS NULL OR (p.sku_id IS NOT NULL AND p.available))`;

const CACHE_PUT_SQL = `
INSERT INTO catalog.ai_resolve_cache (item_normalised, chain_id, model, sku_id, resolved_at)
VALUES ($1, $2, $3, $4, now())
ON CONFLICT (item_normalised, chain_id, model)
DO UPDATE SET sku_id = EXCLUDED.sku_id, resolved_at = now()`;

const PRODUCTS_SQL = `
SELECT p.chain_id, p.sku_id, p.name, p.brand, p.price_cents, p.promo_price_cents,
       p.pack_size_value, p.pack_size_unit, p.unit_price_cents_per_std, p.std_unit,
       p.image_url, p.product_url, 1.0 AS sim
FROM catalog.products p
WHERE p.available AND (p.chain_id, p.sku_id) IN (SELECT unnest($1::text[]), unnest($2::text[]))`;

/**
 * De "Vind mijn prakkie"-motor: lijst genormaliseerde items → per item per
 * keten één AI-gekozen sku, met cache (weeklijsten herhalen zich) en batching.
 * `beforeLlm` wordt precies één keer aangeroepen als er échte LLM-calls nodig
 * zijn — daar hangt het endpoint zijn quotum-check aan.
 */
export async function resolvePrakkie(
  items: { name: string; item_normalised: string; quantity: number | null; unit: string | null }[],
  chainIds: string[],
  client?: Queryable,
  opts: { model?: string; beforeLlm?: () => Promise<void> } = {}
): Promise<PrakkieItemResult[]> {
  const q = client ?? { query: dbQuery };
  const model = opts.model ?? env.openaiModel;
  // prompt-versie in de sleutel: een prompt-fix maakt oude keuzes vanzelf stale
  const cacheModel = `${model}#${PROMPT_VERSION}`;

  // 1. cache: welke (vraag × keten) hebben nog een verse, leverbare keuze?
  // De sleutel is unit- én hoeveelheid-bewust: "1 zak wortels" is een ándere
  // vraag dan "1 pot wortels" (owner-bug 2026-07-08), en "1 kg wortelen" hoort
  // een ander pak te kiezen dan "250 g wortelen" (owner-bug 2026-07-09).
  const keyOf = (it: { item_normalised: string; quantity: number | null; unit: string | null }) =>
    it.unit ? `${it.item_normalised} [${it.quantity ?? 1} ${it.unit}]` : it.item_normalised;
  const asks = new Map<string, { term: string; ask: string; quantity: number | null; unit: string | null }>();
  for (const it of items) {
    if (!asks.has(keyOf(it))) {
      asks.set(keyOf(it), { term: it.item_normalised, ask: it.name, quantity: it.quantity, unit: it.unit });
    }
  }
  const keys = [...asks.keys()];
  const cached = await q.query(CACHE_GET_SQL, [keys, chainIds, cacheModel, String(CACHE_TTL_DAYS)]);
  const cachePicks = new Map<string, string | null>(); // `${key}|${chain}` → sku|null
  for (const row of cached.rows as { item_normalised: string; chain_id: string; sku_id: string | null }[]) {
    cachePicks.set(`${row.item_normalised}|${row.chain_id}`, row.sku_id);
  }
  const isFullyCached = (key: string) => chainIds.every((c) => cachePicks.has(`${key}|${c}`));
  const uncachedKeys = keys.filter((k) => !isFullyCached(k));

  // 2. LLM voor de rest, in batches
  const livePicks = new Map<string, string | null>();
  const liveCandidates = new Map<string, LooseCandidate[]>(); // `${key}|${chain}`
  if (uncachedKeys.length > 0) {
    if (opts.beforeLlm) await opts.beforeLlm();
    for (let start = 0; start < uncachedKeys.length; start += BATCH_SIZE) {
      const batchKeys = uncachedKeys.slice(start, start + BATCH_SIZE);
      const batch = await Promise.all(
        batchKeys.map(async (key) => {
          const ctx = asks.get(key)!;
          return {
            key,
            term: ctx.term,
            ask: ctx.ask,
            quantity: ctx.quantity,
            unit: ctx.unit,
            candidatesByChain: await retrieveLoose(ctx.term, chainIds, client),
          };
        })
      );
      const picks = await aiSelectBestBatch(batch, { model });
      for (let i = 0; i < batch.length; i++) {
        const { key, candidatesByChain } = batch[i]!;
        for (const chain of chainIds) {
          const sku = picks[i]?.[chain] ?? null;
          livePicks.set(`${key}|${chain}`, sku);
          liveCandidates.set(`${key}|${chain}`, candidatesByChain[chain] ?? []);
          await q.query(CACHE_PUT_SQL, [key, chain, cacheModel, sku]);
        }
      }
    }
  }

  // 3. producten hydrateren (cache-picks hebben alleen sku's; live heeft ze al)
  const needFetch: { chain: string; sku: string }[] = [];
  for (const key of keys) {
    for (const chain of chainIds) {
      const k = `${key}|${chain}`;
      const sku = cachePicks.has(k) ? cachePicks.get(k)! : livePicks.get(k) ?? null;
      if (sku && !liveCandidates.get(k)?.some((c) => c.sku_id === sku)) needFetch.push({ chain, sku });
    }
  }
  const products = new Map<string, LooseCandidate>(); // `${chain}|${sku}`
  if (needFetch.length > 0) {
    const r = await q.query(PRODUCTS_SQL, [needFetch.map((f) => f.chain), needFetch.map((f) => f.sku)]);
    for (const row of r.rows as LooseCandidate[]) products.set(`${row.chain_id}|${row.sku_id}`, { ...row, sim: 1 });
  }
  const productOf = (key: string, chain: string): LooseCandidate | null => {
    const k = `${key}|${chain}`;
    const sku = cachePicks.has(k) ? cachePicks.get(k)! : livePicks.get(k) ?? null;
    if (!sku) return null;
    return liveCandidates.get(k)?.find((c) => c.sku_id === sku) ?? products.get(`${chain}|${sku}`) ?? null;
  };

  // 4. resultaat per item: matches-map + goedkoopste keten krijgt preferred
  return items.map((item) => {
    const matches: PrakkieItemResult['matches'] = {};
    const prods: Record<string, LooseCandidate> = {};
    let cheapest: string | null = null;
    let cheapestCents = Number.MAX_SAFE_INTEGER;
    for (const chain of chainIds) {
      const p = productOf(keyOf(item), chain);
      if (!p) continue;
      matches[chain] = { sku_id: p.sku_id, confidence: 1, user_pinned: true };
      prods[chain] = p;
      const cents = p.promo_price_cents ?? p.price_cents;
      if (cents < cheapestCents) {
        cheapestCents = cents;
        cheapest = chain;
      }
    }
    if (cheapest) matches[cheapest] = { ...matches[cheapest]!, preferred: true };
    return {
      name: item.name,
      item_normalised: item.item_normalised,
      quantity: item.quantity,
      unit: item.unit,
      matches,
      products: prods,
      cheapest_chain: cheapest,
      from_cache: isFullyCached(keyOf(item)),
    };
  });
}

/**
 * Full resolve for one item across chains: loose retrieval → AI selection →
 * hydrate into a ChainMatch-like shape (best + shortlist). Drop-in for the
 * matcher's output; used by the eval and (later) the /v1/prakkie/resolve endpoint.
 */
export async function resolveItem(
  term: string,
  chainIds: string[],
  client?: Queryable,
  opts: { model?: string } = {}
): Promise<Record<string, ResolvedMatch>> {
  const candidatesByChain = await retrieveLoose(term, chainIds, client);
  const picks = await aiSelectBest(term, candidatesByChain, opts);

  const result: Record<string, ResolvedMatch> = {};
  for (const chain of chainIds) {
    const shortlist = candidatesByChain[chain] ?? [];
    const pickedSku = picks[chain] ?? null;
    const picked = pickedSku ? shortlist.find((c) => c.sku_id === pickedSku) ?? null : null;
    result[chain] = {
      best: picked ? { ...picked, source: 'ai', confidence: 1 } : null,
      shortlist,
    };
  }
  return result;
}
