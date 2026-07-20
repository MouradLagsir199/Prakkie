import { extractJsonLdRecipe, isoDurationToMinutes } from '@prakkie/shared';
import { describe, expect, it } from 'vitest';
import { detectPlatform, failureKind, hasUsableRecipeSignal, sourceCaptureOf, type LinkContext } from './context';
import { buildMessages, normaliseDutchRecipe } from './parse-recipe';
import {
  actorFailureMessage,
  captionTitleHint,
  extractFacebookPost,
  isSlowPath,
  usableSocialTitle,
} from './platforms';

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

describe('social/video collection routing', () => {
  it('always sends every video platform, including YouTube, through the transcript worker', () => {
    for (const platform of ['instagram', 'tiktok', 'facebook', 'pinterest', 'youtube']) {
      expect(isSlowPath(platform)).toBe(true);
    }
    expect(isSlowPath('blog')).toBe(false);
  });
});

describe('social source quality guards', () => {
  it('rejects platform slogans and derives a concise recipe title from the caption', () => {
    expect(usableSocialTitle('TikTok - Make Your Day', 'tiktok')).toBeNull();
    expect(usableSocialTitle('Instagram', 'instagram')).toBeNull();
    expect(captionTitleHint('Indian spiced cheesey garlic naan wraps🧄\nIngredients:\n- flour')).toBe(
      'Indian spiced cheesey garlic naan wraps'
    );
    expect(captionTitleHint('Creamy Chicken Orzo, rich, hearty, and full of flavor.')).toBe('Creamy Chicken Orzo');
    expect(captionTitleHint('#recipes #food #easyrecipes')).toBeNull();
  });

  it('recognises actor failures returned inside a successful dataset response', () => {
    expect(actorFailureMessage({ status: 'failed', error: 'Usage limit exceeded' })).toBe('Usage limit exceeded');
    expect(actorFailureMessage({ status: 'success', text: 'ok' })).toBeNull();
  });

  it('reads Facebook Reel text, thumbnail, author and media metadata from the nested payload', () => {
    const extracted = extractFacebookPost({
      message: { text: 'Maak deze snelle pasta.' },
      short_form_video_context: {
        video_owner: { name: 'Super Recipes' },
        video: { first_frame_thumbnail: { uri: 'https://cdn.example/thumb.jpg' } },
        playback_video: {
          length_in_second: 88.655,
          videoDeliveryLegacyFields: { browser_native_sd_url: 'https://cdn.example/video.mp4' },
        },
      },
    });
    expect(extracted).toEqual({
      text: 'Maak deze snelle pasta.',
      image: 'https://cdn.example/thumb.jpg',
      author: 'Super Recipes',
      mediaUrl: 'https://cdn.example/video.mp4',
      durationSeconds: 88.655,
    });
  });
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
    expect(msgs[0]!.content).toContain('neutral oil');
    expect(msgs[0]!.content).toContain('1 cup = 240 ml');
    expect(msgs[0]!.content).toContain('raw_text is óók Nederlands');
    expect(user).toContain('PLATFORM: instagram');
    expect(user).toContain('caption hier');
    expect(user).toContain('transcript hier');
    expect(user).toContain('missing_fields');
    expect(msgs[0]!.content).toContain('VERZIN OF VUL NIETS AAN');
    expect(msgs[0]!.content).toContain('note is bij deze eerste import altijd null');
    expect(msgs[0]!.content).not.toContain('WEL gewenst — AI-SUGGESTIES');
  });

  it('keeps the exact API capture available for review', () => {
    const capture = sourceCaptureOf(base({
      title: 'Pasta uit de bron',
      description: 'Caption zonder wijzigingen',
      transcript: 'Doe de pasta in de pan en kook deze acht minuten.'.repeat(2),
      jsonLd: {
        name: 'Pasta', description: null, images: [], ingredients: ['200 g pasta'],
        instructions: ['Kook acht minuten.'], prepMinutes: null, cookMinutes: 8,
        totalMinutes: 8, recipeYield: null, author: null, nutrition: null,
      },
    }));
    expect(capture.caption).toBe('Caption zonder wijzigingen');
    expect(capture.structured_ingredients).toEqual(['200 g pasta']);
    expect(capture.structured_steps).toEqual(['Kook acht minuten.']);
  });
});

describe('Dutch ingredient and unit normalisation', () => {
  it('translates common product terms and converts cups to metric units', () => {
    const recipe = normaliseDutchRecipe({
      title: 'Indian spiced garlic naan wraps', source_author: null, images: [], servings_base: 2,
      time_prep_min: null, time_cook_min: null,
      ingredients: [
        { raw_text: '1 cup neutral oil', quantity: 1, unit: 'cup', item_normalised: 'neutral oil', note: null, confidence: 1 },
        { raw_text: '2 cups all-purpose flour', quantity: 2, unit: 'cups', item_normalised: 'all-purpose flour', note: null, confidence: 1 },
        { raw_text: '3 garlic cloves', quantity: 3, unit: null, item_normalised: 'garlic', note: null, confidence: 1 },
      ],
      steps: [], tags: [], cuisine: null, diet_flags: [], nutrition: null, missing_fields: [],
    });
    expect(recipe.title).toContain('Indiaas gekruide');
    expect(recipe.ingredients[0]).toMatchObject({ quantity: 240, unit: 'ml', item_normalised: 'olie' });
    expect(recipe.ingredients[1]).toMatchObject({ quantity: 240, unit: 'g', item_normalised: 'tarwebloem' });
    expect(recipe.ingredients[2]!.item_normalised).toBe('knoflook');
  });
});
