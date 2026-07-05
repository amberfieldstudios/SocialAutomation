/**
 * In-memory `JobStore`. Sufficient for unit tests and for running the queue
 * standalone before `@social/db` grows a driver-backed repository. Field
 * shapes match the DB schema exactly (see `types.ts`) so swapping in a real
 * SQLite/Postgres-backed `JobStore` later is a drop-in replacement — nothing
 * above this abstraction (the `Worker`) needs to change.
 *
 * Concurrency note: Node is single-threaded per event-loop turn, and every
 * method here does its read-modify-write synchronously before the first
 * `await`, so `claimDueJobs` cannot double-claim a row even with multiple
 * concurrent callers in the same process.
 */

import type { StructuredLogger } from '@social/core';
import type {
  DeadLetterJobRecord,
  EnqueueJobInput,
  EnqueueResult,
  FailureInfo,
  JobStore,
  PublishJobRecord,
} from './types';
import { deriveIdempotencyKey } from './idempotency';

let idCounter = 0;
function generateId(prefix: string): string {
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${idCounter}`;
}

export interface InMemoryJobStoreOptions {
  defaultMaxAttempts?: number;
  logger?: StructuredLogger;
}

export class InMemoryJobStore implements JobStore {
  private readonly jobs = new Map<string, PublishJobRecord>();
  private readonly byIdempotencyKey = new Map<string, string>();
  private readonly deadLetters: DeadLetterJobRecord[] = [];
  private readonly defaultMaxAttempts: number;
  private readonly logger?: StructuredLogger;

  constructor(options: InMemoryJobStoreOptions = {}) {
    this.defaultMaxAttempts = options.defaultMaxAttempts ?? 5;
    this.logger = options.logger;
  }

  private log(message: string, fields: Record<string, unknown>): void {
    this.logger?.info(message, fields);
  }

  private touch(job: PublishJobRecord, now: Date): void {
    job.updatedAt = now.toISOString();
  }

  async enqueue(input: EnqueueJobInput): Promise<EnqueueResult> {
    const operation = input.operation ?? 'publish';
    const idempotencyKey = input.idempotencyKey ?? deriveIdempotencyKey({ postVariantId: input.postVariantId, operation });

    const existingId = this.byIdempotencyKey.get(idempotencyKey);
    if (existingId) {
      const existing = this.jobs.get(existingId);
      if (existing) {
        this.log('queue.enqueue.deduped', { jobId: existing.id, idempotencyKey });
        return { job: cloneJob(existing), deduped: true };
      }
    }

    const now = new Date();
    const job: PublishJobRecord = {
      id: generateId('job'),
      postVariantId: input.postVariantId,
      scheduleId: input.scheduleId ?? null,
      operation,
      status: 'pending',
      idempotencyKey,
      attempts: 0,
      maxAttempts: input.maxAttempts ?? this.defaultMaxAttempts,
      availableAt: (input.availableAt ?? now).toISOString(),
      claimedAt: null,
      claimedBy: null,
      lastError: null,
      lastErrorCode: null,
      result: undefined,
      payload: input.payload,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };

    this.jobs.set(job.id, job);
    this.byIdempotencyKey.set(idempotencyKey, job.id);
    this.log('queue.job.pending', { jobId: job.id, postVariantId: job.postVariantId, idempotencyKey });
    return { job: cloneJob(job), deduped: false };
  }

  async getById(id: string): Promise<PublishJobRecord | undefined> {
    const job = this.jobs.get(id);
    return job ? cloneJob(job) : undefined;
  }

  async findByIdempotencyKey(key: string): Promise<PublishJobRecord | undefined> {
    const id = this.byIdempotencyKey.get(key);
    if (!id) return undefined;
    const job = this.jobs.get(id);
    return job ? cloneJob(job) : undefined;
  }

  async claimDueJobs(now: Date, limit: number, workerId: string): Promise<PublishJobRecord[]> {
    const due = [...this.jobs.values()]
      .filter((job) => job.status === 'pending' && new Date(job.availableAt).getTime() <= now.getTime())
      .sort((a, b) => new Date(a.availableAt).getTime() - new Date(b.availableAt).getTime())
      .slice(0, limit);

    for (const job of due) {
      job.status = 'claimed';
      job.claimedAt = now.toISOString();
      job.claimedBy = workerId;
      this.touch(job, now);
      this.log('queue.job.claimed', { jobId: job.id, workerId, attempts: job.attempts });
    }

    return due.map(cloneJob);
  }

  async markRunning(id: string): Promise<PublishJobRecord> {
    const job = this.require(id);
    job.status = 'running';
    this.touch(job, new Date());
    this.log('queue.job.running', { jobId: job.id, attempts: job.attempts });
    return cloneJob(job);
  }

  async markSucceeded(id: string, result: unknown): Promise<PublishJobRecord> {
    const job = this.require(id);
    job.status = 'succeeded';
    job.result = result;
    job.attempts += 1;
    job.claimedAt = null;
    job.claimedBy = null;
    this.touch(job, new Date());
    this.log('queue.job.succeeded', { jobId: job.id, attempts: job.attempts });
    return cloneJob(job);
  }

  async markFailedForRetry(id: string, error: FailureInfo, nextRunAt: Date): Promise<PublishJobRecord> {
    const job = this.require(id);
    job.attempts += 1;
    // Transient 'failed' marker for the log line; the persisted row lands back
    // in 'pending' so the claim query (status='pending') can pick it up again.
    this.log('queue.job.failed', {
      jobId: job.id,
      attempts: job.attempts,
      maxAttempts: job.maxAttempts,
      errorCode: error.code,
      error: error.message,
    });
    job.status = 'pending';
    job.availableAt = nextRunAt.toISOString();
    job.claimedAt = null;
    job.claimedBy = null;
    job.lastError = error.message;
    job.lastErrorCode = error.code ?? null;
    this.touch(job, new Date());
    this.log('queue.job.retry_scheduled', { jobId: job.id, attempts: job.attempts, availableAt: job.availableAt });
    return cloneJob(job);
  }

  async markDead(
    id: string,
    error: FailureInfo,
    reason: 'exhausted_retries' | 'non_retryable',
  ): Promise<{ job: PublishJobRecord; deadLetter: DeadLetterJobRecord }> {
    const job = this.require(id);
    // This call always represents the attempt that just failed (whether it's
    // the first attempt with a non-retryable error, or the Nth that exhausted
    // retries) — count it before dead-lettering.
    job.attempts += 1;
    job.status = 'dead';
    job.lastError = error.message;
    job.lastErrorCode = error.code ?? null;
    job.claimedAt = null;
    job.claimedBy = null;
    const now = new Date();
    this.touch(job, now);

    const deadLetter: DeadLetterJobRecord = {
      id: generateId('dlq'),
      publishJobId: job.id,
      postVariantId: job.postVariantId,
      operation: job.operation,
      attempts: job.attempts,
      errorCode: error.code ?? null,
      errorMessage: error.message,
      payloadSnapshot: structuredClonePayload(job.payload),
      failedAt: now.toISOString(),
      resolved: false,
      resolvedAt: null,
      createdAt: now.toISOString(),
    };
    this.deadLetters.push(deadLetter);

    this.log('queue.job.dead_lettered', {
      jobId: job.id,
      reason,
      attempts: job.attempts,
      errorCode: error.code,
      error: error.message,
    });

    return { job: cloneJob(job), deadLetter: cloneDeadLetter(deadLetter) };
  }

  async listDeadLetters(): Promise<DeadLetterJobRecord[]> {
    return this.deadLetters.map(cloneDeadLetter);
  }

  async listAll(): Promise<PublishJobRecord[]> {
    return [...this.jobs.values()].map(cloneJob);
  }

  async findStuckJobs(now: Date, leaseMs: number): Promise<PublishJobRecord[]> {
    const cutoff = now.getTime() - leaseMs;
    const stuck = [...this.jobs.values()].filter((job) => {
      if (job.status !== 'claimed' && job.status !== 'running') return false;
      if (!job.claimedAt) return false;
      return new Date(job.claimedAt).getTime() <= cutoff;
    });
    return stuck.map(cloneJob);
  }

  private require(id: string): PublishJobRecord {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`No such job: ${id}`);
    return job;
  }
}

function cloneJob(job: PublishJobRecord): PublishJobRecord {
  return { ...job, payload: structuredClonePayload(job.payload) as PublishJobRecord['payload'] };
}

function cloneDeadLetter(dlq: DeadLetterJobRecord): DeadLetterJobRecord {
  return { ...dlq, payloadSnapshot: structuredClonePayload(dlq.payloadSnapshot) };
}

function structuredClonePayload(value: unknown): unknown {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value)) as unknown;
}
