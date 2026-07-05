/**
 * `short_urls` migration (0004) + `SqliteShortUrlsStore` round-trip: create a
 * slug -> target mapping, resolve it back (click attribution), and confirm a
 * collision on an existing slug is rejected (caller retries with a new one).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Database } from '../src/index';

describe('@social/db short_urls (migration 0004)', () => {
  let db: Database;

  beforeEach(() => {
    db = Database.sqlite({ filename: ':memory:' });
    db.migrate();
  });

  afterEach(() => {
    db.close();
  });

  it('creates a slug -> target mapping and resolves it back with campaign context', async () => {
    const created = await db.shortUrls.create({
      slug: 'abc123',
      targetUrl: 'https://example.com/post?utm_source=twitch&utm_campaign=launch',
      campaignId: 'launch',
      platformId: 'twitch',
      accountId: 'acc_1',
    });
    expect(created.slug).toBe('abc123');
    expect(created.clickCount).toBe(0);
    expect(created.lastClickedAt).toBeNull();

    const found = await db.shortUrls.findBySlug('abc123');
    expect(found?.targetUrl).toBe('https://example.com/post?utm_source=twitch&utm_campaign=launch');
    expect(found?.campaignId).toBe('launch');
    expect(found?.platformId).toBe('twitch');
  });

  it('attributes a click to a campaign via resolve/recordClick and increments the counter', async () => {
    await db.shortUrls.create({
      slug: 'clk001',
      targetUrl: 'https://example.com/x',
      campaignId: 'summer-sale',
    });

    const afterFirstClick = await db.shortUrls.recordClick('clk001');
    expect(afterFirstClick?.campaignId).toBe('summer-sale');
    expect(afterFirstClick?.clickCount).toBe(1);
    expect(afterFirstClick?.lastClickedAt).toBeTruthy();

    const afterSecondClick = await db.shortUrls.recordClick('clk001');
    expect(afterSecondClick?.clickCount).toBe(2);
  });

  it('returns undefined for an unknown slug (never throws)', async () => {
    expect(await db.shortUrls.findBySlug('does-not-exist')).toBeUndefined();
    expect(await db.shortUrls.recordClick('does-not-exist')).toBeUndefined();
  });

  it('rejects a duplicate slug (primary key) so callers can retry with a fresh one', async () => {
    await db.shortUrls.create({ slug: 'dup', targetUrl: 'https://example.com/a' });
    await expect(db.shortUrls.create({ slug: 'dup', targetUrl: 'https://example.com/b' })).rejects.toThrow();
  });

  it('lists every short URL created for a campaign', async () => {
    await db.shortUrls.create({ slug: 's1', targetUrl: 'https://example.com/1', campaignId: 'camp-a' });
    await db.shortUrls.create({ slug: 's2', targetUrl: 'https://example.com/2', campaignId: 'camp-a' });
    await db.shortUrls.create({ slug: 's3', targetUrl: 'https://example.com/3', campaignId: 'camp-b' });

    const forA = await db.shortUrls.listByCampaign('camp-a');
    expect(forA.map((r) => r.slug).sort()).toEqual(['s1', 's2']);
  });
});
