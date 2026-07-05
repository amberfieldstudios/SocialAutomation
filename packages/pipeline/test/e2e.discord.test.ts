/**
 * End-to-end publish through the real Discord connector (`plugins/discord`),
 * with all Discord HTTP mocked via undici's `MockAgent` (same technique
 * `plugins/discord/test/connector.test.ts` uses) — no real credentials, no
 * real network. Proves: submitPost -> validatePost -> post_variants row ->
 * enqueue -> Worker claims -> ConnectorResolver resolves the real
 * DiscordConnector -> connector.publish() called with the exact payload ->
 * PublishResult persisted on both the job row and the post_variant row.
 */

import { MockAgent, setGlobalDispatcher } from 'undici';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { PostPayload } from '@social/core';
import { buildHarness, nonExpiringToken, type TestHarness } from './support';

const BOT_TOKEN = 'super-secret-discord-bot-token';

let mockAgent: MockAgent;
let harness: TestHarness;

beforeEach(async () => {
  mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
  harness = await buildHarness();
});

afterEach(async () => {
  await mockAgent.close();
});

describe('discord end-to-end publish', () => {
  it('runs submitPost -> queue -> worker -> DiscordConnector.publish -> persisted PublishResult', async () => {
    const accountId = await harness.pairAccount({
      platformId: 'discord',
      remoteId: 'guild-channel-555',
      token: nonExpiringToken(BOT_TOKEN),
    });

    let capturedBody: unknown;
    mockAgent
      .get('https://discord.com')
      .intercept({ path: '/api/v10/channels/555/messages', method: 'POST' })
      .reply((opts) => {
        capturedBody = JSON.parse(String(opts.body));
        return { statusCode: 200, data: JSON.stringify({ id: 'msg-1', channel_id: '555', timestamp: '2026-07-04T12:00:00.000Z' }) };
      });

    const payload: PostPayload = {
      platform: 'discord',
      accountId,
      text: 'New stream is live!',
      platformOptions: { channelId: '555' },
    };

    const submission = await harness.pipeline.publishService.submitPost({ platform: 'discord', accountId, payload });
    expect(submission.validation.ok).toBe(true);

    const processed = await harness.pipeline.worker.runOnce();
    expect(processed).toBe(1);

    // Correct payload reached the connector -> Discord API.
    expect((capturedBody as Record<string, unknown>).content).toBe('New stream is live!');

    // PublishResult persisted on the job row.
    const job = await harness.db.jobs.getById(submission.jobId);
    expect(job?.status).toBe('succeeded');
    // Contract v1.1: remoteId is now a bare message id; the channel lives in
    // the typed PublishResult.target instead of a composite remoteId string.
    expect((job?.result as { remoteId?: string })?.remoteId).toBe('msg-1');
    expect((job?.result as { target?: { channelId?: string } })?.target).toEqual({
      channelId: '555',
      extra: { kind: 'channel' },
    });

    // Analytics-ready ids persisted on the post_variant row too.
    const variant = harness.pipeline.variants.getById(submission.postVariantId);
    expect(variant?.status).toBe('published');
    expect(variant?.remoteId).toBe('msg-1');

    // No dead letters, no raw token anywhere in any log line.
    expect(await harness.db.jobs.listDeadLetters()).toHaveLength(0);
    expect(harness.serializedLogs().includes(BOT_TOKEN)).toBe(false);
  });
});
