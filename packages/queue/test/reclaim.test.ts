import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { InMemoryJobStore } from '../src/memoryStore';
import { ReclaimSweeper } from '../src/reclaim';
import type { JobLifecycleEvent } from '../src/events';
import { testLogger } from './support';

const START = new Date('2026-01-01T00:00:00.000Z');
const LEASE_MS = 60_000; // 1 minute
const BACKOFF = { baseMs: 1000, factor: 2, maxDelayMs: 60_000, maxAttempts: 3 };

describe('ReclaimSweeper', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('re-queues a job stuck in running past the lease timeout, incrementing attempts', async () => {
    const store = new InMemoryJobStore({ logger: testLogger() });
    const { job } = await store.enqueue({ postVariantId: 'pv1', payload: {}, maxAttempts: 3 });
    await store.claimDueJobs(START, 10, 'worker-a');
    await store.markRunning(job.id);

    // Worker crashes here — job stays 'running' forever without a sweep.
    const events: JobLifecycleEvent[] = [];
    const sweeper = new ReclaimSweeper({
      store,
      logger: testLogger(),
      leaseMs: LEASE_MS,
      backoff: BACKOFF,
      random: () => 0,
      onEvent: (e) => events.push(e),
    });

    // Not stuck yet.
    vi.setSystemTime(new Date(START.getTime() + LEASE_MS - 1));
    expect(await sweeper.sweepOnce()).toBe(0);

    // Past the lease.
    vi.setSystemTime(new Date(START.getTime() + LEASE_MS + 1));
    expect(await sweeper.sweepOnce()).toBe(1);

    const reclaimed = await store.getById(job.id);
    expect(reclaimed?.status).toBe('pending');
    expect(reclaimed?.attempts).toBe(1);
    expect(reclaimed?.lastErrorCode).toBe('LEASE_EXPIRED');
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('job.retry_scheduled');

    // A second sweep immediately after shouldn't re-reclaim (job is pending now, not claimed/running).
    expect(await sweeper.sweepOnce()).toBe(0);
  });

  it('dead-letters a repeatedly-stuck job once max attempts is reached', async () => {
    const store = new InMemoryJobStore({ logger: testLogger() });
    const { job } = await store.enqueue({ postVariantId: 'pv2', payload: {}, maxAttempts: 2 });

    const events: JobLifecycleEvent[] = [];
    const sweeper = new ReclaimSweeper({
      store,
      logger: testLogger(),
      leaseMs: LEASE_MS,
      backoff: BACKOFF,
      random: () => 0,
      onEvent: (e) => events.push(e),
    });

    // Round 1: claim, go stuck, reclaim -> requeued (attempts 1/2).
    await store.claimDueJobs(START, 10, 'worker-a');
    await store.markRunning(job.id);
    vi.setSystemTime(new Date(START.getTime() + LEASE_MS + 1));
    await sweeper.sweepOnce();
    let current = await store.getById(job.id);
    expect(current?.status).toBe('pending');
    expect(current?.attempts).toBe(1);

    // Round 2: it gets claimed (once due again) and goes stuck again ->
    // attempts reaches maxAttempts -> DLQ.
    const availableAt2 = new Date(current!.availableAt);
    vi.setSystemTime(availableAt2);
    await store.claimDueJobs(availableAt2, 10, 'worker-b');
    await store.markRunning(job.id);
    vi.setSystemTime(new Date(availableAt2.getTime() + LEASE_MS + 1));
    await sweeper.sweepOnce();

    current = await store.getById(job.id);
    expect(current?.status).toBe('dead');
    expect(current?.attempts).toBe(2);

    const deadLetters = await store.listDeadLetters();
    expect(deadLetters).toHaveLength(1);
    expect(deadLetters[0]?.errorCode).toBe('LEASE_EXPIRED');

    expect(events.map((e) => e.type)).toEqual(['job.retry_scheduled', 'job.dead_lettered']);
  });

  it('is a no-op against a store that does not implement findStuckJobs', async () => {
    // Simulate an older/minimal JobStore lacking the optional method — proves
    // adding `findStuckJobs` to the interface didn't break existing stores.
    const inner = new InMemoryJobStore({ logger: testLogger() });
    const bareStore = {
      enqueue: inner.enqueue.bind(inner),
      getById: inner.getById.bind(inner),
      findByIdempotencyKey: inner.findByIdempotencyKey.bind(inner),
      claimDueJobs: inner.claimDueJobs.bind(inner),
      markRunning: inner.markRunning.bind(inner),
      markSucceeded: inner.markSucceeded.bind(inner),
      markFailedForRetry: inner.markFailedForRetry.bind(inner),
      markDead: inner.markDead.bind(inner),
      listDeadLetters: inner.listDeadLetters.bind(inner),
      listAll: inner.listAll.bind(inner),
      // findStuckJobs intentionally omitted.
    };

    const sweeper = new ReclaimSweeper({ store: bareStore, logger: testLogger(), leaseMs: LEASE_MS });
    expect(await sweeper.sweepOnce()).toBe(0);
  });
});
