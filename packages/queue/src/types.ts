/**
 * Types for the persisted publish-job queue.
 *
 * Field names mirror the `publish_jobs` / `dead_letter_jobs` columns in
 * `docs/SCHEMA.md` / `packages/db/migrations/0001_init.sql` 1:1 (camelCase of
 * the snake_case column). Any `JobStore` implementation (in-memory now, a real
 * `@social/db`-backed one later) must round-trip these fields without loss.
 */

import type { ConnectorErrorCode } from '@social/core';

/**
 * Matches `publish_jobs.operation`. `'collect_analytics'` (added in m2
 * hardening, t22) lets scheduled analytics collection run through the same
 * queue machinery (retry/backoff/DLQ) as publishing; the handler for it is
 * implemented by the analytics module (see t20/t23), not here.
 */
export type JobOperation = 'publish' | 'edit' | 'delete' | 'collect_analytics';

/**
 * Matches `publish_jobs.status`. Note: a retryable failure does not linger in
 * `'failed'` — the worker records the failure (logged + `last_error` set) and
 * immediately moves the row back to `'pending'` with `available_at` pushed
 * forward, because the claim query only selects `status = 'pending'`. `'failed'`
 * exists in the enum for the moment between "attempt failed" and "retry
 * scheduled" and shows up in logs even though it may never be durably observed
 * mid-transition by another reader.
 */
export type JobStatus = 'pending' | 'claimed' | 'running' | 'succeeded' | 'failed' | 'dead';

/**
 * The execution payload a `JobHandler` needs to actually perform the operation.
 * In the full system this is resolved by loading the referenced `post_variant`
 * (+ decrypted token via the auth vault) when the job runs. This queue skeleton
 * is publish-agnostic and connector-stub-driven, so the payload is captured
 * directly at enqueue time instead. `plugins/*` connectors arrive in m3 and will
 * replace this stub resolution without changing the store/worker contracts.
 */
export interface JobPayload {
  [key: string]: unknown;
}

/** A persisted row in `publish_jobs`. */
export interface PublishJobRecord {
  id: string;
  postVariantId: string;
  scheduleId?: string | null;
  operation: JobOperation;
  status: JobStatus;
  idempotencyKey: string;
  attempts: number;
  maxAttempts: number;
  /** ISO-8601 — eligible-to-run time; backoff moves this forward. */
  availableAt: string;
  claimedAt?: string | null;
  /** Worker id holding the claim. */
  claimedBy?: string | null;
  lastError?: string | null;
  lastErrorCode?: ConnectorErrorCode | string | null;
  /** JSON-serializable `PublishResult` / `EditResult` / `DeleteResult`. */
  result?: unknown;
  /** Not a DB column — see `JobPayload` doc comment. */
  payload: JobPayload;
  createdAt: string;
  updatedAt: string;
}

/** A persisted row in `dead_letter_jobs`. */
export interface DeadLetterJobRecord {
  id: string;
  publishJobId: string;
  postVariantId?: string | null;
  operation: JobOperation;
  attempts: number;
  errorCode?: ConnectorErrorCode | string | null;
  errorMessage?: string | null;
  /** JSON snapshot of the job payload at the moment it was dead-lettered. */
  payloadSnapshot: unknown;
  /** ISO-8601. */
  failedAt: string;
  resolved: boolean;
  resolvedAt?: string | null;
  createdAt: string;
}

export interface EnqueueJobInput {
  postVariantId: string;
  operation?: JobOperation;
  payload: JobPayload;
  scheduleId?: string | null;
  /**
   * Explicit idempotency key. If omitted, one is derived — see
   * `deriveIdempotencyKey` in `idempotency.ts`. Callers scheduling recurring
   * occurrences of the same variant MUST pass an explicit key that includes the
   * occurrence identity (e.g. the fire time), or every occurrence after the
   * first will dedupe against the one already queued.
   */
  idempotencyKey?: string;
  /** Defaults to now. */
  availableAt?: Date;
  /** Defaults to the store's configured default (5, matching the schema default). */
  maxAttempts?: number;
}

export interface EnqueueResult {
  job: PublishJobRecord;
  /** True if an existing job with the same idempotency key was returned instead of creating a new one. */
  deduped: boolean;
}

export interface FailureInfo {
  code?: ConnectorErrorCode | string;
  message: string;
}

/**
 * Persistence abstraction over `publish_jobs` + `dead_letter_jobs`. All methods
 * are async so a real DB-backed implementation (SQLite/Postgres via `@social/db`)
 * is a drop-in replacement for the in-memory one used here and in tests.
 */
export interface JobStore {
  enqueue(input: EnqueueJobInput): Promise<EnqueueResult>;

  getById(id: string): Promise<PublishJobRecord | undefined>;

  findByIdempotencyKey(key: string): Promise<PublishJobRecord | undefined>;

  /**
   * Atomically claims up to `limit` jobs that are `pending` and due
   * (`available_at <= now`), transitioning them to `claimed` and stamping
   * `claimed_at`/`claimed_by`. Ordered oldest-available-first.
   */
  claimDueJobs(now: Date, limit: number, workerId: string): Promise<PublishJobRecord[]>;

  /** Transitions a claimed job to `running` right before the handler is invoked. */
  markRunning(id: string): Promise<PublishJobRecord>;

  /** Terminal success: status -> `succeeded`, stores `result`. */
  markSucceeded(id: string, result: unknown): Promise<PublishJobRecord>;

  /**
   * Retryable failure that has attempts remaining: increments `attempts`,
   * records `last_error`/`last_error_code`, and moves `available_at` forward to
   * `nextRunAt`. Status returns to `pending` so the claim query picks it up
   * again once due.
   */
  markFailedForRetry(id: string, error: FailureInfo, nextRunAt: Date): Promise<PublishJobRecord>;

  /**
   * Terminal failure (non-retryable error, or retries exhausted): status ->
   * `dead`, and a corresponding `dead_letter_jobs` row is inserted with the
   * error and a payload snapshot.
   */
  markDead(id: string, error: FailureInfo, reason: 'exhausted_retries' | 'non_retryable'): Promise<{
    job: PublishJobRecord;
    deadLetter: DeadLetterJobRecord;
  }>;

  listDeadLetters(): Promise<DeadLetterJobRecord[]>;

  /** Test/debug helper — not part of the production contract surface. */
  listAll(): Promise<PublishJobRecord[]>;

  /**
   * Finds jobs stuck in `claimed`/`running` whose `claimed_at` is older than
   * `leaseMs` — i.e. a worker claimed (or started running) the job and then
   * crashed/died before reaching a terminal state or handing it back. Used by
   * the `ReclaimSweeper` (see `reclaim.ts`) to re-queue or dead-letter those
   * jobs so a crash never leaves work silently stuck forever.
   *
   * Optional so existing `JobStore` implementations remain valid without
   * modification (additive m2-hardening addition, t22); a store that doesn't
   * implement it simply has no reclaim coverage until it does.
   */
  findStuckJobs?(now: Date, leaseMs: number): Promise<PublishJobRecord[]>;
}
