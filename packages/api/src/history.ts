/**
 * Publish-history read model: joins `post_variants` -> `posts` -> `accounts`
 * for the History view (per-post results: platform, account, status, remote
 * URL, campaign). `@social/db` doesn't ship a `post_variants` repo (see
 * `@social/pipeline`'s `PostVariantsRepo` doc comment — it's a minimal writer,
 * m4/content-pipeline territory), so this is a small read-only query against
 * the shared `SqlDriver`, scoped to this package the same way
 * `PostVariantsRepo` is scoped to `@social/pipeline`.
 */

import type { SqlDriver } from '@social/db';

export interface HistoryEntry {
  variantId: string;
  postId: string;
  campaignId: string | null;
  platformId: string;
  accountId: string;
  accountHandle: string | null;
  text: string | null;
  title: string | null;
  status: string;
  validationState: string;
  remoteId: string | null;
  remoteUrl: string | null;
  publishedAt: string | null;
  createdAt: string;
}

interface HistoryRow {
  id: string;
  post_id: string;
  campaign_id: string | null;
  platform_id: string;
  account_id: string;
  handle: string | null;
  text: string | null;
  title: string | null;
  status: string;
  validation_state: string;
  remote_id: string | null;
  remote_url: string | null;
  published_at: string | null;
  created_at: string;
}

export interface ListHistoryFilter {
  campaignId?: string;
  platformId?: string;
  status?: string;
  limit?: number;
}

export function listHistory(driver: SqlDriver, filter: ListHistoryFilter = {}): HistoryEntry[] {
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (filter.campaignId) {
    clauses.push('p.campaign_id = ?');
    params.push(filter.campaignId);
  }
  if (filter.platformId) {
    clauses.push('v.platform_id = ?');
    params.push(filter.platformId);
  }
  if (filter.status) {
    clauses.push('v.status = ?');
    params.push(filter.status);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const limit = filter.limit ?? 200;

  const rows = driver.all<HistoryRow>(
    `SELECT v.id, v.post_id, p.campaign_id, v.platform_id, v.account_id, a.handle,
            v.text, v.title, v.status, v.validation_state, v.remote_id, v.remote_url,
            v.published_at, v.created_at
       FROM post_variants v
       JOIN posts p ON p.id = v.post_id
       LEFT JOIN accounts a ON a.id = v.account_id
       ${where}
       ORDER BY v.created_at DESC
       LIMIT ?`,
    [...params, limit],
  );

  return rows.map((row) => ({
    variantId: row.id,
    postId: row.post_id,
    campaignId: row.campaign_id,
    platformId: row.platform_id,
    accountId: row.account_id,
    accountHandle: row.handle,
    text: row.text,
    title: row.title,
    status: row.status,
    validationState: row.validation_state,
    remoteId: row.remote_id,
    remoteUrl: row.remote_url,
    publishedAt: row.published_at,
    createdAt: row.created_at,
  }));
}

export interface CampaignSummary {
  id: string;
  name: string;
  status: string;
  trackingCode: string | null;
  createdAt: string;
}

interface CampaignRow {
  id: string;
  name: string;
  status: string;
  tracking_code: string | null;
  created_at: string;
}

export function listCampaigns(driver: SqlDriver): CampaignSummary[] {
  const rows = driver.all<CampaignRow>(
    `SELECT id, name, status, tracking_code, created_at FROM campaigns ORDER BY created_at DESC`,
  );
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    status: row.status,
    trackingCode: row.tracking_code,
    createdAt: row.created_at,
  }));
}
