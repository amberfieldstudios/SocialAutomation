import { AuthError, TransientError } from '@social/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemoryJobStore } from '../src/memoryStore';
import { Worker } from '../src/worker';
import type { JobLifecycleEvent } from '../src/events';
import { testLogger } from './support';

const START = new Date('2026-01-01T00:00:00.000Z');
const BACKOFF = { baseMs: 1000, factor: 2, maxDelayMs: 60_000, maxAttempts: 3 };

describe('Worker retry / DLQ behavior', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('retries a job that fails transiently N times then succeeds, applying equal-jitter backoff', async () => {
    const store = new InMemoryJobStore({ logger: testLogger() });
    await store.enqueue({ postVariantId: 'pv1', payload: { ok: true } });

    let calls = 0;
    const handler = vi.fn(async () => {
      calls += 1;
      if (calls < 3) throw new TransientError(`transient failure #${calls}`);
      return { remoteId: 'remote-1', publishedAt: new Date().toISOString() };
    });

    const events: JobLifecycleEvent[] = [];
    const worker = new Worker({
      store,
      handler,
      logger: testLogger(),
      backoff: BACKOFF,
      random: () => 0, // deterministic: delay = half of the capped exponential
      onEvent: (e) => {
        events.push(e);
      },
    });

    // Attempt 1 fails. delay = half(1000*2^0)=500ms -> nextRunAt = START+500
    await worker.runOnce();
    let job = await store.findByIdempotencyKey('pv1:publish');
    expect(job?.status).toBe('pending');
    expect(job?.attempts).toBe(1);
    expect(job?.availableAt).toBe(new Date(START.getTime() + 500).toISOString());

    // Not due yet — no-op.
    expect(await worker.runOnce()).toBe(0);
    expect(handler).toHaveBeenCalledTimes(1);

    // Advance to the retry time. Attempt 2 fails. delay = half(1000*2^1)=1000ms.
    vi.setSystemTime(new Date(START.getTime() + 500));
    await worker.runOnce();
    job = await store.findByIdempotencyKey('pv1:publish');
    expect(job?.attempts).toBe(2);
    expect(job?.availableAt).toBe(new Date(START.getTime() + 500 + 1000).toISOString());

    // Advance to the second retry time. Attempt 3 succeeds.
    vi.setSystemTime(new Date(START.getTime() + 500 + 1000));
    await worker.runOnce();
    job = await store.findByIdempotencyKey('pv1:publish');
    expect(job?.status).toBe('succeeded');
    expect(job?.attempts).toBe(3);
    expect(handler).toHaveBeenCalledTimes(3);

    const types = events.map((e) => e.type);
    expect(types).toEqual(['job.retry_scheduled', 'job.retry_scheduled', 'job.published']);
    expect(await store.listDeadLetters()).toHaveLength(0);
  });

  it('dead-letters a job once retries are exhausted, having applied backoff on each attempt', async () => {
    const store = new InMemoryJobStore({ logger: testLogger() });
    await store.enqueue({ postVariantId: 'pv2', payload: {}, maxAttempts: 3 });

    const handler = vi.fn(async () => {
      throw new TransientError('platform is down');
    });

    const events: JobLifecycleEvent[] = [];
    const worker = new Worker({
      store,
      handler,
      logger: testLogger(),
      backoff: BACKOFF,
      random: () => 0,
      onEvent: (e) => events.push(e),
    });

    await worker.runOnce(); // attempt 1/3 fails -> retry scheduled, nextRunAt = +500ms
    vi.setSystemTime(new Date(START.getTime() + 500));
    await worker.runOnce(); // attempt 2/3 fails -> retry scheduled, nextRunAt = +500+1000ms
    vi.setSystemTime(new Date(START.getTime() + 500 + 1000));
    await worker.runOnce(); // attempt 3/3 fails -> exhausted -> dead-lettered

    const job = await store.findByIdempotencyKey('pv2:publish');
    expect(job?.status).toBe('dead');
    expect(job?.attempts).toBe(3);
    expect(handler).toHaveBeenCalledTimes(3);

    const deadLetters = await store.listDeadLetters();
    expect(deadLetters).toHaveLength(1);
    expect(deadLetters[0]?.attempts).toBe(3);
    expect(deadLetters[0]?.errorMessage).toBe('platform is down');

    const types = events.map((e) => e.type);
    expect(types).toEqual(['job.retry_scheduled', 'job.retry_scheduled', 'job.dead_lettered']);
    const last = events[events.length - 1];
    expect(last?.type === 'job.dead_lettered' && last.reason).toBe('exhausted_retries');
  });

  it('sends a non-retryable error straight to the DLQ without any retry', async () => {
    const store = new InMemoryJobStore({ logger: testLogger() });
    await store.enqueue({ postVariantId: 'pv3', payload: {} });

    const handler = vi.fn(async () => {
      throw new AuthError('invalid credentials'); // retryable: false
    });

    const events: JobLifecycleEvent[] = [];
    const worker = new Worker({
      store,
      handler,
      logger: testLogger(),
      backoff: BACKOFF,
      onEvent: (e) => events.push(e),
    });

    await worker.runOnce();

    const job = await store.findByIdempotencyKey('pv3:publish');
    expect(job?.status).toBe('dead');
    expect(job?.attempts).toBe(1);
    expect(handler).toHaveBeenCalledTimes(1);

    const deadLetters = await store.listDeadLetters();
    expect(deadLetters).toHaveLength(1);
    expect(deadLetters[0]?.errorMessage).toBe('invalid credentials');

    expect(events).toHaveLength(1);
    const only = events[0];
    expect(only?.type === 'job.dead_lettered' && only.reason).toBe('non_retryable');
  });

  it('does not double-publish: a job already succeeded is never reclaimed', async () => {
    const store = new InMemoryJobStore({ logger: testLogger() });
    await store.enqueue({ postVariantId: 'pv4', payload: {} });
    const handler = vi.fn(async () => ({ remoteId: 'r1', publishedAt: new Date().toISOString() }));
    const worker = new Worker({ store, handler, logger: testLogger(), backoff: BACKOFF });

    await worker.runOnce();
    expect(await worker.runOnce()).toBe(0); // nothing left to claim
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
