import { describe, expect, it } from 'vitest';
import { InMemoryJobStore } from '../src/memoryStore';
import { deriveIdempotencyKey } from '../src/idempotency';
import { testLogger } from './support';

describe('idempotency', () => {
  it('derives a stable key from postVariantId + operation', () => {
    expect(deriveIdempotencyKey({ postVariantId: 'pv1', operation: 'publish' })).toBe('pv1:publish');
    expect(deriveIdempotencyKey({ postVariantId: 'pv1', operation: 'edit' })).toBe('pv1:edit');
  });

  it('includes occurrenceKey for recurring occurrences', () => {
    expect(
      deriveIdempotencyKey({ postVariantId: 'pv1', operation: 'publish', occurrenceKey: '2026-07-05T09:00:00.000Z' }),
    ).toBe('pv1:publish:2026-07-05T09:00:00.000Z');
  });

  it('dedupes a second enqueue with the same derived key', async () => {
    const store = new InMemoryJobStore({ logger: testLogger() });
    const first = await store.enqueue({ postVariantId: 'pv1', payload: { n: 1 } });
    const second = await store.enqueue({ postVariantId: 'pv1', payload: { n: 2 } });

    expect(first.deduped).toBe(false);
    expect(second.deduped).toBe(true);
    expect(second.job.id).toBe(first.job.id);
    // The original payload wins; the second enqueue's payload is not applied.
    expect(second.job.payload).toEqual({ n: 1 });

    const all = await store.listAll();
    expect(all).toHaveLength(1);
  });

  it('dedupes against an explicit idempotencyKey regardless of payload', async () => {
    const store = new InMemoryJobStore({ logger: testLogger() });
    const first = await store.enqueue({ postVariantId: 'pv1', payload: {}, idempotencyKey: 'custom-key' });
    const second = await store.enqueue({ postVariantId: 'pv1', payload: {}, idempotencyKey: 'custom-key' });
    expect(second.deduped).toBe(true);
    expect(second.job.id).toBe(first.job.id);
  });

  it('does NOT dedupe distinct occurrences of a recurring campaign (distinct occurrenceKey)', async () => {
    const store = new InMemoryJobStore({ logger: testLogger() });
    const occ1 = deriveIdempotencyKey({ postVariantId: 'pv1', operation: 'publish', occurrenceKey: 't1' });
    const occ2 = deriveIdempotencyKey({ postVariantId: 'pv1', operation: 'publish', occurrenceKey: 't2' });
    const a = await store.enqueue({ postVariantId: 'pv1', payload: {}, idempotencyKey: occ1 });
    const b = await store.enqueue({ postVariantId: 'pv1', payload: {}, idempotencyKey: occ2 });
    expect(a.deduped).toBe(false);
    expect(b.deduped).toBe(false);
    expect(a.job.id).not.toBe(b.job.id);

    const all = await store.listAll();
    expect(all).toHaveLength(2);
  });
});
