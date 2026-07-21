// LLM-facetextractie (docs/09_matching_architecture.md, Fase 0/1).
//
// Per product: naam/merk/verpakking/categoriepad → schone ProductFacets-struct.
// Eén keer per EAN, gecached, auditbaar. Deterministisch (temperature 0) en
// gedwongen JSON. De struct gaat daarna door verifyFacets() (facets.mjs); een
// onverifieerbare extractie wordt uitgesloten van auto-matchen.
//
// Gebruikt fetch tegen de OpenAI Chat Completions API — geen SDK-dependency.
// Sleutel: env OPENAI_API_KEY, anders KeyVault (KEY_VAULT_NAME + OPENAI-API-KEY).

import { FORM_VALUES, BRAND_TIERS } from './facets.mjs';

const MODEL = process.env.FACET_MODEL ?? 'gpt-4o-mini';
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';

const SYSTEM_PROMPT = `Je bent een Nederlandse supermarkt-productclassificator. Gegeven een productnaam,
merk, verpakking en categoriepad, geef je EXACT dit JSON-object terug (geen extra tekst):

{
  "category": "<fijnmazige categorie-slug, kleine letters, bv. frisdrank, zuivel-melk, groente-conserven, suiker, brood, bakproducten>",
  "brand_tier": "a_merk" | "private_label" | "value_line",
  "variant": "<regular|zero|light|cafeinevrij|... of null>",
  "flavor": "<regular|cherry|vanille|... of null>",
  "form": ${JSON.stringify(FORM_VALUES)},
  "dietary": ["bio"|"lactosevrij"|"glutenvrij"|...],
  "type": "<categorie-specifiek subtype of null: vol/halfvol/mager, kristal/basterd, sperziebonen/doperwten, wit/bruin>",
  "pack": { "value": <getal of null>, "unit": "<g|kg|ml|l|st of null>" }
}

Regels:
- category: STABIEL en vorm-onafhankelijk. Verse, blik- en diepvriesgroente delen
  dezelfde categorie "groente"; de vorm zit in "form", niet in de categorie.
  Cola/fris = "frisdrank"; melk = "zuivel-melk"; suiker = "suiker"; brood = "brood";
  bakmix/bakpoeder = "bakproducten".
- type: het categorie-specifieke subtype. Melk: vetgehalte (vol/halfvol/mager) → type
  (NIET variant). Groente: de groentesoort (sperziebonen/doperwten). Suiker:
  kristal/basterd/riet. Brood: wit/bruin/volkoren.
- brand_tier: huismerk/eigen merk van de keten = "private_label"; goedkoopste basislijn
  = "value_line"; landelijk A-merk = "a_merk".
- variant/flavor: gebruik "regular" als er geen bijzondere variant/smaak is. Vetgehalte
  van melk is GEEN variant.
- form: kies uit de gegeven lijst; een bakmix/poeder is "houdbaar", NOOIT "vers".
- Verzin niets. Bij twijfel: kies de meest letterlijke lezing van de naam.`;

function userPrompt(raw) {
  return [
    `naam: ${raw.name ?? ''}`,
    `merk: ${raw.brand ?? '—'}`,
    `verpakking: ${raw.pack_size_value ?? '—'} ${raw.pack_size_unit ?? ''}`.trim(),
    `categoriepad: ${(raw.category_path ?? []).join(' > ') || '—'}`,
  ].join('\n');
}

/** Eén product → facetstruct via OpenAI. Gooit bij API-fout. */
export async function extractFacets(raw, { apiKey, model = MODEL } = {}) {
  const key = apiKey ?? process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY ontbreekt');
  const res = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt(raw) },
      ],
    }),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
  const body = await res.json();
  const content = body.choices?.[0]?.message?.content;
  if (!content) throw new Error('OpenAI: lege respons');
  return normalizeFacets(JSON.parse(content));
}

/** Ruwe LLM-output → gevalideerde struct met vaste vormen. */
export function normalizeFacets(obj) {
  const s = (v) => (v == null || v === '' ? null : String(v).toLowerCase());
  const form = s(obj.form);
  return {
    category: s(obj.category),
    brand_tier: BRAND_TIERS.includes(s(obj.brand_tier)) ? s(obj.brand_tier) : null,
    variant: s(obj.variant) ?? 'regular',
    flavor: s(obj.flavor) ?? 'regular',
    form: FORM_VALUES.includes(form) ? form : null,
    dietary: Array.isArray(obj.dietary) ? obj.dietary.map((d) => String(d).toLowerCase()) : [],
    type: s(obj.type),
    pack: {
      value: obj.pack?.value != null ? Number(obj.pack.value) : null,
      unit: s(obj.pack?.unit),
    },
  };
}

/** OpenAI-sleutel uit KeyVault als env leeg is (mirror van run.mjs). */
export async function resolveApiKey() {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  const vault = process.env.KEY_VAULT_NAME;
  if (!vault) throw new Error('OPENAI_API_KEY of KEY_VAULT_NAME is vereist');
  const { DefaultAzureCredential } = await import('@azure/identity');
  const { SecretClient } = await import('@azure/keyvault-secrets');
  const client = new SecretClient(`https://${vault}.vault.azure.net`, new DefaultAzureCredential());
  const secret = await client.getSecret(process.env.OPENAI_SECRET_NAME ?? 'OPENAI-API-KEY');
  return secret.value;
}
