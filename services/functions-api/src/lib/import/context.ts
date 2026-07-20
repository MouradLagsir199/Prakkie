import { extractJsonLdRecipe, type JsonLdRecipe } from '@prakkie/shared';

/**
 * LinkContext plumbing (docs/06 §1, §5): platform detection, page metadata,
 * oEmbed (TikTok + Pinterest only — per spec IG/FB/YouTube have none), and the
 * hasUsableRecipeSignal() go/no-go gate.
 */

export type Platform = 'instagram' | 'tiktok' | 'facebook' | 'pinterest' | 'youtube' | 'blog';

export interface LinkContext {
  url: string;
  platform: Platform;
  title: string | null;
  description: string | null; // caption / post text
  image: string | null;
  author: string | null;
  jsonLd: JsonLdRecipe | null;
  transcript: string | null;
  linkedRecipeUrl: string | null;
  warnings: string[];
}

/** De onbewerkte tekst die de import-API's daadwerkelijk hebben gevonden.
 * Deze reist mee naar de review, zodat de gebruiker vóór iedere AI-aanvulling
 * zelf kan zien wat caption, transcript en JSON-LD opleverden. */
export interface SourceCapture {
  title: string | null;
  author: string | null;
  caption: string | null;
  transcript: string | null;
  structured_ingredients: string[];
  structured_steps: string[];
}

export function sourceCaptureOf(ctx: LinkContext): SourceCapture {
  return {
    title: ctx.title,
    author: ctx.author,
    caption: ctx.description,
    transcript: ctx.transcript,
    structured_ingredients: ctx.jsonLd?.ingredients ?? [],
    structured_steps: ctx.jsonLd?.instructions ?? [],
  };
}

export const MAX_SOCIAL_VIDEO_SECONDS = 5 * 60;
export const MIN_TRANSCRIPT_CHARS = 40;
export const MAX_TRANSCRIPT_CHARS = 12_000;

export function detectPlatform(url: string): Platform {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return 'blog';
  }
  if (host.includes('instagram.com')) return 'instagram';
  if (host.includes('tiktok.com')) return 'tiktok';
  if (host.includes('facebook.com') || host.includes('fb.watch')) return 'facebook';
  if (host.includes('pinterest.') || host === 'pin.it') return 'pinterest';
  if (host.includes('youtube.com') || host === 'youtu.be') return 'youtube';
  return 'blog';
}

const BROWSER_HEADERS = {
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  accept: 'text/html,application/xhtml+xml',
  'accept-language': 'nl,en;q=0.8',
};

function metaContent(html: string, patterns: string[]): string | null {
  for (const p of patterns) {
    const rx = new RegExp(
      `<meta[^>]+(?:property|name)\\s*=\\s*["']${p}["'][^>]*content\\s*=\\s*["']([^"']+)["']|<meta[^>]+content\\s*=\\s*["']([^"']+)["'][^>]*(?:property|name)\\s*=\\s*["']${p}["']`,
      'i'
    );
    const m = html.match(rx);
    const v = m?.[1] ?? m?.[2];
    if (v) return decodeEntities(v.trim());
  }
  return null;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&#x27;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}

export interface PageMetadata {
  resolvedUrl: string;
  title: string | null;
  description: string | null;
  image: string | null;
  author: string | null;
  jsonLd: JsonLdRecipe | null;
}

export async function fetchPageMetadata(url: string, timeoutSeconds = 12): Promise<PageMetadata | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutSeconds * 1000);
  try {
    const res = await fetch(url, { headers: BROWSER_HEADERS, signal: controller.signal, redirect: 'follow' });
    if (!res.ok) return null;
    const html = await res.text();
    const title =
      metaContent(html, ['og:title', 'twitter:title']) ??
      (decodeEntities(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? '') || null);
    return {
      resolvedUrl: res.url || url,
      title,
      description: metaContent(html, ['og:description', 'twitter:description', 'description']),
      image: metaContent(html, ['og:image', 'twitter:image']),
      author: metaContent(html, ['og:site_name', 'author', 'twitter:creator']),
      jsonLd: extractJsonLdRecipe(html),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** TikTok + Pinterest are the only configured oEmbed endpoints (docs/06 §4). */
export async function fetchPlatformOembed(
  url: string,
  platform: Platform
): Promise<{ title: string | null; author: string | null; description: string | null; image: string | null } | null> {
  const endpoint =
    platform === 'tiktok'
      ? `https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`
      : platform === 'pinterest'
        ? `https://www.pinterest.com/oembed.json?url=${encodeURIComponent(url)}`
        : null;
  if (!endpoint) return null;
  try {
    const res = await fetch(endpoint, { headers: { accept: 'application/json' } });
    if (!res.ok) return null;
    const o = (await res.json()) as {
      title?: string; author_name?: string; description?: string; thumbnail_url?: string;
    };
    return {
      title: o.title ?? null,
      author: o.author_name ?? null,
      description: o.description ?? null,
      image: o.thumbnail_url ?? null,
    };
  } catch {
    return null;
  }
}

const RECIPE_WORDS =
  /ingredi[eë]nt|bereiding|bereidingswijze|recept|bakken|koken|oven|pan\b|sauce|saus|soup|soep|pasta|salade|dressing|marinade|deeg|beslag|serveer|eetlepel|theelepel|\bgram\b|\bml\b|recipe/i;

/** docs/06 §5 — is there enough source material for the parser? */
export function hasUsableRecipeSignal(ctx: LinkContext): boolean {
  const jl = ctx.jsonLd;
  if (jl && (jl.ingredients.length > 0 || jl.instructions.length > 0 || (jl.name && jl.description))) return true;
  if (ctx.transcript && ctx.transcript.length >= 60) return true;
  if (ctx.platform === 'pinterest' && ctx.linkedRecipeUrl) return true;
  const text = [ctx.title, ctx.description].filter(Boolean).join(' ');
  return text.length >= 80 && RECIPE_WORDS.test(text);
}

const TRANSIENT_RX = /rate.?limit|usage limit|memory.?limit|timeout|timed?.?out|http 5\d\d|econnre|abort/i;

/** 503 when warnings look transient, else 422 (docs/06 §5). */
export function failureKind(warnings: string[]): 'transient_503' | 'unusable_422' {
  return warnings.some((w) => TRANSIENT_RX.test(w)) ? 'transient_503' : 'unusable_422';
}

export function clampTranscript(raw: string | null | undefined): string | null {
  const t = raw?.trim();
  if (!t || t.length < MIN_TRANSCRIPT_CHARS) return null;
  return t.slice(0, MAX_TRANSCRIPT_CHARS);
}
