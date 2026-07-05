import { afterEach, describe, expect, it } from 'vitest';
import { assertFfmpegAvailable, FfmpegUnavailableError, isFfmpegAvailable, resetFfmpegAvailabilityCache } from '../src/videoCapability';

describe('videoCapability', () => {
  afterEach(() => {
    resetFfmpegAvailabilityCache();
  });

  it('detects real ffmpeg presence/absence on this machine without throwing', async () => {
    const available = await isFfmpegAvailable();
    expect(typeof available).toBe('boolean');
  });

  it('caches the result across calls', async () => {
    const first = await isFfmpegAvailable();
    const second = await isFfmpegAvailable();
    expect(second).toBe(first);
  });

  it('assertFfmpegAvailable() matches isFfmpegAvailable()', async () => {
    const available = await isFfmpegAvailable();
    if (available) {
      await expect(assertFfmpegAvailable()).resolves.toBeUndefined();
    } else {
      await expect(assertFfmpegAvailable()).rejects.toThrow(FfmpegUnavailableError);
    }
  });
});
