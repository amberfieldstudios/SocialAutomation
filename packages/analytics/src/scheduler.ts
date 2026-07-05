/**
 * ScheduledCollectionRunner — periodic analytics collection.
 *
 * GAP (routed to scheduler-queue, see also t22/t23): the cleanest way to make
 * this queue-backed would be a new `publish_jobs.operation` value (e.g.
 * `'collect_analytics'`), so collection runs get the queue's retry/backoff/DLQ
 * machinery for free. `@social/queue`'s `JobOperation` union
 * (`'publish' | 'edit' | 'delete'`) is owned by scheduler-queue and
 * `publish_jobs.operation` is scoped to one `post_variant_id`, both of which
 * fit a per-post analytics job well — but changing that type/schema is out of
 * this package's lane. Until that lands, this runner drives collection
 * directly on an interval (or via a single `runOnce`, which a `@social/queue`
 * job handler — or a cron trigger — can call today without any core changes:
 * `handler = () => runner.runOnce()`).
 */

import type { StructuredLogger } from '@social/core';
import type { AnalyticsCollector } from './collector';
import type { CollectionBatchResult, CollectionTarget } from './types';

export interface ScheduledCollectionRunnerOptions {
  collector: AnalyticsCollector;
  logger: StructuredLogger;
  /** Resolves the current set of published posts to collect analytics for. */
  listTargets: () => Promise<CollectionTarget[]> | CollectionTarget[];
  /** Injectable timer, for tests. Defaults to real `setInterval`/`clearInterval`. */
  setIntervalFn?: (fn: () => void, ms: number) => unknown;
  clearIntervalFn?: (handle: unknown) => void;
}

export class ScheduledCollectionRunner {
  private readonly logger: StructuredLogger;
  private handle: unknown;

  constructor(private readonly options: ScheduledCollectionRunnerOptions) {
    this.logger = options.logger.child({ module: 'analytics.scheduler' });
  }

  /** Run one collection pass immediately. Safe to call directly from a queue job handler or cron trigger. */
  async runOnce(): Promise<CollectionBatchResult> {
    const targets = await this.options.listTargets();
    this.logger.info('analytics.schedule.run_started', { targetCount: targets.length });
    const result = await this.options.collector.collectBatch(targets);
    this.logger.info('analytics.schedule.run_completed', {
      collected: result.collected,
      skippedUnsupported: result.skippedUnsupported,
      errored: result.errored,
    });
    return result;
  }

  /** Start running `runOnce` every `intervalMs`. Errors from one pass are logged, never thrown into the timer. */
  start(intervalMs: number): void {
    if (this.handle !== undefined) return;
    const setIntervalFn = this.options.setIntervalFn ?? ((fn, ms) => setInterval(fn, ms));
    this.handle = setIntervalFn(() => {
      this.runOnce().catch((err) => {
        this.logger.error('analytics.schedule.run_failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, intervalMs);
  }

  stop(): void {
    if (this.handle === undefined) return;
    const clearIntervalFn = this.options.clearIntervalFn ?? ((h) => clearInterval(h as NodeJS.Timeout));
    clearIntervalFn(this.handle);
    this.handle = undefined;
  }
}
