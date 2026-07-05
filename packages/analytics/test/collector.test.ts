import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NotSupportedError, RateLimitError, type AnalyticsSnapshot } from '@social/core';
import { Database } from '@social/db';
import { createLogger } from '@social/logging';
import { AnalyticsCollector } from '../src/collector';
import { baseCapabilities, makeConnector, makeCtx, makeResolver, seedFixture } from './support';

describe('AnalyticsCollector', () => {
  let db: Database;

  beforeEach(() => {
    db = Database.sqlite({ filename: ':memory:' });
  });

  afterEach(() => {
    db.close();
  });

  it('collects from a supporting platform and persists a normalized snapshot', async () => {
    const fixture = seedFixture(db, 'mock');
    const snapshot: AnalyticsSnapshot = {
      remoteId: `remote-${fixture.postVariantId}`,
      collectedAt: '2026-07-04T12:00:00.000Z',
      metrics: { likes: 10, views: 200, clicks: 20, comments: 3, shares: 2, followersDelta: 5 },
      raw: { platformExtra: 'ok' },
    };
    const connector = makeConnector(baseCapabilities({ platform: 'mock' }), async () => snapshot);
    const collector = new AnalyticsCollector({
      connectors: makeResolver({ mock: connector }),
      store: db.analyticsSnapshots,
      logger: createLogger({ sink: () => {} }),
    });

    const outcome = await collector.collect({
      platform: 'mock',
      accountId: fixture.accountId,
      postVariantId: fixture.postVariantId,
      remoteId: snapshot.remoteId,
      ctx: makeCtx(),
    });

    expect(outcome.status).toBe('collected');
    expect(outcome.snapshot?.metrics.likes).toBe(10);
    // Derived CTR = clicks / views = 20 / 200 = 0.1.
    expect(outcome.snapshot?.metrics.ctr).toBeCloseTo(0.1);

    const persisted = await db.analyticsSnapshots.listByVariant(fixture.postVariantId);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.metrics.likes).toBe(10);
    expect(persisted[0]?.metrics.ctr).toBeCloseTo(0.1);
    expect(persisted[0]?.raw).toEqual({ platformExtra: 'ok' });
    expect(persisted[0]?.accountId).toBe(fixture.accountId);
  });

  it('skips (and records, without crashing) a platform whose capability declares getAnalytics unsupported', async () => {
    const fixture = seedFixture(db, 'nosupport');
    const connector = makeConnector(
      baseCapabilities({
        platform: 'nosupport',
        operations: {
          connect: true,
          authenticate: true,
          refreshToken: true,
          validatePost: true,
          uploadMedia: false,
          publish: true,
          delete: false,
          edit: false,
          getAnalytics: false,
          disconnect: true,
        },
        supportsAnalytics: false,
      }),
    );
    const collector = new AnalyticsCollector({
      connectors: makeResolver({ nosupport: connector }),
      store: db.analyticsSnapshots,
      logger: createLogger({ sink: () => {} }),
    });

    const outcome = await collector.collect({
      platform: 'nosupport',
      accountId: fixture.accountId,
      postVariantId: fixture.postVariantId,
      remoteId: 'remote-1',
      ctx: makeCtx(),
    });

    expect(outcome.status).toBe('skipped_unsupported');
    expect(await db.analyticsSnapshots.listByVariant(fixture.postVariantId)).toHaveLength(0);
  });

  it('also skips gracefully if getAnalytics throws NotSupportedError at runtime (capability/impl mismatch defense)', async () => {
    const fixture = seedFixture(db, 'mock');
    const connector = makeConnector(baseCapabilities({ platform: 'mock' }), async () => {
      throw new NotSupportedError('getAnalytics', 'mock');
    });
    const collector = new AnalyticsCollector({
      connectors: makeResolver({ mock: connector }),
      store: db.analyticsSnapshots,
      logger: createLogger({ sink: () => {} }),
    });

    const outcome = await collector.collect({
      platform: 'mock',
      accountId: fixture.accountId,
      postVariantId: fixture.postVariantId,
      remoteId: 'remote-1',
      ctx: makeCtx(),
    });
    expect(outcome.status).toBe('skipped_unsupported');
  });

  it('retries a rate-limited platform then succeeds, without crashing the batch', async () => {
    const fixture = seedFixture(db, 'mock');
    let calls = 0;
    const connector = makeConnector(baseCapabilities({ platform: 'mock' }), async () => {
      calls += 1;
      if (calls < 3) {
        throw new RateLimitError('slow down', { retryAfterMs: 1 });
      }
      return {
        remoteId: 'remote-1',
        collectedAt: '2026-07-04T12:00:00.000Z',
        metrics: { likes: 1 },
      };
    });
    const collector = new AnalyticsCollector({
      connectors: makeResolver({ mock: connector }),
      store: db.analyticsSnapshots,
      logger: createLogger({ sink: () => {} }),
      retry: { maxAttempts: 5, sleep: async () => {} },
    });

    const outcome = await collector.collect({
      platform: 'mock',
      accountId: fixture.accountId,
      postVariantId: fixture.postVariantId,
      remoteId: 'remote-1',
      ctx: makeCtx(),
    });

    expect(calls).toBe(3);
    expect(outcome.status).toBe('collected');
  });

  it('records a persistent error (retries exhausted) without throwing, and continues the batch', async () => {
    const fixtureA = seedFixture(db, 'mock');
    const fixtureBDb = fixtureA; // same db, second variant via a second seed on a different platform
    const fixtureB = seedFixture(db, 'mock2');

    const failing = makeConnector(baseCapabilities({ platform: 'mock' }), async () => {
      throw new RateLimitError('still slow', { retryAfterMs: 1 });
    });
    const succeeding = makeConnector(baseCapabilities({ platform: 'mock2' }), async () => ({
      remoteId: 'remote-ok',
      collectedAt: '2026-07-04T12:00:00.000Z',
      metrics: { views: 50 },
    }));

    const collector = new AnalyticsCollector({
      connectors: makeResolver({ mock: failing, mock2: succeeding }),
      store: fixtureBDb.db.analyticsSnapshots,
      logger: createLogger({ sink: () => {} }),
      retry: { maxAttempts: 2, sleep: async () => {} },
    });

    const batch = await collector.collectBatch([
      {
        platform: 'mock',
        accountId: fixtureA.accountId,
        postVariantId: fixtureA.postVariantId,
        remoteId: 'remote-fail',
        ctx: makeCtx(),
      },
      {
        platform: 'mock2',
        accountId: fixtureB.accountId,
        postVariantId: fixtureB.postVariantId,
        remoteId: 'remote-ok',
        ctx: makeCtx(),
      },
    ]);

    expect(batch.errored).toBe(1);
    expect(batch.collected).toBe(1);
    expect(batch.outcomes[0]?.status).toBe('error');
    expect(batch.outcomes[1]?.status).toBe('collected');
  });
});
