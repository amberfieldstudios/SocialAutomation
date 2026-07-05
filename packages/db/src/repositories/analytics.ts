/**
 * SQLite-backed repository over `analytics_snapshots`.
 *
 * Owned by `@social/analytics` conceptually (the analytics-logging worker),
 * but implemented here — alongside the other repos — to stay consistent with
 * the rest of `@social/db`'s repo set and avoid a new package depending
 * directly on `SqlDriver` internals. `@social/analytics` only ever talks to
 * this through the narrow `AnalyticsSnapshotsStore` port (mirrors how
 * `@social/queue`/`@social/auth` consume their SQLite-backed ports).
 *
 * `metrics`/`raw` round-trip via JSON TEXT columns (same convention as
 * `publish_jobs.payload`). `listByCampaign` joins through `post_variants` and
 * `posts` since `analytics_snapshots` itself has no `campaign_id` column —
 * campaign membership is a property of the *post*, not the snapshot.
 */

import { randomUUID } from 'node:crypto';
import type { StructuredLogger } from '@social/core';
import type { SqlDriver } from '../driver';
import { parseJson, toJson } from './rows';

export interface AnalyticsSnapshotRecord {
  id: string;
  postVariantId: string;
  accountId: string | null;
  remoteId: string;
  /** ISO-8601. */
  collectedAt: string;
  /** Normalized metric values (canonical keys where applicable, extras allowed). */
  metrics: Record<string, number>;
  /** Untyped platform payload, for audit. */
  raw?: unknown;
  createdAt: string;
}

export interface InsertSnapshotInput {
  postVariantId: string;
  accountId?: string | null;
  remoteId: string;
  collectedAt: string;
  metrics: Record<string, number>;
  raw?: unknown;
}

/** One row of `listByCampaign` — a snapshot plus the campaign/platform context needed to aggregate it. */
export interface CampaignSnapshotRow extends AnalyticsSnapshotRecord {
  campaignId: string;
  platformId: string;
}

interface SnapshotRow {
  id: string;
  post_variant_id: string;
  account_id: string | null;
  remote_id: string;
  collected_at: string;
  metrics: string;
  raw: string | null;
  created_at: string;
}

interface CampaignSnapshotSqlRow extends SnapshotRow {
  campaign_id: string;
  platform_id: string;
}

function mapRow(row: SnapshotRow): AnalyticsSnapshotRecord {
  return {
    id: row.id,
    postVariantId: row.post_variant_id,
    accountId: row.account_id,
    remoteId: row.remote_id,
    collectedAt: row.collected_at,
    metrics: parseJson<Record<string, number>>(row.metrics, {}),
    raw: row.raw === null ? undefined : (JSON.parse(row.raw) as unknown),
    createdAt: row.created_at,
  };
}

function mapCampaignRow(row: CampaignSnapshotSqlRow): CampaignSnapshotRow {
  return {
    ...mapRow(row),
    campaignId: row.campaign_id,
    platformId: row.platform_id,
  };
}

/** Storage port `@social/analytics` depends on (structurally — no cross-package type import needed). */
export interface AnalyticsSnapshotsStore {
  insert(input: InsertSnapshotInput): Promise<AnalyticsSnapshotRecord>;
  listByVariant(postVariantId: string): Promise<AnalyticsSnapshotRecord[]>;
  listByAccount(accountId: string): Promise<AnalyticsSnapshotRecord[]>;
  /** Every snapshot for posts belonging to `campaignId`, newest first is NOT guaranteed — callers aggregate. */
  listByCampaign(campaignId: string): Promise<CampaignSnapshotRow[]>;
  listAll(): Promise<AnalyticsSnapshotRecord[]>;
}

export class SqliteAnalyticsSnapshotsStore implements AnalyticsSnapshotsStore {
  constructor(
    private readonly driver: SqlDriver,
    private readonly logger?: StructuredLogger,
  ) {}

  async insert(input: InsertSnapshotInput): Promise<AnalyticsSnapshotRecord> {
    const id = `snap_${randomUUID()}`;
    const now = new Date().toISOString();
    this.driver.run(
      `INSERT INTO analytics_snapshots
         (id, post_variant_id, account_id, remote_id, collected_at, metrics, raw, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.postVariantId,
        input.accountId ?? null,
        input.remoteId,
        input.collectedAt,
        toJson(input.metrics) ?? '{}',
        toJson(input.raw),
        now,
      ],
    );
    this.logger?.info('analytics.snapshot.persisted', {
      snapshotId: id,
      postVariantId: input.postVariantId,
      remoteId: input.remoteId,
      metricKeys: Object.keys(input.metrics),
    });
    return this.requireRow(id);
  }

  async listByVariant(postVariantId: string): Promise<AnalyticsSnapshotRecord[]> {
    return this.driver
      .all<SnapshotRow>(
        'SELECT * FROM analytics_snapshots WHERE post_variant_id = ? ORDER BY collected_at',
        [postVariantId],
      )
      .map(mapRow);
  }

  async listByAccount(accountId: string): Promise<AnalyticsSnapshotRecord[]> {
    return this.driver
      .all<SnapshotRow>(
        'SELECT * FROM analytics_snapshots WHERE account_id = ? ORDER BY collected_at',
        [accountId],
      )
      .map(mapRow);
  }

  async listByCampaign(campaignId: string): Promise<CampaignSnapshotRow[]> {
    return this.driver
      .all<CampaignSnapshotSqlRow>(
        `SELECT s.*, p.campaign_id AS campaign_id, pv.platform_id AS platform_id
           FROM analytics_snapshots s
           JOIN post_variants pv ON pv.id = s.post_variant_id
           JOIN posts p ON p.id = pv.post_id
          WHERE p.campaign_id = ?
          ORDER BY s.collected_at`,
        [campaignId],
      )
      .map(mapCampaignRow);
  }

  async listAll(): Promise<AnalyticsSnapshotRecord[]> {
    return this.driver
      .all<SnapshotRow>('SELECT * FROM analytics_snapshots ORDER BY created_at')
      .map(mapRow);
  }

  private requireRow(id: string): AnalyticsSnapshotRecord {
    const row = this.driver.get<SnapshotRow>('SELECT * FROM analytics_snapshots WHERE id = ?', [
      id,
    ]);
    if (!row) throw new Error(`analytics snapshot ${id} not found`);
    return mapRow(row);
  }
}
