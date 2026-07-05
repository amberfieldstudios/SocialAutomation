/**
 * CampaignAggregator — rolls per-post `analytics_snapshots` up to per-campaign
 * totals, via `@social/db`'s `AnalyticsSnapshotsStore.listByCampaign` (which
 * joins `analytics_snapshots -> post_variants -> posts` since campaign
 * membership lives on `posts.campaign_id`, not the snapshot itself).
 *
 * Rate-shaped metrics (`ctr`, `engagementRate`) are never summed — they are
 * recomputed from the aggregate totals so the campaign-level rate reflects the
 * whole campaign rather than an average of per-post rates (which would
 * over-weight low-volume posts).
 */

import type { StructuredLogger } from '@social/core';
import type { AnalyticsSnapshotsStore, CampaignSnapshotRow } from '@social/db';

/** Metric keys that are rates/ratios, not counts — excluded from the summed totals. */
const RATE_METRICS = new Set(['ctr', 'engagementRate']);

export interface CampaignAnalyticsSummary {
  campaignId: string;
  /** Number of analytics_snapshots rows rolled up. */
  snapshotCount: number;
  /** Distinct post_variants represented. */
  postVariantCount: number;
  /** Distinct platforms represented. */
  platforms: string[];
  /** Summed counts across every snapshot, keyed by metric name (excludes rate metrics). */
  totals: Record<string, number>;
  /** clicks / views (falling back to clicks / impressions) computed from `totals`. Omitted if not computable. */
  ctr?: number;
  /** ISO-8601. */
  generatedAt: string;
}

export interface CampaignAggregatorOptions {
  store: AnalyticsSnapshotsStore;
  logger: StructuredLogger;
  now?: () => Date;
}

export class CampaignAggregator {
  private readonly logger: StructuredLogger;
  private readonly now: () => Date;

  constructor(private readonly options: CampaignAggregatorOptions) {
    this.logger = options.logger.child({ module: 'analytics.aggregator' });
    this.now = options.now ?? (() => new Date());
  }

  async aggregate(campaignId: string): Promise<CampaignAnalyticsSummary> {
    const rows = await this.options.store.listByCampaign(campaignId);
    const summary = summarize(campaignId, rows, this.now().toISOString());

    this.logger.info('analytics.aggregate.campaign', {
      campaignId,
      snapshotCount: summary.snapshotCount,
      postVariantCount: summary.postVariantCount,
      platforms: summary.platforms,
      ctr: summary.ctr,
    });
    return summary;
  }
}

function summarize(
  campaignId: string,
  rows: CampaignSnapshotRow[],
  generatedAt: string,
): CampaignAnalyticsSummary {
  const totals: Record<string, number> = {};
  const postVariantIds = new Set<string>();
  const platforms = new Set<string>();

  for (const row of rows) {
    postVariantIds.add(row.postVariantId);
    platforms.add(row.platformId);
    for (const [key, value] of Object.entries(row.metrics)) {
      if (RATE_METRICS.has(key)) continue;
      if (typeof value !== 'number' || Number.isNaN(value)) continue;
      totals[key] = (totals[key] ?? 0) + value;
    }
  }

  const clicks = totals.clicks;
  const views = totals.views;
  const impressions = totals.impressions;
  let ctr: number | undefined;
  if (typeof clicks === 'number') {
    const denominator =
      typeof views === 'number' && views > 0
        ? views
        : typeof impressions === 'number' && impressions > 0
          ? impressions
          : undefined;
    if (denominator !== undefined) {
      ctr = clicks / denominator;
    }
  }

  return {
    campaignId,
    snapshotCount: rows.length,
    postVariantCount: postVariantIds.size,
    platforms: [...platforms],
    totals,
    ...(ctr !== undefined ? { ctr } : {}),
    generatedAt,
  };
}
