/**
 * The `collect_analytics` job handler (t23) — the analytics-collection
 * counterpart to `publish-worker.ts`'s `createPublishHandler`, run through the
 * exact same `@social/queue` `Worker` (and therefore the same retry/backoff/
 * dead-letter machinery) instead of a bespoke interval timer.
 *
 * `AnalyticsCollector.collect()` (see `@social/analytics`) never throws — it
 * already retries transient/rate-limited `ConnectorError`s internally and
 * returns a `{ status: 'error', error }` outcome once its own retry budget is
 * exhausted, or `{ status: 'skipped_unsupported' }` for a platform that
 * doesn't implement `getAnalytics`. To let the queue's own retry/backoff/DLQ
 * apply on top of that (a second, coarser retry layer — e.g. for a platform
 * outage that outlasts the collector's few in-process attempts), this handler
 * re-throws a `ConnectorError` reconstructed from the outcome's error info
 * when `status === 'error'`, preserving the original error code's
 * retryability where recognized. A `skipped_unsupported` outcome is NOT an
 * error — it resolves successfully (the job's `result` records the skip) so a
 * platform without analytics support never occupies a DLQ slot.
 */

import { ConnectorError, type ConnectorErrorCode, type StructuredLogger } from '@social/core';
import type { PublishJobRecord } from '@social/queue';
import type { AccountManager } from '@social/auth';
import type { AnalyticsCollector, CollectionOutcome, ConnectorResolverPort } from '@social/analytics';

/** Codes an `AnalyticsCollector` outcome can carry that are worth a further queue-level retry. */
const RETRYABLE_ANALYTICS_CODES = new Set(['rate_limited', 'transient', 'token_expired']);

export interface AnalyticsJobPayload {
  [key: string]: unknown;
  platform: string;
  accountId: string;
  postVariantId: string;
  /** Platform-native post id (`post_variants.remote_id`, set by `markPublished`). */
  remoteId: string;
  since?: string;
  until?: string;
}

export interface AnalyticsHandlerDeps {
  connectors: ConnectorResolverPort;
  accounts: AccountManager;
  collector: AnalyticsCollector;
  logger: StructuredLogger;
}

function parseAnalyticsPayload(job: PublishJobRecord): AnalyticsJobPayload {
  const payload = job.payload as Partial<AnalyticsJobPayload> | undefined;
  if (
    !payload ||
    typeof payload.platform !== 'string' ||
    typeof payload.accountId !== 'string' ||
    typeof payload.postVariantId !== 'string' ||
    typeof payload.remoteId !== 'string'
  ) {
    throw new Error(
      `collect_analytics job ${job.id} has a malformed payload; expected { platform, accountId, postVariantId, remoteId }.`,
    );
  }
  return payload as AnalyticsJobPayload;
}

/** Builds the `JobHandler` a `Worker` drives `collect_analytics` jobs through. */
export function createAnalyticsHandler(deps: AnalyticsHandlerDeps) {
  const log = deps.logger.child({ component: 'pipeline.analytics_handler' });

  return async (job: PublishJobRecord): Promise<CollectionOutcome> => {
    const { platform, accountId, postVariantId, remoteId, since, until } = parseAnalyticsPayload(job);
    const ctx = await deps.accounts.createContext(accountId);

    const outcome = await deps.collector.collect({
      platform,
      accountId,
      postVariantId,
      remoteId,
      ctx,
      ...(since !== undefined ? { since } : {}),
      ...(until !== undefined ? { until } : {}),
    });

    if (outcome.status === 'error') {
      const code = outcome.error?.code;
      log.warn('pipeline.analytics_handler.collect_failed', { jobId: job.id, platform, postVariantId, errorCode: code });
      throw new ConnectorError((code as ConnectorErrorCode | undefined) ?? 'transient', outcome.error?.message ?? 'analytics collection failed', {
        retryable: code ? RETRYABLE_ANALYTICS_CODES.has(code) : true,
      });
    }

    return outcome;
  };
}
