/**
 * The queue worker: claims due jobs and drives them through a `JobHandler`
 * (a stand-in for `registry.get(platform).publish(...)` until m3 wires real
 * connectors in). Publish-agnostic by design — it only knows about
 * `PublishJobRecord`/`JobStore`/typed connector errors, never a platform.
 *
 * Outcome routing:
 *   - handler resolves                    -> markSucceeded, emit `job.published`
 *   - handler throws non-retryable error   -> markDead(reason='non_retryable'), emit `job.dead_lettered`
 *   - handler throws retryable error,
 *       attempts remaining                 -> markFailedForRetry (backoff+jitter), emit `job.retry_scheduled`
 *   - handler throws retryable error,
 *       attempts exhausted                 -> markDead(reason='exhausted_retries'), emit `job.dead_lettered`
 *
 * Every transition above is persisted through `JobStore` *before* the
 * corresponding event is emitted, and every transition logs a structured line
 * — so a crash between "job executed" and "event emitted" loses at most a
 * notification, never the durable job state, and a crash mid-handler just
 * leaves the job `claimed`/`running` for a future `reclaimStuckJobs` sweep
 * (not yet implemented — see report) rather than silently dropping it.
 */

import type { StructuredLogger } from '@social/core';
import { isRetryable } from '@social/core';
import type { JobLifecycleEvent, JobEventListener } from './events';
import { computeBackoffDelayMs, resolveBackoffOptions, type BackoffOptions } from './retry';
import type { FailureInfo, JobStore, PublishJobRecord } from './types';

/** Executes one job's operation. Analogous to a connector call in the real
 * system; throws a typed connector error (see `@social/core/connector/errors`)
 * on failure so the worker can decide retry vs. dead-letter. */
export type JobHandler = (job: PublishJobRecord) => Promise<unknown>;

export interface WorkerOptions {
  store: JobStore;
  handler: JobHandler;
  logger: StructuredLogger;
  /** Identifies this worker in `claimed_by` / logs. Defaults to a random id. */
  workerId?: string;
  /** How many jobs to claim per poll. Default 10. */
  batchSize?: number;
  /** Poll interval when running continuously via `start()`. Default 1000ms. */
  pollIntervalMs?: number;
  backoff?: Partial<BackoffOptions>;
  /** Injectable clock, primarily for tests. */
  now?: () => Date;
  /** Injectable RNG for jitter, primarily for tests. */
  random?: () => number;
  onEvent?: JobEventListener;
}

function toFailureInfo(error: unknown): FailureInfo {
  if (error instanceof Error) {
    const code = (error as { code?: string }).code;
    return { code, message: error.message };
  }
  return { message: String(error) };
}

export class Worker {
  private readonly store: JobStore;
  private readonly handler: JobHandler;
  private readonly logger: StructuredLogger;
  private readonly workerId: string;
  private readonly batchSize: number;
  private readonly pollIntervalMs: number;
  private readonly backoff: BackoffOptions;
  private readonly now: () => Date;
  private readonly random: () => number;
  private readonly onEvent?: JobEventListener;

  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = true;
  private loopPromise: Promise<void> | undefined;
  /** Resolves the in-flight inter-poll sleep; set while the loop is sleeping, cleared once it wakes. */
  private wakeSleep: (() => void) | undefined;

  constructor(options: WorkerOptions) {
    this.store = options.store;
    this.handler = options.handler;
    this.logger = options.logger.child({ component: 'queue.worker' });
    this.workerId = options.workerId ?? `worker_${Math.random().toString(36).slice(2, 10)}`;
    this.batchSize = options.batchSize ?? 10;
    this.pollIntervalMs = options.pollIntervalMs ?? 1000;
    this.backoff = resolveBackoffOptions(options.backoff);
    this.now = options.now ?? (() => new Date());
    this.random = options.random ?? Math.random;
    this.onEvent = options.onEvent;
  }

