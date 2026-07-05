/**
 * t21: `LinkRewriter` wired into `CampaignService.composeAndSubmit` as an
 * OPTIONAL, injected step. Proves:
 *  - with no `linkRewriter` configured, `composeAndSubmit` behaves exactly as
 *    it did before t21 (existing m3/m4 callers unaffected);
 *  - with a `linkRewriter` configured, the campaign's `link` is rewritten to a
 *    tracked short URL BEFORE generation, the generated variant's text
 *    contains the tracked link (not the original), the rewritten link still
 *    passes the target platform's `validatePost` gate, and the tracked link
 *    round-trips through a real `@social/db`-backed `short_urls` mapping —
 *    including click attribution back to the campaign via `resolve()`.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Database } from '@social/db';
import { MockProvider } from '@social/ai';
import { LinkRewriter, LocalShortUrlService } from '@social/analytics';
import { buildPipeline, type Pipeline } from '../src/pipeline';
import { CampaignService } from '../src/campaign-service';
import { CapturingLogger, nonExpiringToken } from './support';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const DISCORD_BOT_TOKEN = 'super-secret-discord-bot-token-linktest';

describe('CampaignService link rewriting (t21, optional + additive)', () => {
  let mediaOutDir: string;
  let logger: CapturingLogger;
  let db: Database;
  let pipeline: Pipeline;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    mediaOutDir = await mkdtemp(join(tmpdir(), 'social-linktest-out-'));
    logger = new CapturingLogger();
    db = Database.sqlite({ filename: ':memory:' }, { logger });
    db.migrate();

    pipeline = await buildPipeline({
      db,
      logger,
      now: () => new Date('2026-07-04T12:00:00.000Z'),
      contentProvider: new MockProvider(),
      mediaOutDir,
    });
    await pipeline.loadPlugins();

    fetchMock = vi.fn(async (input: string | URL) => {
      const url = input.toString();
      if (url.includes('discord.com') && url.includes('/messages')) {
        const channelMatch = /channels\/(\d+)\/messages/.exec(url);
        return jsonResponse({
          id: `msg-${channelMatch?.[1] ?? '0'}`,
          channel_id: channelMatch?.[1] ?? '0',
          timestamp: '2026-07-04T12:00:00.000Z',
        });
      }
      throw new Error(`Unexpected fetch in link-rewrite test: ${url}`);
    }) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(mediaOutDir, { recursive: true, force: true });
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

  it('without a linkRewriter, the original link is published verbatim (no behavior change)', async () => {
    const accountId = await pairDiscord('guild-channel-no-rewrite');
    const campaigns = new CampaignService({
      connectors: pipeline.connectors,
      publishService: pipeline.publishService,
      provider: new MockProvider(),
      logger,
      mediaOutDir,
    });

    const result = await campaigns.composeAndSubmit({
      description: 'Check out our new devlog.',
      link: 'https://example.com/devlog',
      platforms: [{ platformId: 'discord', accountId, platformOptions: { channelId: '111' } }],
    });

    expect(result.results[0]?.status).toBe('enqueued');
    const variantId = result.results[0]!.postVariantId!;
    const variant = pipeline.variants.getById(variantId);
    expect(variant).toBeDefined();
    // The raw payload text (persisted at enqueue time) must contain the ORIGINAL link, untouched.
    const row = db
      .raw()
      .get<{ text: string | null }>('SELECT text FROM post_variants WHERE id = ?', [variantId]);
    expect(row?.text).toContain('https://example.com/devlog');
    expect(row?.text).not.toContain('utm_source');
  });

  it('with a linkRewriter, the campaign link is tracked, still validates, and click attribution round-trips', async () => {
    const accountId = await pairDiscord('guild-channel-with-rewrite');
    const shortUrlService = new LocalShortUrlService({ store: db.shortUrls, logger, baseUrl: 'https://trk.local' });
    const linkRewriter = new LinkRewriter({ logger, shortUrlService });

    const campaigns = new CampaignService({
      connectors: pipeline.connectors,
      publishService: pipeline.publishService,
      provider: new MockProvider(),
      logger,
      mediaOutDir,
      linkRewriter,
    });

    const result = await campaigns.composeAndSubmit({
      description: 'Check out our new devlog.',
      link: 'https://example.com/devlog',
      campaignId: 'devlog-campaign',
      platforms: [{ platformId: 'discord', accountId, platformOptions: { channelId: '222' } }],
    });

    // 1. Still passes validatePost / gets enqueued -- the platform's own limits are respected.
    expect(result.results[0]?.status).toBe('enqueued');
    expect(result.results[0]?.validation?.ok).toBe(true);

    // 2. The persisted variant text carries the TRACKED link, not the original bare URL.
    const variantId = result.results[0]!.postVariantId!;
    const row = db
      .raw()
      .get<{ text: string | null }>('SELECT text FROM post_variants WHERE id = ?', [variantId]);
    expect(row?.text).not.toContain('https://example.com/devlog');
    expect(row?.text).toMatch(/https:\/\/trk\.local\/\w+/);

    // 3. The tracked slug round-trips through the real DB mapping to the UTM-tagged target + campaign.
    const slugMatch = /https:\/\/trk\.local\/(\w+)/.exec(row!.text!);
    expect(slugMatch).toBeTruthy();
    const slug = slugMatch![1]!;
    const mapping = await db.shortUrls.findBySlug(slug);
    expect(mapping?.campaignId).toBe('devlog-campaign');
    expect(mapping?.targetUrl).toContain('utm_campaign=devlog-campaign');
    expect(mapping?.targetUrl).toContain('utm_source=discord');

    // 4. Click attribution: resolving the slug (as a redirect handler would) maps back to the campaign.
    const clicked = await shortUrlService.resolve(slug);
    expect(clicked?.campaignId).toBe('devlog-campaign');
    expect(clicked?.clickCount).toBe(1);

    // 5. The worker still publishes successfully end-to-end with the rewritten link in place.
    const processed = await pipeline.worker.runOnce();
    expect(processed).toBe(1);
    const published = pipeline.variants.getById(variantId);
    expect(published?.status).toBe('published');
  });

  it('link-rewrite failure never blocks the campaign -- falls back to the original link', async () => {
    const accountId = await pairDiscord('guild-channel-rewrite-fails');
    const failingRewriter = {
      rewriteLink: vi.fn().mockRejectedValue(new Error('short-url backend unavailable')),
    } as unknown as LinkRewriter;

    const campaigns = new CampaignService({
      connectors: pipeline.connectors,
      publishService: pipeline.publishService,
      provider: new MockProvider(),
      logger,
      mediaOutDir,
      linkRewriter: failingRewriter,
    });

    const result = await campaigns.composeAndSubmit({
      description: 'Fallback path check.',
      link: 'https://example.com/fallback',
      platforms: [{ platformId: 'discord', accountId, platformOptions: { channelId: '333' } }],
    });

    expect(result.results[0]?.status).toBe('enqueued');
    const variantId = result.results[0]!.postVariantId!;
    const row = db
      .raw()
      .get<{ text: string | null }>('SELECT text FROM post_variants WHERE id = ?', [variantId]);
    expect(row?.text).toContain('https://example.com/fallback');
  });
});
