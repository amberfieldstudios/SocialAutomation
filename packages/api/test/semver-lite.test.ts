import { describe, expect, it } from 'vitest';
import { compareVersions } from '../src/semver-lite';

describe('compareVersions', () => {
  it('returns 0 for equal versions', () => {
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
  });

  it('treats missing segments as 0 ("1.2" == "1.2.0")', () => {
    expect(compareVersions('1.2', '1.2.0')).toBe(0);
  });

  it('compares major/minor/patch numerically, not lexically (1.10.0 > 1.9.0)', () => {
    expect(compareVersions('1.10.0', '1.9.0')).toBeGreaterThan(0);
    expect(compareVersions('1.9.0', '1.10.0')).toBeLessThan(0);
  });

  it('handles an empty string as 0.0.0', () => {
    expect(compareVersions('', '0.0.0')).toBe(0);
    expect(compareVersions('0.0.1', '')).toBeGreaterThan(0);
  });
});
