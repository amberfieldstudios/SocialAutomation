/**
 * AnalyticsCollector — calls `connector.getAnalytics` for a batch of published
 * posts, normalizes each response, and persists one `analytics_snapshots` row
 * per successful collection.
 *
 * Failure handling (the batch NEVER throws/crashes on a single target's
 * failure):
 *  - `capabilities.operations.getAnalytics === false` (or a thrown
 *    `NotSupportedError`, belt-and-suspenders): the platform is skipped and
 *    recorded via a structured log line + `status: 'skipped_unsupported'` in
 *    the batch result. No snapshot row is written.
 *  - A `retryable` `ConnectorError` (rate-limited/transient): retried up to
 *    `retry.maxAttempts` with backoff, then recorded as `status: 'error'` if
 *    still failing.
 *  - Any other error: recorded as `status: 'error'` and logged; the batch
 *    continues with the remaining targets.
 */

import { ConnectorError, NotSupportedError, type StructuredLogger } from '@social/core';
import type { AnalyticsSnapshotsStore } from '@social/db';
import { normalizeMetrics } from './normalize';
import type {
  CollectionBatchResult,
  CollectionOutcome,
  CollectionTarget,
  ConnectorResolverPort,
  NormalizedSnapshot,
} from './types';

export interface RetryOptions {
  /** Total attempts (including the first), for retryable errors. Default 3. */
  maxAttempts?: number;
  /** Base backoff in ms between attempts (linear: attempt * base). Default 200. */
  backoffMs?: number;
  /** Injectable delay, for tests. Default a real `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
}

export interface AnalyticsCollectorOptions {
  connectors: ConnectorResolverPort;
  store: AnalyticsSnapshotsStore;
  logger: StructuredLogger;
  now?: () => Date;
  retry?: RetryOptions;
}

const DEFAULT_RETRY: Required<RetryOptions> = {
  maxAttempts: 3,
  backoffMs: 200,
  sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export class AnalyticsCollector {
  private readonly logger: StructuredLogger;
  private readonly now: () => Date;
  private readonly retry: Required<RetryOptions>;

  constructor(private readonly options: AnalyticsCollectorOptions) {
    this.logger = options.logger.child({ module: 'analytics.collector' });
    this.now = options.now ?? (() => new Date());
    this.retry = { ...DEFAULT_RETRY, ...options.retry };
  }

  /** Collect + persist analytics for one target. Never throws — failures are reported in the returned outcome. */
  async collect(target: CollectionTarget): Promise<CollectionOutcome> {
    const log = this.logger.child({
      platform: target.platform,
      accountId: target.accountId,
      postVariantId: target.postVariantId,
    });

    let connector;
    try {
      connector = this.options.connectors.resolve(target.platform);
    } catch (err) {
      log.error('analytics.collect.connector_resolve_failed', { error: describeError(err) });
      return { status: 'error', target, error: describeError(err) };
    }

    if (connector.capabilities.operations.getAnalytics !== true) {
      log.info('analytics.collect.skipped_unsupported', { remoteId: target.remoteId });
      return { status: 'skipped_unsupported', target };
    }

    let attempt = 0;
     
    while (true) {
      attempt += 1;
      try {
        const snapshot = await connector.getAnalytics(
          {
            remoteId: target.remoteId,
            ...(target.since !== undefined ? { since: target.since } : {}),
            ...(target.until !== undefined ? { until: target.until } : {}),
          },
          target.ctx,
        );

        const normalized: NormalizedSnapshot = {
          postVariantId: target.postVariantId,
          accountId: target.accountId,
          platform: target.platform,
          remoteId: snapshot.remoteId,
          collectedAt: snapshot.collectedAt ?? this.now().toISOString(),
          metrics: normalizeMetrics(snapshot.metrics),
          raw: snapshot.raw,
        };

        await this.options.store.insert({
          postVariantId: normalized.postVariantId,
          accountId: normalized.accountId,
          remoteId: normalized.remoteId,
          collectedAt: normalized.collectedAt,
          metrics: normalized.metrics,
          raw: normalized.raw,
        });

        log.info('analytics.collect.succeeded', {
          remoteId: target.remoteId,
          metricKeys: Object.keys(normalized.metrics),
          attempt,
        });
        return { status: 'collected', target, snapshot: normalized };
      } catch (err) {
        if (err instanceof NotSupportedError) {
          log.warn('analytics.collect.skipped_unsupported_at_runtime', {
            remoteId: target.remoteId,
            message: err.message,
          });
          return { status: 'skipped_unsupported', target };
        }

        const retryable = err instanceof ConnectorError && err.retryable;
        const attemptsLeft = attempt < this.retry.maxAttempts;
        if (retryable && attemptsLeft) {
          const delayMs =
            (err instanceof ConnectorError && err.retryAfterMs) || this.retry.backoffMs * attempt;
          log.warn('analytics.collect.retrying', {
            remoteId: target.remoteId,
            attempt,
            delayMs,
            errorCode: err.code,
            error: err.message,
          });
          await this.retry.sleep(delayMs);
          continue;
        }

        log.error('analytics.collect.failed', {
          remoteId: target.remoteId,
          attempt,
          error: describeError(err),
        });
        return { status: 'error', target, error: describeError(err) };
      }
    }
  }

  /** Collect every target, isolating failures so one bad platform never aborts the batch. */
  async collectBatch(targets: CollectionTarget[]): Promise<CollectionBatchResult> {
    const outcomes: CollectionOutcome[] = [];
    for (const target of targets) {
      outcomes.push(await this.collect(target));
    }
    const collected = outcomes.filter((o) => o.status === 'collected').length;
    const skippedUnsupported = outcomes.filter((o) => o.status === 'skipped_unsupported').length;
    const errored = outcomes.filter((o) => o.status === 'error').length;

    this.logger.info('analytics.collect.batch_complete', {
      total: outcomes.length,
      collected,
      skippedUnsupported,
      errored,
    });
    return { outcomes, collected, skippedUnsupported, errored };
  }
}

function describeError(err: unknown): { code?: string; message: string } {
  if (err instanceof ConnectorError) {
    return { code: err.code, message: err.message };
  }
  if (err instanceof Error) {
    return { message: err.message };
  }
  return { message: String(err) };
}
