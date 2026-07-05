/**
 * Per-platform media specs the RenditionPlanner and validator read from.
 *
 * SOURCE OF TRUTH: `docs/PLATFORM-RULES.md` (owned by content-ai/connector-
 * engineer). As of the last sync (2026-07-04) that doc records media rules for
 * Twitch, Bluesky, and Discord only — those three are transcribed verbatim
 * below with the doc section referenced in each comment. Every other platform
 * id falls back to `DEFAULT_PLATFORM_MEDIA_SPEC`, a conservative placeholder
 * (documented at its declaration) that must be replaced with the platform's
 * real numbers here the day its section is added to PLATFORM-RULES.md — do
 * not let this fallback silently stand in for a documented spec.
 *
 * If PLATFORM-RULES.md changes, update this file in the same change (per the
 * repo rule that both the AI-generation stage and connector validation read
 * from one recorded set of numbers).
 */

import type { RenditionKind } from './types';

/** One aspect-ratio rendition target: kind + the exact w:h ratio it must hit. */
export interface AspectTarget {
  kind: Extract<RenditionKind, 'square' | 'portrait' | 'landscape' | 'story'>;
  ratioW: number;
  ratioH: number;
}

export const ASPECT_TARGETS: Record<AspectTarget['kind'], AspectTarget> = {
  square: { kind: 'square', ratioW: 1, ratioH: 1 },
  portrait: { kind: 'portrait', ratioW: 4, ratioH: 5 },
  landscape: { kind: 'landscape', ratioW: 16, ratioH: 9 },
  story: { kind: 'story', ratioW: 9, ratioH: 16 },
};

export interface ImageSpec {
  supported: boolean;
  /** Mime types the platform accepts, e.g. ['image/jpeg', 'image/png', 'image/webp']. */
  allowedMimeTypes: string[];
  /** Max bytes for a single image upload. */
  maxBytes: number;
  /** Longest edge, in px, the platform will accept without server-side downscale. */
  maxDimensionPx: number;
  /** Which aspect renditions this platform's composer/feed actually wants. */
  renditions: AspectTarget['kind'][];
  /** Always produce a thumbnail for this platform. */
  needsThumbnail: boolean;
  /** sharp JPEG/WebP quality (0-100) to target when compressing. */
  quality: number;
  /** Max images per post. */
  maxCount: number;
}

export interface VideoSpec {
  supported: boolean;
  allowedMimeTypes: string[];
  maxBytes: number;
  maxDurationMs: number | null;
  /** Target long-edge resolution (px) to transcode to. */
  targetResolutionPx: number;
  /** Target average video bitrate, bits/sec. */
  targetBitrateBps: number;
  /** Target audio bitrate, bits/sec. */
  targetAudioBitrateBps: number;
  /** Whether the platform's upload surface accepts a caption/subtitle track. */
  supportsCaptionTrack: boolean;
  maxCount: number;
}

export interface PlatformMediaSpec {
  platform: string;
  image: ImageSpec;
  video: VideoSpec;
  /** True only for specs transcribed from a dated, cited PLATFORM-RULES.md section. */
  documented: boolean;
}

/**
 * Twitch: PLATFORM-RULES.md "### Media" under Twitch — `maxMediaCount: 0`,
 * `supportedMediaTypes: []`. No media attachment surface exists at all.
 */
const TWITCH: PlatformMediaSpec = {
  platform: 'twitch',
  documented: true,
  image: {
    supported: false,
    allowedMimeTypes: [],
    maxBytes: 0,
    maxDimensionPx: 0,
    renditions: [],
    needsThumbnail: false,
    quality: 0,
    maxCount: 0,
  },
  video: {
    supported: false,
    allowedMimeTypes: [],
    maxBytes: 0,
    maxDurationMs: null,
    targetResolutionPx: 0,
    targetBitrateBps: 0,
    targetAudioBitrateBps: 0,
    supportsCaptionTrack: false,
    maxCount: 0,
  },
};

/**
 * Bluesky: PLATFORM-RULES.md "### Media" under Bluesky / AT Protocol.
 * Images: up to 4, png/jpeg/webp/gif, 1,000,000 bytes/image (conservative
 * floor). Video: exactly 1, video/mp4 only, 100,000,000 bytes max, no
 * lexicon-level duration cap (we mirror the app's ~3-minute advisory cap).
 * Images and video are mutually exclusive per post, but that's a payload-
 * composition rule for the connector, not a per-file media spec, so it's not
 * modeled here.
 */
