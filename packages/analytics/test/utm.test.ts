import { describe, expect, it } from 'vitest';
import { buildUtmUrl, isUtmTagged, stripUtm } from '../src/url-tracking/utm';

describe('buildUtmUrl', () => {
  it('tags a bare URL with source/medium/campaign', () => {
    const tagged = buildUtmUrl('https://example.com/post', {
      source: 'twitch',
      medium: 'social',
      campaign: 'launch-week',
    });
    const url = new URL(tagged);
    expect(url.searchParams.get('utm_source')).toBe('twitch');
    expect(url.searchParams.get('utm_medium')).toBe('social');
    expect(url.searchParams.get('utm_campaign')).toBe('launch-week');
  });

  it('preserves existing non-UTM query params and the fragment', () => {
    const tagged = buildUtmUrl('https://example.com/post?ref=abc#section2', {
      source: 'discord',
      medium: 'social',
      campaign: 'c1',
    });
    const url = new URL(tagged);
    expect(url.searchParams.get('ref')).toBe('abc');
    expect(url.hash).toBe('#section2');
    expect(url.searchParams.get('utm_source')).toBe('discord');
  });

  it('correctly encodes special characters (spaces, &, unicode)', () => {
    const tagged = buildUtmUrl('https://example.com/post', {
      source: 'blue sky',
      medium: 'social & organic',
      campaign: 'launch 🚀',
    });
    const url = new URL(tagged);
    expect(url.searchParams.get('utm_source')).toBe('blue sky');
    expect(url.searchParams.get('utm_medium')).toBe('social & organic');
    expect(url.searchParams.get('utm_campaign')).toBe('launch 🚀');
    // The wire form must actually be percent-encoded, not raw.
    expect(tagged.includes(' ')).toBe(false);
  });

  it('includes optional content/term when supplied, omits them otherwise', () => {
    const withExtras = buildUtmUrl('https://example.com/x', {
      source: 's',
      medium: 'm',
      campaign: 'c',
      content: 'acc_1',
      term: 'keyword',
    });
    expect(new URL(withExtras).searchParams.get('utm_content')).toBe('acc_1');
    expect(new URL(withExtras).searchParams.get('utm_term')).toBe('keyword');

    const withoutExtras = buildUtmUrl('https://example.com/x', { source: 's', medium: 'm', campaign: 'c' });
    expect(new URL(withoutExtras).searchParams.has('utm_content')).toBe(false);
    expect(new URL(withoutExtras).searchParams.has('utm_term')).toBe(false);
  });

  it('is idempotent: tagging an already-tagged URL replaces (never duplicates) the utm_* values', () => {
    const once = buildUtmUrl('https://example.com/post', {
      source: 'twitch',
      medium: 'social',
      campaign: 'first',
    });
    const twice = buildUtmUrl(once, {
      source: 'twitch',
      medium: 'social',
      campaign: 'second',
    });

    const url = new URL(twice);
    // Exactly one utm_campaign value, and it's the latest one -- not stacked.
    expect(url.searchParams.getAll('utm_campaign')).toEqual(['second']);
    expect(url.searchParams.getAll('utm_source')).toEqual(['twitch']);

    // Re-tagging with the SAME values produces a byte-identical URL (true idempotency).
    const sameAgain = buildUtmUrl(twice, { source: 'twitch', medium: 'social', campaign: 'second' });
    expect(sameAgain).toBe(twice);
  });

  it('throws on an invalid base URL', () => {
    expect(() => buildUtmUrl('not-a-url', { source: 's', medium: 'm', campaign: 'c' })).toThrow();
  });
});

describe('isUtmTagged / stripUtm', () => {
  it('detects tagged vs. untagged URLs', () => {
    expect(isUtmTagged('https://example.com/x?utm_source=a&utm_campaign=b')).toBe(true);
    expect(isUtmTagged('https://example.com/x')).toBe(false);
    expect(isUtmTagged('not-a-url')).toBe(false);
  });

  it('removes only utm_* params, keeping the rest', () => {
    const stripped = stripUtm('https://example.com/x?ref=abc&utm_source=a&utm_campaign=b&utm_content=c');
    const url = new URL(stripped);
    expect(url.searchParams.get('ref')).toBe('abc');
    expect(url.searchParams.has('utm_source')).toBe(false);
    expect(url.searchParams.has('utm_campaign')).toBe(false);
    expect(url.searchParams.has('utm_content')).toBe(false);
  });
});
