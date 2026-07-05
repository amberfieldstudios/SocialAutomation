import { describe, expect, it } from 'vitest';
import { classifyAspect, validateSourceMedia } from '../src/validation';
import { getPlatformMediaSpec } from '../src/platformSpecs';
import type { SourceMedia } from '../src/types';

const baseImage: SourceMedia = {
  mediaType: 'image',
  mimeType: 'image/jpeg',
  path: '/tmp/whatever.jpg',
  bytes: 500_000,
  width: 1200,
  height: 1200,
};

describe('validateSourceMedia', () => {
  it('rejects any media for Twitch (no media support at all)', () => {
    const result = validateSourceMedia(baseImage, getPlatformMediaSpec('twitch'));
    expect(result.ok).toBe(false);
    expect(result.errors[0]?.code).toBe('media_not_supported');
  });

  it('accepts a small JPEG within Bluesky limits', () => {
    const result = validateSourceMedia(baseImage, getPlatformMediaSpec('bluesky'));
    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('rejects a JPEG over Bluesky\'s 1,000,000-byte per-image cap', () => {
    const oversized: SourceMedia = { ...baseImage, bytes: 2_000_000 };
    const result = validateSourceMedia(oversized, getPlatformMediaSpec('bluesky'));
    expect(result.ok).toBe(false);
    const err = result.errors.find((e) => e.code === 'file_too_large');
    expect(err).toBeDefined();
    expect(err?.limit).toBe(1_000_000);
    expect(err?.actual).toBe(2_000_000);
  });

  it('rejects an unsupported mime type', () => {
    const heic: SourceMedia = { ...baseImage, mimeType: 'image/heic' };
    const result = validateSourceMedia(heic, getPlatformMediaSpec('discord'));
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.code === 'unsupported_mime_type')).toBe(true);
  });

  it('rejects a video over Bluesky\'s advisory duration cap', () => {
    const video: SourceMedia = {
      mediaType: 'video',
      mimeType: 'video/mp4',
      path: '/tmp/clip.mp4',
      bytes: 5_000_000,
      durationMs: 4 * 60 * 1000,
    };
    const result = validateSourceMedia(video, getPlatformMediaSpec('bluesky'));
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.code === 'duration_too_long')).toBe(true);
  });

  it('rejects video for Twitch (unsupported)', () => {
    const video: SourceMedia = {
      mediaType: 'video',
      mimeType: 'video/mp4',
      path: '/tmp/clip.mp4',
      bytes: 5_000_000,
    };
    const result = validateSourceMedia(video, getPlatformMediaSpec('twitch'));
    expect(result.ok).toBe(false);
  });

  it('warns (does not error) when a platform has no documented spec', () => {
    const result = validateSourceMedia(baseImage, getPlatformMediaSpec('instagram'));
    expect(result.warnings.some((w) => w.code === 'platform_media_spec_undocumented')).toBe(true);
  });

  it('flags non-positive dimensions as an error', () => {
    const bad: SourceMedia = { ...baseImage, width: 0, height: 0 };
    const result = validateSourceMedia(bad, getPlatformMediaSpec('discord'));
    expect(result.errors.some((e) => e.code === 'invalid_dimensions')).toBe(true);
  });
});

describe('classifyAspect', () => {
  it('classifies exact ratios', () => {
    expect(classifyAspect(1000, 1000)).toBe('square');
    expect(classifyAspect(800, 1000)).toBe('portrait');
    expect(classifyAspect(1600, 900)).toBe('landscape');
    expect(classifyAspect(900, 1600)).toBe('story');
  });

  it('falls back to "other" outside tolerance', () => {
    expect(classifyAspect(3000, 500)).toBe('other');
  });
});
