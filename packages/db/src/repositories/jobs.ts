/**
 * SQLite-backed `JobStore` (the port declared in `@social/queue/src/types.ts`)
 * over `publish_jobs` + `dead_letter_jobs`. Drop-in replacement for
 * `InMemoryJobStore` — the lifecycle semantics (attempt counting, the transient
 * `failed` -> `pending` retry transition, dead-letter insertion, idempotent
 * enqueue dedupe) mirror it exactly.
 *
 * FK note: `publish_jobs.post_variant_id` references `post_variants(id)` with
 * FKs enforced, so `enqueue` requires the referenced variant to exist. This is
 * always true in the real pipeline (a variant is created before its publish job
 * is enqueued); tests seed the variant.
 *
 * `payload` round-trips via the `publish_jobs.payload` JSON column (migration
 * 0003). `dead_letter_jobs.post_variant_id` is denormalized TEXT (no FK), so
 * `markDead` never fails on a missing variant.
 */

import { randomUUID } from 'node:crypto';
import type { StructuredLogger } from '@social/core';
import type {
  DeadLetterJobRecord,
  EnqueueJobInput,
  EnqueueResult,
  FailureInfo,
  JobOperation,
  JobStatus,
  JobStore,
  PublishJobRecord,
} from '@social/queue';
import type { SqlDriver } from '../driver';
import { nullableText, parseJsonNullable, toJson } from './rows';

/** Mirrors `deriveIdempotencyKey` in `@social/queue/src/idempotency.ts`. */
function deriveIdempotencyKey(postVariantId: string, operation: JobOperation): string {
  return `${postVariantId}:${operation}`;
}

interface JobRow {
  id: string;
  post_variant_id: string;
  schedule_id: string | null;
  operation: string;
  status: string;
  idempotency_key: string;
  attempts: number;
  max_attempts: number;
  available_at: string;
  claimed_at: string | null;
  claimed_by: string | null;
  last_error: string | null;
  last_error_code: string | null;
  result: string | null;
  payload: string | null;
  created_at: string;
  updated_at: string;
}

interface DeadLetterRow {
  id: string;
  publish_job_id: string;
  post_variant_id: string | null;
  operation: string;
  attempts: number;
  error_code: string | null;
  error_message: string | null;
  payload_snapshot: string | null;
  failed_at: string;
  resolved: number;
  resolved_at: string | null;
  created_at: string;
}

