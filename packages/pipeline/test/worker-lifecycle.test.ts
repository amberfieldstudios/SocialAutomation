/**
 * Regression test for QA finding F1 (t9) / t13: the pipeline's queue `Worker`
 * must actually drain jobs when driven the way the running server drives it
 * (`worker.start()` continuous polling + `worker.stop()` on shutdown), not
 * just via the manual `runOnce()` sweep `seed.ts`/other tests use.
 *
 * Before t13, `packages/api/src/prod.ts` and `dev.ts` never called
 * `pipeline.worker.start()` at all — a submitted campaign would enqueue a job
 * that sat `pending` forever because nothing ever claimed it. This test
 * exercises the exact same `Worker` API surface the entrypoints now use
 * (`start()` then `stop()`, with real timers — no `runOnce()` call in this
 * test) and asserts the job LEAVES `pending`.
 *
 * It also guards the `Worker.stop()` hang bug found while implementing t13:
 * calling `stop()` while the poller is between polls (awaiting its
 * inter-poll sleep) must resolve promptly, not hang forever — verified here
 * simply by the test completing within its normal timeout instead of the
 * default 5s vitest timeout being hit.
 */

import { Agent, MockAgent, setGlobalDispatcher } from 'undici';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { PostPayload } from '@social/core';
import { buildHarness, nonExpiringToken, type TestHarness } from './support';

const BOT_TOKEN = 'super-secret-discord-bot-token-lifecycle';

let mockAgent: MockAgent | undefined;

beforeEach(() => {
  mockAgent = undefined;
});

afterEach(async () => {
  // Scoped per-test: close whichever MockAgent this test created, then
  // restore a normal (non-destroyed) global dispatcher so a later test in
  // this file that does NOT use undici mocking never trips
  // `ClientDestroyedError` against the previous test's closed mock client.
  if (mockAgent) await mockAgent.close();
  setGlobalDispatcher(new Agent());
});

async function waitUntil(predicate: () => Promise<boolean>, timeoutMs = 2000, intervalMs = 10): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) {
      throw new Error(`waitUntil: condition not met within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

describe('queue worker lifecycle (start/stop), as driven by the server entrypoints', () => {
  it('drains an enqueued publish job once worker.start() is called, and worker.stop() resolves promptly', async () => {
    mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    setGlobalDispatcher(mockAgent);

    // Fast poll so the test doesn't wait on the default 1000ms interval.
    const harness: TestHarness = await buildHarness(undefined, { pollIntervalMs: 15 });

    const accountId = await harness.pairAccount({
      platformId: 'discord',
      remoteId: 'guild-channel-lifecycle',
      token: nonExpiringToken(BOT_TOKEN),
    });

    mockAgent
      .get('https://discord.com')
      .intercept({ path: '/api/v10/channels/lifecycle/messages', method: 'POST' })
      .reply(200, JSON.stringify({ id: 'msg-lifecycle', channel_id: 'lifecycle', timestamp: '2026-07-04T12:00:00.000Z' }));

    const payload: PostPayload = {
      platform: 'discord',
      accountId,
      text: 'Draining via worker.start(), not runOnce()!',
      platformOptions: { channelId: 'lifecycle' },
    };

    const submission = await harness.pipeline.publishService.submitPost({ platform: 'discord', accountId, payload });
    expect(submission.validation.ok).toBe(true);

    // Sanity: the job is genuinely pending immediately after enqueue, before
    // any worker has touched it — this is the exact state QA's F1 found jobs
    // stuck in forever.
    const beforeStart = await harness.db.jobs.getById(submission.jobId);
    expect(beforeStart?.status).toBe('pending');

    // This is the entrypoint-lifecycle call (prod.ts/dev.ts now make this
    // call after the server starts listening) — deliberately NOT runOnce().
    harness.pipeline.worker.start();

    try {
      await waitUntil(async () => {
        const job = await harness.db.jobs.getById(submission.jobId);
        return job !== undefined && job.status !== 'pending';
      });
    } finally {
      // Entrypoint-lifecycle call on shutdown (prod.ts/dev.ts's SIGINT/SIGTERM
      // handlers). Must resolve promptly — this used to be able to hang
      // forever if stop() landed mid-sleep (fixed in packages/queue/src/worker.ts).
      await harness.pipeline.worker.stop();
    }

    const job = await harness.db.jobs.getById(submission.jobId);
    expect(job?.status).toBe('succeeded');
    expect(job?.status).not.toBe('pending');

    const variant = harness.pipeline.variants.getById(submission.postVariantId);
    expect(variant?.status).toBe('published');

    expect(harness.serializedLogs().includes(BOT_TOKEN)).toBe(false);
  });

  it('worker.stop() resolves promptly even when called while the poller is sleeping between polls', async () => {
    const harness: TestHarness = await buildHarness(undefined, { pollIntervalMs: 5000 });

    harness.pipeline.worker.start();
    // Give the first runOnce() (which fires immediately on start()) a moment
    // to complete so the loop is now in its inter-poll sleep — the case that
    // used to hang stop() forever since the sleep's setTimeout (5s here)
    // would never fire once cleared.
    await new Promise((resolve) => setTimeout(resolve, 20));

    const stopped = harness.pipeline.worker.stop();
    await expect(
      Promise.race([
        stopped.then(() => 'stopped' as const),
        new Promise((resolve) => setTimeout(resolve, 1000)).then(() => 'timed-out' as const),
      ]),
    ).resolves.toBe('stopped');
  });
});
