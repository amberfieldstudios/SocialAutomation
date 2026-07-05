import { describe, expect, it } from 'vitest';
import {
  appendWithinLimit,
  measureLength,
  sanitizeHashtag,
  sanitizeHashtags,
  sanitizeMentions,
  truncateToLimit,
} from '../src/text';

describe('measureLength', () => {
  it('counts UTF-16 code units by default', () => {
    expect(measureLength('hello')).toBe(5);
  });

  it('counts grapheme clusters when requested (Bluesky semantics)', () => {
    const familyEmoji = '👨‍👩‍👧‍👦';
    expect(measureLength(familyEmoji, true)).toBe(1);
    expect(measureLength(familyEmoji, false)).toBeGreaterThan(1);
  });
});

describe('truncateToLimit', () => {
  it('returns the input unchanged when already within the limit', () => {
    expect(truncateToLimit('short', 100)).toBe('short');
  });

  it('truncates to the limit and prefers a word boundary', () => {
    const long = 'The quick brown fox jumps over the lazy dog';
    const result = truncateToLimit(long, 20);
    expect(result.length).toBeLessThanOrEqual(20);
    expect(result.endsWith(' ')).toBe(false);
  });

  it('never exceeds the limit even with a hard cut required', () => {
    const result = truncateToLimit('supercalifragilisticexpialidocious', 10);
    expect(result.length).toBeLessThanOrEqual(10);
  });

  it('is grapheme-aware and never splits a multi-code-unit grapheme', () => {
    const text = '👨‍👩‍👧‍👦👨‍👩‍👧‍👦👨‍👩‍👧‍👦';
    const result = truncateToLimit(text, 2, true);
    expect(measureLength(result, true)).toBeLessThanOrEqual(2);
  });
});

describe('appendWithinLimit', () => {
  it('appends the suffix when there is room', () => {
    expect(appendWithinLimit('hello', 'world', 20)).toBe('hello world');
  });

  it('truncates the base to make room for the suffix, never exceeding the limit', () => {
    const result = appendWithinLimit('a very long base string indeed', 'TAG', 10);
    expect(result.length).toBeLessThanOrEqual(10);
    expect(result.endsWith('TAG')).toBe(true);
  });
});

describe('sanitizeHashtag', () => {
  it('strips a leading # and disallowed characters', () => {
    expect(sanitizeHashtag('#Gaming!')).toBe('Gaming');
  });

  it('enforces the strict Twitch channel-tag charset (letters/digits/underscore, alnum start)', () => {
    expect(sanitizeHashtag('#hello-world', { strict: true })).toBe('helloworld');
    expect(sanitizeHashtag('___leading', { strict: true })).toBe('leading');
    expect(sanitizeHashtag('a'.repeat(40), { strict: true, maxLength: 25 })?.length).toBe(25);
  });

  it('returns null when nothing usable remains', () => {
    expect(sanitizeHashtag('!!!', { strict: true })).toBeNull();
  });
});

describe('sanitizeHashtags', () => {
  it('dedupes case-insensitively and caps the count', () => {
    const result = sanitizeHashtags(['Gaming', 'gaming', 'Live', 'New', 'Extra'], 3);
    expect(result).toHaveLength(3);
    expect(result.filter((t) => t.toLowerCase() === 'gaming')).toHaveLength(1);
  });
});

describe('sanitizeMentions', () => {
  it('strips leading @ and caps the count', () => {
    expect(sanitizeMentions(['@alice', 'bob', '@Alice'], 5)).toEqual(['alice', 'bob']);
    expect(sanitizeMentions(['@alice', '@bob'], 1)).toEqual(['alice']);
  });

  it('drops all mentions when max is 0', () => {
    expect(sanitizeMentions(['@alice'], 0)).toEqual([]);
  });
});
