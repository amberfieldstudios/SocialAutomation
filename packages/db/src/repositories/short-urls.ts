/**
 * SQLite-backed repository over `short_urls` (migration 0004).
 *
 * Owned conceptually by `@social/analytics` (the analytics-logging worker,
 * mirrors `repositories/analytics.ts`'s ownership note), implemented here
 * alongside the other repos so `@social/analytics` never needs to depend on
 * `SqlDriver` internals directly — it only talks to this through the narrow
 * `ShortUrlsStore` port.
 */

import type { StructuredLogger } from '@social/core';
import type { SqlDriver } from '../driver';
import { nullableText } from './rows';

export interface ShortUrlRecord {
  slug: string;
  targetUrl: string;
  campaignId: string | null;
  platformId: string | null;
  accountId: string | null;
  clickCount: number;
  createdAt: string;
  lastClickedAt: string | null;
}

export interface CreateShortUrlInput {
  slug: string;
  targetUrl: string;
  campaignId?: string | null;
  platformId?: string | null;
  accountId?: string | null;
}

interface ShortUrlRow {
  slug: string;
  target_url: string;
  campaign_id: string | null;
  platform_id: string | null;
  account_id: string | null;
  click_count: number;
  created_at: string;
  last_clicked_at: string | null;
}

function mapRow(row: ShortUrlRow): ShortUrlRecord {
  return {
    slug: row.slug,
    targetUrl: row.target_url,
    campaignId: nullableText(row.campaign_id),
    platformId: nullableText(row.platform_id),
    accountId: nullableText(row.account_id),
    clickCount: row.click_count,
    createdAt: row.created_at,
    lastClickedAt: nullableText(row.last_clicked_at),
  };
}

/** Storage port `@social/analytics`'s `LocalShortUrlService` depends on (structurally — no cross-package type import needed). */
export interface ShortUrlsStore {
  /** Insert a new slug -> target mapping. Throws on slug collision (caller retries with a new slug). */
  create(input: CreateShortUrlInput): Promise<ShortUrlRecord>;
  findBySlug(slug: string): Promise<ShortUrlRecord | undefined>;
  /** Increment `click_count` + stamp `last_clicked_at`, then return the (post-increment) row. Undefined if the slug is unknown. */
  recordClick(slug: string, clickedAt?: string): Promise<ShortUrlRecord | undefined>;
  listByCampaign(campaignId: string): Promise<ShortUrlRecord[]>;
}

export class SqliteShortUrlsStore implements ShortUrlsStore {
  constructor(
    private readonly driver: SqlDriver,
    private readonly logger?: StructuredLogger,
  ) {}

  async create(input: CreateShortUrlInput): Promise<ShortUrlRecord> {
    const now = new Date().toISOString();
    this.driver.run(
      `INSERT INTO short_urls (slug, target_url, campaign_id, platform_id, account_id, click_count, created_at, last_clicked_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, NULL)`,
      [
        input.slug,
        input.targetUrl,
        input.campaignId ?? null,
        input.platformId ?? null,
        input.accountId ?? null,
        now,
      ],
    );
    this.logger?.info('db.short_url.created', {
      slug: input.slug,
      campaignId: input.campaignId ?? null,
      platformId: input.platformId ?? null,
    });
    return this.requireRow(input.slug);
  }

  async findBySlug(slug: string): Promise<ShortUrlRecord | undefined> {
    const row = this.driver.get<ShortUrlRow>('SELECT * FROM short_urls WHERE slug = ?', [slug]);
    return row ? mapRow(row) : undefined;
  }

  async recordClick(slug: string, clickedAt?: string): Promise<ShortUrlRecord | undefined> {
    const existing = await this.findBySlug(slug);
    if (!existing) {
      this.logger?.warn('db.short_url.click_unknown_slug', { slug });
      return undefined;
    }
    const at = clickedAt ?? new Date().toISOString();
    this.driver.run(
      'UPDATE short_urls SET click_count = click_count + 1, last_clicked_at = ? WHERE slug = ?',
      [at, slug],
    );
    this.logger?.info('db.short_url.click_recorded', {
      slug,
      campaignId: existing.campaignId,
    });
    return this.requireRow(slug);
  }

  async listByCampaign(campaignId: string): Promise<ShortUrlRecord[]> {
    return this.driver
      .all<ShortUrlRow>('SELECT * FROM short_urls WHERE campaign_id = ? ORDER BY created_at', [campaignId])
      .map(mapRow);
  }

  private requireRow(slug: string): ShortUrlRecord {
    const row = this.driver.get<ShortUrlRow>('SELECT * FROM short_urls WHERE slug = ?', [slug]);
    if (!row) throw new Error(`short_urls row ${slug} not found`);
    return mapRow(row);
  }
}
