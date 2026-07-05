/**
 * m5 capstone integration test (t23): schedule a RECURRING campaign across
 * discord + bluesky -> `ScheduleMaterializer` enqueues occurrence jobs (via
 * `CampaignService.composeAndSubmit`, with a `LinkRewriter`-tracked link) ->
 * the real `@social/queue` `Worker` publishes them (mocked platform HTTP) ->
 * `collect_analytics` jobs run through that SAME worker/retry/DLQ machinery
 * -> `CampaignAggregator` rolls the per-post snapshots up by campaign
 * (totals + CTR).
 *
 * Proves scheduling (t19) + the job queue (t22) + analytics collection (t20)
 * + URL tracking (t21) work TOGETHER through the real pipeline, backed by a
 * real migrated SQLite DB, `MockProvider` (@social/ai, no network/API key),
 * and mocked platform HTTP via a single stubbed global `fetch`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Database } from '@social/db';
import { MockProvider } from '@social/ai';
import { LinkRewriter, LocalShortUrlService } from '@social/analytics';
import { buildPipeline, type Pipeline } from '../src/pipeline';
import { CapturingLogger, nonExpiringToken } from './support';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function fakeJwt(sub: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ sub, scope: 'com.atproto.access' })).toString('base64url');
  return `${header}.${payload}.sig`;
}

const DISCORD_BOT_TOKEN = 'super-secret-discord-bot-token-m5';
const BLUESKY_ACCESS = fakeJwt('did:plc:m5account');

describe('m5 capstone: scheduling + queue + analytics + URL tracking wired end-to-end', () => {
  let logger: CapturingLogger;
  let db: Database;
  let pipeline: Pipeline;
  let fetchMock: ReturnType<typeof vi.fn>;
  let blueskyRecordCounter: number;
  let bskyPostMetrics: Map<string, { likeCount: number; replyCount: number; repostCount: number }>;

  beforeEach(async () => {
    logger = new CapturingLogger();
    db = Database.sqlite({ filename: ':memory:' }, { logger });
    db.migrate();

    const shortUrlService = new LocalShortUrlService({ store: db.shortUrls, logger, baseUrl: 'https://trk.local' });
    const linkRewriter = new LinkRewriter({ logger, shortUrlService });

    pipeline = await buildPipeline({
      db,
      logger,
      now: () => new Date('2026-07-04T08:00:00.000Z'),
      contentProvider: new MockProvider(),
      linkRewriter,
    });
    await pipeline.loadPlugins();

    blueskyRecordCounter = 0;
    bskyPostMetrics = new Map();

    fetchMock = vi.fn(async (input: string | URL) => {
      const url = input.toString();

      // Discord: POST a message to a channel.
      if (url.includes('discord.com') && url.includes('/messages')) {
        const channelMatch = /channels\/(\d+)\/messages/.exec(url);
        return jsonResponse({
          id: `msg-${channelMatch?.[1] ?? '0'}-${Math.random().toString(36).slice(2, 8)}`,
          channel_id: channelMatch?.[1] ?? '0',
          timestamp: '2026-07-04T09:00:00.000Z',
        });
      }

      // Bluesky: AT Proto XRPC createRecord (publish) — one unique uri per call.
      if (url.includes('com.atproto.repo.createRecord')) {
        blueskyRecordCounter += 1;
        const uri = `at://did:plc:m5account/app.bsky.feed.post/rec${blueskyRecordCounter}`;
        bskyPostMetrics.set(uri, {
          likeCount: 10 * blueskyRecordCounter,
          replyCount: blueskyRecordCounter,
          repostCount: 2 * blueskyRecordCounter,
        });
        return jsonResponse({ uri, cid: `bafycid-${blueskyRecordCounter}` });
      }

      // Bluesky: getAnalytics -> app.bsky.feed.getPosts.
      if (url.includes('app.bsky.feed.getPosts')) {
        const parsed = new URL(url);
        const uris = parsed.searchParams.getAll('uris');
        const posts = uris.filter((uri) => bskyPostMetrics.has(uri)).map((uri) => ({ uri, cid: 'bafycid', ...bskyPostMetrics.get(uri)! }));
        return jsonResponse({ posts });
      }

      throw new Error(`Unexpected fetch in m5 capstone test: ${url}`);
    }) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function pairDiscord(remoteId: string): Promise<string> {
    const capabilities = pipeline.connectors.resolve('discord').capabilities;
    db.platforms.upsert({
      id: 'discord',
      displayName: capabilities.displayName,
      apiBaseUrl: capabilities.apiBaseUrl,
      contractVersion: capabilities.contractVersion,
      capabilities,
    });
    const summary = await pipeline.accountManager.addAccount(
      { platformId: 'discord', remoteId, displayName: remoteId },
      nonExpiringToken(DISCORD_BOT_TOKEN),
    );
    return summary.id;
  }

  async function pairBluesky(remoteId: string): Promise<string> {
    const capabilities = pipeline.connectors.resolve('bluesky').capabilities;
    db.platforms.upsert({
      id: 'bluesky',
      displayName: capabilities.displayName,
      apiBaseUrl: capabilities.apiBaseUrl,
      contractVersion: capabilities.contractVersion,
      capabilities,
    });
    const summary = await pipeline.accountManager.addAccount(
      { platformId: 'bluesky', remoteId, displayName: remoteId },
      {
        accessToken: BLUESKY_ACCESS,
        tokenType: 'Bearer',
        scopes: ['atproto'],
        obtainedAt: new Date('2026-07-04T00:00:00.000Z').toISOString(),
      },
    );
    return summary.id;
  }

  it('recurring campaign materializes idempotently, publishes, collects analytics, and tracks URLs — across discord + bluesky', async () => {
    const discordAccountId = await pairDiscord('guild-channel-m5');
    const blueskyAccountId = await pairBluesky('did:plc:m5account');
    const campaignId = 'summer-sale-m5';

    // --- 1. Create the recurring schedule -----------------------------------
    const schedule = pipeline.scheduler.scheduleCampaign({
      mode: 'recurring',
      description: 'Daily summer sale reminder: 20% off everything today only.',
      link: 'https://example.com/summer-sale',
      campaignId,
      startLocalDateTime: '2026-07-04T09:00:00',
      timezone: 'UTC',
      recurrenceRule: 'FREQ=DAILY',
      platforms: [
        { platformId: 'discord', accountId: discordAccountId, platformOptions: { channelId: '555' } },
        { platformId: 'bluesky', accountId: blueskyAccountId },
      ],
    });
    expect(schedule.mode).toBe('recurring');
    expect(schedule.nextRunAt).toBe('2026-07-04T09:00:00.000Z');

    // --- 2. First occurrence materializes: 2 publish jobs (discord + bluesky) ---
    const day1 = new Date('2026-07-04T09:00:00.000Z');
    const firstSweep = await pipeline.scheduler.materializer.materializeDue(day1);
    expect(firstSweep).toHaveLength(1);
    expect(firstSweep[0]?.outcome).toBe('submitted');

    let allJobs = await db.jobs.listAll();
    expect(allJobs.filter((j) => j.operation === 'publish')).toHaveLength(2);

    // --- 3. Overlapping sweep of the SAME due window must not double-enqueue ---
    // (the materializer's claimOccurrence CAS already advanced next_run_at past
    // day1, so re-sweeping the identical `now` sees nothing due.)
    const secondSweepSameWindow = await pipeline.scheduler.materializer.materializeDue(day1);
    expect(secondSweepSameWindow).toHaveLength(0);
    allJobs = await db.jobs.listAll();
    expect(allJobs.filter((j) => j.operation === 'publish')).toHaveLength(2); // unchanged

    // Every enqueued job's idempotency key carries the occurrence instant (t23 wiring):
    // `${postVariantId}:publish:${occurrenceKey}` — proves occurrenceKey threaded
    // from ScheduleMaterializer -> CampaignService -> PublishService -> queue.
    for (const job of allJobs) {
      expect(job.idempotencyKey.endsWith(':2026-07-04T09:00:00.000Z')).toBe(true);
    }

    // --- 4. Second occurrence (the recurrence's next day) -------------------
    const day2 = new Date('2026-07-05T09:00:00.000Z');
    const thirdSweep = await pipeline.scheduler.materializer.materializeDue(day2);
    expect(thirdSweep).toHaveLength(1);
    expect(thirdSweep[0]?.outcome).toBe('submitted');

    allJobs = await db.jobs.listAll();
    const publishJobs = allJobs.filter((j) => j.operation === 'publish');
    expect(publishJobs).toHaveLength(4); // 2 occurrences x 2 platforms
    expect(publishJobs.filter((j) => j.idempotencyKey.endsWith(':2026-07-05T09:00:00.000Z'))).toHaveLength(2);

    // --- 5. URL tracking: every occurrence/platform rewrote the link to a tracked short URL ---
    const shortUrls = await db.shortUrls.listByCampaign(campaignId);
    expect(shortUrls.length).toBeGreaterThanOrEqual(4); // 2 occurrences x 2 platforms
    for (const short of shortUrls) {
      expect(short.campaignId).toBe(campaignId);
      expect(short.targetUrl).toContain(`utm_campaign=${campaignId}`);
    }

    // --- 6. Run the worker: all 4 publish jobs succeed via mocked platform HTTP ---
    let processed = 0;
    do {
      processed = await pipeline.worker.runOnce();
    } while (processed > 0);

    const finalPublishJobs = (await db.jobs.listAll()).filter((j) => j.operation === 'publish');
    for (const job of finalPublishJobs) {
      expect(job.status).toBe('succeeded');
    }
    expect(await db.jobs.listDeadLetters()).toHaveLength(0);

    const variantRows = db
      .raw()
      .all<{ id: string; platform_id: string; remote_id: string | null; status: string }>(
        'SELECT id, platform_id, remote_id, status FROM post_variants',
      );
    expect(variantRows).toHaveLength(4);
    for (const row of variantRows) {
      expect(row.status).toBe('published');
      expect(row.remote_id).toBeTruthy();
    }

    // Every variant is tagged to the campaign (post_variants -> posts.campaign_id).
    const postCampaignRows = db.raw().all<{ campaign_id: string | null }>('SELECT campaign_id FROM posts');
    expect(postCampaignRows.every((r) => r.campaign_id === campaignId)).toBe(true);

    // --- 7. Analytics collection through the SAME queue/worker/DLQ machinery ---
    const discordVariants = variantRows.filter((r) => r.platform_id === 'discord');
    const blueskyVariants = variantRows.filter((r) => r.platform_id === 'bluesky');
    expect(discordVariants).toHaveLength(2);
    expect(blueskyVariants).toHaveLength(2);

    for (const v of discordVariants) {
      await pipeline.analytics.enqueueCollection({
        platform: 'discord',
        accountId: discordAccountId,
        postVariantId: v.id,
        remoteId: v.remote_id!,
      });
    }
    for (const v of blueskyVariants) {
      await pipeline.analytics.enqueueCollection({
        platform: 'bluesky',
        accountId: blueskyAccountId,
        postVariantId: v.id,
        remoteId: v.remote_id!,
      });
    }

    processed = 0;
    do {
      processed = await pipeline.worker.runOnce();
    } while (processed > 0);

    const analyticsJobs = (await db.jobs.listAll()).filter((j) => j.operation === 'collect_analytics');
    expect(analyticsJobs).toHaveLength(4);
    for (const job of analyticsJobs) {
      // Discord's "unsupported" outcome is still a queue SUCCESS (skipped, not failed/DLQ'd).
      expect(job.status).toBe('succeeded');
    }
    expect(await db.jobs.listDeadLetters()).toHaveLength(0);

    // Discord (getAnalytics unsupported) wrote NO snapshot rows; bluesky wrote one per variant.
    const snapshotsAfterCollection = await db.analyticsSnapshots.listAll();
    expect(snapshotsAfterCollection).toHaveLength(2);
    for (const snap of snapshotsAfterCollection) {
      expect(blueskyVariants.some((v) => v.id === snap.postVariantId)).toBe(true);
      expect(snap.metrics.likes).toBeGreaterThan(0);
    }

    // --- 8. CampaignAggregator rolls the campaign's snapshots up (totals + CTR) ---
    // GAP (routed to connector-engineer/analytics-logging): none of the current
    // connectors (discord/bluesky/twitch) report the canonical `clicks`/`views`
    // metrics `getAnalytics` would need for a live CTR — bluesky only reports
    // likes/comments/shares. To exercise CampaignAggregator's CTR math against a
    // real DB row (not a unit-test double), one supplementary snapshot is
    // inserted directly through the same `AnalyticsSnapshotsStore` port the
    // collector itself writes through.
    await db.analyticsSnapshots.insert({
      postVariantId: blueskyVariants[0]!.id,
      accountId: blueskyAccountId,
      remoteId: blueskyVariants[0]!.remote_id!,
      collectedAt: '2026-07-05T10:00:00.000Z',
      metrics: { clicks: 10, views: 100 },
    });

    const summary = await pipeline.analytics.aggregator.aggregate(campaignId);
    expect(summary.snapshotCount).toBe(3);
    expect(summary.postVariantCount).toBe(2);
    expect(summary.platforms).toEqual(['bluesky']);
    expect(summary.totals.likes).toBeGreaterThan(0);
    expect(summary.totals.clicks).toBe(10);
    expect(summary.totals.views).toBe(100);
    expect(summary.ctr).toBeCloseTo(0.1);

    // --- 9. No raw secrets leaked into any structured log line --------------
    const logs = logger.lines.map((l) => JSON.stringify(l)).join('\n');
    expect(logs.includes(DISCORD_BOT_TOKEN)).toBe(false);
    expect(logs.includes(BLUESKY_ACCESS)).toBe(false);
  });
});
