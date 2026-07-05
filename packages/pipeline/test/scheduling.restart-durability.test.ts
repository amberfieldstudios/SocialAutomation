/**
 * t30 restart-durability test.
 *
 * Before t30, a scheduled/recurring campaign's `ComposeAndSubmitInput` lived
 * ONLY in an in-process `Map` owned by the `Pipeline` instance that created
 * the schedule (`buildPipeline.scheduler`, see `pipeline.ts`'s
 * `campaignSpecCache`/former `campaignRegistry`). If the process restarted —
 * or, in a multi-process deployment, a different process ran the materializer
 * sweep — that Map was empty and the due occurrence could never compose.
 *
 * This test proves the fix: the compose spec is persisted to the real
 * `scheduled_campaigns` table (migration 0006), and a SECOND, entirely fresh
 * `buildPipeline()` instance against the SAME underlying `Database` (no
 * shared in-process state — a brand-new `campaignSpecCache` Map) can still
 * materialize the due occurrence correctly: generate, validate, and enqueue a
 * real publish job.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Database } from '@social/db';
import { MockProvider } from '@social/ai';
import { buildPipeline, type Pipeline } from '../src/pipeline';
import { CapturingLogger, nonExpiringToken } from './support';

const DISCORD_BOT_TOKEN = 'super-secret-discord-bot-token-t30';

describe('t30: scheduled campaigns survive a process restart', () => {
  let logger: CapturingLogger;
  let db: Database;

  beforeEach(() => {
    logger = new CapturingLogger();
    db = Database.sqlite({ filename: ':memory:' }, { logger });
    db.migrate();
  });

  afterEach(() => {
    db.close();
  });

  async function buildPipelineInstance(now: () => Date): Promise<Pipeline> {
    const pipeline = await buildPipeline({ db, logger, now, contentProvider: new MockProvider() });
    await pipeline.loadPlugins();
    return pipeline;
  }

  it('a fresh Pipeline instance (empty in-process cache) still composes + enqueues a due occurrence created by an earlier instance', async () => {
    // --- "Process 1": creates the account + the scheduled campaign. --------
    const process1 = await buildPipelineInstance(() => new Date('2026-07-04T08:00:00.000Z'));

    const capabilities = process1.connectors.resolve('discord').capabilities;
    db.platforms.upsert({
      id: 'discord',
      displayName: capabilities.displayName,
      apiBaseUrl: capabilities.apiBaseUrl,
      contractVersion: capabilities.contractVersion,
      capabilities,
    });
    const account = await process1.accountManager.addAccount(
      { platformId: 'discord', remoteId: 'guild-channel-t30', displayName: 'guild-channel-t30' },
      nonExpiringToken(DISCORD_BOT_TOKEN),
    );

    const schedule = process1.scheduler.scheduleCampaign({
      mode: 'once',
      description: 'Restart-durability check: this campaign must survive a process restart.',
      link: 'https://example.com/t30',
      campaignId: 'restart-durability-t30',
      localDateTime: '2026-07-04T09:00:00',
      timezone: 'UTC',
      platforms: [{ platformId: 'discord', accountId: account.id, platformOptions: { channelId: '999' } }],
    });
    expect(schedule.mode).toBe('scheduled');
    expect(schedule.nextRunAt).toBe('2026-07-04T09:00:00.000Z');

    // The compose spec is durably persisted -- not just held in process1's Map.
    const persisted = db.scheduledCampaigns.getByScheduleId(schedule.id);
    expect(persisted).toBeDefined();
    expect(persisted?.composeSpec).toMatchObject({
      description: 'Restart-durability check: this campaign must survive a process restart.',
      campaignId: 'restart-durability-t30',
    });
    // The spec references the account by id only -- never a token/secret.
    const specJson = JSON.stringify(persisted?.composeSpec);
    expect(specJson).not.toContain(DISCORD_BOT_TOKEN);
    expect(specJson).not.toMatch(/token|secret|ciphertext/i);

    // Nothing has materialized yet -- no publish jobs exist.
    expect((await db.jobs.listAll()).filter((j) => j.operation === 'publish')).toHaveLength(0);

    // --- Simulated crash/restart: process1 is discarded (never swept). -----
    // A brand-new Pipeline instance, with its own empty `campaignSpecCache`
    // Map, is built against the SAME `db` (the durable state a real restart
    // would keep) — nothing from process1's in-memory state is reused.
    const process2 = await buildPipelineInstance(() => new Date('2026-07-04T09:00:00.000Z'));

    const dueAt = new Date('2026-07-04T09:00:00.000Z');
    const outcomes = await process2.scheduler.materializer.materializeDue(dueAt);

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.outcome).toBe('submitted');
    expect(outcomes[0]?.scheduleId).toBe(schedule.id);

    // The occurrence composed + enqueued a real publish job through process2,
    // which never had process1's spec in memory -- it was loaded from the
    // `scheduled_campaigns` table on demand.
    const publishJobs = (await db.jobs.listAll()).filter((j) => j.operation === 'publish');
    expect(publishJobs).toHaveLength(1);
    expect(publishJobs[0]?.idempotencyKey.endsWith(':2026-07-04T09:00:00.000Z')).toBe(true);

    const postVariants = db.raw().all<{ id: string; platform_id: string; account_id: string }>(
      'SELECT id, platform_id, account_id FROM post_variants',
    );
    expect(postVariants).toHaveLength(1);
    expect(postVariants[0]?.platform_id).toBe('discord');
    expect(postVariants[0]?.account_id).toBe(account.id);

    // The schedule is now completed (one-shot) -- re-sweeping finds nothing due.
    const resweep = await process2.scheduler.materializer.materializeDue(dueAt);
    expect(resweep).toHaveLength(0);
    expect((await db.jobs.listAll()).filter((j) => j.operation === 'publish')).toHaveLength(1);

    // No raw secret leaked into any structured log line across either instance.
    const logs = logger.lines.map((l) => JSON.stringify(l)).join('\n');
    expect(logs.includes(DISCORD_BOT_TOKEN)).toBe(false);
  });
});
