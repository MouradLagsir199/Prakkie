import { ApifyError, runApifyActor } from './apify';
import {
  clampTranscript,
  detectPlatform,
  fetchPageMetadata,
  fetchPlatformOembed,
  hasUsableRecipeSignal,
  MAX_SOCIAL_VIDEO_SECONDS,
  type LinkContext,
} from './context';

/**
 * Per-platform LinkContext collectors — docs/06 §4 ported verbatim: actor ids,
 * input JSON and fallback ladders are the owner's tested configuration.
 */

const IG_TRANSCRIPT_ACTOR = 'S9A11NvceWaGorwwh';
const UNIVERSAL_TRANSCRIPT_ACTOR = 'CVQmx5Se22zxPaWc1';
const FB_POST_ACTOR = 'KoJrdxJCTtpon81KY';
const PINTEREST_MEDIA_ACTOR = 'tseqJicQpIxyFdHNB';
const DIRECT_MEDIA_TRANSCRIPT_ACTOR = 'VZTENHFJOyJEGIKCv';

type Item = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

function firstImage(item: Item): string | null {
  for (const key of ['displayUrl', 'imageUrl', 'thumbnailUrl', 'thumbnail', 'image']) {
    const v = item[key];
    if (typeof v === 'string' && v) return v;
    if (v && typeof v === 'object' && 'url' in (v as Item)) return str((v as Item).url);
  }
  for (const key of ['images', 'displayResources', 'media']) {
    const arr = item[key];
    if (Array.isArray(arr) && arr.length) {
      const first = arr[0] as Item | string;
      if (typeof first === 'string') return first;
      return str(first?.url ?? first?.src ?? (first as Item)?.imageUrl);
    }
  }
  return null;
}

const igCaption = (i: Item) => str(i.caption) ?? str(i.description) ?? str(i.text) ?? str(i.alt);
const igOwner = (i: Item) => str(i.ownerUsername) ?? str(i.username) ?? str(i.ownerFullName) ?? str(i.fullName);

