import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LogFields, StructuredLogger } from '@social/core';
import sharp from 'sharp';

/** A silent `StructuredLogger` for tests; flip to a console-backed one locally to debug. */
export function testLogger(): StructuredLogger {
  const make = (bindings: LogFields): StructuredLogger => ({
    child: (more) => make({ ...bindings, ...more }),
    trace: () => {},
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  });
  return make({});
}

export async function makeTempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

export async function cleanupDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

/**
 * Generates a real JPEG test fixture of the given size using sharp itself
 * (a solid-color image plus a contrasting corner block so "attention"-based
 * cropping has something non-uniform to key off of). Returns the file path.
 */
export async function makeTestImage(
  dir: string,
  name: string,
  width: number,
  height: number,
  opts: { alpha?: boolean; format?: 'jpeg' | 'png' | 'webp' } = {},
): Promise<string> {
  const format = opts.format ?? (opts.alpha ? 'png' : 'jpeg');
  const path = join(dir, `${name}.${format === 'jpeg' ? 'jpg' : format}`);
  const channels = opts.alpha ? 4 : 3;
  const background = opts.alpha ? { r: 40, g: 120, b: 200, alpha: 1 } : { r: 40, g: 120, b: 200 };
  let img = sharp({ create: { width, height, channels, background } }).composite([
    {
      input: await sharp({
        create: {
          width: Math.max(1, Math.round(width * 0.2)),
          height: Math.max(1, Math.round(height * 0.2)),
          channels,
          background: opts.alpha ? { r: 220, g: 50, b: 50, alpha: 1 } : { r: 220, g: 50, b: 50 },
        },
      })
        .png()
        .toBuffer(),
      gravity: 'northeast',
    },
  ]);
  if (format === 'jpeg') img = img.jpeg({ quality: 95 });
  else if (format === 'png') img = img.png();
  else img = img.webp({ quality: 95 });
  await img.toFile(path);
  return path;
}

/**
 * Generates a real (single-frame) GIF fixture using sharp. Good enough to
 * exercise the GIF mime/format code paths in `imageRenditions.ts` with a
 * real file on disk; multi-frame animation authoring is out of scope for a
 * test fixture and isn't required to prove the resize/crop/encode logic.
 */
export async function makeTestGif(dir: string, name: string, width: number, height: number): Promise<string> {
  const path = join(dir, `${name}.gif`);
  await sharp({ create: { width, height, channels: 3, background: { r: 10, g: 200, b: 10 } } })
    .gif()
    .toFile(path);
  return path;
}
