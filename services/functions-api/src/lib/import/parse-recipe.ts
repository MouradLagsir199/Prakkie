import { Recipe, type Recipe as RecipeType } from '@prakkie/shared';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { env } from '../env';
import type { LinkContext } from './context';

/**
 * parseRecipe(context) → Recipe — the thin OpenAI seam (docs/06 §6). The model
 * only ever sees merged source material and may never fill gaps. Output is
 * validated against the shared zod schema;
 * one retry with the validation errors folded into the prompt.
 */

// what the model returns (subset of Recipe; server fills identity/timestamps)
// — exported: enrich-recipe.ts valideert tegen precies dezelfde vorm
export const ParsedRecipe = Recipe.omit({
  id: true, origin: true, owner_id: true, household_id: true,
  last_cooked_at: true, created_at: true, updated_at: true,
  source_url: true, source_platform: true,
});

const SYSTEM_PROMPT = `Je bent de recept-parser van Prakkie, een Nederlandse boodschappen-app.
Je krijgt ruwe brontekst van een social-media post, video-transcript of website en zet die om naar één gestructureerd recept.

HARDE REGELS:
- Alle output in natuurlijk Nederlands.
- Ingrediënten als Nederlandse supermarkttermen (item_normalised klein geschreven, enkelvoud).
- Vertaal ieder ingrediënt naar een gangbare Nederlandse supermarktterm, ook
  als de bron Engels is. Voorbeelden: "neutral oil" → "olie", "garlic" →
  "knoflook", "all-purpose flour" → "tarwebloem", "heavy cream" → "slagroom".
- raw_text is óók Nederlands en gebruikt dezelfde omgerekende hoeveelheid als
  quantity/unit; kopieer dus geen Engelse ingrediëntregel naar de output.
- Zet imperiale en Angelsaksische keukenmaten om naar metrische Nederlandse
  maten: tsp → tl, tbsp → el, fl oz → ml, oz/lb → g of kg en cups vloeistof →
  ml (1 cup = 240 ml). Voor droge cups gebruik je de gangbare ingrediënt-
  specifieke gramconversie (bijv. bloem 1 cup ≈ 120 g). Rond af naar een
  praktisch kookgetal zonder betekenisvolle precisie kwijt te raken.
- Nederlandse bronmaten blijven ongewijzigd; "naar smaak", snufjes en aantallen
  worden niet geforceerd naar grammen.
- "green onion", "spring onion", "scallion" en "lente-ui" worden ALTIJD "bosui".
- PRESENTEER NOOIT iets als bronfeit dat niet in de bron staat. Ontbreekt iets,
  zet de veldnaam in missing_fields (bijv. "quantities", "servings", "steps", "time").
- VERZIN OF VUL NIETS AAN. Voeg geen hoeveelheden, ingrediënten, stappen,
  tijden, porties, voedingswaarden, tags, keuken of dieetlabels toe die niet
  letterlijk of als gestructureerde data in de bron staan.
- Een deterministische vertaling of eenheidsconversie van een wél aanwezige
  hoeveelheid geldt niet als aanvulling en moet juist altijd gebeuren.
- Ontbrekende hoeveelheid: quantity null, unit null en "quantities" in missing_fields.
- Ontbrekende stappen: steps [] en "steps" in missing_fields.
- Een technisch verplichte fallback (zoals servings_base 2) is nooit een
  bronfeit en vereist "servings" in missing_fields.
- note is bij deze eerste import altijd null. AI-aanvullingen gebeuren alleen
  via de aparte knop die de gebruiker bewust indrukt.
- Per ingrediënt confidence 1: iedere ingrediëntregel moet rechtstreeks uit de bron komen.
- item_normalised mag uitsluitend de letterlijk gevonden productterm normaliseren;
  het mag geen ander of extra ingrediënt introduceren.
- steps krijgen order 1..n; herken timers in stappen ("20 min sudderen" → timer_seconds 1200).
- Antwoord met ALLEEN een JSON-object dat aan het schema voldoet.`;

