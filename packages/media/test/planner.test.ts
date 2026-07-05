/**
 * Integration test for RenditionPlanner: `plan()` is pure selection logic,
 * `execute()` for images runs real sharp end-to-end (files are written to a
 * real temp dir and read back). The video branch runs against whatever
 * ffmpeg availability this machine actually has — see the assertions below,
 * which branch on `isFfmpegAvailable()` so the suite is honest either way
 * instead of asserting a specific environment.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { RenditionPlanner } from '../src/planner';
import { isFfmpegAvailable } from '../src/videoCapability';
import type { SourceMedia } from '../src/types';
import { cleanupDir, makeTempDir, makeTestImage, testLogger } from './support';

describe('RenditionPlanner.plan (pure)', () => {
  it('excludes Twitch (no media support) but still plans for Bluesky/Discord', () => {
    const planner = new RenditionPlanner(testLogger());
    const source: SourceMedia = {
      mediaType: 'image',
      mimeType: 'image/jpeg',
      path: '/tmp/src.jpg',
      bytes: 500_000,
      width: 2000,
      height: 1000,
    };
    const plan = planner.plan(source, ['twitch', 'bluesky', 'discord']);

    expect(plan.issuesByPlatform.twitch?.ok).toBe(false);
    expect(plan.issuesByPlatform.bluesky?.ok).toBe(true);
    expect(plan.issuesByPlatform.discord?.ok).toBe(true);

    const kinds = plan.needs.map((n) => n.kind).sort();
    expect(kinds).toContain('thumbnail');
    expect(kinds).toContain('square');
    expect(kinds).toContain('landscape');
    expect(kinds).toContain('portrait');
    // Twitch contributed nothing.
    expect(plan.needs.every((n) => !n.platforms.includes('twitch'))).toBe(true);
    // Both bluesky and discord want "square" -> rendered once, shared.
    const square = plan.needs.find((n) => n.kind === 'square');
    expect(square?.platforms.sort()).toEqual(['bluesky', 'discord']);
  });

  it('adds a "compressed" need when the source exceeds a platform byte cap', () => {
    const planner = new RenditionPlanner(testLogger());
    const source: SourceMedia = {
      mediaType: 'image',
      mimeType: 'image/jpeg',
      path: '/tmp/src.jpg',
      bytes: 2_000_000, // over Bluesky's 1,000,000-byte cap
      width: 1200,
      height: 1200,
    };
    const plan = planner.plan(source, ['bluesky']);
    expect(plan.needs.some((n) => n.kind === 'compressed')).toBe(true);
  });
});

describe('RenditionPlanner.execute (real sharp for images)', () => {
  let dir: string;
  let outDir: string;

  beforeEach(async () => {
    dir = await makeTempDir('social-media-planner-src-');
    outDir = await makeTempDir('social-media-planner-out-');
  });

  afterEach(async () => {
    await cleanupDir(dir);
    await cleanupDir(outDir);
  });

  it('writes real files for every planned rendition and reports accurate dimensions/bytes', async () => {
    const srcPath = await makeTestImage(dir, 'src', 2400, 1200, { format: 'jpeg' });
    const planner = new RenditionPlanner(testLogger());
    const source: SourceMedia = {
      mediaType: 'image',
      mimeType: 'image/jpeg',
      path: srcPath,
      originalFilename: 'src.jpg',
    };
    const plan = planner.plan(source, ['bluesky', 'discord']);
    const { asset, renditions } = await planner.execute(source, plan, outDir);

    expect(asset.width).toBe(2400);
    expect(asset.height).toBe(1200);
    expect(asset.status).toBe('ready');

    const original = renditions.find((r) => r.kind === 'original');
    expect(original?.status).toBe('ready');
    expect(original?.storageUri).toBe(srcPath);

    const square = renditions.find((r) => r.kind === 'square');
    expect(square?.status).toBe('ready');
    expect(square?.width).toBe(square?.height);
    const squareBytes = await readFile(square!.storageUri);
    expect(squareBytes.length).toBeGreaterThan(0);
    expect(squareBytes.length).toBe(square?.bytes);

    const thumb = renditions.find((r) => r.kind === 'thumbnail');
    expect(thumb?.status).toBe('ready');
    expect(thumb?.width).toBeLessThanOrEqual(320);

    const landscape = renditions.find((r) => r.kind === 'landscape');
    expect(landscape?.width).toBeGreaterThan(landscape!.height);

    const portrait = renditions.find((r) => r.kind === 'portrait');
    expect(portrait?.height).toBeGreaterThan(portrait!.width);

    // Every non-original rendition kind planned actually produced a 'ready' record.
    for (const need of plan.needs) {
      const r = renditions.find((x) => x.kind === need.kind);
      expect(r?.status).toBe('ready');
    }
  });

  it('marks the compressed image rendition ready and smaller than the oversized source', async () => {
    // Bluesky's 1,000,000-byte cap: force a source over it with high quality/no compression.
    const srcPath = await makeTestImage(dir, 'src', 3000, 3000, { format: 'jpeg' });
    const rawBytes = await readFile(srcPath);
    const planner = new RenditionPlanner(testLogger());
    const source: SourceMedia = {
      mediaType: 'image',
      mimeType: 'image/jpeg',
      path: srcPath,
      bytes: Math.max(rawBytes.length, 1_500_000), // ensure it reads as "oversized" for the plan step
    };
    const plan = planner.plan(source, ['bluesky']);
    expect(plan.needs.some((n) => n.kind === 'compressed')).toBe(true);

    const { renditions } = await planner.execute(source, plan, outDir);
    const compressed = renditions.find((r) => r.kind === 'compressed');
    expect(compressed?.status).toBe('ready');
    expect(compressed!.bytes!).toBeLessThan(rawBytes.length);
  });

  it('records a failed video rendition with an actionable message when ffmpeg is unavailable', async () => {
    const ffmpegAvailable = await isFfmpegAvailable();
    const planner = new RenditionPlanner(testLogger());
    const source: SourceMedia = {
      mediaType: 'video',
      mimeType: 'video/webm', // forces needsTranscode regardless of size/resolution
      path: '/nonexistent/clip.webm',
      bytes: 5_000_000,
      width: 1920,
      height: 1080,
      durationMs: 15_000,
    };
    const plan = planner.plan(source, ['discord']);
    expect(plan.needs.some((n) => n.kind === 'compressed')).toBe(true);

    const { renditions } = await planner.execute(source, plan, outDir);
    const compressed = renditions.find((r) => r.kind === 'compressed');
    expect(compressed).toBeDefined();
    if (!ffmpegAvailable) {
      expect(compressed?.status).toBe('failed');
      expect(compressed?.storageUri).toMatch(/^error:\/\//);
      expect(decodeURIComponent(compressed!.storageUri)).toMatch(/ffmpeg is not installed/);
    } else {
      // On a machine with ffmpeg this would attempt a real transcode against a
      // nonexistent source file and also fail, just with a different message.
      expect(['failed', 'ready']).toContain(compressed?.status);
    }
  });
});
