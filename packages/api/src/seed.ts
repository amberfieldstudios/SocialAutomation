/**
 * Dev seed script: `pnpm --filter @social/api run seed`.
 *
 * Populates a SQLite dev DB (default `./dev.sqlite`, override with
 * `SOCIAL_DB_FILE`) with:
 *   - sample accounts across the three loaded connector plugins (discord,
 *     twitch, bluesky) — added via the REAL `AccountManager.addAccount`, no
 *     tokens (this dashboard has no real OAuth credentials to pair with);
 *   - two campaigns actually run through the REAL pipeline
 *     (`CampaignGenerator` + `MockProvider` — deliberately hardcoded here
 *     regardless of `AI_PROVIDER`, so seeding demo data never spends real
 *     AI tokens -> `connector.validatePost` ->
 *     `PublishService.submitPost` -> `JobStore.enqueue`), then one real
 *     `Worker.runOnce()` sweep. Since there are no real platform credentials,
 *     the worker's `connector.publish()` calls genuinely fail (network/auth
 *     errors against the live Discord/Twitch/Bluesky APIs) — with
 *     `maxAttempts: 1` those jobs land straight in the dead-letter queue, an
 *     honest demonstration of the retry/DLQ path, not a simulated one;
 *   - a handful of SYNTHETIC "already published" post_variants + matching
 *     analytics_snapshots, inserted directly via `PostVariantsRepo` /
 *     `db.analyticsSnapshots`, so the History and Analytics views have
 *     something to render. These are clearly synthetic (no real platform
 *     ever produced these remote ids/metrics) since fetching real analytics
 *     requires a real published post, which requires real credentials this
 *     project does not have.
 */

import { randomUUID } from 'node:crypto';
import { CampaignGenerator, MockProvider } from '@social/ai';
import { createAppContext } from './context';

const PLATFORMS = ['discord', 'twitch', 'bluesky'] as const;

