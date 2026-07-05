/**
 * Regression test (t28, item 5): campaign attribution on the DIRECT publish path.
 *
 * t25 flagged that `CampaignService.composeAndSubmit` might not forward
 * `campaignId` into `PublishService.submitPost` on the direct (non-scheduled)
 * publish path, which would make campaign analytics under-attribute variants
 * created by a plain `composeAndSubmit(...)` call (i.e. the API/dashboard path,
 * as opposed to the scheduler's `scheduleCampaign(...)` path already covered by
 * `scheduling.analytics.e2e.test.ts`).
 *
 * This test drives `composeAndSubmit` DIRECTLY (no scheduler, no materializer)
 * with an explicit `campaignId` and asserts the persisted `posts.campaign_id`
 * of the resulting variant carries that id — i.e. the variant is attributable
 * to the campaign, so `CampaignAggregator.aggregate(campaignId)` will roll it up.
 *
 * It also asserts the `campaignId ?? campaign` fallback: when only the free-text
 * `campaign` name is supplied (no explicit `campaignId`), that name is used as
 * the attribution id — matching `CampaignService`'s documented behavior.
 */

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

import { Database } from '@social/db';
import { MockProvider } from '@social/ai';
import { buildPipeline, type Pipeline } from '../src/pipeline';
import { CampaignService } from '../src/campaign-service';
import { CapturingLogger, nonExpiringToken } from './support';

const DISCORD_BOT_TOKEN = 'super-secret-discord-bot-token-attribution';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('CampaignService.composeAndSubmit — campaign attribution on the direct path (t28)', () => {
  let logger: CapturingLogger;
  let db: Database;
  let pipeline: Pipeline;
  let campaigns: CampaignService;

  beforeEach(async () => {
    logger = new CapturingLogger();
    db = Database.sqlite({ filename: ':memory:' }, { logger });
    db.migrate();

    pipeline = await buildPipeline({
      db,
      logger,
      now: () => new Date('2026-07-04T12:00:00.000Z'),
      contentProvider: new MockProvider(),
    });
    await pipeline.loadPlugins();
    campaigns = pipeline.campaigns!;

    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = input.toString();
      if (url.includes('discord.com') && url.includes('/messages')) {
        const channelMatch = /channels\/(\d+)\/messages/.exec(url);
        return jsonResponse({ id: `msg-${channelMatch?.[1] ?? '0'}`, channel_id: channelMatch?.[1] ?? '0', timestamp: '2026-07-04T12:00:00.000Z' });
      }
      throw new Error(`Unexpected fetch in attribution test: ${url}`);
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

  it('forwards an explicit campaignId into the persisted posts.campaign_id of a directly-submitted variant', async () => {
    const accountId = await pairDiscord('guild-channel-attr-1');
    const campaignId = 'launch-week-2026';

    const result = await campaigns.composeAndSubmit({
      description: 'Big launch this week — join us for the reveal stream tonight!',
      campaignId,
      platforms: [{ platformId: 'discord', accountId, platformOptions: { channelId: '999' } }],
    });

    const discord = result.results[0]!;
    expect(discord.status).toBe('enqueued');
    expect(discord.postVariantId).toBeTruthy();

    // The variant exists and is tied through posts.campaign_id to the campaign.
    const postRows = db
      .raw()
      .all<{ campaign_id: string | null }>(
        `SELECT p.campaign_id AS campaign_id
           FROM post_variants v JOIN posts p ON p.id = v.post_id
          WHERE v.id = ?`,
        [discord.postVariantId!],
      );
    expect(postRows).toHaveLength(1);
    expect(postRows[0]!.campaign_id).toBe(campaignId);

    // The campaigns row was materialized so aggregation can join through it.
    const campaignRow = db.raw().get<{ id: string }>('SELECT id FROM campaigns WHERE id = ?', [campaignId]);
    expect(campaignRow?.id).toBe(campaignId);
  });

  it('falls back to the free-text campaign name as the attribution id when no explicit campaignId is given', async () => {
    const accountId = await pairDiscord('guild-channel-attr-2');

    const result = await campaigns.composeAndSubmit({
      description: 'Weekly community roundup — highlights from the last seven days.',
      campaign: 'weekly-roundup',
      platforms: [{ platformId: 'discord', accountId, platformOptions: { channelId: '111' } }],
    });

    const discord = result.results[0]!;
    expect(discord.status).toBe('enqueued');

    const postRows = db
      .raw()
      .all<{ campaign_id: string | null }>(
        `SELECT p.campaign_id AS campaign_id
           FROM post_variants v JOIN posts p ON p.id = v.post_id
          WHERE v.id = ?`,
        [discord.postVariantId!],
      );
    expect(postRows[0]!.campaign_id).toBe('weekly-roundup');
  });

  it('leaves posts.campaign_id NULL when neither campaignId nor campaign is supplied (no false attribution)', async () => {
    const accountId = await pairDiscord('guild-channel-attr-3');

    const result = await campaigns.composeAndSubmit({
      description: 'A one-off announcement with no campaign attached.',
      platforms: [{ platformId: 'discord', accountId, platformOptions: { channelId: '222' } }],
    });

    const discord = result.results[0]!;
    expect(discord.status).toBe('enqueued');

    const postRows = db
      .raw()
      .all<{ campaign_id: string | null }>(
        `SELECT p.campaign_id AS campaign_id
           FROM post_variants v JOIN posts p ON p.id = v.post_id
          WHERE v.id = ?`,
        [discord.postVariantId!],
      );
    expect(postRows[0]!.campaign_id).toBeNull();
  });
});
