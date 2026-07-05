/**
 * Shared schema.org Recipe JSON-LD extractor — built for WS3 import, reused
 * unchanged by the WS7 discovery crawler (plan/05). Pure string→data, no DOM.
 */

export interface JsonLdRecipe {
  name: string | null;
  description: string | null;
  images: string[];
  ingredients: string[];
  instructions: string[];
  prepMinutes: number | null;
  cookMinutes: number | null;
  totalMinutes: number | null;
  recipeYield: string | null;
  author: string | null;
  nutrition: Record<string, string> | null;
}

/** "PT1H30M" → 90 */
export function isoDurationToMinutes(iso: string | null | undefined): number | null {
  if (!iso || typeof iso !== 'string') return null;
  const m = iso.match(/^-?PT?(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/i);
  if (!m || (!m[1] && !m[2] && !m[3])) return null;
  return Math.round((parseFloat(m[1] ?? '0') * 60 + parseFloat(m[2] ?? '0') + parseFloat(m[3] ?? '0') / 60));
}

function asArray<T>(v: T | T[] | undefined | null): T[] {
  return v == null ? [] : Array.isArray(v) ? v : [v];
}

function textOf(v: unknown): string | null {
  if (typeof v === 'string') return v.trim() || null;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return textOf(o.name) ?? textOf(o.text) ?? textOf(o['@value']) ?? null;
  }
  return null;
}

function imagesOf(v: unknown): string[] {
  return asArray(v)
    .map((i) => (typeof i === 'string' ? i : (i as { url?: string })?.url ?? null))
    .filter((u): u is string => !!u);
}

function instructionsOf(v: unknown): string[] {
  const out: string[] = [];
  for (const step of asArray(v)) {
    if (typeof step === 'string') {
      out.push(step.trim());
      continue;
    }
    const o = step as Record<string, unknown>;
    const type = String(o['@type'] ?? '');
    if (type.includes('HowToSection')) {
      out.push(...instructionsOf(o.itemListElement));
    } else {
      const t = textOf(o);
      if (t) out.push(t);
    }
  }
  return out.filter(Boolean);
}

function isRecipeNode(node: unknown): node is Record<string, unknown> {
  if (!node || typeof node !== 'object') return false;
  const t = (node as Record<string, unknown>)['@type'];
  return asArray(t).some((x) => String(x).toLowerCase() === 'recipe');
}

function* candidateNodes(doc: unknown): Generator<Record<string, unknown>> {
  for (const node of asArray(doc)) {
    if (!node || typeof node !== 'object') continue;
    const o = node as Record<string, unknown>;
    if (isRecipeNode(o)) yield o;
    for (const g of asArray(o['@graph'])) if (isRecipeNode(g)) yield g as Record<string, unknown>;
    // some sites nest under mainEntity
    if (isRecipeNode(o.mainEntity)) yield o.mainEntity as Record<string, unknown>;
  }
}

/** Extract the first schema.org Recipe from raw HTML (script ld+json blocks). */
export function extractJsonLdRecipe(html: string): JsonLdRecipe | null {
  const scripts = html.matchAll(
    /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  );
  for (const match of scripts) {
    let doc: unknown;
    try {
      doc = JSON.parse(match[1]!.trim());
    } catch {
      continue; // malformed block; try the next one
    }
    for (const node of candidateNodes(doc)) {
      const nutritionRaw = node.nutrition as Record<string, unknown> | undefined;
      const nutrition = nutritionRaw
        ? Object.fromEntries(
            Object.entries(nutritionRaw)
              .filter(([k, v]) => k !== '@type' && typeof v === 'string')
              .map(([k, v]) => [k, String(v)])
          )
        : null;
      return {
        name: textOf(node.name),
        description: textOf(node.description),
        images: imagesOf(node.image),
        ingredients: asArray(node.recipeIngredient ?? node.ingredients).map((i) => String(i).trim()).filter(Boolean),
        instructions: instructionsOf(node.recipeInstructions),
        prepMinutes: isoDurationToMinutes(node.prepTime as string),
        cookMinutes: isoDurationToMinutes(node.cookTime as string),
        totalMinutes: isoDurationToMinutes(node.totalTime as string),
        recipeYield: asArray(node.recipeYield).map(textOf).find(Boolean) ?? null,
        author: asArray(node.author).map(textOf).find(Boolean) ?? null,
        nutrition: nutrition && Object.keys(nutrition).length ? nutrition : null,
      };
    }
  }
  return null;
}
