import { z } from 'zod';
import { ParsedRecipe, callOpenAI } from './parse-recipe';

/**
 * generateRecipe — "Genereer recept" (owner 2026-07-10). Vierde AI-actie: de
 * gebruiker zoekt in Recepten ("nasi"), vindt niets, en laat het recept dan
 * genereren. Anders dan de import is hier géén bron — het hele recept is een
 * AI-product en wordt ook zo gemarkeerd (het review-scherm blijft de plek waar
 * de gebruiker het naleest en bewaart).
 */

const SYSTEM_PROMPT = `Je bent de recept-generator van Prakkie, een Nederlandse boodschappen-app.
De gebruiker zocht een gerecht dat niet in de collectie zit; jij schrijft er één compleet recept voor.

HARDE REGELS:
- Alle output in natuurlijk Nederlands; een klassieke, breed gedragen bereiding van het gerecht.
- Ingrediënten als Nederlandse supermarkttermen (item_normalised klein geschreven, enkelvoud),
  met realistische hoeveelheden in Nederlandse supermarktmaten (g, ml, el, tl, stuks) voor servings_base 2.
- BEREIDING: een gedetailleerd stappenplan van minimaal 4 duidelijke, uitvoerbare stappen
  met concrete tijden en temperaturen; herken timers ("20 min sudderen" → timer_seconds 1200).
- Vul time_prep_min en time_cook_min realistisch in; servings_base is 2.
- Elke regel krijgt confidence 1 (dit is een generatie, geen bron-reconstructie) en missing_fields blijft leeg.
- Genereer Nederlandse tags (gerechtstype, hoofdingrediënt, keuken, moment) en zet cuisine indien duidelijk.
- images blijft een lege lijst — verzin geen foto-URL's.
- Antwoord met ALLEEN een JSON-object dat aan het schema voldoet.`;

const SCHEMA_HINT = `JSON-schema (verplichte vorm): {
 "title": string, "source_author": null, "images": [],
 "servings_base": 2,
 "time_prep_min": int, "time_cook_min": int,
 "ingredients": [{"raw_text": string, "quantity": number|null, "unit": string|null, "item_normalised": string|null, "note": string|null, "confidence": number|null}],
 "steps": [{"order": int, "text": string, "timer_seconds"?: int}],
 "tags": string[], "cuisine": string|null, "diet_flags": ("vegetarisch"|"vegan"|"glutenvrij"|"halal"|"lactosevrij")[],
 "nutrition": {"kcal"?: number, "protein_g"?: number, "carbs_g"?: number, "fat_g"?: number}|null,
 "missing_fields": [] }`;

export async function generateRecipe(query: string): Promise<z.infer<typeof ParsedRecipe>> {
  let feedback: string | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    const user = [`GEVRAAGD GERECHT: "${query}"`, SCHEMA_HINT, feedback ? `VORIGE POGING AFGEKEURD:\n${feedback}` : '']
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
  throw new Error('generateRecipe: model output failed schema validation twice');
}
