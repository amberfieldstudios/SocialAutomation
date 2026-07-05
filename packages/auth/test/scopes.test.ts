import { describe, expect, it } from 'vitest';
import { InsufficientScopeError } from '../src/errors';
import {
  hasScopesForOperation,
  missingScopes,
  requiredScopesForOperation,
  resolveRequestedScopes,
  validateGranted,
} from '../src/scopes';

describe('resolveRequestedScopes (least privilege)', () => {
  it('requests only base scopes when no scoped operations are enabled', () => {
    expect(resolveRequestedScopes('twitch', [])).toEqual(['user:read:email']);
  });

  it('adds only the enabled operations’ scopes (publish, not analytics)', () => {
    expect(resolveRequestedScopes('twitch', ['publish'])).toEqual([
      'user:read:email',
      'channel:manage:broadcast',
    ]);
  });

  it('unions and de-duplicates scopes across multiple operations', () => {
    const scopes = resolveRequestedScopes('twitch', ['publish', 'getAnalytics']);
    expect(scopes).toContain('channel:manage:broadcast');
    expect(scopes).toContain('analytics:read:games');
    expect(scopes).toContain('channel:read:subscriptions');
    expect(new Set(scopes).size).toBe(scopes.length);
  });

  it('returns empty for an unknown platform (nothing to enforce)', () => {
    expect(resolveRequestedScopes('does-not-exist', ['publish'])).toEqual([]);
  });

  it('returns empty for Bluesky (app passwords are not OAuth-scoped)', () => {
    expect(resolveRequestedScopes('bluesky', ['publish'])).toEqual([]);
  });
});

describe('validateGranted', () => {
  it('passes when granted covers the operation', () => {
    expect(() =>
      validateGranted('twitch', ['publish'], ['user:read:email', 'channel:manage:broadcast']),
    ).not.toThrow();
  });

  it('throws InsufficientScopeError listing the exact missing scopes', () => {
    try {
      validateGranted('twitch', ['publish', 'getAnalytics'], ['user:read:email', 'channel:manage:broadcast']);
      throw new Error('expected throw');
    } catch (error) {
      expect(error).toBeInstanceOf(InsufficientScopeError);
      const err = error as InsufficientScopeError;
      expect(err.missing).toEqual(['analytics:read:games', 'channel:read:subscriptions']);
      expect(err.platformId).toBe('twitch');
    }
  });

  it('passes trivially for an unscoped platform (Bluesky)', () => {
    expect(() => validateGranted('bluesky', ['publish'], [])).not.toThrow();
  });
});

describe('helpers', () => {
  it('missingScopes returns the set difference', () => {
    expect(missingScopes(['a', 'b', 'c'], ['b'])).toEqual(['a', 'c']);
  });

  it('requiredScopesForOperation combines base + op', () => {
    expect(requiredScopesForOperation('twitch', 'publish')).toEqual([
      'user:read:email',
      'channel:manage:broadcast',
    ]);
  });

  it('hasScopesForOperation is the non-throwing form', () => {
    expect(hasScopesForOperation('twitch', 'publish', ['user:read:email', 'channel:manage:broadcast'])).toBe(true);
    expect(hasScopesForOperation('twitch', 'publish', ['user:read:email'])).toBe(false);
  });
});
