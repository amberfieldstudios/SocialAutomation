/**
 * `LocalShortUrlService` + `LinkRewriter` against a real SQLite-backed
 * `@social/db` `shortUrls` store (the verified persistence path), plus click
 * attribution (`resolve()` maps a slug back to its campaignId).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLogger } from '@social/logging';
import { Database } from '@social/db';
import { LocalShortUrlService } from '../src/url-tracking/short-url-service';
import { LinkRewriter } from '../src/url-tracking/link-rewriter';
import { buildUtmUrl } from '../src/url-tracking/utm';

function testLogger() {
  return createLogger({ sink: () => {}, service: 'test' });
}

describe('LocalShortUrlService (real @social/db-backed store)', () => {
  let db: Database;
  let service: LocalShortUrlService;

  beforeEach(() => {
    db = Database.sqlite({ filename: ':memory:' });
    db.migrate();
    service = new LocalShortUrlService({ store: db.shortUrls, logger: testLogger(), baseUrl: 'https://trk.local' });
  });

  afterEach(() => {
    db.close();
  });

  it('creates a short URL and persists the slug -> target + campaign mapping', async () => {
    const targetUrl = buildUtmUrl('https://example.com/vod', {
      source: 'twitch',
      medium: 'social',
      campaign: 'summer-launch',
    });

    const tracked = await service.createShortUrl({
      targetUrl,
      campaignId: 'summer-launch',
      platform: 'twitch',
      accountId: 'acc_1',
    });

    expect(tracked.shortUrl).toMatch(/^https:\/\/trk\.local\/\w+$/);
    expect(tracked.campaignId).toBe('summer-launch');

    // Round-trips through the real DB row, not just the in-memory return value.
    const row = await db.shortUrls.findBySlug(tracked.slug);
    expect(row?.targetUrl).toBe(targetUrl);
    expect(row?.campaignId).toBe('summer-launch');
    expect(row?.platformId).toBe('twitch');
    expect(row?.accountId).toBe('acc_1');
  });

  it('resolve() attributes a click back to the owning campaign and increments the click count', async () => {
    const tracked = await service.createShortUrl({
      targetUrl: 'https://example.com/x',
      campaignId: 'camp-42',
      platform: 'bluesky',
    });

    const resolved = await service.resolve(tracked.slug);
    expect(resolved?.targetUrl).toBe('https://example.com/x');
    expect(resolved?.campaignId).toBe('camp-42');
    expect(resolved?.clickCount).toBe(1);

    const resolvedAgain = await service.resolve(tracked.slug);
    expect(resolvedAgain?.clickCount).toBe(2);
  });

  it('resolve() returns undefined for an unknown slug', async () => {
    expect(await service.resolve('nonexistent')).toBeUndefined();
  });

  it('generates distinct slugs across repeated calls (no accidental reuse)', async () => {
    const a = await service.createShortUrl({ targetUrl: 'https://example.com/a' });
    const b = await service.createShortUrl({ targetUrl: 'https://example.com/b' });
    expect(a.slug).not.toBe(b.slug);
  });
});

describe('LinkRewriter', () => {
  let db: Database;

  beforeEach(() => {
    db = Database.sqlite({ filename: ':memory:' });
    db.migrate();
  });

  afterEach(() => {
    db.close();
  });

  it('UTM-tags the link when no ShortUrlProvider is configured', async () => {
    const rewriter = new LinkRewriter({ logger: testLogger() });
    const result = await rewriter.rewriteLink('https://example.com/vod', {
      platform: 'twitch',
      accountId: 'acc_1',
      campaignId: 'launch',
    });

    const url = new URL(result);
    expect(url.searchParams.get('utm_source')).toBe('twitch');
    expect(url.searchParams.get('utm_campaign')).toBe('launch');
    expect(url.searchParams.get('utm_content')).toBe('acc_1');
  });

  it('shortens the tagged link when a ShortUrlProvider is configured, preserving campaign attribution', async () => {
    const shortUrlService = new LocalShortUrlService({ store: db.shortUrls, logger: testLogger() });
    const rewriter = new LinkRewriter({ logger: testLogger(), shortUrlService });

    const result = await rewriter.rewriteLink('https://example.com/vod', {
      platform: 'bluesky',
      campaignId: 'launch-2',
    });

    expect(result).toMatch(/^https:\/\/trk\.local\/\w+$/);
    const slug = new URL(result).pathname.slice(1);

    const row = await db.shortUrls.findBySlug(slug);
    expect(row?.campaignId).toBe('launch-2');
    // The short URL's target is itself UTM-tagged -- attribution survives even off the mapping table.
    expect(new URL(row!.targetUrl).searchParams.get('utm_campaign')).toBe('launch-2');

    // Clicking the short link attributes back to the same campaign.
    const clicked = await shortUrlService.resolve(slug);
    expect(clicked?.campaignId).toBe('launch-2');
  });

  it('falls back to "uncampaigned" when no campaignId is supplied', async () => {
    const rewriter = new LinkRewriter({ logger: testLogger() });
    const result = await rewriter.rewriteLink('https://example.com/x', { platform: 'discord' });
    expect(new URL(result).searchParams.get('utm_campaign')).toBe('uncampaigned');
  });
});
