/**
 * m4 capstone integration test: `CampaignService.composeAndSubmit` end-to-end
 * across multiple real connectors (discord + twitch + bluesky) at once, from
 * ONE content description + ONE source image, backed by:
 *   - `MockProvider` (@social/ai) — deterministic, no API key, no network.
 *   - A real `RenditionPlanner` (@social/media) running real `sharp` against a
 *     real fixture image on disk.
 *   - A real migrated in-memory SQLite `@social/db`.
 *   - All platform HTTP mocked via a single stubbed global `fetch` (every
 *     connector here — Discord, Twitch, Bluesky — calls the platform's REST
 *     API through the global `fetch`, so one stub covers all three).
 *
 * Asserts the full description -> variants -> media -> validate -> enqueue
 * chain: a variant is generated per platform within its character limit,
 * renditions are produced from the one source image, valid variants are
 * persisted + enqueued (real `publish_jobs` rows), and a deliberately invalid
 * variant (an oversized Discord embed title) is REJECTED — never enqueued —
 * with its validation errors surfaced in the result. Finally, the worker runs
 * one enqueued job through to a mocked `connector.publish()` to prove the
 * m3 (queue/worker) and m4 (campaign) paths still connect end-to-end.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Database } from '@social/db';
import { MockProvider } from '@social/ai';
import type { SourceMedia } from '@social/media';
import { buildPipeline, type Pipeline } from '../src/pipeline';
import { CampaignService } from '../src/campaign-service';
import { CapturingLogger, nonExpiringToken, farFutureToken } from './support';

function fakeJwt(sub: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ sub, scope: 'com.atproto.access' })).toString('base64url');
  return `${header}.${payload}.sig`;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

async function makeFixtureImage(dir: string): Promise<string> {
  const path = join(dir, 'source.jpg');
  await sharp({ create: { width: 1600, height: 900, channels: 3, background: { r: 30, g: 90, b: 180 } } })
    .jpeg({ quality: 90 })
    .toFile(path);
  return path;
}

const DISCORD_BOT_TOKEN = 'super-secret-discord-bot-token-campaign';
const BLUESKY_ACCESS = fakeJwt('did:plc:campaignaccount');
const TWITCH_ACCESS = 'super-secret-twitch-access-token-campaign';
const TWITCH_REFRESH = 'super-secret-twitch-refresh-token-campaign';

describe('CampaignService.composeAndSubmit (m4 capstone, multi-platform)', () => {
  let srcDir: string;
  let mediaOutDir: string;
  let logger: CapturingLogger;
  let db: Database;
  let pipeline: Pipeline;
  let campaigns: CampaignService;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    srcDir = await mkdtemp(join(tmpdir(), 'social-campaign-src-'));
    mediaOutDir = await mkdtemp(join(tmpdir(), 'social-campaign-out-'));

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
    expect(pipeline.campaigns).toBeDefined();
    campaigns = pipeline.campaigns!;

    fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = input.toString();

      // Discord: POST a message to a channel.
      if (url.includes('discord.com') && url.includes('/messages')) {
        const channelMatch = /channels\/(\d+)\/messages/.exec(url);
        return jsonResponse({
          id: `msg-${channelMatch?.[1] ?? '0'}`,
          channel_id: channelMatch?.[1] ?? '0',
          timestamp: '2026-07-04T12:00:00.000Z',
        });
      }

      // Twitch: token validation + channel-info update.
      if (url.includes('id.twitch.tv') || url.includes('/oauth2/validate')) {
        return jsonResponse({ client_id: 'app-client-id', login: 'coolstreamer', user_id: 'broadcaster-campaign', scopes: [] });
      }
      if (url.includes('api.twitch.tv') && url.includes('/helix/channels')) {
        return new Response(null, { status: 204 });
      }

      // Bluesky: image upload (media attached) + AT Proto XRPC createRecord.
      if (url.includes('com.atproto.repo.uploadBlob')) {
        return jsonResponse({
          blob: { $type: 'blob', ref: { $link: 'bafyblob-campaign' }, mimeType: 'image/jpeg', size: 12345 },
        });
      }
      if (url.includes('com.atproto.repo.createRecord')) {
        return jsonResponse({ uri: 'at://did:plc:campaignaccount/app.bsky.feed.post/xyz789', cid: 'bafycid-campaign' });
      }

      throw new Error(`Unexpected fetch in campaign test: ${url} (init=${JSON.stringify(init)})`);
    }) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(srcDir, { recursive: true, force: true });
    await rm(mediaOutDir, { recursive: true, force: true });
  });

  it('generates per-platform variants, produces renditions, enqueues valid variants, and rejects an oversized invalid one', async () => {
    const discordAccountId = await pairAccount(pipeline, db, {
      platformId: 'discord',
      remoteId: 'guild-channel-campaign-1',
      token: nonExpiringToken(DISCORD_BOT_TOKEN),
    });
    const discordInvalidAccountId = await pairAccount(pipeline, db, {
      platformId: 'discord',
      remoteId: 'guild-channel-campaign-2',
      token: nonExpiringToken(DISCORD_BOT_TOKEN),
    });
    const twitchAccountId = await pairAccount(pipeline, db, {
      platformId: 'twitch',
      remoteId: 'broadcaster-campaign',
      token: farFutureToken(TWITCH_ACCESS, { refreshToken: TWITCH_REFRESH, scopes: ['channel:manage:broadcast'] }),
    });
    const blueskyAccountId = await pairAccount(pipeline, db, {
      platformId: 'bluesky',
      remoteId: 'did:plc:campaignaccount',
      token: {
        accessToken: BLUESKY_ACCESS,
        tokenType: 'Bearer',
        scopes: ['atproto'],
        obtainedAt: new Date('2026-07-04T00:00:00.000Z').toISOString(),
      },
    });

    const sourcePath = await makeFixtureImage(srcDir);
    const mediaSources: SourceMedia[] = [
      { mediaType: 'image', mimeType: 'image/jpeg', path: sourcePath, bytes: 250_000, width: 1600, height: 900 },
    ];

    const result = await campaigns.composeAndSubmit({
      description:
        'Our new indie game update just shipped with major performance improvements and a fresh questline for everyone to explore tonight.',
      // Deliberately includes a link + CTA + hashtags + mentions on every
      // target, INCLUDING Bluesky (t24: this combination used to be omitted
      // for Bluesky here as a workaround for a length bug where
      // BlueskyConnector.assembleText() re-adding payload.tags[]/mentions[]
      // could push the assembled post past the 300-grapheme limit even
      // though CampaignGenerator reported success; @social/ai now reserves
      // budget for that re-add and guarantees the assembled result always
      // passes validatePost, so the full combination is exercised here).
      link: 'https://example.com/indie-game-update',
      tags: ['indiegame', 'update'],
      mentions: ['alice'],
      cta: 'Play now',
      mediaSources,
      platforms: [
        { platformId: 'discord', accountId: discordAccountId, platformOptions: { channelId: '777' } },
        { platformId: 'twitch', accountId: twitchAccountId },
        { platformId: 'bluesky', accountId: blueskyAccountId },
        {
          // Deliberately invalid: an embed title far beyond Discord's 256-char limit.
          // validatePost MUST catch this and CampaignService MUST reject it, not enqueue it.
          platformId: 'discord',
          accountId: discordInvalidAccountId,
          platformOptions: { channelId: '888', embeds: [{ title: 'X'.repeat(400) }] },
        },
      ],
    });

    expect(result.results).toHaveLength(4);
    expect(result.mediaPlans).toHaveLength(1);

    // --- Renditions were actually produced from the one source image -------
    // (both Discord and Bluesky support media; the plan's needs cover both.)
    const plan = result.mediaPlans[0]!;
    expect(plan.needs.length).toBeGreaterThan(0);
    expect(plan.needs.some((n) => n.platforms.includes('discord'))).toBe(true);
    expect(plan.needs.some((n) => n.platforms.includes('bluesky'))).toBe(true);
    // Twitch has no media surface at all -> contributes no rendition needs.
    expect(plan.needs.every((n) => !n.platforms.includes('twitch'))).toBe(true);

    const byAccount = (accountId: string) => result.results.find((r) => r.accountId === accountId)!;

    // --- Valid variants across all three platforms, each within its limit --
    const discordResult = byAccount(discordAccountId);
    expect(discordResult.status).toBe('enqueued');
    expect(discordResult.validation?.ok).toBe(true);
    expect(discordResult.textLength).toBeLessThanOrEqual(2000); // Discord's characterLimit
    expect(discordResult.mediaAttached).toBeGreaterThan(0); // Discord supports media -> a rendition was attached
    expect(discordResult.jobId).toBeTruthy();
    expect(discordResult.postVariantId).toBeTruthy();

    const twitchResult = byAccount(twitchAccountId);
    expect(twitchResult.status).toBe('enqueued');
    expect(twitchResult.validation?.ok).toBe(true);
    expect(twitchResult.textLength).toBeLessThanOrEqual(140); // Twitch's title characterLimit
    expect(twitchResult.mediaAttached).toBe(0); // Twitch has no media surface

    const blueskyResult = byAccount(blueskyAccountId);
    expect(blueskyResult.status).toBe('enqueued');
    expect(blueskyResult.validation?.ok).toBe(true);
    expect(blueskyResult.textLength).toBeLessThanOrEqual(300); // Bluesky's grapheme characterLimit
    expect(blueskyResult.mediaAttached).toBeGreaterThan(0);

    // --- The deliberately invalid variant was REJECTED, never enqueued -----
    const invalidResult = byAccount(discordInvalidAccountId);
    expect(invalidResult.status).toBe('rejected');
    expect(invalidResult.validation?.ok).toBe(false);
    expect(invalidResult.validation?.errors.some((e) => e.code === 'embed_title_too_long')).toBe(true);
    expect(invalidResult.jobId).toBeUndefined();
    expect(invalidResult.postVariantId).toBeUndefined();

    // Confirm at the persistence layer too: exactly 3 jobs were enqueued (not 4).
    const enqueuedIds = [discordResult.jobId, twitchResult.jobId, blueskyResult.jobId].filter(Boolean) as string[];
    expect(enqueuedIds).toHaveLength(3);
    for (const jobId of enqueuedIds) {
      const job = await db.jobs.getById(jobId);
      expect(job?.status).toBe('pending');
    }
    expect(await db.jobs.listDeadLetters()).toHaveLength(0);

    // --- Run the worker: prove the m3 (queue/worker) + m4 (campaign) paths still connect ---
    const processed = await pipeline.worker.runOnce();
    expect(processed).toBe(3); // only the 3 valid, enqueued jobs -- the rejected one never became a job

    for (const jobId of enqueuedIds) {
      const job = await db.jobs.getById(jobId);
      expect(job?.status).toBe('succeeded');
    }
    const discordVariant = pipeline.variants.getById(discordResult.postVariantId!);
    expect(discordVariant?.status).toBe('published');
    const twitchVariant = pipeline.variants.getById(twitchResult.postVariantId!);
    expect(twitchVariant?.status).toBe('published');
    const blueskyVariant = pipeline.variants.getById(blueskyResult.postVariantId!);
    expect(blueskyVariant?.status).toBe('published');

    // --- No raw secrets leaked into any structured log line ----------------
    const logs = logger.lines.map((l) => JSON.stringify(l)).join('\n');
    expect(logs.includes(DISCORD_BOT_TOKEN)).toBe(false);
    expect(logs.includes(TWITCH_ACCESS)).toBe(false);
    expect(logs.includes(TWITCH_REFRESH)).toBe(false);
    expect(logs.includes(BLUESKY_ACCESS)).toBe(false);
  });

  it('reports a per-platform error (not a whole-batch failure) when a target platform has no registered connector', async () => {
    const discordAccountId = await pairAccount(pipeline, db, {
      platformId: 'discord',
      remoteId: 'guild-channel-campaign-3',
      token: nonExpiringToken(DISCORD_BOT_TOKEN),
    });

    const result = await campaigns.composeAndSubmit({
      description: 'A quick community update about tonight\'s schedule.',
      platforms: [
        { platformId: 'discord', accountId: discordAccountId, platformOptions: { channelId: '123' } },
        { platformId: 'not-a-real-platform', accountId: 'whatever' },
      ],
    });

    expect(result.results).toHaveLength(2);
    const goodResult = result.results.find((r) => r.platform === 'discord')!;
    expect(goodResult.status).toBe('enqueued');

    const badResult = result.results.find((r) => r.platform === 'not-a-real-platform')!;
    expect(badResult.status).toBe('error');
    expect(badResult.error).toBeTruthy();
  });
});

async function pairAccount(
  pipeline: Pipeline,
  db: Database,
  input: { platformId: string; remoteId: string; token: import('@social/core').TokenSet },
): Promise<string> {
  const capabilities = pipeline.connectors.resolve(input.platformId).capabilities;
  db.platforms.upsert({
    id: input.platformId,
    displayName: capabilities.displayName,
    apiBaseUrl: capabilities.apiBaseUrl,
    contractVersion: capabilities.contractVersion,
    capabilities,
  });
  const summary = await pipeline.accountManager.addAccount(
    { platformId: input.platformId, remoteId: input.remoteId, displayName: input.remoteId },
    input.token,
  );
  return summary.id;
}
