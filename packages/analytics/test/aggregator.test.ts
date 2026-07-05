import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Database } from '@social/db';
import { createLogger } from '@social/logging';
import { CampaignAggregator } from '../src/aggregator';
import { seedFixture } from './support';

describe('CampaignAggregator', () => {
  let db: Database;

  beforeEach(() => {
    db = Database.sqlite({ filename: ':memory:' });
  });

  afterEach(() => {
    db.close();
  });

  it('rolls up per-post snapshots into per-campaign totals with correct CTR', async () => {
    const a = seedFixture(db, 'platformA');
    // Second post variant in the SAME campaign, on a different platform.
    const now = new Date().toISOString();
    db.platforms.upsert({ id: 'platformB', displayName: 'B', apiBaseUrl: 'https://b', contractVersion: '1.0.0' });
    db.raw().run(
      `INSERT INTO accounts (id, platform_id, remote_id, status, created_at, updated_at) VALUES (?, 'platformB', 'remote-b', 'active', ?, ?)`,
      ['acc_b', now, now],
    );
    db.raw().run(
      `INSERT INTO posts (id, campaign_id, brief, status, created_at, updated_at) VALUES ('post_b', ?, 'brief', 'published', ?, ?)`,
      [a.campaignId, now, now],
    );
    db.raw().run(
      `INSERT INTO post_variants (id, post_id, account_id, platform_id, payload, status, remote_id, created_at, updated_at)
       VALUES ('pv_b', 'post_b', 'acc_b', 'platformB', '{}', 'published', 'remote-b', ?, ?)`,
      [now, now],
    );

    await db.analyticsSnapshots.insert({
      postVariantId: a.postVariantId,
      accountId: a.accountId,
      remoteId: 'remote-a',
      collectedAt: '2026-07-04T10:00:00.000Z',
      metrics: { likes: 10, views: 100, clicks: 10, comments: 1 },
    });
    await db.analyticsSnapshots.insert({
      postVariantId: 'pv_b',
      accountId: 'acc_b',
      remoteId: 'remote-b',
      collectedAt: '2026-07-04T11:00:00.000Z',
      metrics: { likes: 5, views: 100, clicks: 10, shares: 4 },
    });

    // A snapshot for a DIFFERENT campaign must not leak into this rollup.
    const other = seedFixture(db, 'platformC');
    await db.analyticsSnapshots.insert({
      postVariantId: other.postVariantId,
      accountId: other.accountId,
      remoteId: 'remote-c',
      collectedAt: '2026-07-04T09:00:00.000Z',
      metrics: { likes: 1000, views: 1000 },
    });

    const aggregator = new CampaignAggregator({ store: db.analyticsSnapshots, logger: createLogger({ sink: () => {} }) });
    const summary = await aggregator.aggregate(a.campaignId);

    expect(summary.snapshotCount).toBe(2);
    expect(summary.postVariantCount).toBe(2);
    expect(summary.platforms.sort()).toEqual(['platformA', 'platformB']);
    expect(summary.totals.likes).toBe(15);
    expect(summary.totals.views).toBe(200);
    expect(summary.totals.clicks).toBe(20);
    expect(summary.totals.comments).toBe(1);
    expect(summary.totals.shares).toBe(4);
    // CTR recomputed from totals: 20 clicks / 200 views = 0.1 (NOT an average of per-post ctr).
    expect(summary.ctr).toBeCloseTo(0.1);
  });

  it('returns an empty summary (no crash) for a campaign with no snapshots yet', async () => {
    db.migrate();
    const now = new Date().toISOString();
    db.raw().run(
      `INSERT INTO campaigns (id, name, status, created_at, updated_at) VALUES ('camp_empty', 'Empty', 'active', ?, ?)`,
      [now, now],
    );
    const aggregator = new CampaignAggregator({ store: db.analyticsSnapshots, logger: createLogger({ sink: () => {} }) });
    const summary = await aggregator.aggregate('camp_empty');
    expect(summary.snapshotCount).toBe(0);
    expect(summary.totals).toEqual({});
    expect(summary.ctr).toBeUndefined();
  });
});
