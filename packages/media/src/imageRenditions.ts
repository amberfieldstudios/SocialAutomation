/**
 * Real image processing via `sharp`. Every function here is a pure
 * input-file -> output-file transform: given a source path and explicit
 * target parameters, it writes exactly one output file and returns its
 * resulting dimensions/bytes. No global state, no implicit platform lookups
 * — the planner is responsible for deciding *which* targets to call this
 * with (see `planner.ts`), so this module stays trivially cacheable/
 * retryable: the same (source, target) pair always produces the same output.
 */

import sharp from 'sharp';
import { ASPECT_TARGETS, type AspectTarget } from './platformSpecs';

export interface ImageTransformResult {
  width: number;
  height: number;
  bytes: number;
  mimeType: string;
}

export interface ImageSourceInfo {
  width: number;
  height: number;
  format: string;
  hasAlpha: boolean;
  isAnimated: boolean;
  bytes: number;
}

/** Reads dimensions/format metadata without decoding full pixel data. */
export async function readImageInfo(sourcePath: string): Promise<ImageSourceInfo> {
  const image = sharp(sourcePath, { animated: true });
  const meta = await image.metadata();
  const stats = await import('node:fs/promises').then((fs) => fs.stat(sourcePath));
  if (!meta.width || !meta.height) {
    throw new Error(`Could not read dimensions for image at "${sourcePath}".`);
  }
  return {
    width: meta.width,
    height: meta.height,
    format: meta.format ?? 'unknown',
    hasAlpha: meta.hasAlpha ?? false,
    isAnimated: (meta.pages ?? 1) > 1,
    bytes: stats.size,
  };
}

/** Chooses an output mime type: preserves alpha/animation-bearing formats, else JPEG. */
export function chooseOutputFormat(info: ImageSourceInfo): 'jpeg' | 'png' | 'webp' | 'gif' {
  if (info.isAnimated) return 'gif';
  if (info.hasAlpha) return 'webp';
  return 'jpeg';
}

const FORMAT_MIME: Record<'jpeg' | 'png' | 'webp' | 'gif', string> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
};

/**
 * Produces one aspect-ratio rendition: resize+center-crop (sharp `cover` fit)
 * to exactly the target ratio, long edge capped at `maxDimensionPx`, encoded
 * at `quality`. Writes to `outPath` and returns the resulting dimensions.
 */
export async function deriveAspectRendition(
  sourcePath: string,
  outPath: string,
  target: AspectTarget,
  maxDimensionPx: number,
  quality: number,
  format: 'jpeg' | 'png' | 'webp' | 'gif',
): Promise<ImageTransformResult> {
  const { ratioW, ratioH } = target;
  let width: number;
  let height: number;
  if (ratioW >= ratioH) {
    width = maxDimensionPx;
    height = Math.round((maxDimensionPx * ratioH) / ratioW);
  } else {
    height = maxDimensionPx;
    width = Math.round((maxDimensionPx * ratioW) / ratioH);
  }

  let pipeline = sharp(sourcePath, { animated: format === 'gif' }).resize(width, height, {
    fit: 'cover',
    position: 'attention',
  });
  pipeline = applyFormat(pipeline, format, quality);

  const info = await pipeline.toFile(outPath);
  return {
    width: info.width,
    height: info.height,
    bytes: info.size,
    mimeType: FORMAT_MIME[format],
  };
}

/**
 * Produces a thumbnail: a small square-ish (default 320px long edge) static
 * frame, always non-animated even if the source is a GIF.
 */
export async function deriveThumbnail(
  sourcePath: string,
  outPath: string,
  maxDimensionPx = 320,
  quality = 75,
): Promise<ImageTransformResult> {
  const pipeline = sharp(sourcePath, { animated: false })
    .resize(maxDimensionPx, maxDimensionPx, { fit: 'cover', position: 'attention' })
    .jpeg({ quality });
  const info = await pipeline.toFile(outPath);
  return { width: info.width, height: info.height, bytes: info.size, mimeType: 'image/jpeg' };
}

/**
 * Produces a "compressed" rendition: same aspect ratio as the source
 * (no crop), just downscaled to `maxDimensionPx` long edge (if larger) and
 * re-encoded at `quality` to fit a platform's byte budget.
 */
export async function deriveCompressed(
  sourcePath: string,
  outPath: string,
  maxDimensionPx: number,
  quality: number,
  format: 'jpeg' | 'png' | 'webp' | 'gif',
): Promise<ImageTransformResult> {
  let pipeline = sharp(sourcePath, { animated: format === 'gif' }).resize(
    maxDimensionPx,
    maxDimensionPx,
    { fit: 'inside', withoutEnlargement: true },
  );
  pipeline = applyFormat(pipeline, format, quality);
  const info = await pipeline.toFile(outPath);
  return {
    width: info.width,
    height: info.height,
    bytes: info.size,
    mimeType: FORMAT_MIME[format],
  };
}

function applyFormat(pipeline: sharp.Sharp, format: 'jpeg' | 'png' | 'webp' | 'gif', quality: number): sharp.Sharp {
  switch (format) {
    case 'jpeg':
      return pipeline.jpeg({ quality });
    case 'webp':
      return pipeline.webp({ quality });
    case 'png':
      return pipeline.png({ quality });
    case 'gif':
      return pipeline.gif();
  }
}

export { ASPECT_TARGETS };