export function buildMessages(ctx: LinkContext, validationFeedback?: string): { role: string; content: string }[] {
  const parts: string[] = [`PLATFORM: ${ctx.platform}`, `URL: ${ctx.url}`];
  if (ctx.title) parts.push(`TITEL: ${ctx.title}`);
  if (ctx.author) parts.push(`AUTEUR: ${ctx.author}`);
  if (ctx.description) parts.push(`CAPTION/TEKST:\n${ctx.description}`);
  if (ctx.jsonLd) {
    const jl = ctx.jsonLd;
    parts.push(
      `GESTRUCTUREERDE RECEPTDATA (JSON-LD):\n${JSON.stringify(
        { name: jl.name, ingredients: jl.ingredients, instructions: jl.instructions,
          prepMinutes: jl.prepMinutes, cookMinutes: jl.cookMinutes, totalMinutes: jl.totalMinutes,
          yield: jl.recipeYield, nutrition: jl.nutrition },
        null, 1
      )}`
    );
  }
  if (ctx.transcript) parts.push(`VIDEO-TRANSCRIPT:\n${ctx.transcript}`);

  const schemaHint = `JSON-schema (verplichte vorm): {
 "title": string, "source_author": string|null, "images": string[],
 "servings_base": int (default 2 alleen als de bron het echt zegt; anders 2 + "servings" in missing_fields),
 "time_prep_min": int|null, "time_cook_min": int|null,
 "ingredients": [{"raw_text": string, "quantity": number|null, "unit": string|null, "item_normalised": string|null, "note": string|null, "confidence": number|null}],
 "steps": [{"order": int, "text": string, "timer_seconds"?: int}],
 "tags": string[], "cuisine": string|null, "diet_flags": ("vegetarisch"|"vegan"|"glutenvrij"|"halal"|"lactosevrij")[],
 "nutrition": {"kcal"?: number, "protein_g"?: number, "carbs_g"?: number, "fat_g"?: number}|null,
 "missing_fields": string[] }`;

  const user = [parts.join('\n\n'), schemaHint, validationFeedback ? `VORIGE POGING AFGEKEURD:\n${validationFeedback}` : '']
    .filter(Boolean)
    .join('\n\n');
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: user },
  ];
}

const NL_REPLACEMENTS: [RegExp, string][] = [
  [/\bindian spiced\b/gi, 'Indiaas gekruide'],
  [/\bneutral oil\b/gi, 'olie'],
  [/\bpre[- ]marinated\b/gi, 'voorgemarineerde'],
  [/\bspatchcock chicken\b/gi, 'vlinderkip'],
  [/\bchicken breast\b/gi, 'kipfilet'],
  [/\bchicken\b/gi, 'kip'],
  [/\bgreen chutney\b/gi, 'groene chutney'],
  [/\bgarlic cloves?\b/gi, 'tenen knoflook'],
  [/\bgarlic\b/gi, 'knoflook'],
  [/\ball[- ]purpose flour\b/gi, 'tarwebloem'],
  [/\bflour\b/gi, 'bloem'],
  [/\bheavy cream\b/gi, 'slagroom'],
  [/\bwhite vinegar\b/gi, 'witte azijn'],
  [/\bred onions?\b/gi, 'rode ui'],
  [/\bonions?\b/gi, 'ui'],
  [/\bspinach\b/gi, 'spinazie'],
  [/\bparsley\b/gi, 'peterselie'],
  [/\bsugar\b/gi, 'suiker'],
  [/\bsalt\b/gi, 'zout'],
  [/\bnaan wraps?\b/gi, 'naanwraps'],
];

function translateKnownIngredientText(value: string | null | undefined): string | null {
  if (!value) return value ?? null;
  return NL_REPLACEMENTS.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), value)
    .replace(/\s+/g, ' ')
    .trim();
}

/** Deterministic safety net after the parser: prompt instructions handle broad
 * translation, while these conversions guarantee that common English recipe
 * units never leak into the Dutch UI. */
