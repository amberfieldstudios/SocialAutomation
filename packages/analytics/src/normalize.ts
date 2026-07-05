/**
 * Normalization: turns a connector's `AnalyticsSnapshot.metrics` (already
 * canonical-keyed per the `PlatformConnector` contract, per-platform extras
 * allowed) into the metric set we persist, adding derived metrics the
 * connectors themselves never compute.
 *
 * `CANONICAL_METRICS` (impressions, reach, likes, comments, shares, clicks,
 * views, saves, followersDelta, engagementRate) is the cross-platform source
 * of truth defined in `@social/core`. Two metrics the task brief calls out —
 * CTR and watch time — are NOT canonical metric names:
 *   - CTR is *derived* (clicks / views, falling back to clicks / impressions)
 *     rather than reported directly by any platform, so we compute it here
 *     rather than expecting connectors to fabricate it.
 *   - Watch time has no canonical slot (video-specific, not every platform
 *     reports it) — connectors that expose it put it in `metrics.watchTimeMs`
 *     (or similar) as a platform-extra key, which passes through untouched.
 * "followers" (a running total) likewise passes through as a platform-extra
 * key distinct from the canonical `followersDelta` (a period-over-period
 * change); both survive normalization unmodified.
 */

import type { AnalyticsSnapshot } from '@social/core';

/** Metric keys this module derives; kept out of `CANONICAL_METRICS` deliberately (see file header). */
export const DERIVED_METRICS = ['ctr'] as const;
export type DerivedMetric = (typeof DERIVED_METRICS)[number];

/**
 * Merge the connector-reported metrics with derived ones. Never mutates the
 * input. A derived metric is only added when its inputs are present and the
 * denominator is non-zero, so absence still means "not computable" rather
 * than a fabricated 0.
 */
export function normalizeMetrics(metrics: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = { ...metrics };

  const clicks = metrics.clicks;
  const views = metrics.views;
  const impressions = metrics.impressions;

  if (typeof clicks === 'number') {
    const denominator =
      typeof views === 'number' && views > 0
        ? views
        : typeof impressions === 'number' && impressions > 0
          ? impressions
          : undefined;
    if (denominator !== undefined) {
      out.ctr = clicks / denominator;
    }
  }

  return out;
}

/** Applies `normalizeMetrics` to a full connector snapshot, preserving `remoteId`/`collectedAt`/`raw`. */
export function normalizeSnapshot(snapshot: AnalyticsSnapshot): AnalyticsSnapshot {
  return {
    ...snapshot,
    metrics: normalizeMetrics(snapshot.metrics),
  };
}