const BLUESKY: PlatformMediaSpec = {
  platform: 'bluesky',
  documented: true,
  image: {
    supported: true,
    allowedMimeTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
    maxBytes: 1_000_000,
    maxDimensionPx: 2048,
    renditions: ['square', 'landscape', 'portrait'],
    needsThumbnail: true,
    quality: 80,
    maxCount: 4,
  },
  video: {
    supported: true,
    allowedMimeTypes: ['video/mp4'],
    maxBytes: 100_000_000,
    maxDurationMs: 3 * 60 * 1000,
    targetResolutionPx: 1280,
    targetBitrateBps: 3_500_000,
    targetAudioBitrateBps: 128_000,
    supportsCaptionTrack: false,
    maxCount: 1,
  },
};

/**
 * Discord: PLATFORM-RULES.md "### Media" under Discord. Max 10 attachments,
 * 25 MiB/file floor (guild boost tiers can raise it but a generic connector
 * call can't know the target guild's tier), effectively any file type
 * (generic "document" with a wildcard mime type) with inline preview for
 * image/video/gif — "No connector-side transcoding" is called out
 * explicitly, so we still offer compression as an opt-in size-fitting step,
 * not a default.
 */
const DISCORD: PlatformMediaSpec = {
  platform: 'discord',
  documented: true,
  image: {
    supported: true,
    allowedMimeTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
    maxBytes: 25 * 1024 * 1024,
    maxDimensionPx: 4096,
    renditions: ['square', 'landscape', 'portrait', 'story'],
    needsThumbnail: true,
    quality: 90,
    maxCount: 10,
  },
  video: {
    supported: true,
    allowedMimeTypes: ['video/mp4', 'video/webm', 'video/quicktime'],
    maxBytes: 25 * 1024 * 1024,
    maxDurationMs: null,
    targetResolutionPx: 1920,
    targetBitrateBps: 6_000_000,
    targetAudioBitrateBps: 128_000,
    supportsCaptionTrack: false,
    maxCount: 10,
  },
};

/**
 * PLACEHOLDER used for any platform id not yet documented in
 * PLATFORM-RULES.md (e.g. instagram/tiktok/youtube/x/reddit/linkedin — those
 * connectors are still to be built per docs/ARCHITECTURE.md §3). Numbers are
 * a conservative common denominator across mainstream feed/story surfaces
 * (roughly: JPEG quality 82, 2048px long edge, 1080p/8Mbps video, all four
 * aspect renditions + thumbnail) so a post is never rejected for being *too
 * small/low-bitrate*, only ever flagged when its actual real limit is added.
 * `documented: false` lets validation/logging surface "using a placeholder
 * spec" so nobody mistakes this for a checked number.
 */
export const DEFAULT_PLATFORM_MEDIA_SPEC: Omit<PlatformMediaSpec, 'platform'> = {
  documented: false,
  image: {
    supported: true,
    allowedMimeTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
    maxBytes: 8 * 1024 * 1024,
    maxDimensionPx: 2048,
    renditions: ['square', 'portrait', 'landscape', 'story'],
    needsThumbnail: true,
    quality: 82,
    maxCount: 4,
  },
  video: {
    supported: true,
    allowedMimeTypes: ['video/mp4', 'video/quicktime', 'video/webm'],
    maxBytes: 512 * 1024 * 1024,
    maxDurationMs: 10 * 60 * 1000,
    targetResolutionPx: 1920,
    targetBitrateBps: 8_000_000,
    targetAudioBitrateBps: 128_000,
    supportsCaptionTrack: true,
    maxCount: 1,
  },
};

const REGISTRY: Record<string, PlatformMediaSpec> = {
  twitch: TWITCH,
  bluesky: BLUESKY,
  discord: DISCORD,
};

/** Returns the documented spec for `platform`, or the placeholder default. */
export function getPlatformMediaSpec(platform: string): PlatformMediaSpec {
  const documented = REGISTRY[platform];
  if (documented) return documented;
  return { platform, ...DEFAULT_PLATFORM_MEDIA_SPEC };
}

export function listDocumentedPlatforms(): string[] {
  return Object.keys(REGISTRY);
}
