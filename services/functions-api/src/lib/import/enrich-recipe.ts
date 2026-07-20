import { z } from 'zod';
import { ParsedRecipe, callOpenAI } from './parse-recipe';

/**
 * enrichRecipe — "Vul het recept aan" (owner 2026-07-10). Tweede, aparte
 * LLM-call ná een import: de gebruiker drukt bewust op de knop als er nog
 * gaten zitten in het recept. Doel: élk recept eindigt met een gedetailleerd
 * stappenplan en hoeveelheden. Alles wat de bron al had blijft onaangetast;
 * aanvullingen houden confidence 0.5 zodat de review ze als controlepunt kan
 * tonen, zonder technische AI-herkomsttekst in het recept.
 */

/** wat de client opstuurt: de huidige (mogelijk al bewerkte) recept-staat */
export const EnrichInput = ParsedRecipe.partial().extend({
  title: z.string().min(1),
  servings_base: z.number().int().positive().default(2),
  source_capture: z.object({
    title: z.string().nullable().optional(),
    author: z.string().nullable().optional(),
    caption: z.string().nullable().optional(),
    transcript: z.string().nullable().optional(),
    structured_ingredients: z.array(z.string()).optional(),
    structured_steps: z.array(z.string()).optional(),
  }).optional(),
});
export type EnrichInput = z.infer<typeof EnrichInput>;

const SYSTEM_PROMPT = `Je bent de recept-aanvuller van Prakkie, een Nederlandse boodschappen-app.
Je krijgt een bestaand maar onvolledig recept. Vul de gaten — verzin niets opnieuw wat er al staat.

HARDE REGELS:
- Alle output in natuurlijk Nederlands.
- WIJZIG NIETS aan wat er al goed staat: bestaande titel, ingrediëntkeuzes,
  bestaande hoeveelheden en bruikbare stappen blijven letterlijk behouden.
- BEREIDING: lever ALTIJD een gedetailleerd stappenplan af (minimaal 4 stappen).
  Bestaande dunne of vage stappen werk je uit tot duidelijke, uitvoerbare stappen
  met concrete tijden en temperaturen; herken timers ("20 min sudderen" → timer_seconds 1200).
- HOEVEELHEDEN: elk ingrediënt zonder hoeveelheid krijgt een realistische
  hoeveelheid in Nederlandse supermarktmaten (g, ml, el, tl, stuks), passend bij
  servings_base — behalve waar "naar smaak" echt logischer is (peper, zout).
- Elke aanvulling die niet uit de bron komt krijgt confidence 0.5 en note null.
  Bestaande regels en hun confidence blijven ongewijzigd.
- Ontbreekt een overduidelijk basisingrediënt dat de stappen gebruiken (olie om
  te bakken, zout, kookvocht)? Voeg het toe met confidence 0.5 en note null.
- Vul time_prep_min en time_cook_min met een realistische schatting als ze ontbreken.
- missing_fields: alleen wat je ná het aanvullen écht niet kon bepalen.
- Antwoord met ALLEEN een JSON-object dat aan het schema voldoet.`;

const SCHEMA_HINT = `JSON-schema (verplichte vorm): {
 "title": string, "source_author": string|null, "images": string[],
 "servings_base": int,
 "time_prep_min": int|null, "time_cook_min": int|null,
 "ingredients": [{"raw_text": string, "quantity": number|null, "unit": string|null, "item_normalised": string|null, "note": string|null, "confidence": number|null}],
 "steps": [{"order": int, "text": string, "timer_seconds"?: int}],
 "tags": string[], "cuisine": string|null, "diet_flags": ("vegetarisch"|"vegan"|"glutenvrij"|"halal"|"lactosevrij")[],
 "nutrition": {"kcal"?: number, "protein_g"?: number, "carbs_g"?: number, "fat_g"?: number}|null,
 "missing_fields": string[] }`;

export async function enrichRecipe(input: EnrichInput): Promise<z.infer<typeof ParsedRecipe>> {
  let feedback: string | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    const user = [
      `HUIDIG RECEPT (onvolledig):\n${JSON.stringify(input, null, 1)}`,
      SCHEMA_HINT,
      feedback ? `VORIGE POGING AFGEKEURD:\n${feedback}` : '',
    ]
      .filter(Boolean)
      .join('\n\n');
    const raw = await callOpenAI([
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: user },
    ]);
    const parsed = ParsedRecipe.safeParse(raw);
    if (parsed.success) return parsed.data;
    feedback = JSON.stringify(parsed.error.flatten().fieldErrors).slice(0, 1500);
  }
  throw new Error('enrichRecipe: model output failed schema validation twice');
}
