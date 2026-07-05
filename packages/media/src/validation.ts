/**
 * Validates a source media file against one platform's spec, before any
 * rendition work is attempted. This is deliberately the same shape as
 * `ValidationResult`/`ValidationIssue` from `@social/core` so the pipeline's
 * validation stage (which runs `connector.validatePost`) and this
 * pre-upload media check read the same way — the goal (per the task brief)
 * is to fail with an actionable error here, before a connector's
 * `uploadMedia` ever gets a chance to have the platform reject it.
 */

import type { MediaProcessingIssue, SourceMedia } from './types';
import type { PlatformMediaSpec } from './platformSpecs';

export interface MediaValidationResult {
  ok: boolean;
  errors: MediaProcessingIssue[];
  warnings: MediaProcessingIssue[];
}

/** Rough aspect-ratio classification tolerance (10%) for "is this usable as-is". */
const ASPECT_TOLERANCE = 0.1;

export function validateSourceMedia(
  source: SourceMedia,
  spec: PlatformMediaSpec,
): MediaValidationResult {
  const errors: MediaProcessingIssue[] = [];
  const warnings: MediaProcessingIssue[] = [];

  if (!spec.documented) {
    warnings.push({
      code: 'platform_media_spec_undocumented',
      message: `No dated PLATFORM-RULES.md media section exists yet for platform "${spec.platform}"; validating against a conservative placeholder spec.`,
      severity: 'warning',
      field: 'platform',
    });
  }

  const kind = source.mediaType === 'gif' ? 'image' : source.mediaType;

  if (kind === 'image') {
    const img = spec.image;
    if (!img.supported) {
      errors.push({
        code: 'media_not_supported',
        message: `Platform "${spec.platform}" does not accept image/gif media.`,
        severity: 'error',
        field: 'mediaType',
      });
      return { ok: false, errors, warnings };
    }
    if (!img.allowedMimeTypes.includes(source.mimeType)) {
      errors.push({
        code: 'unsupported_mime_type',
        message: `"${source.mimeType}" is not accepted by "${spec.platform}" (allowed: ${img.allowedMimeTypes.join(', ')}).`,
        severity: 'error',
        field: 'mimeType',
      });
    }
    if (typeof source.bytes === 'number' && source.bytes > img.maxBytes) {
      errors.push({
        code: 'file_too_large',
        message: `Source image is ${source.bytes} bytes, exceeding "${spec.platform}"'s ${img.maxBytes}-byte limit. It must be compressed or re-encoded before upload.`,
        severity: 'error',
        field: 'bytes',
        limit: img.maxBytes,
        actual: source.bytes,
      });
    }
    if (
      typeof source.width === 'number' &&
      typeof source.height === 'number' &&
      Math.max(source.width, source.height) > img.maxDimensionPx * 4
    ) {
      // Only flag as an error when the source is wildly oversized (>4x target);
      // anything smaller is just downscaled by the rendition step.
      warnings.push({
        code: 'dimension_far_above_target',
        message: `Source image is ${source.width}x${source.height}, far above "${spec.platform}"'s ${img.maxDimensionPx}px target long edge; it will be downscaled.`,
        severity: 'warning',
        field: 'width',
        limit: img.maxDimensionPx,
        actual: Math.max(source.width, source.height),
      });
    }
    if (
      typeof source.width === 'number' &&
      typeof source.height === 'number' &&
      (source.width <= 0 || source.height <= 0)
    ) {
      errors.push({
        code: 'invalid_dimensions',
        message: `Source image reports non-positive dimensions (${source.width}x${source.height}).`,
        severity: 'error',
        field: 'width',
      });
    }
  } else if (kind === 'video') {
    const vid = spec.video;
    if (!vid.supported) {
      errors.push({
        code: 'media_not_supported',
        message: `Platform "${spec.platform}" does not accept video media.`,
        severity: 'error',
        field: 'mediaType',
      });
      return { ok: false, errors, warnings };
    }
    if (!vid.allowedMimeTypes.includes(source.mimeType)) {
      errors.push({
        code: 'unsupported_mime_type',
        message: `"${source.mimeType}" is not accepted by "${spec.platform}" (allowed: ${vid.allowedMimeTypes.join(', ')}).`,
        severity: 'error',
        field: 'mimeType',
      });
    }
    if (typeof source.bytes === 'number' && source.bytes > vid.maxBytes) {
      errors.push({
        code: 'file_too_large',
        message: `Source video is ${source.bytes} bytes, exceeding "${spec.platform}"'s ${vid.maxBytes}-byte limit. Re-encode at a lower bitrate/resolution before upload.`,
        severity: 'error',
        field: 'bytes',
        limit: vid.maxBytes,
        actual: source.bytes,
      });
    }
    if (
      vid.maxDurationMs !== null &&
      typeof source.durationMs === 'number' &&
      source.durationMs > vid.maxDurationMs
    ) {
      errors.push({
        code: 'duration_too_long',
        message: `Source video is ${source.durationMs}ms, exceeding "${spec.platform}"'s ${vid.maxDurationMs}ms limit.`,
        severity: 'error',
        field: 'durationMs',
        limit: vid.maxDurationMs,
        actual: source.durationMs,
      });
    }
  } else {
    warnings.push({
      code: 'unvalidated_media_type',
      message: `Media type "${source.mediaType}" has no platform spec validation implemented; passing through unchecked.`,
      severity: 'warning',
      field: 'mediaType',
    });
  }

  return { ok: errors.length === 0, errors, warnings };
}

/** Classifies how close a w:h ratio is to one of the four named aspect targets, if any. */
export function classifyAspect(
  width: number,
  height: number,
): 'square' | 'portrait' | 'landscape' | 'story' | 'other' {
  const ratio = width / height;
  const candidates: Array<{ kind: 'square' | 'portrait' | 'landscape' | 'story'; ratio: number }> = [
    { kind: 'square', ratio: 1 },
    { kind: 'portrait', ratio: 4 / 5 },
    { kind: 'landscape', ratio: 16 / 9 },
    { kind: 'story', ratio: 9 / 16 },
  ];
  for (const c of candidates) {
    if (Math.abs(ratio - c.ratio) / c.ratio <= ASPECT_TOLERANCE) return c.kind;
  }
  return 'other';
}
