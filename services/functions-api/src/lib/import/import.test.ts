import { extractJsonLdRecipe, isoDurationToMinutes } from '@prakkie/shared';
import { describe, expect, it } from 'vitest';
import { detectPlatform, failureKind, hasUsableRecipeSignal, type LinkContext } from './context';
import { buildMessages } from './parse-recipe';

const base = (over: Partial<LinkContext>): LinkContext => ({
  url: 'https://example.com/r', platform: 'blog', title: null, description: null, image: null,
  author: null, jsonLd: null, transcript: null, linkedRecipeUrl: null, warnings: [], ...over,
});

describe('detectPlatform (docs/06 §1)', () => {
  const cases: [string, string][] = [
    ['https://www.instagram.com/reel/Cxyz/', 'instagram'],
    ['https://www.tiktok.com/@user/video/123', 'tiktok'],
    ['https://fb.watch/abc/', 'facebook'],
    ['https://www.facebook.com/user/posts/1', 'facebook'],
    ['https://pin.it/abc123', 'pinterest'],
    ['https://nl.pinterest.com/pin/1/', 'pinterest'],
    ['https://youtu.be/xyz', 'youtube'],
    ['https://www.leukerecepten.nl/recepten/pasta/', 'blog'],
    ['not a url', 'blog'],
  ];
  for (const [url, platform] of cases) it(`${url} → ${platform}`, () => expect(detectPlatform(url)).toBe(platform));
});

describe('JSON-LD extractor (shared, reused by WS7)', () => {
  it('parses a plain Recipe block', () => {
    const html = `<html><script type="application/ld+json">{"@context":"https://schema.org","@type":"Recipe",
      "name":"Shakshuka","recipeIngredient":["4 eieren","400 g tomatenblokjes"],
      "recipeInstructions":[{"@type":"HowToStep","text":"Fruit de ui."},{"@type":"HowToStep","text":"Voeg eieren toe."}],
      "prepTime":"PT10M","cookTime":"PT20M","recipeYield":"2 personen","author":{"@type":"Person","name":"Fatima"}}</script></html>`;
    const r = extractJsonLdRecipe(html)!;
    expect(r.name).toBe('Shakshuka');
    expect(r.ingredients).toHaveLength(2);
    expect(r.instructions).toEqual(['Fruit de ui.', 'Voeg eieren toe.']);
    expect(r.prepMinutes).toBe(10);
    expect(r.cookMinutes).toBe(20);
    expect(r.author).toBe('Fatima');
  });

  it('finds Recipe inside @graph and survives a malformed first block', () => {
    const html = `<script type="application/ld+json">{broken</script>
      <script type='application/ld+json'>{"@graph":[{"@type":"WebSite"},{"@type":["Recipe"],"name":"Stamppot",
      "recipeIngredient":["1 kg aardappelen"],"recipeInstructions":"Kook en stamp.","totalTime":"PT45M"}]}</script>`;
    const r = extractJsonLdRecipe(html)!;
    expect(r.name).toBe('Stamppot');
    expect(r.instructions).toEqual(['Kook en stamp.']);
    expect(r.totalMinutes).toBe(45);
  });

  it('returns null when no Recipe exists', () => {
    expect(extractJsonLdRecipe('<script type="application/ld+json">{"@type":"Article"}</script>')).toBeNull();
  });

  it('ISO durations', () => {
    expect(isoDurationToMinutes('PT1H30M')).toBe(90);
    expect(isoDurationToMinutes('PT45S')).toBe(1);
    expect(isoDurationToMinutes('garbage')).toBeNull();
  });
});

describe('hasUsableRecipeSignal / 422-vs-503 (docs/06 §5)', () => {
  it('JSON-LD with ingredients = usable', () => {
    expect(hasUsableRecipeSignal(base({ jsonLd: { name: 'x', description: null, images: [], ingredients: ['ui'], instructions: [], prepMinutes: null, cookMinutes: null, totalMinutes: null, recipeYield: null, author: null, nutrition: null } }))).toBe(true);
  });
  it('transcript ≥60 chars = usable', () => {
    expect(hasUsableRecipeSignal(base({ transcript: 'x'.repeat(80) }))).toBe(true);
  });
  it('pinterest linked recipe url = usable', () => {
    expect(hasUsableRecipeSignal(base({ platform: 'pinterest', linkedRecipeUrl: 'https://x.nl/r' }))).toBe(true);
  });
  it('long caption with recipe words = usable; without = not', () => {
    expect(hasUsableRecipeSignal(base({ description: 'Dit recept met 400 gram pasta en een lekkere saus, bereiding in de oven, echt super makkelijk koken!' }))).toBe(true);
    expect(hasUsableRecipeSignal(base({ description: 'Mooie dag op het strand vandaag met vrienden en familie, wat een prachtig weer hebben we toch hier.' }))).toBe(false);
  });
  it('transient warnings → 503, else 422', () => {
    expect(failureKind(['ig-scraper: Apify x → HTTP 500'])).toBe('transient_503');
    expect(failureKind(['rate limit exceeded'])).toBe('transient_503');
    expect(failureKind(['no public data'])).toBe('unusable_422');
  });
});

describe('parseRecipe prompt builder', () => {
  it('folds all context parts in and never leaks secrets', () => {
    const msgs = buildMessages(base({
      platform: 'instagram', title: 'Pasta', description: 'caption hier',
      transcript: 'transcript hier', author: '@kok',
    }));
    const user = msgs[1]!.content;
    expect(msgs[0]!.content).toContain('bosui');
    expect(user).toContain('PLATFORM: instagram');
    expect(user).toContain('caption hier');
    expect(user).toContain('transcript hier');
    expect(user).toContain('missing_fields');
  });
});
