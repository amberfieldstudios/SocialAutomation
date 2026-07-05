import { describe, expect, it, vi } from 'vitest';
import { WebhookNotifier, signWebhookPayload, verifyWebhookSignature } from '../src/webhook';
import type { JobLifecycleEvent } from '../src/events';
import type { PublishJobRecord } from '../src/types';
import { testLogger } from './support';

function makeJob(overrides: Partial<PublishJobRecord> = {}): PublishJobRecord {
  return {
    id: 'job_1',
    postVariantId: 'pv1',
    scheduleId: null,
    operation: 'publish',
    status: 'succeeded',
    idempotencyKey: 'pv1:publish',
    attempts: 1,
    maxAttempts: 5,
    availableAt: '2026-01-01T00:00:00.000Z',
    claimedAt: null,
    claimedBy: null,
    lastError: null,
    lastErrorCode: null,
    result: undefined,
    payload: {},
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function publishedEvent(job: PublishJobRecord): JobLifecycleEvent {
  return { type: 'job.published', at: '2026-01-01T00:00:01.000Z', job, result: { remoteId: 'r1' } };
}

describe('signWebhookPayload / verifyWebhookSignature', () => {
  it('produces a verifiable sha256= HMAC signature', () => {
    const body = JSON.stringify({ hello: 'world' });
    const sig = signWebhookPayload(body, 'top-secret');
    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(verifyWebhookSignature(body, 'top-secret', sig)).toBe(true);
  });

  it('rejects a signature computed with the wrong secret or over tampered body', () => {
    const body = JSON.stringify({ hello: 'world' });
    const sig = signWebhookPayload(body, 'top-secret');
    expect(verifyWebhookSignature(body, 'wrong-secret', sig)).toBe(false);
    expect(verifyWebhookSignature(JSON.stringify({ hello: 'tampered' }), 'top-secret', sig)).toBe(false);
  });
});

describe('WebhookNotifier', () => {
  it('signs delivery with the per-subscription secret via X-Signature and never logs the secret', async () => {
    const logLines: string[] = [];
    const logger = testLogger();
    const spyLogger = {
      ...logger,
      info: (msg: string, fields?: Record<string, unknown>) => {
        logLines.push(JSON.stringify({ msg, fields }));
      },
      child: () => spyLogger,
    };

    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    const notifier = new WebhookNotifier({ logger: spyLogger as unknown as ReturnType<typeof testLogger>, fetchImpl });
    const sub = notifier.subscribe({ url: 'https://example.com/hook', secret: 'shh-secret' });

    const job = makeJob();
    const event = publishedEvent(job);
    await notifier.handle(event);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [, init] = fetchImpl.mock.calls[0]!;
    const headers = init!.headers as Record<string, string>;
    const body = init!.body as string;
    expect(headers['X-Signature']).toBe(signWebhookPayload(body, 'shh-secret'));
    expect(verifyWebhookSignature(body, 'shh-secret', headers['X-Signature'])).toBe(true);

    // The secret must never appear in any log line.
    const allLogText = logLines.join('\n');
    expect(allLogText).not.toContain('shh-secret');

    expect(notifier.list()).toEqual([
      { id: sub.id, url: sub.url, eventTypes: sub.eventTypes, createdAt: sub.createdAt },
    ]);
    // list() must never leak the secret field.
    expect(JSON.stringify(notifier.list())).not.toContain('shh-secret');
  });

  it('delivers unsigned when subscribed via legacy urls (no secret)', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    const notifier = new WebhookNotifier({ logger: testLogger(), fetchImpl, urls: ['https://example.com/legacy'] });

    await notifier.handle(publishedEvent(makeJob()));

    const [, init] = fetchImpl.mock.calls[0]!;
    const headers = init!.headers as Record<string, string>;
    expect(headers['X-Signature']).toBeUndefined();
  });

  it('retries delivery with exponential backoff and gives up without throwing or affecting job state', async () => {
    let attempts = 0;
    const fetchImpl = vi.fn(async () => {
      attempts += 1;
      return new Response(null, { status: 500 });
    });

    const scheduledDelays: number[] = [];
    const notifier = new WebhookNotifier({
      logger: testLogger(),
      fetchImpl,
      backoff: { baseMs: 100, factor: 2, maxDelayMs: 10_000, maxAttempts: 3 },
      random: () => 0,
      // Run "retries" synchronously/immediately so the test doesn't need real timers.
      scheduleRetry: (fn, delayMs) => {
        scheduledDelays.push(delayMs);
        fn();
      },
    });
    notifier.subscribe({ url: 'https://example.com/flaky', secret: 's' });

    await expect(notifier.handle(publishedEvent(makeJob()))).resolves.toBeUndefined();

    expect(attempts).toBe(3); // maxAttempts from backoff config
    expect(scheduledDelays).toEqual([50, 100]); // half of 100*2^0 and 100*2^1 with random()=0
  });

  it('unsubscribe stops future deliveries to that destination', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    const notifier = new WebhookNotifier({ logger: testLogger(), fetchImpl });
    const sub = notifier.subscribe({ url: 'https://example.com/hook', secret: 's' });

    expect(notifier.unsubscribe(sub.id)).toBe(true);
    await notifier.handle(publishedEvent(makeJob()));
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(notifier.list()).toHaveLength(0);
  });

  it('filters delivery by eventTypes per-subscription', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    const notifier = new WebhookNotifier({ logger: testLogger(), fetchImpl });
    notifier.subscribe({ url: 'https://example.com/published-only', secret: 's', eventTypes: ['job.published'] });

    const deadLetterEvent: JobLifecycleEvent = {
      type: 'job.dead_lettered',
      at: '2026-01-01T00:00:01.000Z',
      job: makeJob({ status: 'dead' }),
      error: { message: 'boom' },
      reason: 'non_retryable',
      deadLetter: {
        id: 'dlq_1',
        publishJobId: 'job_1',
        postVariantId: 'pv1',
        operation: 'publish',
        attempts: 1,
        errorCode: undefined,
        errorMessage: 'boom',
        payloadSnapshot: {},
        failedAt: '2026-01-01T00:00:01.000Z',
        resolved: false,
        resolvedAt: null,
        createdAt: '2026-01-01T00:00:01.000Z',
      },
    };

    await notifier.handle(deadLetterEvent);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