async function tryActor(
  ctx: LinkContext,
  label: string,
  fn: () => Promise<unknown[]>
): Promise<Item | null> {
  try {
    const items = await fn();
    return (items[0] as Item) ?? null;
  } catch (err) {
    ctx.warnings.push(`${label}: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

async function universalTranscript(ctx: LinkContext): Promise<void> {
  const item = await tryActor(ctx, 'universal-transcript', () =>
    runApifyActor(UNIVERSAL_TRANSCRIPT_ACTOR, { start_urls: ctx.url })
  );
  const transcript = clampTranscript(str(item?.transcript) ?? str(item?.text) ?? str(item?.captions));
  if (transcript) ctx.transcript = transcript;
  else ctx.warnings.push('universal-transcript: no usable transcript');
}

// ---------- Instagram (docs/06 §4.1 — its own path) ----------

async function collectInstagram(ctx: LinkContext): Promise<void> {
  const meta = await fetchPageMetadata(ctx.url, 12);
  if (meta) Object.assign(ctx, { title: meta.title, description: meta.description, image: meta.image, jsonLd: meta.jsonLd });
  if (hasUsableRecipeSignal(ctx)) return;

  const isReel = /\/reel\//.test(ctx.url);
  const ladder: [string, () => Promise<unknown[]>][] = [
    ...(isReel
      ? ([[
          'ig-reel-scraper',
          () =>
            runApifyActor('apify~instagram-reel-scraper', {
              username: [ctx.url], resultsLimit: 1, includeTranscript: false,
              includeDownloadedVideo: false, includeSharesCount: false,
            }),
        ]] as [string, () => Promise<unknown[]>][])
      : []),
    [
      'ig-scraper',
      () =>
        runApifyActor('apify~instagram-scraper', {
          directUrls: [ctx.url], resultsType: isReel ? 'reels' : 'posts', resultsLimit: 1, addParentData: false,
        }),
    ],
    [
      'ig-post-scraper',
      () => runApifyActor('apify~instagram-post-scraper', { username: [ctx.url], resultsLimit: 1, dataDetailLevel: 'basicData' }),
    ],
  ];
  for (const [label, fn] of ladder) {
    const item = await tryActor(ctx, label, fn);
    const caption = item ? igCaption(item) : null;
    if (!caption) continue; // a metadata result without caption counts as failed (spec §4.1.4)
    ctx.description = caption;
    ctx.author = ctx.author ?? (item ? igOwner(item) : null);
    ctx.image = ctx.image ?? (item ? firstImage(item) : null);
    break;
  }
  if (hasUsableRecipeSignal(ctx)) return;

  const ig = await tryActor(ctx, 'ig-transcript', () => runApifyActor(IG_TRANSCRIPT_ACTOR, { videoUrl: ctx.url }));
  ctx.transcript = clampTranscript(str(ig?.transcript) ?? str(ig?.text));
  if (!ctx.transcript) await universalTranscript(ctx);
}

// ---------- Facebook (docs/06 §4.3) ----------

async function collectFacebook(ctx: LinkContext): Promise<void> {
  const [meta, post] = await Promise.all([
    fetchPageMetadata(ctx.url, 12),
    tryActor(ctx, 'fb-post-scraper', () =>
      runApifyActor(FB_POST_ACTOR, { startUrls: [{ url: ctx.url }], resultsLimit: 1, captionText: true })
    ),
  ]);
  if (meta) Object.assign(ctx, { title: meta.title, description: meta.description, image: meta.image, jsonLd: meta.jsonLd });
  if (post) {
    const shared = post.sharedPost as Item | undefined;
    const text = str(post.text) ?? (shared ? str(shared.text) : null);
    if (text) ctx.description = text;
    ctx.image = (shared ? firstImage(shared) : null) ?? firstImage(post) ?? ctx.image;
    ctx.author = str(post.user && (post.user as Item).name) ?? ctx.author;
  }
  const looksLikeVideo = /\/videos?\/|fb\.watch|\/watch\//.test(ctx.url);
  if (!ctx.jsonLd?.ingredients.length && (looksLikeVideo || !hasUsableRecipeSignal(ctx))) {
    await universalTranscript(ctx);
  }
}

// ---------- Pinterest (docs/06 §4.4) ----------

async function collectPinterest(ctx: LinkContext): Promise<void> {
  const [meta, pinItem, oembed] = await Promise.all([
    fetchPageMetadata(ctx.url, 12),
    tryActor(ctx, 'pinterest-scraper', () =>
      runApifyActor(
        PINTEREST_MEDIA_ACTOR,
        {
          startUrls: [ctx.url], type: 'all-pins', limit: 1,
          sentinent_analysis: false, content_analysis: false,
          proxyConfiguration: { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] },
        },
        { maxTotalChargeUsd: 1.0 }
      )
    ),
    fetchPlatformOembed(ctx.url, 'pinterest'),
  ]);
  if (meta) Object.assign(ctx, { title: meta.title, description: meta.description, image: meta.image, jsonLd: meta.jsonLd });
  if (oembed) {
    ctx.title = ctx.title ?? oembed.title;
    ctx.author = ctx.author ?? oembed.author;
  }

  const item = pinItem ?? {};
  const pin = ((item as Item).pin as Item | undefined) ?? (item as Item); // newer nested format
  const rich = ((pin.rich_summary as Item) ?? {}) as Item;
  ctx.description =
    str(rich.display_description) ?? str(pin.closeup_description) ?? str(pin.description) ??
    str(pin.closeup_unified_description) ?? str(pin.alt_text) ?? str((item as Item).description) ??
    str((item as Item).text) ?? str((item as Item).caption) ?? ctx.description;
  ctx.image = firstImage(item as Item) ?? firstImage(pin) ?? ctx.image;
  ctx.author = str(((item as Item).creator as Item | undefined)?.full_name) ?? ctx.author;
  ctx.linkedRecipeUrl =
    str((item as Item).source_url) ?? str((item as Item).sourceUrl) ?? str((item as Item).trackedLink) ??
    str((item as Item).link) ?? str(pin.tracked_link) ?? str(pin.trackedLink) ?? str(pin.link) ?? str(pin.sourceUrl);

  const richRecipe = (pin.rich_metadata as Item | undefined)?.recipe;
  if (richRecipe && !ctx.jsonLd) {
    const r = richRecipe as Item;
    ctx.jsonLd = {
      name: str(r.name), description: str(r.description) ?? null, images: [],
      ingredients: ((r.ingredients as unknown[]) ?? []).map((i) => String((i as Item)?.name ?? i)).filter(Boolean),
      instructions: ((r.instructions as unknown[]) ?? []).map((i) => String((i as Item)?.text ?? i)).filter(Boolean),
      prepMinutes: null, cookMinutes: null, totalMinutes: null, recipeYield: str(r.yields), author: null, nutrition: null,
    };
  }
  if (ctx.linkedRecipeUrl) {
    const linked = await fetchPageMetadata(ctx.linkedRecipeUrl, 12);
    if (linked?.jsonLd && !ctx.jsonLd?.ingredients.length) ctx.jsonLd = linked.jsonLd;
    ctx.title = ctx.title ?? linked?.title ?? null;
  }
  if (ctx.jsonLd?.ingredients.length) return;

  // video tail: captions first, then direct media transcription under strict cost guards
  const videoUrl = str(pin.video_url) ?? str((item as Item).videoUrl);
  const captionsUrl = str(pin.captions_url) ?? str((item as Item).captionsUrl);
  const durationSeconds = Number(pin.duration ?? (item as Item).duration ?? NaN);
  if (captionsUrl) {
    try {
      const res = await fetch(captionsUrl);
      if (res.ok) ctx.transcript = clampTranscript((await res.text()).replace(/<[^>]+>/g, ' '));
    } catch (err) {
      ctx.warnings.push(`pinterest-captions: ${err instanceof Error ? err.message : err}`);
    }
  }
  if (!ctx.transcript && videoUrl && Number.isFinite(durationSeconds) && durationSeconds <= MAX_SOCIAL_VIDEO_SECONDS) {
    const t = await tryActor(ctx, 'direct-media-transcript', () =>
      runApifyActor(
        DIRECT_MEDIA_TRANSCRIPT_ACTOR,
        { mediaUrl: videoUrl, maxAudioMinutes: 5, diarize: false, smartFormat: true },
        { maxTotalChargeUsd: 0.25, timeoutMs: 180_000 }
      )
    );
    ctx.transcript = clampTranscript(str(t?.transcript) ?? str(t?.text));
  }
}

// ---------- TikTok / YouTube / blog (docs/06 §4.2, §4.5, §4.6) ----------

async function collectTiktok(ctx: LinkContext): Promise<void> {
  const [meta, oembed] = await Promise.all([fetchPageMetadata(ctx.url, 12), fetchPlatformOembed(ctx.url, 'tiktok')]);
  if (meta) Object.assign(ctx, { title: meta.title, description: meta.description, image: meta.image, jsonLd: meta.jsonLd });
  if (oembed) {
    ctx.title = ctx.title ?? oembed.title;
    ctx.description = ctx.description ?? oembed.title; // TikTok oEmbed title carries the caption
    ctx.author = ctx.author ?? oembed.author;
  }
  if (!ctx.jsonLd?.ingredients.length) await universalTranscript(ctx); // always try (spec §4.2.4)
}

async function collectMetadataOnly(ctx: LinkContext): Promise<void> {
  const meta = await fetchPageMetadata(ctx.url, 12);
  if (!meta) {
    ctx.warnings.push('page-metadata: fetch failed');
    return;
  }
  Object.assign(ctx, {
    title: meta.title, description: meta.description, image: meta.image,
    author: meta.author, jsonLd: meta.jsonLd,
  });
}

/** true ⇒ this platform may need the slow (video transcript) path. */
export function isSlowPath(platform: string): boolean {
  return platform === 'instagram' || platform === 'tiktok' || platform === 'facebook' || platform === 'pinterest';
}

export async function collectLinkContext(url: string): Promise<LinkContext> {
  const ctx: LinkContext = {
    url, platform: detectPlatform(url), title: null, description: null, image: null,
    author: null, jsonLd: null, transcript: null, linkedRecipeUrl: null, warnings: [],
  };
  try {
    switch (ctx.platform) {
      case 'instagram': await collectInstagram(ctx); break;
      case 'facebook': await collectFacebook(ctx); break;
      case 'pinterest': await collectPinterest(ctx); break;
      case 'tiktok': await collectTiktok(ctx); break;
      default: await collectMetadataOnly(ctx); // youtube = metadata-only (spec §4.5), blog = JSON-LD-first
    }
  } catch (err) {
    ctx.warnings.push(err instanceof ApifyError ? `${err.kind}: ${err.message}` : String(err));
  }
  return ctx;
}