async function main(): Promise<void> {
  const dbFile = process.env.SOCIAL_DB_FILE ?? './dev.sqlite';
  const ctx = await createAppContext({ dbFile });
  const { pipeline, db, logger } = ctx;

  logger.info('seed.start', { dbFile });

  // --- Accounts -----------------------------------------------------------
  const seededAccounts: Record<string, string[]> = {};
  const sampleProfiles: Record<(typeof PLATFORMS)[number], { remoteId: string; handle: string; displayName: string; avatarUrl: string }[]> = {
    discord: [
      { remoteId: 'discord-guild-1', handle: 'launch-hq', displayName: 'Launch HQ', avatarUrl: 'https://picsum.photos/seed/discord1/64' },
      { remoteId: 'discord-guild-2', handle: 'community-lounge', displayName: 'Community Lounge', avatarUrl: 'https://picsum.photos/seed/discord2/64' },
    ],
    twitch: [
      { remoteId: 'twitch-channel-1', handle: 'streamgo_official', displayName: 'StreamGo Official', avatarUrl: 'https://picsum.photos/seed/twitch1/64' },
    ],
    bluesky: [
      { remoteId: 'bluesky-did-1', handle: 'launchhq.bsky.social', displayName: 'Launch HQ', avatarUrl: 'https://picsum.photos/seed/bsky1/64' },
      { remoteId: 'bluesky-did-2', handle: 'devrel.bsky.social', displayName: 'DevRel', avatarUrl: 'https://picsum.photos/seed/bsky2/64' },
    ],
  };

  for (const platformId of PLATFORMS) {
    seededAccounts[platformId] = [];
    for (const profile of sampleProfiles[platformId]) {
      const account = await pipeline.accountManager.addAccount({
        platformId,
        remoteId: profile.remoteId,
        handle: profile.handle,
        displayName: profile.displayName,
        avatarUrl: profile.avatarUrl,
        profileUrl: `https://example.com/${platformId}/${profile.handle}`,
      });
      seededAccounts[platformId]!.push(account.id);
    }
  }
  logger.info('seed.accounts_done', { counts: Object.fromEntries(PLATFORMS.map((p) => [p, seededAccounts[p]!.length])) });

  // One account marked disconnected, to exercise the reconnect flow in the UI.
  const disconnectTarget = seededAccounts.twitch![0];
  if (disconnectTarget) {
    await pipeline.accountManager.setStatus(disconnectTarget, 'disconnected');
  }

  // --- Real campaign submissions (generate -> validate -> enqueue -> worker) --
  const provider = new MockProvider();
  const generator = new CampaignGenerator(provider, logger);

  const campaignBriefs = [
    {
      campaignId: 'summer-launch',
      description: 'We just shipped multi-platform scheduling for SocialAutomation — plan once, publish everywhere.',
      cta: 'Try it today',
      tags: ['launch', 'automation'],
    },
    {
      campaignId: 'product-update',
      description: 'New this week: campaign analytics rollups across every connected platform, in one dashboard.',
      cta: 'See the dashboard',
      tags: ['analytics', 'update'],
    },
  ];

  for (const brief of campaignBriefs) {
    for (const platformId of PLATFORMS) {
      const accountId = seededAccounts[platformId]?.[0];
      if (!accountId || accountId === disconnectTarget) continue;
      try {
        const connector = pipeline.connectors.resolve(platformId);
        const generated = await generator.generateVariant(
          { description: brief.description, cta: brief.cta, tags: brief.tags, campaign: brief.campaignId },
          { platform: platformId, accountId, capabilities: connector.capabilities },
        );
        const validation = await connector.validatePost(generated.payload);
        if (!validation.ok) {
          logger.warn('seed.campaign_variant_rejected', { platformId, campaignId: brief.campaignId, errors: validation.errors });
          continue;
        }
        await pipeline.publishService.submitPost({
          platform: platformId,
          accountId,
          payload: generated.payload,
          campaignId: brief.campaignId,
          maxAttempts: 1, // no real credentials exist -> fail fast into the DLQ instead of a long real-time backoff wait
        });
      } catch (err) {
        logger.warn('seed.campaign_submit_failed', { platformId, campaignId: brief.campaignId, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  // Real worker sweep: attempts to actually publish. With no platform
  // credentials configured this will genuinely fail against the live APIs —
  // exactly what dead-letters real jobs for the Queue view to display.
  const processed = await pipeline.worker.runOnce();
  logger.info('seed.worker_run_once', { processed });

  // --- Synthetic "already published" history + analytics ------------------
  // Real publishing requires real OAuth credentials this project doesn't have
  // (see docs/ARCHITECTURE.md non-negotiables). To give the History/Analytics
  // views something realistic to render, seed a few variants directly as
  // already-published, with synthetic analytics snapshots.
  const now = new Date();
  for (const [i, brief] of campaignBriefs.entries()) {
    for (const platformId of PLATFORMS) {
      const accountId = seededAccounts[platformId]?.[i % (seededAccounts[platformId]?.length ?? 1)];
      if (!accountId) continue;
      const { id: variantId } = pipeline.variants.createVariant({
        accountId,
        platformId,
        payload: { platform: platformId, accountId, text: `${brief.description} #${brief.tags[0]}` },
        campaignId: brief.campaignId,
        brief: brief.description,
      });
      const remoteId = `seed-${platformId}-${randomUUID().slice(0, 8)}`;
      pipeline.variants.markPublished(variantId, {
        remoteId,
        remoteUrl: `https://example.com/${platformId}/posts/${remoteId}`,
        publishedAt: now.toISOString(),
      });
      const base = 50 + Math.floor(Math.random() * 500);
      await db.analyticsSnapshots.insert({
        postVariantId: variantId,
        accountId,
        remoteId,
        collectedAt: now.toISOString(),
        metrics: {
          views: base * 4,
          likes: base,
          comments: Math.floor(base * 0.1),
          shares: Math.floor(base * 0.05),
          clicks: Math.floor(base * 0.2),
        },
      });
    }
  }

  logger.info('seed.done', { dbFile });
  ctx.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