function mapJob(row: JobRow): PublishJobRecord {
  return {
    id: row.id,
    postVariantId: row.post_variant_id,
    scheduleId: nullableText(row.schedule_id),
    operation: row.operation as JobOperation,
    status: row.status as JobStatus,
    idempotencyKey: row.idempotency_key,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    availableAt: row.available_at,
    claimedAt: nullableText(row.claimed_at),
    claimedBy: nullableText(row.claimed_by),
    lastError: nullableText(row.last_error),
    lastErrorCode: nullableText(row.last_error_code),
    result: parseJsonNullable<unknown>(row.result) ?? undefined,
    payload: parseJsonNullable<Record<string, unknown>>(row.payload) ?? {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapDeadLetter(row: DeadLetterRow): DeadLetterJobRecord {
  return {
    id: row.id,
    publishJobId: row.publish_job_id,
    postVariantId: nullableText(row.post_variant_id),
    operation: row.operation as JobOperation,
    attempts: row.attempts,
    errorCode: nullableText(row.error_code),
    errorMessage: nullableText(row.error_message),
    payloadSnapshot: parseJsonNullable<unknown>(row.payload_snapshot) ?? undefined,
    failedAt: row.failed_at,
    resolved: row.resolved === 1,
    resolvedAt: nullableText(row.resolved_at),
    createdAt: row.created_at,
  };
}

export interface SqliteJobStoreOptions {
  defaultMaxAttempts?: number;
  logger?: StructuredLogger;
}

export class SqliteJobStore implements JobStore {
  private readonly defaultMaxAttempts: number;
  private readonly logger?: StructuredLogger;

  constructor(
    private readonly driver: SqlDriver,
    options: SqliteJobStoreOptions = {},
  ) {
    this.defaultMaxAttempts = options.defaultMaxAttempts ?? 5;
    this.logger = options.logger;
  }

  async enqueue(input: EnqueueJobInput): Promise<EnqueueResult> {
    const operation = input.operation ?? 'publish';
    const idempotencyKey =
      input.idempotencyKey ?? deriveIdempotencyKey(input.postVariantId, operation);

    const existing = await this.findByIdempotencyKey(idempotencyKey);
    if (existing) {
      this.logger?.info('queue.enqueue.deduped', { jobId: existing.id, idempotencyKey });
      return { job: existing, deduped: true };
    }

    const now = new Date();
    const nowIso = now.toISOString();
    const job: PublishJobRecord = {
      id: `job_${randomUUID()}`,
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
      createdAt: nowIso,
      updatedAt: nowIso,
    };

    this.driver.run(
      `INSERT INTO publish_jobs
         (id, post_variant_id, schedule_id, operation, status, idempotency_key, attempts,
          max_attempts, available_at, claimed_at, claimed_by, last_error, last_error_code,
          result, payload, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        job.id,
        job.postVariantId,
        job.scheduleId ?? null,
        job.operation,
        job.status,
        job.idempotencyKey,
        job.attempts,
        job.maxAttempts,
        job.availableAt,
        job.claimedAt ?? null,
        job.claimedBy ?? null,
        job.lastError ?? null,
        job.lastErrorCode ?? null,
        toJson(job.result),
        toJson(job.payload),
        job.createdAt,
        job.updatedAt,
      ],
    );
    this.logger?.info('queue.job.pending', {
      jobId: job.id,
      postVariantId: job.postVariantId,
      idempotencyKey,
    });
    return { job: mapJob(this.requireRow(job.id)), deduped: false };
  }

  async getById(id: string): Promise<PublishJobRecord | undefined> {
    const row = this.driver.get<JobRow>('SELECT * FROM publish_jobs WHERE id = ?', [id]);
    return row ? mapJob(row) : undefined;
  }

  async findByIdempotencyKey(key: string): Promise<PublishJobRecord | undefined> {
    const row = this.driver.get<JobRow>('SELECT * FROM publish_jobs WHERE idempotency_key = ?', [
      key,
    ]);
    return row ? mapJob(row) : undefined;
  }

  async claimDueJobs(now: Date, limit: number, workerId: string): Promise<PublishJobRecord[]> {
    const nowIso = now.toISOString();
    // Select-then-claim under one write transaction so two workers can't both
    // claim the same row.
    const claimed = this.driver.transaction<JobRow[]>(() => {
      const due = this.driver.all<JobRow>(
        `SELECT * FROM publish_jobs
          WHERE status = 'pending' AND available_at <= ?
          ORDER BY available_at ASC
          LIMIT ?`,
        [nowIso, limit],
      );
      for (const row of due) {
        this.driver.run(
          `UPDATE publish_jobs
             SET status = 'claimed', claimed_at = ?, claimed_by = ?, updated_at = ?
           WHERE id = ?`,
          [nowIso, workerId, nowIso, row.id],
        );
      }
      return due.map((row) => this.requireRow(row.id));
    });

    for (const row of claimed) {
      this.logger?.info('queue.job.claimed', {
        jobId: row.id,
        workerId,
        attempts: row.attempts,
      });
    }
    return claimed.map(mapJob);
  }

  async markRunning(id: string): Promise<PublishJobRecord> {
    const now = new Date().toISOString();
    this.driver.run(`UPDATE publish_jobs SET status = 'running', updated_at = ? WHERE id = ?`, [
      now,
      id,
    ]);
    const row = this.requireRow(id);
    this.logger?.info('queue.job.running', { jobId: id, attempts: row.attempts });
    return mapJob(row);
  }

  async markSucceeded(id: string, result: unknown): Promise<PublishJobRecord> {
    const now = new Date().toISOString();
    this.driver.run(
      `UPDATE publish_jobs
         SET status = 'succeeded', result = ?, attempts = attempts + 1,
             claimed_at = NULL, claimed_by = NULL, updated_at = ?
       WHERE id = ?`,
      [toJson(result), now, id],
    );
    const row = this.requireRow(id);
    this.logger?.info('queue.job.succeeded', { jobId: id, attempts: row.attempts });
    return mapJob(row);
  }

  async markFailedForRetry(
    id: string,
    error: FailureInfo,
    nextRunAt: Date,
  ): Promise<PublishJobRecord> {
    const now = new Date().toISOString();
    const before = this.requireRow(id);
    this.logger?.info('queue.job.failed', {
      jobId: id,
      attempts: before.attempts + 1,
      maxAttempts: before.max_attempts,
      errorCode: error.code,
      error: error.message,
    });
    // Transient 'failed' is only a log marker; the durable row lands back in
    // 'pending' so the claim query picks it up once due.
    this.driver.run(
      `UPDATE publish_jobs
         SET status = 'pending', attempts = attempts + 1, available_at = ?,
             claimed_at = NULL, claimed_by = NULL, last_error = ?, last_error_code = ?,
             updated_at = ?
       WHERE id = ?`,
      [nextRunAt.toISOString(), error.message, error.code ?? null, now, id],
    );
    const row = this.requireRow(id);
    this.logger?.info('queue.job.retry_scheduled', {
      jobId: id,
      attempts: row.attempts,
      availableAt: row.available_at,
    });
    return mapJob(row);
  }

  async markDead(
    id: string,
    error: FailureInfo,
    reason: 'exhausted_retries' | 'non_retryable',
  ): Promise<{ job: PublishJobRecord; deadLetter: DeadLetterJobRecord }> {
    const now = new Date().toISOString();
    const result = this.driver.transaction(() => {
      this.driver.run(
        `UPDATE publish_jobs
           SET status = 'dead', attempts = attempts + 1, last_error = ?, last_error_code = ?,
               claimed_at = NULL, claimed_by = NULL, updated_at = ?
         WHERE id = ?`,
        [error.message, error.code ?? null, now, id],
      );
      const job = this.requireRow(id);
      const deadLetterId = `dlq_${randomUUID()}`;
      this.driver.run(
        `INSERT INTO dead_letter_jobs
           (id, publish_job_id, post_variant_id, operation, attempts, error_code,
            error_message, payload_snapshot, failed_at, resolved, resolved_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?)`,
        [
          deadLetterId,
          job.id,
          job.post_variant_id,
          job.operation,
          job.attempts,
          error.code ?? null,
          error.message,
          job.payload,
          now,
          now,
        ],
      );
      const dlq = this.driver.get<DeadLetterRow>('SELECT * FROM dead_letter_jobs WHERE id = ?', [
        deadLetterId,
      ]);
      if (!dlq) throw new Error(`dead-letter ${deadLetterId} not found after write`);
      return { job: mapJob(job), deadLetter: mapDeadLetter(dlq) };
    });

    this.logger?.info('queue.job.dead_lettered', {
      jobId: id,
      reason,
      attempts: result.job.attempts,
      errorCode: error.code,
      error: error.message,
    });
    return result;
  }

  async listDeadLetters(): Promise<DeadLetterJobRecord[]> {
    return this.driver
      .all<DeadLetterRow>('SELECT * FROM dead_letter_jobs ORDER BY failed_at')
      .map(mapDeadLetter);
  }

  async listAll(): Promise<PublishJobRecord[]> {
    return this.driver.all<JobRow>('SELECT * FROM publish_jobs ORDER BY created_at').map(mapJob);
  }

  /**
   * Reclaim-sweep support (m2 hardening, t22): jobs left in `claimed`/`running`
   * with a stale `claimed_at` indicate a worker crashed mid-flight. `claimed_at`
   * doubles as the lease start — no new column needed since both `claimDueJobs`
   * and `markRunning`'s preceding claim stamp it, and only `markSucceeded` /
   * `markFailedForRetry` / `markDead` ever clear it.
   */
  async findStuckJobs(now: Date, leaseMs: number): Promise<PublishJobRecord[]> {
    const cutoffIso = new Date(now.getTime() - leaseMs).toISOString();
    const rows = this.driver.all<JobRow>(
      `SELECT * FROM publish_jobs
        WHERE status IN ('claimed', 'running') AND claimed_at IS NOT NULL AND claimed_at <= ?
        ORDER BY claimed_at ASC`,
      [cutoffIso],
    );
    return rows.map(mapJob);
  }

  private requireRow(id: string): JobRow {
    const row = this.driver.get<JobRow>('SELECT * FROM publish_jobs WHERE id = ?', [id]);
    if (!row) throw new Error(`publish job ${id} not found`);
    return row;
  }
}