export function normaliseDutchRecipe<T extends z.infer<typeof ParsedRecipe>>(recipe: T): T {
  const title = translateKnownIngredientText(recipe.title) ?? recipe.title;
  const ingredients = recipe.ingredients.map((ingredient) => {
    let quantity = ingredient.quantity;
    let unit = ingredient.unit?.trim().toLowerCase() ?? null;
    const item = translateKnownIngredientText(ingredient.item_normalised) ?? ingredient.item_normalised;
    let converted = false;
    if (quantity != null && unit) {
      if (/^(?:cups?|kopjes?)$/.test(unit)) {
        const dryGrams = /(?:bloem|meel)/i.test(item ?? '') ? 120 : /\bsuiker\b/i.test(item ?? '') ? 200 : null;
        quantity = Math.round(quantity * (dryGrams ?? 240) * 100) / 100;
        unit = dryGrams ? 'g' : 'ml';
        converted = true;
      } else if (/^(?:tbsp|tablespoons?)$/.test(unit)) {
        unit = 'el'; converted = true;
      } else if (/^(?:tsp|teaspoons?)$/.test(unit)) {
        unit = 'tl'; converted = true;
      } else if (/^(?:oz|ounces?)$/.test(unit)) {
        quantity = Math.round(quantity * 28.35); unit = 'g'; converted = true;
      } else if (/^(?:lb|lbs|pounds?)$/.test(unit)) {
        quantity = Math.round(quantity * 453.592); unit = quantity >= 1000 ? 'kg' : 'g';
        if (unit === 'kg') quantity = Math.round((quantity / 1000) * 100) / 100;
        converted = true;
      } else if (/^(?:fl\.?\s*oz|fluid ounces?)$/.test(unit)) {
        quantity = Math.round(quantity * 29.574); unit = 'ml'; converted = true;
      }
    }
    const translatedRaw = translateKnownIngredientText(ingredient.raw_text) ?? ingredient.raw_text;
    const raw_text = converted && quantity != null
      ? `${String(quantity).replace('.', ',')} ${unit} ${item ?? translatedRaw}`.trim()
      : translatedRaw;
    return { ...ingredient, raw_text, quantity, unit, item_normalised: item };
  });
  return { ...recipe, title, ingredients };
}

export async function callOpenAI(messages: { role: string; content: string }[]): Promise<unknown> {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${env.openaiApiKey}` },
    body: JSON.stringify({
      model: env.openaiModel,
      messages,
      response_format: { type: 'json_object' },
    }),
  });
  if (!res.ok) throw new Error(`OpenAI HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body = (await res.json()) as { choices: { message: { content: string } }[] };
  return JSON.parse(body.choices[0]!.message.content);
}

export async function parseRecipe(ctx: LinkContext): Promise<RecipeType> {
  let feedback: string | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await callOpenAI(buildMessages(ctx, feedback));
    const parsed = ParsedRecipe.safeParse(raw);
    if (parsed.success) {
      const normalised = normaliseDutchRecipe(parsed.data);
      const now = new Date().toISOString();
      // A source thumbnail is evidence too. Never let an LLM-provided image
      // array accidentally discard the real social preview image.
      const images = [...normalised.images, ...(ctx.image ? [ctx.image] : [])];
      return Recipe.parse({
        ...normalised,
        images: images.concat(ctx.jsonLd?.images ?? []).filter((v, i, a) => a.indexOf(v) === i).slice(0, 5),
        source_author: normalised.source_author ?? ctx.author,
        id: randomUUID(),
        origin: 'import',
        source_url: ctx.url,
        source_platform: ctx.platform,
        created_at: now,
        updated_at: now,
      });
    }
    feedback = JSON.stringify(parsed.error.flatten().fieldErrors).slice(0, 1500);
  }
  throw new Error('parseRecipe: model output failed schema validation twice');
}

export type ParsedRecipeInput = z.infer<typeof ParsedRecipe>;
