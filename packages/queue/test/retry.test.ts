import { describe, expect, it } from 'vitest';
import { computeBackoffDelayMs, resolveBackoffOptions } from '../src/retry';

describe('computeBackoffDelayMs', () => {
  const opts = resolveBackoffOptions({ baseMs: 1000, factor: 2, maxDelayMs: 60_000, maxAttempts: 5 });

  it('computes equal-jitter delay: half + random*half of the capped exponential', () => {
    // attempt 1: uncapped = 1000 * 2^0 = 1000, half = 500
    expect(computeBackoffDelayMs(1, opts, () => 0)).toBe(500);
    expect(computeBackoffDelayMs(1, opts, () => 1)).toBe(1000);
    expect(computeBackoffDelayMs(1, opts, () => 0.5)).toBe(750);

    // attempt 2: uncapped = 1000 * 2^1 = 2000, half = 1000
    expect(computeBackoffDelayMs(2, opts, () => 0)).toBe(1000);
    expect(computeBackoffDelayMs(2, opts, () => 1)).toBe(2000);

    // attempt 3: uncapped = 4000, half = 2000
    expect(computeBackoffDelayMs(3, opts, () => 0)).toBe(2000);
  });

  it('caps the exponential at maxDelayMs before applying jitter', () => {
    const tightCap = resolveBackoffOptions({ baseMs: 1000, factor: 2, maxDelayMs: 1500, maxAttempts: 10 });
    // attempt 5 uncapped = 1000*16=16000, capped to 1500, half=750
    expect(computeBackoffDelayMs(5, tightCap, () => 0)).toBe(750);
    expect(computeBackoffDelayMs(5, tightCap, () => 1)).toBe(1500);
  });

  it('never goes below half the capped exponential (equal jitter floor)', () => {
    for (let attempt = 1; attempt <= 6; attempt++) {
      const delay = computeBackoffDelayMs(attempt, opts, () => 0);
      const uncapped = opts.baseMs * Math.pow(opts.factor, attempt - 1);
      const capped = Math.min(opts.maxDelayMs, uncapped);
      expect(delay).toBe(Math.round(capped / 2));
    }
  });
});
