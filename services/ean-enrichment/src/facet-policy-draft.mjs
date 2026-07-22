// LLM-draft van per-categorie facetbeleid (matching v2, docs/09 Fase 2).
//
// Voor de longtail: gegeven een categorie + wat voorbeeldproducten stelt de LLM
// voor welke facetten HARD zijn (een verschil = geen equivalent) en welke ZACHT
// (alleen rangschikking). Output is een concept (source='llm', reviewed_by=null);
// een mens keurt het daarna goed (source='human'). Nooit blind vertrouwen: tot
// review valt de categorie terug op het conservatieve in-code beleid.
//
// CLI: node facet-policy-draft.mjs <categorie> "voorbeeld1" "voorbeeld2" ...
//   --write  → upsert in catalog.category_facet_policy (PG_* + KEY_VAULT_NAME)
import { resolveApiKey } from './facet-extract.mjs';

const FACETS = ['category', 'brand_tier', 'variant', 'flavor', 'form', 'dietary', 'type', 'pack'];
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';

const SYSTEM = `Je bepaalt het substitutiebeleid voor één Nederlandse supermarktcategorie.
Facetten: ${JSON.stringify(FACETS)}.
HARD = een verschil maakt het GEEN vervanging (de klant wil dit echt niet anders).
ZACHT = mag verschillen, telt alleen mee in de rangschikking.
'category' hoort ALTIJD bij hard. Wees streng: bij twijfel hard.
Antwoord EXACT als JSON: {"hard":[...],"soft":[...],"rationale":"<1 zin>"}`;

/** Concept-beleid voor één categorie. */
export async function draftCategoryPolicy(category, examples = [], { apiKey } = {}) {
  const key = apiKey ?? (await resolveApiKey());
  const res = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: process.env.FACET_MODEL ?? 'gpt-4o-mini',
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: `categorie: ${category}\nvoorbeelden:\n${examples.map((e) => `- ${e}`).join('\n') || '(geen)'}` },
      ],
    }),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
  const body = await res.json();
  const out = JSON.parse(body.choices?.[0]?.message?.content ?? '{}');
  const hard = [...new Set(['category', ...(out.hard ?? [])])].filter((f) => FACETS.includes(f));
  const soft = (out.soft ?? []).filter((f) => FACETS.includes(f) && !hard.includes(f));
  return { category, hard_facets: hard, soft_facets: soft, source: 'llm', rationale: out.rationale ?? '' };
}

async function main() {
  const [category, ...examples] = process.argv.slice(2).filter((a) => a !== '--write');
  if (!category) throw new Error('gebruik: node facet-policy-draft.mjs <categorie> "voorbeeld" ...');
  const draft = await draftCategoryPolicy(category, examples);
  console.log(JSON.stringify(draft, null, 2));

  if (process.argv.includes('--write')) {
    const pg = (await import('pg')).default;
    const { DefaultAzureCredential } = await import('@azure/identity');
    const { SecretClient } = await import('@azure/keyvault-secrets');
    const vault = process.env.KEY_VAULT_NAME;
    const password = process.env.PG_PASSWORD ??
      (await new SecretClient(`https://${vault}.vault.azure.net`, new DefaultAzureCredential())
        .getSecret(process.env.PG_SECRET_NAME ?? 'PG-INGEST-PASSWORD')).value;
    const pool = new pg.Pool({
      host: process.env.PG_HOST, database: process.env.PG_DATABASE ?? 'prakkie',
      user: process.env.PG_USER ?? 'prakkie_ingest', password, port: Number(process.env.PG_PORT ?? '5432'),
      ssl: { rejectUnauthorized: false }, max: 2,
    });
    await pool.query(
      `INSERT INTO catalog.category_facet_policy (category, hard_facets, soft_facets, source)
       VALUES ($1,$2,$3,'llm')
       ON CONFLICT (category) DO UPDATE SET
         hard_facets=EXCLUDED.hard_facets, soft_facets=EXCLUDED.soft_facets,
         source='llm', reviewed_by=NULL, reviewed_at=NULL, updated_at=now()`,
      [draft.category, draft.hard_facets, draft.soft_facets]
    );
    await pool.end();
    console.log(`\nweggeschreven als concept (source='llm', nog te reviewen).`);
  }
}

if (process.argv[1]?.endsWith('facet-policy-draft.mjs')) {
  main().then(() => process.exit(0), (err) => { console.error('facet-policy-draft mislukt:', err); process.exit(1); });
}