  /** Starts continuous polling on `pollIntervalMs`. Returns immediately. */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.logger.info('worker.started', { workerId: this.workerId, pollIntervalMs: this.pollIntervalMs });
    const loop = async (): Promise<void> => {
      while (!this.stopped) {
        await this.runOnce();
        if (this.stopped) break;
        await new Promise<void>((resolve) => {
          this.wakeSleep = resolve;
          this.timer = setTimeout(resolve, this.pollIntervalMs);
        });
        this.wakeSleep = undefined;
      }
    };
    this.loopPromise = loop();
  }

  /** Stops polling; awaits the in-flight iteration finishing. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    // If the loop is between polls (awaiting the inter-poll sleep), wake it
    // immediately instead of leaving it to hang until a setTimeout that was
    // just cancelled would have fired — `clearTimeout` alone never resolves
    // that promise, which would otherwise make `loopPromise` (and this
    // `stop()` call) hang forever whenever `stop()` lands during the sleep.
    this.wakeSleep?.();
    await this.loopPromise;
    this.logger.info('worker.stopped', { workerId: this.workerId });
  }

  /** Claims and processes one batch of due jobs. Returns the number processed. Safe to call directly in tests without `start()`. */
  async runOnce(): Promise<number> {
    const claimed = await this.store.claimDueJobs(this.now(), this.batchSize, this.workerId);
    for (const job of claimed) {
      await this.process(job);
    }
    return claimed.length;
  }

  private async emit(event: JobLifecycleEvent): Promise<void> {
    if (!this.onEvent) return;
    try {
      await this.onEvent(event);
    } catch (err) {
      // Notification failures must never affect job outcome.
      this.logger.warn('worker.event_listener_failed', { eventType: event.type, jobId: event.job.id, error: String(err) });
    }
  }

  private async process(job: PublishJobRecord): Promise<void> {
    const log = this.logger.child({ jobId: job.id, postVariantId: job.postVariantId, operation: job.operation });
    await this.store.markRunning(job.id);
    log.info('worker.job.executing', { attempt: job.attempts + 1, maxAttempts: job.maxAttempts });

    try {
      const result = await this.handler(job);
      const updated = await this.store.markSucceeded(job.id, result);
      log.info('worker.job.published', { attempts: updated.attempts });
      await this.emit({ type: 'job.published', at: this.now().toISOString(), job: updated, result });
      return;
    } catch (error) {
      const failure = toFailureInfo(error);
      const retryable = isRetryable(error);
      const attemptNumber = job.attempts + 1;

      if (!retryable) {
        const { job: dead, deadLetter } = await this.store.markDead(job.id, failure, 'non_retryable');
        log.error('worker.job.dead_lettered', { reason: 'non_retryable', errorCode: failure.code, error: failure.message });
        await this.emit({ type: 'job.dead_lettered', at: this.now().toISOString(), job: dead, error: failure, reason: 'non_retryable', deadLetter });
        return;
      }

      if (attemptNumber >= job.maxAttempts) {
        const { job: dead, deadLetter } = await this.store.markDead(job.id, failure, 'exhausted_retries');
        log.error('worker.job.dead_lettered', { reason: 'exhausted_retries', attempts: attemptNumber, errorCode: failure.code, error: failure.message });
        await this.emit({ type: 'job.dead_lettered', at: this.now().toISOString(), job: dead, error: failure, reason: 'exhausted_retries', deadLetter });
        return;
      }

      const delayMs = computeBackoffDelayMs(attemptNumber, this.backoff, this.random);
      const nextRunAt = new Date(this.now().getTime() + delayMs);
      const updated = await this.store.markFailedForRetry(job.id, failure, nextRunAt);
      log.warn('worker.job.retry_scheduled', { attempt: attemptNumber, delayMs, nextRunAt: nextRunAt.toISOString(), errorCode: failure.code });
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
}
