import { Recipe, type Recipe as RecipeType } from '@prakkie/shared';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { env } from '../env';
import type { LinkContext } from './context';

/**
 * parseRecipe(context) → Recipe — the thin OpenAI seam (docs/06 §6). The model
 * only ever sees merged source material; it must never invent quantities
 * (bosui rule etc. below). Output is validated against the shared zod schema;
 * one retry with the validation errors folded into the prompt.
 */

// what the model returns (subset of Recipe; server fills identity/timestamps)
const ParsedRecipe = Recipe.omit({
  id: true, origin: true, owner_id: true, household_id: true,
  last_cooked_at: true, created_at: true, updated_at: true,
  source_url: true, source_platform: true,
});

const SYSTEM_PROMPT = `Je bent de recept-parser van Prakkie, een Nederlandse boodschappen-app.
Je krijgt ruwe brontekst van een social-media post, video-transcript of website en zet die om naar één gestructureerd recept.

HARDE REGELS:
- Alle output in natuurlijk Nederlands.
- Ingrediënten als Nederlandse supermarkttermen (item_normalised klein geschreven, enkelvoud).
- "green onion", "spring onion", "scallion" en "lente-ui" worden ALTIJD "bosui".
- PRESENTEER NOOIT iets als bronfeit dat niet in de bron staat. Ontbreekt iets,
  zet de veldnaam in missing_fields (bijv. "quantities", "servings", "steps", "time").
- WEL gewenst — AI-SUGGESTIES voor gaten, altijd expliciet gemarkeerd:
  * Ontbrekende hoeveelheid? Doe een realistische suggestie in Nederlandse
    supermarktmaten (g, ml, el, tl, stuks) passend bij servings_base, met
    confidence 0.5 en note "AI-suggestie — stond niet in de bron".
    Geen zinnige suggestie mogelijk (bv. "naar smaak")? Laat quantity null.
  * Ontbreekt een overduidelijk basisingrediënt dat de stappen wél gebruiken
    (olie om te bakken, zout, water om te koken)? Voeg het toe met dezelfde
    markering (confidence 0.5 + note "AI-suggestie — stond niet in de bron").
  * Geen bereidingsstappen in de bron? Schrijf logische stappen op basis van de
    ingrediënten en zet "steps" in missing_fields — de app toont ze als suggestie.
  * Ingrediënten of stappen die letterlijk in de bron staan krijgen NOOIT zo'n note.
- Een video die alleen over een gerecht práát zonder hoeveelheden ⇒ gemarkeerde
  suggesties zoals hierboven en "quantities" in missing_fields.
- Per ingrediënt een confidence 0-1 (1 = letterlijk zo in de bron, 0.5 = AI-suggestie).
- Genereer Nederlandse tags (gerechtstype, hoofdingrediënt, keuken, moment) en zet cuisine indien duidelijk.
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

async function callOpenAI(messages: { role: string; content: string }[]): Promise<unknown> {
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
      const now = new Date().toISOString();
      const images = parsed.data.images.length ? parsed.data.images : ctx.image ? [ctx.image] : [];
      return Recipe.parse({
        ...parsed.data,
        images: images.concat(ctx.jsonLd?.images ?? []).filter((v, i, a) => a.indexOf(v) === i).slice(0, 5),
        source_author: parsed.data.source_author ?? ctx.author,
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
