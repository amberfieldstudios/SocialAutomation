/**
 * Stuck-job reclaim sweep (m2 hardening, t22).
 *
 * A worker that crashes between `claimDueJobs`/`markRunning` and a terminal
 * state (`succeeded`/`pending`-for-retry/`dead`) leaves a row parked in
 * `claimed` or `running` forever — nothing else re-claims it, because
 * `claimDueJobs` only selects `status = 'pending'`. `claimed_at` doubles as a
 * lease start: once it's older than `leaseMs`, the job is presumed
 * abandoned and the `ReclaimSweeper` treats it exactly like a failed attempt
 * — incrementing `attempts` and either rescheduling (with the same
 * backoff+jitter policy as any other retry) or dead-lettering it once
 * `maxAttempts` is reached. This guarantees a crash never loses a job
 * silently, and never leaves it double-claimable once it's back in
 * `pending`/`dead`.
 *
 * Requires a `JobStore` that implements the optional `findStuckJobs` method
 * (both `InMemoryJobStore` and `@social/db`'s `SqliteJobStore` do). Stores
 * that don't implement it are simply skipped (logged once) rather than
 * throwing, so wiring this in is safe regardless of which store is in use.
 */

import type { StructuredLogger } from '@social/core';
import type { JobLifecycleEvent, JobEventListener } from './events';
import { computeBackoffDelayMs, resolveBackoffOptions, type BackoffOptions } from './retry';
import type { FailureInfo, JobStore, PublishJobRecord } from './types';

export const DEFAULT_LEASE_MS = 5 * 60_000; // 5 minutes

export interface ReclaimSweeperOptions {
  store: JobStore;
  logger: StructuredLogger;
  /** How long a `claimed`/`running` job may go without progress before it's presumed abandoned. Default 5 minutes. */
  leaseMs?: number;
  backoff?: Partial<BackoffOptions>;
  now?: () => Date;
  random?: () => number;
  onEvent?: JobEventListener;
}

const LEASE_EXPIRED_CODE = 'LEASE_EXPIRED';

export class ReclaimSweeper {
  private readonly store: JobStore;
  private readonly logger: StructuredLogger;
  private readonly leaseMs: number;
  private readonly backoff: BackoffOptions;
  private readonly now: () => Date;
  private readonly random: () => number;
  private readonly onEvent?: JobEventListener;
  private warnedUnsupported = false;

  constructor(options: ReclaimSweeperOptions) {
    this.store = options.store;
    this.logger = options.logger.child({ component: 'queue.reclaim' });
    this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    this.backoff = resolveBackoffOptions(options.backoff);
    this.now = options.now ?? (() => new Date());
    this.random = options.random ?? Math.random;
    this.onEvent = options.onEvent;
  }

  /** Runs one sweep. Returns the number of jobs reclaimed. Safe to call on a timer or directly in tests. */
  async sweepOnce(): Promise<number> {
    if (!this.store.findStuckJobs) {
      if (!this.warnedUnsupported) {
        this.logger.warn('reclaim.unsupported_store', {
          message: 'JobStore does not implement findStuckJobs; reclaim sweep is a no-op',
        });
        this.warnedUnsupported = true;
      }
      return 0;
    }

    const stuck = await this.store.findStuckJobs(this.now(), this.leaseMs);
    for (const job of stuck) {
      await this.reclaim(job);
    }
    return stuck.length;
  }

  private async emit(event: JobLifecycleEvent): Promise<void> {
    if (!this.onEvent) return;
    try {
      await this.onEvent(event);
    } catch (err) {
      this.logger.warn('reclaim.event_listener_failed', { eventType: event.type, jobId: event.job.id, error: String(err) });
    }
  }

  private async reclaim(job: PublishJobRecord): Promise<void> {
    const log = this.logger.child({ jobId: job.id, postVariantId: job.postVariantId, operation: job.operation });
    const failure: FailureInfo = {
      code: LEASE_EXPIRED_CODE,
      message: `job lease expired after ${this.leaseMs}ms while status='${job.status}' (worker '${job.claimedBy ?? 'unknown'}' presumed crashed)`,
    };
    const attemptNumber = job.attempts + 1;

    if (attemptNumber >= job.maxAttempts) {
      const { job: dead, deadLetter } = await this.store.markDead(job.id, failure, 'exhausted_retries');
      log.error('reclaim.job.dead_lettered', {
        reason: 'exhausted_retries',
        attempts: attemptNumber,
        leaseMs: this.leaseMs,
      });
      await this.emit({ type: 'job.dead_lettered', at: this.now().toISOString(), job: dead, error: failure, reason: 'exhausted_retries', deadLetter });
      return;
    }

    const delayMs = computeBackoffDelayMs(attemptNumber, this.backoff, this.random);
    const nextRunAt = new Date(this.now().getTime() + delayMs);
    const updated = await this.store.markFailedForRetry(job.id, failure, nextRunAt);
    log.warn('reclaim.job.requeued', {
      attempt: attemptNumber,
      delayMs,
      nextRunAt: nextRunAt.toISOString(),
      leaseMs: this.leaseMs,
    });
    await this.emit({
      type: 'job.retry_scheduled',
      at: this.now().toISOString(),
      job: updated,
      error: failure,
      nextRunAt: nextRunAt.toISOString(),
      attempt: attemptNumber,
      delayMs,
    });
  }
}
