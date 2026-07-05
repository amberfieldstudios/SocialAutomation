/**
 * Failure paths through the real Discord connector + the real `@social/queue`
 * `Worker`/backoff/DLQ machinery + `@social/db`-persisted job state:
 *
 *   1. A transient publish error (Discord 429 -> `RateLimitError`, retryable)
 *      is retried and the job eventually succeeds once the platform recovers.
 *   2. A permanent publish error (Discord 401 -> `TokenRevokedError`, NOT
 *      retryable) skips retries entirely and lands straight in the DLQ with
 *      full error context.
 *
 * No real sleeping: the worker's `now` is an injectable clock we advance
 * manually past each computed `availableAt` between polls, so backoff delays
 * are exercised for real (via `@social/queue`'s own retry math) without the
 * test taking any wall-clock time.
 */

import { MockAgent, setGlobalDispatcher } from 'undici';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { PostPayload } from '@social/core';
import { Database } from '@social/db';
import { buildPipeline } from '../src/index';
import { CapturingLogger } from './support';

// buildPipeline comes straight from the package's public surface (not the
// shared test harness) because this test drives its own clock-controlled
// Worker (via buildPipeline's `now`/`worker.random` options) instead of the
// harness's default one.

const BOT_TOKEN = 'super-secret-discord-bot-token-for-retry-test';

let mockAgent: MockAgent;
let clock: Date;

beforeEach(() => {
  mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
  clock = new Date('2026-07-04T12:00:00.000Z');
});

afterEach(async () => {
  await mockAgent.close();
});

function advanceClockPast(iso: string): void {
  const target = new Date(iso).getTime();
  if (target > clock.getTime()) clock = new Date(target + 1);
}

describe('publish job retry + dead-letter (discord, real backoff math, real persistence)', () => {
  it('retries a transient (429) error and eventually succeeds', async () => {
    const logger = new CapturingLogger();
    const db = Database.sqlite({ filename: ':memory:' }, { logger });
    db.migrate();

    const pipeline = await buildPipeline({ db, logger, now: () => clock, worker: { backoff: { baseMs: 1000, factor: 2, maxDelayMs: 60_000, maxAttempts: 5 }, random: () => 0 } });
    await pipeline.loadPlugins();

    const capabilities = pipeline.connectors.resolve('discord').capabilities;
    db.platforms.upsert({ id: 'discord', displayName: capabilities.displayName, apiBaseUrl: capabilities.apiBaseUrl, contractVersion: capabilities.contractVersion, capabilities });
    const account = await pipeline.accountManager.addAccount(
      { platformId: 'discord', remoteId: 'retry-channel', displayName: 'retry-channel' },
      nonExpiringToken(BOT_TOKEN),
    );

    const pool = mockAgent.get('https://discord.com');
    // 1st attempt: rate limited (retryable).
    pool
      .intercept({ path: '/api/v10/channels/555/messages', method: 'POST' })
      .reply(429, JSON.stringify({ retry_after: 1.5 }), { headers: { 'content-type': 'application/json' } });
    // 2nd attempt: succeeds.
    pool
      .intercept({ path: '/api/v10/channels/555/messages', method: 'POST' })
      .reply(200, JSON.stringify({ id: 'msg-retry-1', channel_id: '555', timestamp: '2026-07-04T12:00:05.000Z' }));

    const payload: PostPayload = { platform: 'discord', accountId: account.id, text: 'retry me', platformOptions: { channelId: '555' } };
    const submission = await pipeline.publishService.submitPost({ platform: 'discord', accountId: account.id, payload });

    // Attempt 1: fails with RateLimitError -> retryable, not exhausted -> markFailedForRetry.
    let processed = await pipeline.worker.runOnce();
    expect(processed).toBe(1);

    let job = await db.jobs.getById(submission.jobId);
    expect(job?.status).toBe('pending'); // scheduled for retry, not dead
    expect(job?.attempts).toBe(1);
    expect(job?.lastErrorCode).toBe('rate_limited');
    expect(job?.availableAt).toBeTruthy();

    // Not due yet: a poll before the backoff window elapses claims nothing.
    processed = await pipeline.worker.runOnce();
    expect(processed).toBe(0);

    // Advance the clock past availableAt (no real sleep) and retry.
    advanceClockPast(job!.availableAt);
    processed = await pipeline.worker.runOnce();
    expect(processed).toBe(1);

    job = await db.jobs.getById(submission.jobId);
    expect(job?.status).toBe('succeeded');
    // Contract v1.1: remoteId is now a bare message id (channel lives in PublishResult.target).
    expect((job?.result as { remoteId?: string })?.remoteId).toBe('msg-retry-1');
    expect(job?.attempts).toBe(2);

    const variant = pipeline.variants.getById(submission.postVariantId);
    expect(variant?.status).toBe('published');

    expect(await db.jobs.listDeadLetters()).toHaveLength(0);
    expect(JSON.stringify(logger.lines).includes(BOT_TOKEN)).toBe(false);
  });

  it('sends a non-retryable (401 revoked) error straight to the dead-letter queue with full error context', async () => {
    const logger = new CapturingLogger();
    const db = Database.sqlite({ filename: ':memory:' }, { logger });
    db.migrate();

    const pipeline = await buildPipeline({ db, logger, now: () => clock });
    await pipeline.loadPlugins();

    const capabilities = pipeline.connectors.resolve('discord').capabilities;
    db.platforms.upsert({ id: 'discord', displayName: capabilities.displayName, apiBaseUrl: capabilities.apiBaseUrl, contractVersion: capabilities.contractVersion, capabilities });
    const account = await pipeline.accountManager.addAccount(
      { platformId: 'discord', remoteId: 'dead-channel', displayName: 'dead-channel' },
      nonExpiringToken(BOT_TOKEN),
    );

    mockAgent
      .get('https://discord.com')
      .intercept({ path: '/api/v10/channels/999/messages', method: 'POST' })
      .reply(401, JSON.stringify({ message: 'Unauthorized' }), { headers: { 'content-type': 'application/json' } });

    const payload: PostPayload = { platform: 'discord', accountId: account.id, text: 'this will be revoked', platformOptions: { channelId: '999' } };
    const submission = await pipeline.publishService.submitPost({ platform: 'discord', accountId: account.id, payload });

    const processed = await pipeline.worker.runOnce();
    expect(processed).toBe(1);

    const job = await db.jobs.getById(submission.jobId);
    expect(job?.status).toBe('dead');
    expect(job?.attempts).toBe(1); // non-retryable -> dead-lettered on the first attempt, no retries burned
    expect(job?.lastErrorCode).toBe('token_revoked');

    const deadLetters = await db.jobs.listDeadLetters();
    expect(deadLetters).toHaveLength(1);
    expect(deadLetters[0]?.publishJobId).toBe(submission.jobId);
    expect(deadLetters[0]?.errorCode).toBe('token_revoked');
    expect(deadLetters[0]?.errorMessage).toBeTruthy();
    expect(deadLetters[0]?.payloadSnapshot).toBeTruthy(); // full error context for later replay

    const variant = pipeline.variants.getById(submission.postVariantId);
    expect(variant?.status).toBe('failed');

    expect(JSON.stringify(logger.lines).includes(BOT_TOKEN)).toBe(false);
  });
});

function nonExpiringToken(accessToken: string) {
  return { accessToken, tokenType: 'bot' as const, scopes: [] as string[], obtainedAt: new Date('2026-07-04T00:00:00.000Z').toISOString() };
}
