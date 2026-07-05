/**
 * Video target-SELECTION logic, unit-tested with fixture metadata objects —
 * no ffmpeg / no real video files involved (this logic must work
 * identically regardless of whether ffmpeg is installed).
 */
import { describe, expect, it } from 'vitest';
import { planCaptionTracks, selectVideoTarget } from '../src/videoPlan';
import { getPlatformMediaSpec } from '../src/platformSpecs';
import type { CaptionTrack } from '../src/types';

describe('selectVideoTarget', () => {
  it('downscales a 4K source to Bluesky\'s 1280px target and keeps aspect ratio', () => {
    const spec = getPlatformMediaSpec('bluesky').video;
    const plan = selectVideoTarget(
      { width: 3840, height: 2160, durationMs: 30_000, bytes: 20_000_000, mimeType: 'video/mp4' },
      spec,
    );
    expect(plan.needsTranscode).toBe(true);
    expect(Math.max(plan.targetWidth, plan.targetHeight)).toBe(1280);
    // 3840x2160 is 16:9; scaled long edge 1280 -> short edge 720.
    expect(plan.targetWidth).toBe(1280);
    expect(plan.targetHeight).toBe(720);
  });

  it('does not upscale a source already under the target resolution', () => {
    const spec = getPlatformMediaSpec('bluesky').video;
    const plan = selectVideoTarget(
      { width: 640, height: 360, durationMs: 10_000, bytes: 2_000_000, mimeType: 'video/mp4' },
      spec,
    );
    expect(plan.targetWidth).toBe(640);
    expect(plan.targetHeight).toBe(360);
  });

  it('tightens bitrate when the spec target would exceed maxBytes over the source duration', () => {
    const spec = getPlatformMediaSpec('discord').video; // maxBytes 25 MiB
    const plan = selectVideoTarget(
      { width: 1920, height: 1080, durationMs: 10 * 60 * 1000, bytes: 100_000_000, mimeType: 'video/mp4' },
      spec,
    );
    expect(plan.needsTranscode).toBe(true);
    expect(plan.targetBitrateBps).toBeLessThan(spec.targetBitrateBps);
    const estimatedBytes = ((plan.targetBitrateBps + plan.targetAudioBitrateBps) / 8) * (10 * 60);
    expect(estimatedBytes).toBeLessThanOrEqual(spec.maxBytes * 1.01);
  });

  it('flags a non-mp4 source as needing transcode even if size/resolution already fit', () => {
    const spec = getPlatformMediaSpec('bluesky').video;
    const plan = selectVideoTarget(
      { width: 1280, height: 720, durationMs: 5_000, bytes: 1_000_000, mimeType: 'video/webm' },
      spec,
    );
    expect(plan.needsTranscode).toBe(true);
    expect(plan.targetWidth).toBe(1280);
    expect(plan.targetHeight).toBe(720);
  });

  it('reports no transcode needed when the source already fits the spec exactly', () => {
    const spec = getPlatformMediaSpec('discord').video;
    const plan = selectVideoTarget(
      { width: 640, height: 360, durationMs: 5_000, bytes: 1_000_000, mimeType: 'video/mp4' },
      spec,
    );
    expect(plan.needsTranscode).toBe(false);
  });

  it('produces only even width/height (codec requirement)', () => {
    const spec = getPlatformMediaSpec('bluesky').video;
    const plan = selectVideoTarget(
      { width: 3841, height: 2161, durationMs: 1000, bytes: 1000, mimeType: 'video/mp4' },
      spec,
    );
    expect(plan.targetWidth % 2).toBe(0);
    expect(plan.targetHeight % 2).toBe(0);
  });
});

describe('planCaptionTracks', () => {
  const enTrack: CaptionTrack = { language: 'en-US', uri: '/tmp/en.srt', format: 'srt' };
  const frTrack: CaptionTrack = { language: 'fr-FR', uri: '/tmp/fr.srt', format: 'srt' };
  const dupeEnTrack: CaptionTrack = { language: 'en-US', uri: '/tmp/en2.srt', format: 'srt' };

  it('drops every track when the platform does not support caption uploads', () => {
    const spec = getPlatformMediaSpec('bluesky').video; // supportsCaptionTrack: false
    const result = planCaptionTracks([enTrack], spec);
    expect(result.attach).toHaveLength(0);
    expect(result.dropped).toHaveLength(1);
    expect(result.dropped[0]?.reason).toMatch(/does not accept/);
  });

  it('attaches distinct-language tracks when the platform supports captions', () => {
    const spec = getPlatformMediaSpec('generic-platform').video; // falls back to default spec: supportsCaptionTrack true
    const result = planCaptionTracks([enTrack, frTrack], spec);
    expect(result.attach).toEqual([enTrack, frTrack]);
    expect(result.dropped).toHaveLength(0);
  });

  it('drops a duplicate-language track', () => {
    const spec = getPlatformMediaSpec('generic-platform').video;
    const result = planCaptionTracks([enTrack, dupeEnTrack], spec);
    expect(result.attach).toEqual([enTrack]);
    expect(result.dropped).toHaveLength(1);
    expect(result.dropped[0]?.reason).toMatch(/duplicate/);
  });
});
