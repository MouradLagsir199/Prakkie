import { ApifyError, runApifyActor } from './apify';
import { env } from '../env';
import {
  clampTranscript,
  detectPlatform,
  fetchPageMetadata,
  fetchPlatformOembed,
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
const TIKTOK_TRANSCRIPT_ACTOR = 'clockworks~tiktok-transcript-extractor';

type Item = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

function nested(item: Item | null | undefined, ...path: string[]): unknown {
  let value: unknown = item;
  for (const key of path) {
    if (!value || typeof value !== 'object') return null;
    value = (value as Item)[key];
  }
  return value;
}

/** Social sites frequently use their marketing slogan as og:title. It is not
 * a recipe title and must never reach the parser as if it were source data. */
export function usableSocialTitle(title: string | null | undefined, platform: LinkContext['platform']): string | null {
  const clean = title?.replace(/\s+/g, ' ').trim();
  if (!clean) return null;
  const generic =
    /^(?:instagram|facebook|tiktok|pinterest)(?:\s*[-|:]\s*.*)?$/i.test(clean) ||
    /make your day/i.test(clean) ||
    (platform === 'facebook' && /(?:weergaven|views).*(?:reacties|comments)/i.test(clean));
  return generic ? null : clean;
}

/** Captions commonly start with the human recipe name, followed by an emoji,
 * comma or ingredient section. Keep that concise lead instead of a platform
 * slogan or the entire caption. */
export function captionTitleHint(caption: string | null | undefined): string | null {
  const firstLine = caption?.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  if (!firstLine) return null;
  if (/^#/.test(firstLine) || (firstLine.match(/#/g)?.length ?? 0) >= 2) return null;
  let lead = firstLine
    .replace(/^#+\s*/, '')
    .split(/\b(?:ingredients?|ingrediënten|for recipe|recipe below)\b/i)[0]!
    .split(/\p{Extended_Pictographic}/u)[0]!
    .split(/[.!?]/)[0]!
    .trim();
  const comma = lead.indexOf(',');
  if (comma >= 0 && lead.slice(0, comma).trim().split(/\s+/).length >= 2) lead = lead.slice(0, comma).trim();
  lead = lead.replace(/[\s:;,-]+$/, '').trim();
  if (!lead || lead.length < 3) return null;
  return lead.length > 90 ? `${lead.slice(0, 87).trim()}…` : lead;
}

export function actorFailureMessage(item: Item | null | undefined): string | null {
  if (!item) return null;
  const status = str(item.status)?.toLowerCase();
  const error = str(item.error) ?? str(item.errorCode) ?? str(item.errMsg);
  return status === 'failed' || error ? error ?? `actor status ${status}` : null;
}

function transcriptText(value: unknown): string | null {
  if (typeof value === 'string') return clampTranscript(value.replace(/<[^>]+>/g, ' '));
  if (Array.isArray(value)) {
    return clampTranscript(value.map((part) => str((part as Item)?.text) ?? str(part)).filter(Boolean).join(' '));
  }
  if (value && typeof value === 'object') {
    return clampTranscript(
      str((value as Item).full_text) ?? str((value as Item).fullText) ?? str((value as Item).text)
    );
  }
  return null;
}

async function fetchTranscriptFile(url: string | null): Promise<string | null> {
  if (!url || !/^https:\/\//i.test(url)) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const isApifyStorage = new URL(url).hostname === 'api.apify.com';
    const res = await fetch(url, {
      signal: controller.signal,
      headers: isApifyStorage ? { authorization: `Bearer ${env.apifyToken}` } : undefined,
    });
    if (!res.ok) return null;
    const raw = await res.text();
    // VTT/SRT: remove headers, timestamps, counters and duplicate rolling captions.
    const lines = raw.split(/\r?\n/)
      .map((line) => line.replace(/<[^>]+>/g, '').trim())
      .filter((line) => line && !/^(?:WEBVTT|\d+|\d\d:\d\d(?::\d\d)?[.,]\d+\s*-->)/i.test(line));
    return clampTranscript(lines.filter((line, index) => line !== lines[index - 1]).join(' '));
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function firstImage(item: Item): string | null {
  for (const key of ['displayUrl', 'imageUrl', 'thumbnailUrl', 'thumbnail', 'image', 'img']) {
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
const igOwner = (i: Item) =>
  str(i.ownerUsername) ?? str(i.username) ?? str(i.userName) ?? str(i.ownerFullName) ?? str(i.userFullName) ?? str(i.fullName);

/** Preserve complementary text returned by page metadata, social APIs and
 * linked pages. A short caption must never replace (or prevent collection of)
 * a richer description/transcript. */
function mergeText(...values: Array<string | null | undefined>): string | null {
  const unique: string[] = [];
  for (const value of values) {
    const clean = value?.trim();
    const folded = clean?.replace(/\s+/g, ' ');
    if (!clean || !folded || unique.some((existing) => {
      const previous = existing.replace(/\s+/g, ' ');
      return previous === folded || previous.includes(folded) || folded.includes(previous);
    })) continue;
    unique.push(clean);
  }
  return unique.length ? unique.join('\n\n') : null;
}

export interface FacebookPostExtraction {
  text: string | null;
  image: string | null;
  author: string | null;
  mediaUrl: string | null;
  durationSeconds: number | null;
}

/** The Facebook actor's Reel payload lives under short_form_video_context;
 * older posts use flat text/user/image fields. Read both shapes. */
export function extractFacebookPost(post: Item): FacebookPostExtraction {
  const shared = post.sharedPost as Item | undefined;
  const duration = Number(
    nested(post, 'short_form_video_context', 'playback_video', 'length_in_second') ??
    nested(post, 'short_form_video_context', 'video', 'duration') ?? NaN
  );
  return {
    text: mergeText(
      str(post.text), str(nested(post, 'message', 'text')),
      shared ? str(shared.text) : null, shared ? str(nested(shared, 'message', 'text')) : null
    ),
    image:
      str(nested(post, 'short_form_video_context', 'video', 'first_frame_thumbnail')) ??
      str(nested(post, 'short_form_video_context', 'video', 'first_frame_thumbnail', 'uri')) ??
      str(nested(post, 'short_form_video_context', 'playback_video', 'thumbnailImage', 'uri')) ??
      (shared ? firstImage(shared) : null) ?? firstImage(post),
    author:
      str(nested(post, 'short_form_video_context', 'video_owner', 'name')) ??
      str(nested(post, 'user', 'name')),
    mediaUrl:
      str(nested(post, 'short_form_video_context', 'playback_video', 'videoDeliveryLegacyFields', 'browser_native_hd_url')) ??
      str(nested(post, 'short_form_video_context', 'playback_video', 'videoDeliveryLegacyFields', 'browser_native_sd_url')),
    durationSeconds: Number.isFinite(duration) && duration > 0 ? duration : null,
  };
}

async function tryActor(
  ctx: LinkContext,
  label: string,
  fn: () => Promise<unknown[]>
): Promise<Item | null> {
  try {
    const items = await fn();
    const item = (items[0] as Item) ?? null;
    const failure = actorFailureMessage(item);
    if (failure) {
      ctx.warnings.push(`${label}: ${failure}`);
      return null;
    }
    return item;
  } catch (err) {
    ctx.warnings.push(`${label}: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

async function universalTranscript(ctx: LinkContext): Promise<void> {
  const item = await tryActor(ctx, 'universal-transcript', () =>
    runApifyActor(UNIVERSAL_TRANSCRIPT_ACTOR, { start_urls: ctx.url })
  );
  const transcript = transcriptText(item?.transcript) ?? transcriptText(item?.text) ?? transcriptText(item?.captions);
  if (transcript) ctx.transcript = transcript;
  else if (item) ctx.warnings.push('universal-transcript: no usable transcript');
}

// ---------- Instagram (docs/06 §4.1 — its own path) ----------

async function collectInstagram(ctx: LinkContext): Promise<void> {
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
  // Collect every available source. Previously a usable meta description or
  // caption returned early and silently skipped the video transcript.
  const [meta, socialItems, ig, universal] = await Promise.all([
    fetchPageMetadata(ctx.url, 12),
    Promise.all(ladder.map(([label, fn]) => tryActor(ctx, label, fn))),
    tryActor(ctx, 'ig-transcript', () => runApifyActor(IG_TRANSCRIPT_ACTOR, { videoUrl: ctx.url })),
    (async () => {
      const isolated: LinkContext = { ...ctx, warnings: ctx.warnings };
      await universalTranscript(isolated);
      return isolated.transcript;
    })(),
  ]);
  if (meta) Object.assign(ctx, { image: meta.image, jsonLd: meta.jsonLd });
  const items = socialItems.filter((item): item is Item => item !== null);
  ctx.description = mergeText(meta?.description, ...items.map(igCaption), str(ig?.title));
  ctx.author = igOwner(ig ?? {}) ?? items.map(igOwner).find(Boolean) ?? meta?.author ?? ctx.author;
  ctx.image = firstImage(ig ?? {}) ?? items.map(firstImage).find(Boolean) ?? ctx.image;
  ctx.title = usableSocialTitle(meta?.title, 'instagram') ?? captionTitleHint(ctx.description);
  ctx.transcript = transcriptText(ig?.transcript) ?? transcriptText(ig?.segments) ?? transcriptText(ig?.text) ?? universal;
}

// ---------- Facebook (docs/06 §4.3) ----------

async function collectFacebook(ctx: LinkContext): Promise<void> {
  const [meta, post] = await Promise.all([
    fetchPageMetadata(ctx.url, 12),
    tryActor(ctx, 'fb-post-scraper', () =>
      runApifyActor(FB_POST_ACTOR, { startUrls: [{ url: ctx.url }], resultsLimit: 1, captionText: true })
    ),
  ]);
  if (meta) Object.assign(ctx, { description: meta.description, image: meta.image, jsonLd: meta.jsonLd });
  let durationSeconds = NaN;
  if (post) {
    const extracted = extractFacebookPost(post);
    ctx.description = mergeText(ctx.description, extracted.text);
    ctx.image = extracted.image ?? ctx.image;
    ctx.author = extracted.author ?? ctx.author;
    durationSeconds = extracted.durationSeconds ?? NaN;
  }
  ctx.title = usableSocialTitle(meta?.title, 'facebook') ?? captionTitleHint(ctx.description);
  // This actor can fetch a complete Facebook stream from the public page URL;
  // passing only the CDN fragment silently loses the audio track.
  if (!Number.isFinite(durationSeconds) || durationSeconds <= MAX_SOCIAL_VIDEO_SECONDS) {
    const transcript = await tryActor(ctx, 'facebook-transcript', () =>
      runApifyActor(
        DIRECT_MEDIA_TRANSCRIPT_ACTOR,
        { videoUrl: meta?.resolvedUrl ?? ctx.url, maxAudioMinutes: 5, diarize: false, smartFormat: true },
        { maxTotalChargeUsd: 0.25, timeoutMs: 90_000 }
      )
    );
    ctx.transcript = transcriptText(transcript?.transcript);
  }
  if (!ctx.transcript) await universalTranscript(ctx);
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
    ctx.image = ctx.image ?? oembed.image;
  }

  const item = pinItem ?? {};
  const pin = ((item as Item).pin as Item | undefined) ?? (item as Item); // newer nested format
  const rich = ((pin.rich_summary as Item) ?? {}) as Item;
  ctx.description = mergeText(
    ctx.description,
    str(rich.display_description), str(pin.closeup_description), str(pin.description),
    str(pin.closeup_unified_description), str(pin.alt_text), str((item as Item).description),
    str((item as Item).text), str((item as Item).caption)
  );
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
        { videoUrl: ctx.url, maxAudioMinutes: 5, diarize: false, smartFormat: true },
        { maxTotalChargeUsd: 0.25, timeoutMs: 180_000 }
      )
    );
    ctx.transcript = clampTranscript(str(t?.transcript) ?? str(t?.text));
  }
  if (!ctx.transcript) await universalTranscript(ctx);
}

// ---------- TikTok / YouTube / blog (docs/06 §4.2, §4.5, §4.6) ----------

async function collectTiktok(ctx: LinkContext): Promise<void> {
  const [meta, oembed, tiktok] = await Promise.all([
    fetchPageMetadata(ctx.url, 12),
    fetchPlatformOembed(ctx.url, 'tiktok'),
    tryActor(ctx, 'tiktok-transcript', () =>
      runApifyActor(
        TIKTOK_TRANSCRIPT_ACTOR,
        {
          postURLs: [ctx.url],
          // Native TikTok subtitles are materially faster. If a video has no
          // subtitles the caption remains usable and the user may explicitly
          // choose "Vul aan met AI" instead of waiting on automatic ASR.
          downloadSubtitlesOptions: 'DOWNLOAD_SUBTITLES',
        },
        { maxTotalChargeUsd: 0.25, timeoutMs: 120_000 }
      )
    ),
  ]);
  if (meta) Object.assign(ctx, { image: meta.image, jsonLd: meta.jsonLd });
  ctx.description = mergeText(meta?.description, oembed?.description, oembed?.title, str(tiktok?.text));
  ctx.title =
    usableSocialTitle(meta?.title, 'tiktok') ??
    captionTitleHint(str(tiktok?.text) ?? oembed?.title ?? ctx.description);
  ctx.author =
    str(nested(tiktok, 'authorMeta', 'nickName')) ??
    str(nested(tiktok, 'authorMeta', 'name')) ?? oembed?.author ?? meta?.author ?? null;
  ctx.image =
    str(nested(tiktok, 'videoMeta', 'coverUrl')) ??
    str(nested(tiktok, 'videoMeta', 'originalCoverUrl')) ?? oembed?.image ?? ctx.image;

  const subtitleLinks = nested(tiktok, 'videoMeta', 'subtitleLinks');
  const subtitleUrl = Array.isArray(subtitleLinks)
    ? str((subtitleLinks[0] as Item | undefined)?.downloadLink)
    : null;
  const transcriptionUrl = str(nested(tiktok, 'videoMeta', 'transcriptionLink'));
  ctx.transcript =
    transcriptText(tiktok?.transcript) ??
    await fetchTranscriptFile(subtitleUrl ?? transcriptionUrl);
}

async function collectYoutube(ctx: LinkContext): Promise<void> {
  await collectMetadataOnly(ctx);
  await universalTranscript(ctx);
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
  return platform === 'instagram' || platform === 'tiktok' || platform === 'facebook' ||
    platform === 'pinterest' || platform === 'youtube';
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
      case 'youtube': await collectYoutube(ctx); break;
      default: await collectMetadataOnly(ctx); // blog = JSON-LD-first
    }
  } catch (err) {
    ctx.warnings.push(err instanceof ApifyError ? `${err.kind}: ${err.message}` : String(err));
  }
  return ctx;
}
