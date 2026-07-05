/**
 * @social/analytics — analytics collection + campaign aggregation.
 *
 * `AnalyticsCollector` calls each connector's `getAnalytics`, normalizes the
 * response to canonical metrics (+ derived metrics like `ctr`), and persists
 * one `analytics_snapshots` row per collection via `@social/db`'s
 * `AnalyticsSnapshotsStore`. `CampaignAggregator` rolls those snapshots up to
 * per-campaign totals. `ScheduledCollectionRunner` is an optional periodic
 * driver (see its file header for the queue-integration gap routed to
 * scheduler-queue).
 */

export * from './types';
export * from './normalize';
export * from './collector';
export * from './aggregator';
export * from './scheduler';
export * from './url-tracking/utm';
export * from './url-tracking/short-url-service';
export * from './url-tracking/link-rewriter';
