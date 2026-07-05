/**
 * Real sharp exercises: every assertion here reads dimensions/bytes back off
 * an actual file sharp wrote to a temp directory — nothing here is mocked.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import {
  chooseOutputFormat,
  deriveAspectRendition,
  deriveCompressed,
  deriveThumbnail,
  readImageInfo,
} from '../src/imageRenditions';
import { ASPECT_TARGETS } from '../src/platformSpecs';
import { cleanupDir, makeTempDir, makeTestGif, makeTestImage } from './support';

describe('imageRenditions (real sharp)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await makeTempDir('social-media-img-');
  });

  afterEach(async () => {
    await cleanupDir(dir);
  });

  it('reads real dimensions/format/alpha/animation off a JPEG fixture', async () => {
    const src = await makeTestImage(dir, 'src', 1600, 1200, { format: 'jpeg' });
    const info = await readImageInfo(src);
    expect(info.width).toBe(1600);
    expect(info.height).toBe(1200);
    expect(info.format).toBe('jpeg');
    expect(info.hasAlpha).toBe(false);
    expect(info.isAnimated).toBe(false);
    expect(info.bytes).toBeGreaterThan(0);
  });

  it('detects alpha on a PNG fixture and chooses webp output', async () => {
    const src = await makeTestImage(dir, 'src', 800, 600, { alpha: true, format: 'png' });
    const info = await readImageInfo(src);
    expect(info.hasAlpha).toBe(true);
    expect(chooseOutputFormat(info)).toBe('webp');
  });

  it('chooses jpeg output for a flat opaque source', async () => {
    const src = await makeTestImage(dir, 'src', 400, 400, { format: 'jpeg' });
    const info = await readImageInfo(src);
    expect(chooseOutputFormat(info)).toBe('jpeg');
  });

  it('produces a real square (1:1) rendition at the requested long edge', async () => {
    const src = await makeTestImage(dir, 'src', 2000, 1000);
    const out = join(dir, 'square.jpg');
    const result = await deriveAspectRendition(src, out, ASPECT_TARGETS.square, 500, 80, 'jpeg');
    expect(result.width).toBe(500);
    expect(result.height).toBe(500);
    expect(result.mimeType).toBe('image/jpeg');

    const written = await readImageInfo(out);
    expect(written.width).toBe(500);
    expect(written.height).toBe(500);
  });

  it('produces a real portrait (4:5) rendition with the correct ratio', async () => {
    const src = await makeTestImage(dir, 'src', 2000, 2000);
    const out = join(dir, 'portrait.jpg');
    const result = await deriveAspectRendition(src, out, ASPECT_TARGETS.portrait, 1000, 80, 'jpeg');
    expect(result.height).toBe(1000);
    expect(result.width).toBe(800); // 4/5 * 1000
  });

  it('produces a real landscape (16:9) rendition with the correct ratio', async () => {
    const src = await makeTestImage(dir, 'src', 2000, 2000);
    const out = join(dir, 'landscape.jpg');
    const result = await deriveAspectRendition(src, out, ASPECT_TARGETS.landscape, 1600, 80, 'jpeg');
    expect(result.width).toBe(1600);
    expect(result.height).toBe(900); // 9/16 * 1600
  });

  it('produces a real story (9:16) rendition with the correct ratio', async () => {
    const src = await makeTestImage(dir, 'src', 2000, 2000);
    const out = join(dir, 'story.jpg');
    const result = await deriveAspectRendition(src, out, ASPECT_TARGETS.story, 1080, 80, 'jpeg');
    expect(result.height).toBe(1080);
    expect(result.width).toBe(608); // round(1080 * 9/16) = 607.5 -> 608
  });

  it('produces a real thumbnail capped at the requested size', async () => {
    const src = await makeTestImage(dir, 'src', 3000, 1500);
    const out = join(dir, 'thumb.jpg');
    const result = await deriveThumbnail(src, out, 320, 70);
    expect(result.width).toBe(320);
    expect(result.height).toBe(320);
    expect(result.mimeType).toBe('image/jpeg');
  });

  it('derives a compressed rendition that shrinks bytes and never upscales', async () => {
    const src = await makeTestImage(dir, 'src', 3000, 2000, { format: 'jpeg' });
    const srcInfo = await readImageInfo(src);
    const out = join(dir, 'compressed.jpg');
    const result = await deriveCompressed(src, out, 1000, 60, 'jpeg');
    expect(Math.max(result.width, result.height)).toBeLessThanOrEqual(1000);
    expect(result.bytes).toBeLessThan(srcInfo.bytes);

    // withoutEnlargement: a source smaller than the cap is left at its own size.
    const small = await makeTestImage(dir, 'small', 200, 150, { format: 'jpeg' });
    const smallOut = join(dir, 'small-compressed.jpg');
    const smallResult = await deriveCompressed(small, smallOut, 1000, 80, 'jpeg');
    expect(smallResult.width).toBe(200);
    expect(smallResult.height).toBe(150);
  });

  it('reads a real GIF fixture and reports gif format', async () => {
    const src = await makeTestGif(dir, 'anim', 200, 200);
    const info = await readImageInfo(src);
    expect(info.format).toBe('gif');
    expect(info.width).toBe(200);
    expect(info.height).toBe(200);
  });
});
