/**
 * RenditionPlanner — the single entry point the pipeline calls with a source
 * asset + target platform list. It:
 *
 *  1. Validates the source against each platform's spec (`validation.ts`),
 *     collecting per-platform errors/warnings.
 *  2. Decides the UNION of rendition kinds every requesting platform needs
 *     (`plan()` — pure, no I/O). Note `media_renditions` has no per-platform
 *     column (see `packages/db/migrations/0001_init.sql`): a rendition is
 *     keyed by `kind` alone, so when two platforms both want e.g. "square"
 *     the planner renders it ONCE, sized/qualified to satisfy the strictest
 *     (smallest maxDimension / lowest quality budget / tightest byte cap) of
 *     every platform requesting that kind. `post_variant_media` is what later
 *     attaches a specific rendition to a specific platform's post variant.
 *  3. `execute()` actually runs sharp (images) / attempts ffmpeg (video,
 *     capability-gated) to produce the files and returns
 *     `MediaAssetRecord`/`MediaRenditionRecord[]` ready to persist via
 *     `@social/db`. Every step logs through the injected `StructuredLogger`.
 */

import { dirname, join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import type { StructuredLogger } from '@social/core';
import type {
  CaptionTrack,
  MediaAssetRecord,
  MediaRenditionRecord,
  RenditionKind,
  SourceMedia,
} from './types';
import { newAssetId, newRenditionId, nowIso } from './ids';
import { getPlatformMediaSpec, type AspectTarget } from './platformSpecs';
import { validateSourceMedia, type MediaValidationResult } from './validation';
import {
  chooseOutputFormat,
  deriveAspectRendition,
  deriveCompressed,
  deriveThumbnail,
  readImageInfo,
} from './imageRenditions';
import { selectVideoTarget, planCaptionTracks, type VideoTargetPlan, type CaptionPlanResult } from './videoPlan';
import { isFfmpegAvailable, FfmpegUnavailableError } from './videoCapability';
import { transcodeVideo } from './videoTranscode';

const ASPECT_KINDS: Array<Extract<RenditionKind, 'square' | 'portrait' | 'landscape' | 'story'>> = [
  'square',
  'portrait',
  'landscape',
  'story',
];

export interface RenditionNeed {
  kind: RenditionKind;
  platforms: string[];
  /** For image kinds: strictest (smallest) long-edge target across requesting platforms. */
  maxDimensionPx?: number;
  /** For image kinds: strictest (lowest) quality across requesting platforms. */
  quality?: number;
}

export interface MediaPlan {
  asset: MediaAssetRecord;
  needs: RenditionNeed[];
  issuesByPlatform: Record<string, MediaValidationResult>;
  videoTargetByPlatform?: Record<string, VideoTargetPlan>;
  captionPlanByPlatform?: Record<string, CaptionPlanResult>;
}

export interface ExecutionResult {
  asset: MediaAssetRecord;
  renditions: MediaRenditionRecord[];
}

export class RenditionPlanner {
  constructor(private readonly logger: StructuredLogger) {}

  /** Pure planning step — no filesystem/ffmpeg I/O. Safe to call repeatedly/cache. */
  plan(source: SourceMedia, platforms: string[], captionTracks: CaptionTrack[] = []): MediaPlan {
    const log = this.logger.child({ op: 'media.plan', assetId: source.assetId, mediaType: source.mediaType });
    const asset = toAssetRecord(source);
    const issuesByPlatform: Record<string, MediaValidationResult> = {};
    const videoTargetByPlatform: Record<string, VideoTargetPlan> = {};
    const captionPlanByPlatform: Record<string, CaptionPlanResult> = {};

    const kindWants = new Map<RenditionKind, { platforms: string[]; maxDimensionPx: number; quality: number }>();

    for (const platform of platforms) {
      const spec = getPlatformMediaSpec(platform);
      const result = validateSourceMedia(source, spec);
      issuesByPlatform[platform] = result;

      // A rendition (in particular "compressed") can often *fix* a byte-size
      // or duration violation, so those errors don't stop planning. Only an
      // unfixable mismatch — the platform doesn't accept this media type at
      // all, or the mime type isn't in its allow-list — skips this platform
      // entirely (no amount of resizing changes that).
      const unfixable = result.errors.some(
        (e) => e.code === 'media_not_supported' || e.code === 'unsupported_mime_type' || e.code === 'invalid_dimensions',
      );
      if (unfixable) {
        log.warn('platform validation failed with an unfixable error; no renditions planned for this platform', {
          platform,
          errors: result.errors,
        });
        continue;
      }

      if ((source.mediaType === 'image' || source.mediaType === 'gif') && spec.image.supported) {
        for (const kind of spec.image.renditions) {
          addWant(kindWants, kind, platform, spec.image.maxDimensionPx, spec.image.quality);
        }
        if (spec.image.needsThumbnail) {
          addWant(kindWants, 'thumbnail', platform, 320, 75);
        }
        if (typeof source.bytes === 'number' && source.bytes > spec.image.maxBytes) {
          addWant(kindWants, 'compressed', platform, spec.image.maxDimensionPx, spec.image.quality);
        }
      } else if (source.mediaType === 'video' && spec.video.supported) {
        const durationMs = source.durationMs ?? 0;
        const target = selectVideoTarget(
          {
            width: source.width ?? 0,
            height: source.height ?? 0,
            durationMs,
            bytes: source.bytes ?? 0,
            mimeType: source.mimeType,
          },
          spec.video,
        );
        videoTargetByPlatform[platform] = target;
        if (target.needsTranscode) {
          addWant(kindWants, 'compressed', platform, target.targetWidth, 0);
        }
        captionPlanByPlatform[platform] = planCaptionTracks(captionTracks, spec.video);
      }
    }

    const needs: RenditionNeed[] = Array.from(kindWants.entries()).map(([kind, v]) => ({
      kind,
      platforms: v.platforms,
      maxDimensionPx: v.maxDimensionPx,
      quality: v.quality,
    }));

    log.info('media plan computed', {
      platforms,
      needs: needs.map((n) => ({ kind: n.kind, platforms: n.platforms })),
    });

    return { asset, needs, issuesByPlatform, videoTargetByPlatform, captionPlanByPlatform };
  }

  /**
   * Executes a plan produced by `plan()`. Images are always processed with
   * real sharp transforms. Video renditions require ffmpeg on PATH — when
   * it's unavailable, the rendition record is written with
   * `status: 'failed'` and an actionable message instead of throwing, so one
   * missing video capability never blocks the image renditions in the same
   * plan.
   */
  async execute(source: SourceMedia, plan: MediaPlan, outDir: string): Promise<ExecutionResult> {
    const log = this.logger.child({ op: 'media.execute', assetId: plan.asset.id });
    await mkdir(outDir, { recursive: true });
    const renditions: MediaRenditionRecord[] = [];
    const asset = { ...plan.asset };

    renditions.push(originalRendition(source, asset));

    if (source.mediaType === 'image' || source.mediaType === 'gif') {
      let info;
      try {
        info = await readImageInfo(source.path);
      } catch (err) {
        log.error('failed to read source image metadata', { error: String(err) });
        for (const need of plan.needs) {
          renditions.push(failedRendition(asset.id, need.kind, source.mimeType, String(err)));
        }
        return { asset, renditions };
      }
      asset.width = info.width;
      asset.height = info.height;
      const format = chooseOutputFormat(info);

      for (const need of plan.needs) {
        try {
          const ext = extensionFor(format);
          const outPath = join(outDir, `${asset.id}_${need.kind}.${ext}`);
          await mkdir(dirname(outPath), { recursive: true });
          let result;
          if (need.kind === 'thumbnail') {
            result = await deriveThumbnail(source.path, outPath, need.maxDimensionPx ?? 320, need.quality ?? 75);
          } else if (need.kind === 'compressed') {
            result = await deriveCompressed(
              source.path,
              outPath,
              need.maxDimensionPx ?? info.width,
              need.quality ?? 80,
              format,
            );
          } else if (isAspectKind(need.kind)) {
            const target: AspectTarget = ASPECT_TARGET_BY_KIND[need.kind];
            result = await deriveAspectRendition(
              source.path,
              outPath,
              target,
              need.maxDimensionPx ?? 1080,
              need.quality ?? 80,
              format,
            );
          } else {
            continue;
          }
          log.info('image rendition produced', { kind: need.kind, width: result.width, height: result.height, bytes: result.bytes });
          renditions.push({
            id: newRenditionId(),
            assetId: asset.id,
            kind: need.kind,
            mimeType: result.mimeType,
            width: result.width,
            height: result.height,
            durationMs: null,
            bytes: result.bytes,
            bitrate: null,
            storageUri: outPath,
            status: 'ready',
            createdAt: nowIso(),
            updatedAt: nowIso(),
          });
        } catch (err) {
          log.error('image rendition failed', { kind: need.kind, error: String(err) });
          renditions.push(failedRendition(asset.id, need.kind, source.mimeType, String(err)));
        }
      }
      asset.status = 'ready';
      return { asset, renditions };
    }

    if (source.mediaType === 'video') {
      const ffmpegOk = await isFfmpegAvailable();
      const compressedNeed = plan.needs.find((n) => n.kind === 'compressed');
      if (compressedNeed) {
        // Use the tightest video target across requesting platforms (smallest long edge).
        const targets = compressedNeed.platforms
          .map((p) => plan.videoTargetByPlatform?.[p])
          .filter((t): t is VideoTargetPlan => !!t);
        const tightest = targets.reduce<VideoTargetPlan | undefined>((acc, t) => {
          if (!acc) return t;
          return Math.max(t.targetWidth, t.targetHeight) < Math.max(acc.targetWidth, acc.targetHeight) ? t : acc;
        }, undefined);

        if (!ffmpegOk) {
          log.warn('ffmpeg unavailable; skipping real video transcode, leaving rendition as failed', {
            kind: 'compressed',
          });
          renditions.push(
            failedRendition(asset.id, 'compressed', 'video/mp4', new FfmpegUnavailableError().message),
          );
        } else if (tightest) {
          const outPath = join(outDir, `${asset.id}_compressed.mp4`);
          try {
            const attachCaptions = Object.values(plan.captionPlanByPlatform ?? {})[0]?.attach ?? [];
            const result = await transcodeVideo(source.path, outPath, tightest, attachCaptions);
            log.info('video rendition produced', { ...result });
            renditions.push({
              id: newRenditionId(),
              assetId: asset.id,
              kind: 'compressed',
              mimeType: 'video/mp4',
              width: result.width,
              height: result.height,
              durationMs: source.durationMs ?? null,
              bytes: null,
              bitrate: result.bitrate,
              storageUri: outPath,
              status: 'ready',
              createdAt: nowIso(),
              updatedAt: nowIso(),
            });
          } catch (err) {
            log.error('video transcode failed', { error: String(err) });
            renditions.push(failedRendition(asset.id, 'compressed', 'video/mp4', String(err)));
          }
        }
      }
      asset.status = 'ready';
      return { asset, renditions };
    }

    log.warn('no processing implemented for media type; only "original" rendition recorded', {
      mediaType: source.mediaType,
    });
    return { asset, renditions };
  }
}

const ASPECT_TARGET_BY_KIND: Record<Extract<RenditionKind, 'square' | 'portrait' | 'landscape' | 'story'>, AspectTarget> = {
  square: { kind: 'square', ratioW: 1, ratioH: 1 },
  portrait: { kind: 'portrait', ratioW: 4, ratioH: 5 },
  landscape: { kind: 'landscape', ratioW: 16, ratioH: 9 },
  story: { kind: 'story', ratioW: 9, ratioH: 16 },
};

function isAspectKind(
  kind: RenditionKind,
): kind is Extract<RenditionKind, 'square' | 'portrait' | 'landscape' | 'story'> {
  return (ASPECT_KINDS as string[]).includes(kind);
}

function addWant(
  map: Map<RenditionKind, { platforms: string[]; maxDimensionPx: number; quality: number }>,
  kind: RenditionKind,
  platform: string,
  maxDimensionPx: number,
  quality: number,
): void {
  const existing = map.get(kind);
  if (!existing) {
    map.set(kind, { platforms: [platform], maxDimensionPx, quality });
    return;
  }
  existing.platforms.push(platform);
  existing.maxDimensionPx = Math.min(existing.maxDimensionPx, maxDimensionPx);
  existing.quality = quality > 0 ? Math.min(existing.quality || quality, quality) : existing.quality;
}

function toAssetRecord(source: SourceMedia): MediaAssetRecord {
  const ts = nowIso();
  return {
    id: source.assetId ?? newAssetId(),
    postId: source.postId ?? null,
    mediaType: source.mediaType,
    originalFilename: source.originalFilename ?? null,
    mimeType: source.mimeType,
    bytes: source.bytes ?? null,
    width: source.width ?? null,
    height: source.height ?? null,
    durationMs: source.durationMs ?? null,
    checksum: source.checksum ?? null,
    storageUri: source.path,
    altText: source.altText ?? null,
    status: 'uploading',
    createdAt: ts,
    updatedAt: ts,
  };
}

function originalRendition(source: SourceMedia, asset: MediaAssetRecord): MediaRenditionRecord {
  const ts = nowIso();
  return {
    id: newRenditionId(),
    assetId: asset.id,
    kind: 'original',
    mimeType: source.mimeType,
    width: source.width ?? null,
    height: source.height ?? null,
    durationMs: source.durationMs ?? null,
    bytes: source.bytes ?? null,
    bitrate: null,
    storageUri: source.path,
    status: 'ready',
    createdAt: ts,
    updatedAt: ts,
  };
}

function failedRendition(assetId: string, kind: RenditionKind, mimeType: string, message: string): MediaRenditionRecord {
  const ts = nowIso();
  return {
    id: newRenditionId(),
    assetId,
    kind,
    mimeType,
    width: null,
    height: null,
    durationMs: null,
    bytes: null,
    bitrate: null,
    storageUri: `error://${encodeURIComponent(message)}`,
    status: 'failed',
    createdAt: ts,
    updatedAt: ts,
  };
}

function extensionFor(format: 'jpeg' | 'png' | 'webp' | 'gif'): string {
  if (format === 'jpeg') return 'jpg';
  return format;
}
